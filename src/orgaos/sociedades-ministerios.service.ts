import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { Ator, contaDaSessao, fundamento, Tx } from '../autorizacao/politica';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { PrismaService } from '../prisma/prisma.service';
import { orgaosDeAtuacao, periodoOrgao, presidenciaSociedades } from './acesso-sociedades';
import { atoAnterior, hashAto, transacaoSerializavel } from './idempotencia';
import { ordemDoAto } from './ordem-ato';
import { limiteExclusivoPorMeses } from './regras-periodos';
import { hojeDaIgreja } from './relogio-igreja';
import { cabeNaFaixa, cargosSociedade, configuracaoOrgao, dataCivilOrgao, diaCivilOrgao, faixaCivil, regraPadrao, regrasSociedade, RegrasSociedade, siglaSociedade } from './sociedades-regras';

const categoriaParticipacao = z.enum(['LOCAL', 'ESCOLA_DOMINICAL', 'AUTORIZACAO_CONSELHO', 'COOPERADOR']);
const base = { evidencia: fundamento, idempotencia: z.uuid() };
const criacao = z.object({ ...base, nome: fundamento.max(255), sigla: fundamento.max(40).optional(), finalidade: fundamento,
  constituicao: z.enum(['ELEICAO', 'DESIGNACAO']), participacao: z.enum(['MEMBROS', 'COMUNGANTES']),
  cargos: z.array(fundamento.max(120)).min(1).max(12), prazo_maximo_meses: z.number().int().min(1).max(60).optional() }).strict();
const comandar = z.discriminatedUnion('tipo', [
  z.object({ ...base, tipo: z.literal('ATIVACAO_SOCIEDADE'), data_organizacao: z.iso.date().optional(), fonte: fundamento,
    idade_transicao: z.union([z.literal(18), z.literal(19)]).optional(), escola_dominical: z.boolean().optional(),
    diretoria_reduzida: z.boolean().optional(), segundo_secretario_ucp: z.boolean().optional() }).strict(),
  z.object({ ...base, tipo: z.literal('DESATIVACAO'), motivo: fundamento }).strict(),
  z.object({ ...base, tipo: z.literal('MANUTENCAO_MINISTERIO'), nome: fundamento.max(255), sigla: fundamento.max(40).nullable(), finalidade: fundamento }).strict(),
  z.object({ ...base, tipo: z.literal('PARTICIPACAO_INCLUSAO'), pessoa_id: z.uuid(), desde: z.iso.date().optional(), categoria: categoriaParticipacao.default('LOCAL') }).strict(),
  z.object({ ...base, tipo: z.literal('PARTICIPACAO_SAIDA'), pessoa_id: z.uuid() }).strict(),
  z.object({ ...base, tipo: z.literal('PROVIMENTO'), cargo_id: z.uuid(), pessoa_id: z.uuid(), data_eleicao: z.iso.date().optional(), termino_previsto: z.iso.date().optional(),
    aprovacao_conselho: fundamento.optional(), posse: fundamento.optional(), frequencia_plenarias: z.number().int().min(0).max(100).optional(),
    presente_na_eleicao: z.literal(true).optional(), excecao_conselho: fundamento.optional() }).strict(),
  z.object({ ...base, tipo: z.literal('ENCERRAMENTO_CARGO'), ocupacao_id: z.uuid(), motivo: fundamento }).strict(),
]);
type Comando = z.infer<typeof comandar>;
type Orgao = Awaited<ReturnType<SociedadesMinisteriosService['orgao']>>;
type Pessoa = { id: string; nome_completo: string; sexo: 'MASCULINO' | 'FEMININO'; data_nascimento: Date };
const periodoCargo = (data: Date) => ({ ...periodoOrgao(data), AND: [{ OR: [{ termino_previsto: null }, { termino_previsto: { gte: data } }] }] });
const habilitado = (o: Orgao) => o.tipo === 'SOCIEDADE_INTERNA' || o.gestao_presidencial;
const cargoSupervisao = (codigo: string) => ['CONSELHEIRO', 'ORIENTADOR'].includes(codigo);
const membroLocal = (rol: string | null) => rol === 'COMUNGANTES' || rol === 'NAO_COMUNGANTES';
const periodoAbertoApos = (inicio: Date, historico: boolean) => ({
  OR: [{ fim: null }, { fim: { gt: inicio } }, ...(historico ? [{ fim: inicio, fim_ordem: { gt: 1 } }] : [])],
});

