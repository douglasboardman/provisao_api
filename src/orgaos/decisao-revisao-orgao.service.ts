import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { bloquearRegrasMembresia } from '../regras-relacao-enum/parametros-membresia';
import { createHash } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { exigirAcessoSensivel } from '../oficiais/acesso-sensivel.service';
import { CorrecaoMembresiaService } from '../oficiais/correcao-membresia.service';
import { CorrecaoConteudoService } from '../oficiais/correcao-conteudo.service';
import { InsercaoRetroativaService } from '../oficiais/insercao-retroativa.service';
import { OrdenacaoMembresiaService } from '../oficiais/ordenacao-membresia.service';
import { DetalheVinculoOrgao } from '../oficiais/impacto-orgaos';
import { bloquearChave, hashAto, transacaoComRetentativa } from './idempotencia';

const texto = z.string().trim().min(1).max(1000);
const entrada = z.object({ operacao: z.enum(['DATA', 'CONTEUDO', 'ORDEM', 'INSERCAO']), resultado: z.enum(['FAVORAVEL', 'DESFAVORAVEL']).optional(), hash_detalhes: z.string().regex(/^[a-f0-9]{64}$/).optional(), anotacoes_vinculos: z.array(z.object({ tipo: z.enum(['PARTICIPACAO', 'OCUPACAO']), id: z.uuid(), observacao: texto, encaminhamento: z.enum(['PRESERVAR', 'REVISAR', 'INDETERMINADO']).optional() }).strict()).max(100).optional(), oficial_id: z.uuid().optional(), proposta: z.record(z.string(), z.unknown()), hash_previa: z.string().regex(/^[a-f0-9]{64}$/), autoridade: texto.max(255), evidencia: texto, justificativa: texto, idempotencia: z.uuid(), ciente: z.literal(true) }).strict();
const entradaVinculos = z.object({ operacao: z.enum(['DATA', 'CONTEUDO', 'ORDEM', 'INSERCAO']), oficial_id: z.uuid().optional(), proposta: z.record(z.string(), z.unknown()), hash_previa: z.string().regex(/^[a-f0-9]{64}$/), pagina: z.number().int().min(0).max(1000000), hash_detalhes: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const entradaConsolidacao = entradaVinculos.omit({ pagina: true, hash_detalhes: true }).extend({ decisoes: z.array(z.uuid()).min(1).max(50), pagina: z.number().int().min(0).max(1000000).optional(), hash_conferencia: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const anotacoesArmazenadas = z.array(z.object({ tipo: z.enum(['PARTICIPACAO', 'OCUPACAO']), id: z.uuid(), observacao: texto, encaminhamento: z.enum(['PRESERVAR', 'REVISAR', 'INDETERMINADO']).optional() }).strict()).max(100);
const uuidValido = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

/** Guarda a decisão declarada para revisão; não autoriza a mutação protegida. */
@Injectable()
export class DecisaoRevisaoOrgaoService {
  constructor(private readonly prisma: PrismaService, private readonly data: CorrecaoMembresiaService, private readonly conteudo: CorrecaoConteudoService, private readonly insercao: InsercaoRetroativaService, private readonly ordem: OrdenacaoMembresiaService) {}

  private async autorizar(tx: Prisma.TransactionClient, igreja: string, usuario: string, modo: 'consultar' | 'registrar') {
    await exigirServicoDoUsuario(tx, igreja, usuario, modo === 'consultar' ? 'HISTORICO_MEMBRESIA_CONSULTAR' : 'REVISOES_ELEITORAIS_DECIDIR');
    await exigirAcessoSensivel(tx, igreja, usuario, modo);
  }

  async listar(igreja: string, usuario: string, pessoa: string, cursor?: string) {
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar');
      if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      if (cursor && (!uuidValido(cursor) || !await tx.decisao_revisao_orgao.findFirst({ where: { id: cursor, igreja_id: igreja, pessoa_id: pessoa }, select: { id: true } }))) throw new BadRequestException('Cursor inválido.');
      const registros = await tx.decisao_revisao_orgao.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa }, select: { id: true, operacao: true, resultado: true, anotacoes_vinculos: true, proposta: true, hash_previa: true, impacto: true, autoridade: true, evidencia: true, justificativa: true, criado_em: true, criado_por: { select: { nome_usuario: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }], take: 51, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const itens = registros.slice(0, 50);
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'decisao_revisao_orgao', registro_id: pessoa } });
      return { itens, proximo_cursor: registros.length > 50 ? itens[itens.length - 1].id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async consultarVinculos(igreja: string, usuario: string, pessoa: string, dados: z.infer<typeof entradaVinculos>) {
    const parsed = entradaVinculos.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Consulta de vínculos inválida.');
    const v = parsed.data;
    if (v.oficial_id && !['DATA', 'ORDEM'].includes(v.operacao)) throw new BadRequestException('Alvo de oficial não se aplica a esta operação.');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar');
      if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      if (v.oficial_id && !await tx.oficial.findFirst({ where: { id: v.oficial_id, igreja_id: igreja, pessoa_id: pessoa }, select: { id: true } })) throw new NotFoundException('Oficial não encontrado para esta pessoa e igreja.');
      let detalhes: DetalheVinculoOrgao[] = [];
      const coletar = (itens: DetalheVinculoOrgao[]) => { detalhes = itens; };
      const alvo = v.oficial_id ?? pessoa, porPessoa = !v.oficial_id;
      const previa = v.operacao === 'DATA' ? await this.data.calcularParaOrgaos(tx, igreja, alvo, v.proposta, porPessoa, coletar)
        : v.operacao === 'CONTEUDO' ? await this.conteudo.calcularParaOrgaos(tx, igreja, pessoa, v.proposta, coletar)
        : v.operacao === 'ORDEM' ? await this.ordem.calcularParaOrgaos(tx, igreja, alvo, v.proposta, porPessoa, coletar)
        : await this.insercao.calcularParaOrgaos(tx, igreja, pessoa, v.proposta, coletar);
      if (previa.pessoa_id !== pessoa || previa.hash !== v.hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes de consultar os vínculos.');
      const hashDetalhes = createHash('sha256').update(JSON.stringify(detalhes)).digest('hex');
      if ((v.pagina > 0 && !v.hash_detalhes) || (v.hash_detalhes && v.hash_detalhes !== hashDetalhes)) throw new ConflictException('Os vínculos mudaram; consulte novamente desde a primeira página.');
      const inicio = v.pagina * 100;
      if (inicio > 0 && inicio >= detalhes.length) throw new BadRequestException('Página de vínculos inválida.');
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'previa_vinculos_orgao', registro_id: pessoa } });
      return { itens: detalhes.slice(inicio, inicio + 100), hash_detalhes: hashDetalhes, pagina: v.pagina, proxima_pagina: inicio + 100 < detalhes.length ? v.pagina + 1 : null, total: detalhes.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** Conferência informativa: decisões selecionadas não são consumidas nem autorizam alterações. */
  async consolidar(igreja: string, usuario: string, pessoa: string, dados: z.infer<typeof entradaConsolidacao>) {
    const parsed = entradaConsolidacao.safeParse(dados);
    if (!parsed.success || new Set(parsed.data?.decisoes).size !== parsed.data?.decisoes.length) throw new BadRequestException('Seleção de decisões inválida.');
    const v = parsed.data;
    if (v.oficial_id && !['DATA', 'ORDEM'].includes(v.operacao)) throw new BadRequestException('Alvo de oficial não se aplica a esta operação.');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'consultar');
      if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      if (v.oficial_id && !await tx.oficial.findFirst({ where: { id: v.oficial_id, igreja_id: igreja, pessoa_id: pessoa }, select: { id: true } })) throw new NotFoundException('Oficial não encontrado para esta pessoa e igreja.');
      let detalhes: DetalheVinculoOrgao[] = [];
      const coletar = (itens: DetalheVinculoOrgao[]) => { detalhes = itens; };
      const alvo = v.oficial_id ?? pessoa, porPessoa = !v.oficial_id;
      const previa = v.operacao === 'DATA' ? await this.data.calcularParaOrgaos(tx, igreja, alvo, v.proposta, porPessoa, coletar)
        : v.operacao === 'CONTEUDO' ? await this.conteudo.calcularParaOrgaos(tx, igreja, pessoa, v.proposta, coletar)
        : v.operacao === 'ORDEM' ? await this.ordem.calcularParaOrgaos(tx, igreja, alvo, v.proposta, porPessoa, coletar)
        : await this.insercao.calcularParaOrgaos(tx, igreja, pessoa, v.proposta, coletar);
      if (previa.pessoa_id !== pessoa || previa.hash !== v.hash_previa || !previa.bloqueio_orgao?.bloqueia) throw new ConflictException('Os dados mudaram; gere nova prévia antes da conferência.');
      if (detalhes.length !== previa.bloqueio_orgao.participacoes + previa.bloqueio_orgao.ocupacoes) throw new ConflictException('Não foi possível conferir todos os vínculos.');
      const registros = await tx.decisao_revisao_orgao.findMany({ where: { id: { in: v.decisoes }, igreja_id: igreja, pessoa_id: pessoa, operacao: v.operacao, hash_previa: v.hash_previa }, select: { id: true, resultado: true, anotacoes_vinculos: true, impacto: true } });
      if (registros.length !== v.decisoes.length) throw new BadRequestException('Há decisão ausente ou incompatível com esta prévia.');
      const atuais = new Set(detalhes.map(d => `${d.tipo}:${d.id}`));
      const hashDetalhes = createHash('sha256').update(JSON.stringify(detalhes)).digest('hex');
      const porVinculo = new Map<string, Set<'PRESERVAR' | 'REVISAR' | 'INDETERMINADO'>>();
      for (const registro of registros) {
        const impacto = z.object({ hash_detalhes_anotados: z.string().optional() }).passthrough().safeParse(registro.impacto);
        if (!impacto.success || (impacto.data.hash_detalhes_anotados && impacto.data.hash_detalhes_anotados !== hashDetalhes)) throw new ConflictException('Os detalhes de uma decisão mudaram; gere nova conferência.');
        const anotacoes = anotacoesArmazenadas.safeParse(registro.anotacoes_vinculos ?? []);
        if (!anotacoes.success) throw new ConflictException('Uma decisão possui anotações indisponíveis para conferência.');
        const vistos = new Set<string>();
        for (const a of anotacoes.data) {
          const chave = `${a.tipo}:${a.id}`;
          if (!atuais.has(chave) || vistos.has(chave)) throw new ConflictException('Uma decisão contém vínculo inválido ou duplicado.');
          vistos.add(chave);
          if (a.encaminhamento) { const valores = porVinculo.get(chave) ?? new Set(); valores.add(a.encaminhamento); porVinculo.set(chave, valores); }
        }
      }
      const totais = { total: detalhes.length, preservar: 0, revisar: 0, indeterminado: 0, sem_encaminhamento: 0, divergentes: 0 };
      const divergencias: { id: string; tipo: 'PARTICIPACAO' | 'OCUPACAO'; orgao: string; inicio: string; encaminhamentos: string[] }[] = [];
      for (const d of detalhes) {
        const valores = porVinculo.get(`${d.tipo}:${d.id}`);
        if (!valores?.size) totais.sem_encaminhamento++;
        else if (valores.size > 1) { totais.divergentes++; divergencias.push({ id: d.id, tipo: d.tipo, orgao: d.orgao, inicio: d.inicio, encaminhamentos: [...valores].sort() }); }
        else { const valor = [...valores][0]; if (valor === 'PRESERVAR') totais.preservar++; else if (valor === 'REVISAR') totais.revisar++; else totais.indeterminado++; }
      }
      const resultados = { favoravel: registros.filter(r => r.resultado === 'FAVORAVEL').length, desfavoravel: registros.filter(r => r.resultado === 'DESFAVORAVEL').length, nao_informado: registros.filter(r => r.resultado === null).length };
      const hashConferencia = hashAto({ hashDetalhes, registros: [...registros].sort((a, b) => a.id.localeCompare(b.id)) });
      const pagina = v.pagina ?? 0, inicio = pagina * 100;
      if ((pagina > 0 && !v.hash_conferencia) || (v.hash_conferencia && v.hash_conferencia !== hashConferencia)) throw new ConflictException('A conferência mudou; consulte novamente desde a primeira página.');
      if (inicio > 0 && inicio >= divergencias.length) throw new BadRequestException('Página de divergências inválida.');
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'conferencia_decisoes_orgao', registro_id: pessoa } });
      return { totais, resultados, divergencias: divergencias.slice(inicio, inicio + 100), divergencias_limitadas: inicio + 100 < divergencias.length, pagina, proxima_pagina: inicio + 100 < divergencias.length ? pagina + 1 : null, hash_conferencia: hashConferencia };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async registrar(igreja: string, usuario: string, pessoa: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Decisão inválida.');
    const { idempotencia, ...v } = parsed.data, chave = idempotencia.toLowerCase();
    if (v.oficial_id && !['DATA', 'ORDEM'].includes(v.operacao)) throw new BadRequestException('Alvo de oficial não se aplica a esta operação.');
    const hash = hashAto({ operacao: 'DECISAO_REVISAO_ORGAO', pessoa, dados: v });
    return transacaoComRetentativa(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuario} AND igreja_id = ${igreja} FOR UPDATE`;
      await this.autorizar(tx, igreja, usuario, 'registrar');
      await bloquearChave(tx, igreja, chave);
      const anterior = await tx.decisao_revisao_orgao.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } } });
      if (anterior) {
        if (anterior.criado_por_id !== usuario || anterior.pessoa_id !== pessoa || anterior.hash_requisicao !== hash) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
        return { id: anterior.id };
      }
      if (!v.resultado) throw new BadRequestException('Informe o resultado declarado.');
      if (await tx.ato_orgao.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } }, select: { id: true } }) || await tx.requisicao_institucional.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } }, select: { idempotencia: true } })) throw new ConflictException('Chave de repetição já utilizada para outro ato.');
      await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa} AND igreja_id = ${igreja} FOR UPDATE`;
      if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      if (v.oficial_id && !await tx.oficial.findFirst({ where: { id: v.oficial_id, igreja_id: igreja, pessoa_id: pessoa }, select: { id: true } })) throw new NotFoundException('Oficial não encontrado para esta pessoa e igreja.');
      if (v.operacao === 'CONTEUDO' || v.operacao === 'INSERCAO') {
        await bloquearRegrasMembresia(tx, igreja);
      }
      let detalhes: DetalheVinculoOrgao[] = [];
      const coletar = (itens: DetalheVinculoOrgao[]) => { detalhes = itens; };
      const alvo = v.oficial_id ?? pessoa, porPessoa = !v.oficial_id;
      const previa = v.operacao === 'DATA' ? await this.data.calcularParaOrgaos(tx, igreja, alvo, v.proposta, porPessoa, coletar)
        : v.operacao === 'CONTEUDO' ? await this.conteudo.calcularParaOrgaos(tx, igreja, pessoa, v.proposta, coletar)
        : v.operacao === 'ORDEM' ? await this.ordem.calcularParaOrgaos(tx, igreja, alvo, v.proposta, porPessoa, coletar)
        : await this.insercao.calcularParaOrgaos(tx, igreja, pessoa, v.proposta, coletar);
      if (previa.pessoa_id !== pessoa) throw new ConflictException('O vínculo do oficial mudou; gere nova prévia.');
      if (previa.hash !== v.hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes da decisão.');
      if (!previa.bloqueio_orgao?.bloqueia) throw new BadRequestException('A prévia não possui vínculos de órgão para revisão.');
      if (detalhes.length !== previa.bloqueio_orgao.participacoes + previa.bloqueio_orgao.ocupacoes) throw new ConflictException('Não foi possível conferir todos os vínculos; gere nova prévia.');
      if (v.anotacoes_vinculos?.length) {
        const validos = new Set(detalhes.map(d => `${d.tipo}:${d.id}`));
        const informados = v.anotacoes_vinculos.map(d => `${d.tipo}:${d.id}`);
        if (new Set(informados).size !== informados.length || informados.some(id => !validos.has(id))) throw new BadRequestException('Anotações devem identificar vínculos distintos exibidos na prévia atual.');
        const iniciais = new Set((previa.bloqueio_orgao.detalhes ?? []).map(d => `${d.tipo}:${d.id}`));
        const requerAssinatura = informados.some(id => !iniciais.has(id));
        const hashDetalhes = createHash('sha256').update(JSON.stringify(detalhes)).digest('hex');
        if ((requerAssinatura && !v.hash_detalhes) || (v.hash_detalhes && v.hash_detalhes !== hashDetalhes)) throw new ConflictException('Os vínculos mudaram; consulte novamente antes de registrar as anotações.');
      }
      const encaminhamentos = v.anotacoes_vinculos ?? [];
      const preservar = encaminhamentos.filter(a => a.encaminhamento === 'PRESERVAR').length;
      const revisar = encaminhamentos.filter(a => a.encaminhamento === 'REVISAR').length;
      const indeterminado = encaminhamentos.filter(a => a.encaminhamento === 'INDETERMINADO').length;
      const resumoEncaminhamentos = { total: detalhes.length, preservar, revisar, indeterminado, sem_encaminhamento: detalhes.length - preservar - revisar - indeterminado };
      const registro = await tx.decisao_revisao_orgao.create({ data: { igreja_id: igreja, pessoa_id: pessoa, criado_por_id: usuario, operacao: v.operacao, resultado: v.resultado, ...(v.anotacoes_vinculos ? { anotacoes_vinculos: v.anotacoes_vinculos } : {}), proposta: { ...v.proposta, ...(v.oficial_id ? { alvo_oficial_id: v.oficial_id } : {}) } as Prisma.InputJsonObject, hash_previa: v.hash_previa, hash_requisicao: hash, impacto: { ...previa, resumo_encaminhamentos: resumoEncaminhamentos, ...(v.anotacoes_vinculos?.length ? { vinculos_anotados: detalhes.filter(d => v.anotacoes_vinculos!.some(a => a.tipo === d.tipo && a.id === d.id)), ...(v.hash_detalhes ? { hash_detalhes_anotados: v.hash_detalhes } : {}) } : {}) }, autoridade: v.autoridade, evidencia: v.evidencia, justificativa: v.justificativa, idempotencia: chave } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'decisao_revisao_orgao', registro_id: registro.id, dados_novos: { pessoa_id: pessoa, operacao: v.operacao, resultado: v.resultado, hash_previa: v.hash_previa } } });
      return { id: registro.id };
    }, Prisma.TransactionIsolationLevel.Serializable, erro => {
      if (!(erro instanceof Prisma.PrismaClientKnownRequestError) || erro.code !== 'P2002' || erro.meta?.modelName !== 'decisao_revisao_orgao') return false;
      const campos = erro.meta?.target;
      return Array.isArray(campos) && campos.length === 2 && campos.includes('igreja_id') && campos.includes('idempotencia');
    });
  }
}
