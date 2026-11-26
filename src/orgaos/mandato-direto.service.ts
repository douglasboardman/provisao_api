import type { Ator, Tx } from '../autorizacao/politica';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { permissaoMandato } from './permissao-mandato';
import { avaliarEleicaoOficial } from '../elegibilidade/eleicao-oficial';
import { camposEventoRecepcao, recepcaoDaMembresia } from '../elegibilidade/recepcao-membresia';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { avaliarExercicio } from '../oficiais/exercicio';
import { IndicacoesEleicaoService } from '../oficiais/indicacoes-eleicao.service';
import { terminoCincoAnos } from '../oficiais/mandato.service';
import { PrismaService } from '../prisma/prisma.service';
import { AtorSecretaria, dataCivil } from '../secretaria/secretaria-base.service';
import { bloquearChave, hashAto, transacaoSerializavel } from './idempotencia';

const texto = z.string().trim().min(1).max(1000);
const contexto = z.enum(['ASSEMBLEIA_GERAL', 'CONSELHO']);
const regra = z.object({ mandato_anos: z.literal(5), atos: z.object({ eleicao_integrante: contexto, posse_integrante: contexto }) });
const entrada = z.strictObject({
  pessoa_id: z.uuid(), ata_eleicao: z.uuid(), trecho_eleicao: texto, ata_posse: z.uuid(), trecho_posse: texto,
  indicacao_id: z.uuid().optional(),
  data_posse: z.iso.date(), ordenacao: z.strictObject({ data: z.iso.date(), autoridade: texto, evidencia: texto }).optional(),
  idempotencia: z.uuid(), previa: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const civil = (v: Date) => v.toISOString().slice(0, 10);

@Injectable()
export class MandatoDiretoService {
  constructor(private readonly prisma: PrismaService, private readonly atas: IndicacoesEleicaoService) {}

  private async orgao(tx: Tx, igreja_id: string, id: string) {
    const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id, ativo: true, tipo_padrao: { in: ['CONSELHO','JUNTA'] } } });
    if (!orgao) throw new NotFoundException('Conselho ou Junta indisponível nesta igreja.');
    return { orgao, oficio: orgao.tipo === 'JUNTA' ? 'DIACONO' as const : 'PRESBITERO_REGENTE' as const };
  }

  indicacoes(ator: AtorSecretaria & Ator, orgaoId: string, pessoa: string, ata: string) {
    return this.prisma.$transaction(async tx => {
      if (!await permissaoMandato(tx, ator)) throw new ForbiddenException('A consulta de indicações exige permissão para registrar mandatos.');
      const { oficio } = await this.orgao(tx, ator.igreja_id, orgaoId);
      const acesso = await this.atas.acesso(tx, ator);
      const eleicao = await this.atas.ata(tx, ator, acesso, 'ASSEMBLEIA', ata);
      return this.atas.indicacoesDoMandato(tx, ator, acesso, pessoa, oficio, eleicao.data);
    });
  }

  executar(ator: AtorSecretaria & Ator, orgao_id: string, dados: unknown, confirmar: boolean) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success || (confirmar && !parsed.data.previa)) throw new BadRequestException('Confira a pessoa, as atas, a posse e a prévia.');
    const { previa, ...v } = parsed.data;
    const igreja_id = ator.igreja_id;
    return transacaoSerializavel(this.prisma, async tx => {
      const permissao = await permissaoMandato(tx, ator, confirmar);
      if (!permissao) throw new ForbiddenException('A conta precisa de permissão para registrar mandatos.');
      if (permissao.pessoa === v.pessoa_id && !permissao.podeRegistrarParaSi)
        throw new ForbiddenException('O mandato deve ser registrado por outro operador autorizado.');
      const acesso = await this.atas.acesso(tx, ator);
      const { orgao, oficio } = await this.orgao(tx, igreja_id, orgao_id);
      const assembleia = await this.atas.ata(tx, ator, acesso, 'ASSEMBLEIA', v.ata_eleicao);
      const posse = dataCivil(v.data_posse);
      if (posse < assembleia.data || (orgao.data_criacao && posse < orgao.data_criacao)) throw new BadRequestException('A posse deve respeitar a eleição e a instituição do órgão.');
      const versoes = await tx.versao_orgao.findMany({ where: { igreja_id, orgao_id }, orderBy: { inicio: 'asc' } });
      // Para transcrição anterior ao catálogo, identifica a primeira configuração usada para conferir o acervo.
      const historico = !!versoes[0] && assembleia.data < versoes[0].inicio;
      const versao = historico ? versoes[0] : versoes.find(r => r.inicio <= assembleia.data && (!r.fim || assembleia.data < r.fim));
      const regras = regra.safeParse(versao?.configuracao);
      if (!versao || !regras.success || regras.data.atos.eleicao_integrante !== 'ASSEMBLEIA_GERAL') throw new ConflictException('Configuração eleitoral indisponível para esta data.');
      const tipoPosse = regras.data.atos.posse_integrante === 'CONSELHO' ? 'CONSELHO' : 'ASSEMBLEIA';
      const instalacao = await this.atas.ata(tx, ator, acesso, tipoPosse, v.ata_posse);
      const evidenciaValida = async (versaoId: string, padrao: string) => tx.documento_versao.findFirst({
        where: { id: versaoId, igreja_id, documento: { contexto: { orgao: { tipo_padrao: padrao } } } }, select: { id: true } });
      if (!await evidenciaValida(assembleia.versao_id, 'ASSEMBLEIA_GERAL') || !await evidenciaValida(instalacao.versao_id, regras.data.atos.posse_integrante))
        throw new BadRequestException('A ata deve pertencer ao órgão identificado na configuração.');
      if (instalacao.data < assembleia.data) throw new BadRequestException('A ata da posse antecede a eleição.');
      const hash = hashAto({ ...v, orgao_id, operador: ator.sub });
      await bloquearChave(tx, igreja_id, v.idempotencia);
      const anterior = await tx.mandato_oficial.findUnique({ where: { igreja_id_chave_registro: { igreja_id, chave_registro: v.idempotencia } } });
      if (anterior) {
        if (anterior.hash_registro !== hash) throw new ConflictException('Chave já utilizada com outros dados.');
        if (!confirmar) throw new ConflictException('Este mandato já foi registrado. Consulte os períodos da ficha.');
        return { id: anterior.id, oficial_id: anterior.oficial_id };
      }
      const indicacao = v.indicacao_id
        ? await this.atas.antecedenteDoMandato(tx, ator, acesso, v.indicacao_id, v.pessoa_id, oficio, assembleia.data)
        : undefined;

      await tx.$queryRaw`SELECT id FROM pessoas WHERE igreja_id = ${igreja_id} AND id = ${v.pessoa_id} FOR UPDATE`;
      const pessoa = await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id }, select: { sexo: true, nome_completo: true, data_nascimento: true,
        eventos_membresia: { where: { data_evento: { lte: posse } }, select: camposEventoRecepcao } } });
      if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      const eventos = pessoa.eventos_membresia;
      const eleicao = eventoVigente(eventos, assembleia.data), naPosse = eventoVigente(eventos, posse);
      const recepcao = recepcaoDaMembresia(eventos, assembleia.data);
      if (pessoa.data_nascimento > assembleia.data || pessoa.sexo !== 'MASCULINO' || eleicao.situacao !== 'DEFINIDO' || eleicao.evento.rol !== 'COMUNGANTES' ||
          naPosse.situacao !== 'DEFINIDO' || naPosse.evento.rol !== 'COMUNGANTES' || !recepcao || recepcao.id !== recepcaoDaMembresia(eventos, posse)?.id)
        throw new BadRequestException('Confira a membresia e a elegibilidade na eleição e na posse.');
      const politica = await tx.politica_eleicao_oficial.findFirst({ where: { igreja_id, vigente_desde: { lte: assembleia.data },
        OR: [{ vigente_ate: null }, { vigente_ate: { gte: assembleia.data } }] } });
      if (politica?.vigente_ate && politica.vigente_ate < posse) throw new BadRequestException('A política eleitoral termina antes da posse.');
      const bissexto = politica?.aniversario_bissexto ?? 'DIA_28_FEVEREIRO';
      const termino = terminoCincoAnos(posse, bissexto);
      const avaliacao = avaliarEleicaoOficial({ dataEleicao: civil(assembleia.data), dataNascimento: civil(pessoa.data_nascimento),
        dataRecepcao: civil(recepcao.data_evento), evidenciaRecepcao: recepcao.id, capacidadeConfirmada: true, evidenciaCapacidade: v.trecho_eleicao },
        { idadeMinima: politica?.idade_minima ?? 18, fonte: politica?.fonte ?? versao.fonte, versao: politica?.versao ?? String(versao.numero),
          vigenteDesde: politica ? civil(politica.vigente_desde) : civil(assembleia.data), aniversarioBissexto: bissexto === 'DIA_01_MARCO' ? '01_MARCO' : '28_FEVEREIRO' });
      if (!avaliacao.requisitosAtendidos) throw new BadRequestException(avaliacao.requisitos.filter(r => !r.atendido).map(r => r.motivo));
      const mesmaEleicao = await tx.referencia_ata_oficial.findFirst({ where: { igreja_id, ato: 'ELEICAO', versao: { documento_id: assembleia.documento_id },
        mandato: { oficial: { pessoa_id: v.pessoa_id, tipo: oficio } } }, select: { id: true } });
      if (mesmaEleicao) throw new ConflictException('Esta eleição já originou um mandato para a pessoa neste ofício.');
      const periodos = await tx.mandato_oficial.findMany({ where: { igreja_id, oficial: { pessoa_id: v.pessoa_id } },
        select: { oficial_id: true, data_posse: true, termino_previsto: true, termino_efetivo: true } });
      if (periodos.some(m => m.data_posse <= termino && (m.termino_efetivo ?? m.termino_previsto) >= posse)) throw new ConflictException('A pessoa já possui mandato neste intervalo.');
      const oficial = await tx.oficial.findFirst({ where: { igreja_id, pessoa_id: v.pessoa_id, tipo: oficio }, include: { eventos: true } });
      const fatos = [...(oficial?.eventos ?? [])];
      const ordenado = fatos.find(e => e.tipo === 'ORDENACAO' && e.data_efeito <= posse);
      if (v.ordenacao) {
        const data = dataCivil(v.ordenacao.data);
        if (data > posse || data > acesso.hoje || fatos.length || periodos.some(m => m.oficial_id === oficial?.id))
          throw new BadRequestException('Confira a ordenação existente ou use a revisão do prontuário para inserção retroativa.');
        fatos.push({ id: 'previa', oficial_id: '', igreja_id, criado_em: acesso.hoje, observacoes: null, tipo: 'ORDENACAO', ordem: 1,
          data_efeito: data, evento_restaurado_id: null, autoridade: v.ordenacao.autoridade, evidencia: v.ordenacao.evidencia });
      }
      if (!ordenado && !v.ordenacao) throw new BadRequestException('Informe a comprovação da ordenação para a primeira investidura.');
      if (!avaliarExercicio({ data_posse: posse, termino_previsto: termino, termino_efetivo: null }, fatos, posse).em_exercicio)
        throw new BadRequestException('O exercício do ofício não está comprovado na posse. Consulte o prontuário.');
      const resultado = { nome: pessoa.nome_completo, oficio, data_eleicao: civil(assembleia.data), data_posse: v.data_posse,
        termino_previsto: civil(termino), reeleicao: periodos.some(m => m.oficial_id === oficial?.id && m.data_posse < posse),
        versao_orgao_id: versao.id, versao: versao.numero, transcricao_historica: historico,
        ...(indicacao && { indicacao_id: indicacao.id, assunto_indicacao: indicacao.ata_conselho.assunto }) };
      const revisao = hashAto({ hash, ...resultado, ordenacao: ordenado?.id, rol_eleicao: eleicao.evento.id,
        rol_posse: naPosse.evento.id, politica: politica?.id, avaliacao });
      if (!confirmar) return { ...resultado, previa: revisao };
      if (previa !== revisao) throw new ConflictException('Os dados mudaram. Confira uma nova prévia.');
      const outroAtivo = await tx.oficial.findFirst({ where: { igreja_id, pessoa_id: v.pessoa_id, ativo: true } });
      const titular = oficial ?? await tx.oficial.create({ data: { igreja_id, pessoa_id: v.pessoa_id, tipo: oficio, ativo: !outroAtivo } });
      const ordenacao = ordenado ?? await tx.evento_oficial.create({ data: { igreja_id, oficial_id: titular.id, tipo: 'ORDENACAO',
        ordem: 1, data_efeito: dataCivil(v.ordenacao!.data), autoridade: v.ordenacao!.autoridade, evidencia: v.ordenacao!.evidencia } });
      const mandato = await tx.mandato_oficial.create({ data: { igreja_id, orgao_id, oficial_id: titular.id,
        versao_orgao_id: versao.id, chave_registro: v.idempotencia, hash_registro: hash, data_eleicao: assembleia.data,
        indicacao_id: indicacao?.id,
        data_posse: posse, termino_previsto: termino, autoridade: 'Assembleia Geral', evidencia: 'Referências versionadas da eleição e da posse.',
        avaliacao_eleicao: { ...resultado, avaliacao, ata_eleicao: assembleia.versao_id, ata_posse: instalacao.versao_id, operador_id: ator.sub, atribuicao_id: permissao.atribuicao, origem_autorizacao: permissao.origem, ordenacao_id: ordenacao.id,
          rol_eleicao_evento_id: eleicao.evento.id, rol_posse_evento_id: naPosse.evento.id } } });
      await tx.referencia_ata_oficial.createMany({ data: [
        { ato: 'ELEICAO', ata_documento_id: assembleia.documento_id, versao_id: assembleia.versao_id, justificativa: v.trecho_eleicao },
        { ato: 'POSSE', ata_documento_id: instalacao.documento_id, versao_id: instalacao.versao_id, justificativa: v.trecho_posse },
      ].map(r => ({ ...r, igreja_id, mandato_id: mandato.id, sequencia: 1, registrado_por_id: ator.sub })) });
      await tx.evento_autorizacao.create({ data: { igreja_id, operador_id: ator.sub, operador_pessoa_id: permissao.pessoa, pessoa_id: v.pessoa_id,
        acao: 'MANDATO_REGISTRADO', recurso_id: mandato.id, fundamento: 'Eleição e posse documentadas',
        dados: { orgao_id, atribuicao_id: permissao.atribuicao, origem_autorizacao: permissao.origem, ordenacao_id: ordenacao.id, indicacao_id: indicacao?.id ?? null } } });
      return { id: mandato.id, oficial_id: titular.id };
    });
  }
}