@Injectable()
export class SociedadesMinisteriosService {
  constructor(private readonly prisma: PrismaService) {}

  async orgao(tx: Tx, igreja_id: string, id: string) {
    const orgao = await tx.orgao_interno.findFirst({ where: { igreja_id, id, tipo: { in: ['SOCIEDADE_INTERNA', 'UNIDADE_MINISTERIAL'] } } });
    if (!orgao) throw new NotFoundException('Sociedade ou ministério indisponível.');
    return orgao;
  }

  private versao(tx: Tx, orgao: Orgao, data: Date) {
    return tx.versao_orgao.findFirst({ where: { igreja_id: orgao.igreja_id, orgao_id: orgao.id, ...periodoOrgao(data) } });
  }

  private async regra(tx: Tx, orgao: Orgao, data: Date) {
    const versao = await this.versao(tx, orgao, data);
    const regra = regrasSociedade.safeParse(configuracaoOrgao(versao?.configuracao).regra_sociedade);
    return { versao, regra: regra.success ? regra.data : null };
  }

  private async dirigente(tx: Tx, a: Ator, dia: string) {
    await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${a.sub} AND igreja_id = ${a.igreja_id} FOR UPDATE`;
    const conta = await contaDaSessao(tx, a);
    const presidencia = await presidenciaSociedades(tx, conta, dia);
    if (!presidencia || !conta.pessoa_id) throw new ForbiddenException('É necessária a conta de atuação do presidente institucional conferido.');
    await tx.$queryRaw`SELECT id FROM presidencia_conselho WHERE id = ${presidencia} AND igreja_id = ${a.igreja_id} FOR SHARE`;
    return { presidencia, pessoa: conta.pessoa_id };
  }

  private async registrar(tx: Tx, a: Ator, orgao: string, tipo: string, data: Date, presidente: Awaited<ReturnType<SociedadesMinisteriosService['dirigente']>>,
    entrada: { idempotencia: string; evidencia: string }, hash: string, detalhes: Prisma.InputJsonObject) {
    const ato = await tx.ato_orgao.create({ data: { orgao_id: orgao, igreja_id: a.igreja_id, operador_id: a.sub, tipo, data_efeito: data,
      autoridade: presidente.pessoa, evidencia: entrada.evidencia, idempotencia: entrada.idempotencia, hash_requisicao: hash,
      detalhes: { ...detalhes, presidencia_id: presidente.presidencia } } });
    await tx.logs_atividades.create({ data: { igreja_id: a.igreja_id, usuario_id: a.sub, acao: 'CRIACAO', tabela_afetada: 'ato_orgao',
      registro_id: ato.id, dados_novos: { orgao_id: orgao, tipo, data_efeito: diaCivilOrgao(data) } } });
    return { id: orgao, ato_id: ato.id };
  }

  criar(a: Ator, body: unknown) {
    const entrada = criacao.safeParse(body);
    if (!entrada.success) throw new BadRequestException('Confira os dados e os cargos do ministério.');
    const v = entrada.data;
    if (new Set(v.cargos.map(x => x.toLocaleLowerCase('pt-BR'))).size !== v.cargos.length ||
      (v.constituicao === 'ELEICAO' && !v.prazo_maximo_meses)) throw new BadRequestException('Informe cargos distintos e, para eleição, o prazo máximo.');
    const tipo = 'INSTITUICAO_MINISTERIO', hash = hashAto({ tipo, ...v }), igreja_id = a.igreja_id;
    return transacaoSerializavel(this.prisma, async tx => {
      const dia = await hojeDaIgreja(tx, igreja_id), data = dataCivilOrgao(dia);
      const presidente = await this.dirigente(tx, a, dia);
      const anterior = await atoAnterior(tx, { igreja: igreja_id, usuario: a.sub, tipo, idempotencia: v.idempotencia, hash }, 'orgao_id');
      if (anterior) return { id: anterior.ocupacao_id, ato_id: anterior.ato_id };
      const orgao = await tx.orgao_interno.create({ data: { igreja_id, nome: v.nome, sigla: v.sigla, finalidade: v.finalidade,
        tipo: 'UNIDADE_MINISTERIAL', constituicao: v.constituicao, gestao_presidencial: true, data_criacao: data,
        criador_id: a.sub, instituidor_id: presidente.pessoa, evidencia_instituicao: v.evidencia } });
      await tx.cargo_orgao.createMany({ data: v.cargos.map((nome, indice) => ({
        igreja_id, orgao_id: orgao.id, nome, codigo: 'MINISTERIO_' + (indice + 1), funcao: indice === 0 ? 'LIDER' : 'OUTRO',
      })) });
      const regras = JSON.stringify({ composicao: v.constituicao, participacao: v.participacao, cargo_prazo_maximo_meses: v.prazo_maximo_meses });
      await tx.$executeRaw`SELECT configurar_orgao_inicial(${orgao.id}, ${igreja_id}, ${regras}::jsonb, ${v.evidencia})`;
      await tx.versao_orgao.updateMany({ where: { igreja_id, orgao_id: orgao.id, numero: 1 }, data: { inicio: data } });
      return this.registrar(tx, a, orgao.id, tipo, data, presidente, v, hash, { orgao_id: orgao.id });
    });
  }

  executar(a: Ator, id: string, body: unknown) {
    const entrada = comandar.safeParse(body);
    if (!entrada.success) throw new BadRequestException('Confira os dados do ato.');
    const v = entrada.data, igreja_id = a.igreja_id, hash = hashAto({ id, ...v });
    return transacaoSerializavel(this.prisma, async tx => {
      const dia = await hojeDaIgreja(tx, igreja_id), data = dataCivilOrgao(dia);
      const presidente = await this.dirigente(tx, a, dia);
      const anterior = await atoAnterior(tx, { igreja: igreja_id, usuario: a.sub, orgao: id, tipo: v.tipo, idempotencia: v.idempotencia, hash }, 'orgao_id');
      if (anterior) return { id, ato_id: anterior.ato_id };
      // O bloqueio por igreja ordena ativações UPA/UMP e admissões entre as duas sociedades.
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja_id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${id} AND igreja_id = ${igreja_id} FOR UPDATE`;
      const orgao = await this.orgao(tx, igreja_id, id);
      if (!habilitado(orgao)) throw new NotFoundException('Órgão indisponível nesta gestão.');
      if (v.tipo !== 'ATIVACAO_SOCIEDADE' && !orgao.ativo) throw new ConflictException('O órgão está inativo para novos atos.');
      const ordem = await ordemDoAto(tx, igreja_id, id, data);
      const detalhes = await this.aplicar(tx, orgao, v, dia, data, ordem);
      return this.registrar(tx, a, id, v.tipo, data, presidente, v, hash, { orgao_id: id, ordem_efeito: ordem, ...detalhes });
    });
  }

  private async aplicar(tx: Tx, o: Orgao, v: Comando, dia: string, data: Date, ordem: number): Promise<Prisma.InputJsonObject> {
    const escopo = { igreja_id: o.igreja_id, orgao_id: o.id };
    if (v.tipo === 'ATIVACAO_SOCIEDADE') return this.ativar(tx, o, v, data);
    if (v.tipo === 'DESATIVACAO') {
      const futuras = await tx.ocupacao_cargo.count({ where: { ...escopo, inicio: { gt: data }, fim: null } });
      if (futuras) throw new ConflictException('Resolva as ocupações futuras antes de desativar.');
      const fim = { fim: data, fim_ordem: ordem };
      const ocupacoes = await tx.ocupacao_cargo.updateMany({ where: { ...escopo, ...periodoCargo(data), fim: null }, data: fim });
      const membros = await tx.membro_orgao.updateMany({ where: { ...escopo, ...periodoOrgao(data), fim: null }, data: fim });
      await tx.orgao_interno.update({ where: { id: o.id }, data: { ativo: false } });
      return { motivo: v.motivo, ocupacoes_encerradas: ocupacoes.count, participacoes_encerradas: membros.count };
    }
    if (v.tipo === 'MANUTENCAO_MINISTERIO') {
      if (!o.gestao_presidencial) throw new BadRequestException('A operação é exclusiva de ministérios.');
      const novo = { nome: v.nome, sigla: v.sigla, finalidade: v.finalidade };
      await tx.orgao_interno.update({ where: { id: o.id }, data: novo });
      return { anterior: { nome: o.nome, sigla: o.sigla, finalidade: o.finalidade }, novo };
    }
    if (v.tipo === 'ENCERRAMENTO_CARGO') {
      const ocupacao = await tx.ocupacao_cargo.findFirst({ where: { ...escopo, id: v.ocupacao_id, ...periodoCargo(data) } });
      if (!ocupacao) throw new NotFoundException('Ocupação em exercício indisponível.');
      await tx.ocupacao_cargo.update({ where: { id: ocupacao.id }, data: { fim: data, fim_ordem: ordem } });
      return { ocupacao_id: ocupacao.id, cargo_id: ocupacao.cargo_id, motivo: v.motivo };
    }
    const pessoa = await tx.pessoas.findFirst({ where: { igreja_id: o.igreja_id, id: v.pessoa_id },
      select: { id: true, nome_completo: true, sexo: true, data_nascimento: true } });
    if (!pessoa) throw new NotFoundException('Pessoa indisponível nesta igreja.');
    await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa.id} AND igreja_id = ${o.igreja_id} FOR SHARE`;
    if (v.tipo === 'PROVIMENTO') return this.prover(tx, o, pessoa, v, dia, data, ordem);

    const membro = await tx.membro_orgao.findFirst({ where: { ...escopo, pessoa_id: pessoa.id, ...periodoOrgao(data) } });
    if (v.tipo === 'PARTICIPACAO_SAIDA') {
      if (!membro) throw new NotFoundException('Participação vigente indisponível.');
      if (await tx.ocupacao_cargo.findFirst({ where: { ...escopo, pessoa_id: pessoa.id, ...periodoCargo(data), cargo: { codigo: { notIn: ['CONSELHEIRO', 'ORIENTADOR'] } } }, select: { id: true } }))
        throw new ConflictException('Encerre o cargo em exercício antes de registrar a saída.');
      await tx.membro_orgao.update({ where: { id: membro.id }, data: { fim: data, fim_ordem: ordem } });
      return { membro_id: membro.id };
    }
    if (membro) throw new ConflictException('A pessoa já participa deste órgão.');
    const desde = v.desde ?? dia, inicio = dataCivilOrgao(desde);
    const ativacao = o.tipo === 'SOCIEDADE_INTERNA' ? await tx.ato_orgao.findFirst({ where: { ...escopo, tipo: 'ATIVACAO_SOCIEDADE' },
      orderBy: [{ data_efeito: 'desc' }, { criado_em: 'desc' }], select: { detalhes: true } }) : null;
    const marco = configuracaoOrgao(ativacao?.detalhes).inicio_atividade;
    if (desde > dia || (typeof marco === 'string' && desde < marco) || (o.data_criacao && inicio < o.data_criacao))
      throw new BadRequestException('A data de ingresso deve cair no período atual de atividade do órgão.');
    const { versao, regra } = await this.regra(tx, o, inicio);
    const rol = this.rolNaData(await this.historicoRol(tx, o, pessoa.id, desde), desde);
    if (!this.elegivel(o, pessoa, desde, v.categoria, regra, versao?.configuracao, rol))
      throw new BadRequestException('A pessoa não atende à faixa etária, ao rol ou à categoria de participação registrada.');
    if (['UPA', 'UMP'].includes(o.tipo_padrao ?? '') && await tx.membro_orgao.findFirst({ where: {
      igreja_id: o.igreja_id, pessoa_id: pessoa.id, ...periodoAbertoApos(inicio, false),
      orgao: { tipo_padrao: o.tipo_padrao === 'UPA' ? 'UMP' : 'UPA' },
    }, select: { id: true } })) throw new ConflictException('Registre a saída da sociedade anterior antes da nova adesão.');
    if (await tx.membro_orgao.findFirst({ where: { ...escopo, pessoa_id: pessoa.id, ...periodoAbertoApos(inicio, desde !== dia) }, select: { id: true } }))
      throw new ConflictException('Já existe participação no período informado.');
    const novo = await tx.membro_orgao.create({ data: { ...escopo, pessoa_id: pessoa.id, inicio, inicio_ordem: desde === dia ? ordem : 1,
      categoria_participacao: v.categoria } });
    return { membro_id: novo.id, ingresso: desde, categoria: v.categoria, versao_orgao_id: versao?.id ?? null };
  }

  private async ativar(tx: Tx, o: Orgao, v: Extract<Comando, { tipo: 'ATIVACAO_SOCIEDADE' }>, data: Date) {
    const sigla = siglaSociedade.safeParse(o.tipo_padrao);
    if (!sigla.success || o.ativo) throw new ConflictException('Selecione uma sociedade inativa.');
    const chave = sigla.data, dia = diaCivilOrgao(data);
    const escopo = { igreja_id: o.igreja_id, orgao_id: o.id };
    const ultima = await tx.versao_orgao.findFirst({ where: escopo, orderBy: { numero: 'desc' } });
    if (!ultima) throw new ConflictException('A estrutura institucional precisa ser instalada.');
    const aprovada = regrasSociedade.safeParse(configuracaoOrgao(ultima.configuracao).regra_sociedade);
    if (aprovada.success && ultima.inicio > data)
      throw new ConflictException('Aguarde a vigência da configuração programada antes de reativar a sociedade.');
    const desde = v.data_organizacao ?? dia;
    if ((aprovada.success && desde !== dia) || desde > dia) throw new BadRequestException('Na reativação, use a data da igreja.');
    const regra = aprovada.success ? aprovada.data : regraPadrao(chave);
    if (v.idade_transicao && chave === 'UPA') regra.idade_maxima = v.idade_transicao - 1;
    if (v.idade_transicao && chave === 'UMP') regra.idade_minima = v.idade_transicao;
    if (v.escola_dominical !== undefined && ['UCP', 'UPA'].includes(chave)) regra.escola_dominical = v.escola_dominical;
    if (v.diretoria_reduzida !== undefined && ['SAF', 'UMP'].includes(chave)) regra.diretoria_reduzida = v.diretoria_reduzida;
    if (v.segundo_secretario_ucp !== undefined && chave === 'UCP') regra.segundo_secretario_ucp = v.segundo_secretario_ucp;
    if (chave === 'UPA' || chave === 'UMP') {
      const outra = await tx.orgao_interno.findFirst({ where: { igreja_id: o.igreja_id, ativo: true, tipo_padrao: chave === 'UPA' ? 'UMP' : 'UPA' } });
      const outraRegra = outra ? (await this.regra(tx, outra, data)).regra : null;
      if (outraRegra && (chave === 'UPA' ? regra.idade_maxima! + 1 !== outraRegra.idade_minima : outraRegra.idade_maxima! + 1 !== regra.idade_minima))
        throw new BadRequestException('Use a mesma idade de transição adotada na outra sociedade.');
    }
    const codigos = cargosSociedade(chave, regra);
    await tx.cargo_orgao.createMany({ data: [
      { ...escopo, codigo: 'CONSELHEIRO', nome: 'Conselheiro', funcao: 'OUTRO' },
      ...(['UCP', 'UPA'].includes(chave) ? [{ ...escopo, codigo: 'ORIENTADOR', nome: 'Orientador', funcao: 'OUTRO' }] : []),
    ], skipDuplicates: true });
    const codigosAtivos = [...codigos, 'CONSELHEIRO', ...(['UCP', 'UPA'].includes(chave) ? ['ORIENTADOR'] : [])];
    await tx.cargo_orgao.updateMany({ where: { ...escopo, codigo: { in: codigosAtivos } }, data: { ativo: true } });
    await tx.cargo_orgao.updateMany({ where: { ...escopo, codigo: { notIn: codigosAtivos } }, data: { ativo: false } });
    const cargos = await tx.cargo_orgao.findMany({ where: escopo, select: { id: true, codigo: true, nome: true, funcao: true, permite_acumulacao: true, ativo: true }, orderBy: { codigo: 'asc' } });
    const configuracao = { ...configuracaoOrgao(ultima.configuracao), regra_sociedade: regra, cargos } as Prisma.InputJsonObject;
    let versaoId = ultima.id;
    if (!aprovada.success) {
      // A versão pré-instalada é um catálogo para homologação, sem atos de adesão associados.
      await tx.versao_orgao.update({ where: { id: ultima.id }, data: { fonte: v.fonte, inicio: dataCivilOrgao(desde), configuracao } });
    } else if (JSON.stringify(aprovada.data) !== JSON.stringify(regra) || ultima.fonte !== v.fonte) {
      if (ultima.inicio >= data) throw new ConflictException('Uma alteração da regra já entrou em vigor nesta data.');
      await tx.versao_orgao.update({ where: { id: ultima.id }, data: { fim: data } });
      versaoId = (await tx.versao_orgao.create({ data: { ...escopo, numero: ultima.numero + 1, inicio: data, fonte: v.fonte, configuracao } })).id;
    }
    await tx.orgao_interno.update({ where: { id: o.id }, data: { ativo: true } });
    return { inicio_atividade: desde, versao_orgao_id: versaoId };
  }

  private async historicoRol(tx: Tx, o: Orgao, pessoa_id: string, dia: string) {
    return tx.eventos_membresia.findMany({ where: { igreja_id: o.igreja_id, pessoa_id, data_evento: { lte: dataCivilOrgao(dia) } },
      select: { data_evento: true, ordem_dia: true, rol: true } });
  }

  private rolNaData(historico: Awaited<ReturnType<SociedadesMinisteriosService['historicoRol']>>, dia: string) {
    const estado = eventoVigente(historico, dataCivilOrgao(dia));
    return estado.situacao === 'DEFINIDO' ? estado.evento.rol : null;
  }

  private elegivel(o: Orgao, p: Pessoa, dia: string, categoria: z.infer<typeof categoriaParticipacao>, regra: RegrasSociedade | null, configuracao: unknown, rol: string | null) {
    if (!regra) return o.gestao_presidencial && categoria === 'LOCAL' &&
      (configuracaoOrgao(configuracao).participacao === 'COMUNGANTES' ? rol === 'COMUNGANTES' : membroLocal(rol));
    if (!cabeNaFaixa(regra, p.data_nascimento, dia) || (regra.sexo && regra.sexo !== p.sexo)) return false;
    if (categoria === 'LOCAL') return membroLocal(rol);
    if (categoria === 'ESCOLA_DOMINICAL') return regra.escola_dominical;
    if (categoria === 'COOPERADOR') return o.tipo_padrao === 'UMP' || o.tipo_padrao === 'UPH';
    return o.tipo_padrao === 'SAF';
  }

  private async prover(tx: Tx, o: Orgao, p: Pessoa, v: Extract<Comando, { tipo: 'PROVIMENTO' }>, dia: string, data: Date, ordem: number) {
    const escopo = { igreja_id: o.igreja_id, orgao_id: o.id };
    const cargo = await tx.cargo_orgao.findFirst({ where: { ...escopo, id: v.cargo_id, ativo: true } });
    if (!cargo) throw new NotFoundException('Cargo indisponível no órgão.');
    const supervisao = cargoSupervisao(cargo.codigo), eleicao = !supervisao && o.constituicao === 'ELEICAO';
    const diaEleicao = v.data_eleicao ?? dia, dataEleicao = dataCivilOrgao(diaEleicao);
    const naEleicao = await this.regra(tx, o, dataEleicao);
    const noExercicio = diaEleicao === dia ? naEleicao : await this.regra(tx, o, data);
    const regra = naEleicao.regra;
    const modo = supervisao ? 'NOMEACAO_CONSELHO' : eleicao ? 'ELEICAO' : 'DESIGNACAO';
    const historico = await this.historicoRol(tx, o, p.id, dia);
    const rol = this.rolNaData(historico, dia);
    const comungante = rol === 'COMUNGANTES';
    if (eleicao) {
      if (!v.data_eleicao || diaEleicao > dia || !v.termino_previsto || v.termino_previsto < dia || !v.posse || !naEleicao.versao)
        throw new BadRequestException('Informe a eleição, a posse e o último dia do mandato.');
      const meses = Number(configuracaoOrgao(naEleicao.versao.configuracao).cargo_prazo_maximo_meses ?? (regra ? 12 : undefined));
      if (!Number.isInteger(meses) || meses < 1 || v.termino_previsto >= limiteExclusivoPorMeses(dia, meses))
        throw new BadRequestException('O término excede o prazo máximo da configuração.');
    } else if (v.data_eleicao || (v.termino_previsto && v.termino_previsto < dia)) {
      throw new BadRequestException('Confira as datas da designação.');
    }
    if (supervisao && (!comungante || faixaCivil(p.data_nascimento, 18) > dia))
      throw new BadRequestException('A supervisão requer membro comungante adulto indicado pelo Conselho.');
    if (o.gestao_presidencial && !comungante)
      throw new BadRequestException('A liderança exige membresia comungante em exercício.');
    if (eleicao) {
      const membro = await tx.membro_orgao.findFirst({ where: { ...escopo, pessoa_id: p.id, ...periodoOrgao(dataEleicao) } });
      const atual = diaEleicao === dia ? membro : await tx.membro_orgao.findFirst({ where: { ...escopo, pessoa_id: p.id, ...periodoOrgao(data) } });
      if (!membro || !atual || membro.id !== atual.id || membro.categoria_participacao !== 'LOCAL' ||
        !this.elegivel(o, p, diaEleicao, 'LOCAL', regra, naEleicao.versao?.configuracao, this.rolNaData(historico, diaEleicao)) ||
        !this.elegivel(o, p, dia, 'LOCAL', noExercicio.regra, noExercicio.versao?.configuracao, rol))
        throw new BadRequestException('A eleição exige participação local elegível na eleição e na posse.');
      if (regra) {
        if (!v.aprovacao_conselho) throw new BadRequestException('Informe a aprovação da eleição pelo Conselho.');
        const meses = regra.meses_filiacao_diretoria;
        const excecao = o.tipo_padrao === 'UPA' && !!v.excecao_conselho;
        if (meses && limiteExclusivoPorMeses(diaCivilOrgao(membro.inicio), meses) > diaEleicao && !excecao)
          throw new BadRequestException('Tempo mínimo de filiação à sociedade ainda não alcançado.');
        if (meses && ['SAF','UPA'].includes(o.tipo_padrao ?? '') && !excecao) {
          const limite = new Date(dataEleicao);
          limite.setUTCDate(1);
          limite.setUTCMonth(limite.getUTCMonth() - meses);
          const diaLimite = Math.min(dataEleicao.getUTCDate(), new Date(Date.UTC(limite.getUTCFullYear(), limite.getUTCMonth() + 1, 0)).getUTCDate());
          limite.setUTCDate(diaLimite);
          const anterior = eventoVigente(historico, limite);
          if (anterior.situacao !== 'DEFINIDO' || !membroLocal(anterior.evento.rol) ||
            historico.some(e => e.data_evento > limite && e.data_evento <= dataEleicao && !membroLocal(e.rol)))
            throw new BadRequestException('Tempo mínimo contínuo de membresia da igreja ainda não comprovado.');
        }
        if (o.tipo_padrao === 'SAF' && (!v.presente_na_eleicao || (v.frequencia_plenarias ?? 0) < 50))
          throw new BadRequestException('Na SAF, confirme a presença na eleição e a frequência mínima de 50% às plenárias.');
        if (o.tipo_padrao === 'SAF' && regra.diretoria_reduzida && await tx.membro_orgao.count({ where: { ...escopo, ...periodoOrgao(dataEleicao) } }) >= 8)
          throw new BadRequestException('A diretoria reduzida da SAF é prevista para menos de oito sócias.');
      }
    }
    const acumulacao = o.tipo_padrao === 'UMP' && regra?.diretoria_reduzida && !!v.excecao_conselho;
    if (!supervisao && !acumulacao && await tx.ocupacao_cargo.findFirst({ where: { ...escopo, pessoa_id: p.id, ...periodoCargo(data),
      cargo: { codigo: { notIn: ['CONSELHEIRO', 'ORIENTADOR'] } } }, select: { id: true } }))
      throw new ConflictException('A pessoa já exerce um cargo neste órgão.');
    if (await tx.ocupacao_cargo.findFirst({ where: { ...escopo, cargo_id: cargo.id, OR: [
      { inicio: { gt: data } }, periodoCargo(data),
    ] }, select: { id: true } })) throw new ConflictException('O cargo já tem titular vigente ou futuro.');
    const ocupacao = await tx.ocupacao_cargo.create({ data: { ...escopo, cargo_id: cargo.id, pessoa_id: p.id,
      inicio: data, inicio_ordem: ordem, termino_previsto: v.termino_previsto ? dataCivilOrgao(v.termino_previsto) : null } });
    return { cargo_id: cargo.id, ocupacao_id: ocupacao.id, modo, versao_orgao_id: naEleicao.versao?.id ?? null,
      data_eleicao: v.data_eleicao ?? null, aprovacao_conselho: v.aprovacao_conselho ?? null, posse: v.posse ?? null,
      frequencia_plenarias: v.frequencia_plenarias ?? null, presente_na_eleicao: v.presente_na_eleicao ?? null,
      excecao_conselho: v.excecao_conselho ?? null, termino_previsto: v.termino_previsto ?? null };
  }

  async consultar(a: Ator, id: string, busca?: string, diaSolicitado?: string, supervisao = false) {
    if (diaSolicitado && !z.iso.date().safeParse(diaSolicitado).success) throw new BadRequestException('Data inválida.');
    return this.prisma.$transaction(async tx => {
      const conta = await contaDaSessao(tx, a);
      const hoje = await hojeDaIgreja(tx, a.igreja_id), dia = diaSolicitado ?? hoje, data = dataCivilOrgao(dia);
      const [o, presidente] = await Promise.all([this.orgao(tx, a.igreja_id, id), presidenciaSociedades(tx, conta, hoje)]);
      if (!habilitado(o) || (!presidente && !(await orgaosDeAtuacao(tx, conta, hoje)).includes(o.id)))
        throw new NotFoundException('Gestão indisponível para esta conta.');
      const { regra, versao } = await this.regra(tx, o, data);
      const codigo = siglaSociedade.safeParse(o.tipo_padrao);
      const faixa = regra ?? (codigo.success ? regraPadrao(codigo.data) : null);
      const escopo = { igreja_id: a.igreja_id, orgao_id: o.id };
      const cargos = await tx.cargo_orgao.findMany({ where: { ...escopo, ativo: true }, select: { id: true, nome: true, codigo: true }, orderBy: { nome: 'asc' } });
      const filtro = busca?.trim().slice(0, 100);
      const candidatos = filtro && filtro.length >= 2 && presidente && o.ativo ? await tx.pessoas.findMany({ where: {
        igreja_id: a.igreja_id, nome_completo: { contains: filtro, mode: 'insensitive' }, ...(!supervisao && faixa?.sexo ? { sexo: faixa.sexo } : {}),
      }, select: { id: true, nome_completo: true, sexo: true, data_nascimento: true }, orderBy: [{ nome_completo: 'asc' }, { id: 'asc' }], take: 40 }) : [];
      const eventos = candidatos.length ? await tx.eventos_membresia.findMany({ where: {
        igreja_id: a.igreja_id, pessoa_id: { in: candidatos.map(p => p.id) }, data_evento: { lte: data },
      }, select: { pessoa_id: true, data_evento: true, ordem_dia: true, rol: true } }) : [];
      const sugestoes = candidatos.map(p => {
        const rol = this.rolNaData(eventos.filter(e => e.pessoa_id === p.id), dia);
        const categorias = supervisao
          ? (rol === 'COMUNGANTES' && faixaCivil(p.data_nascimento, 18) <= dia ? ['LOCAL'] : [])
          : categoriaParticipacao.options.filter(c => this.elegivel(o, p, dia, c, faixa, versao?.configuracao, rol));
        return { id: p.id, nome: p.nome_completo, categorias };
      });
      return { pode_gerir: !!presidente && hoje === dia, regra: faixa, fonte: versao?.fonte ?? null, cargos,
        sugestoes: sugestoes.filter(p => p.categorias.length) };
    }, { isolationLevel: 'RepeatableRead' });
  }
}
