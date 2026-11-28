import type { Ator, Tx } from '../autorizacao/politica';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { permissaoMandato } from './permissao-mandato';
import { avaliarEleicaoOficial } from '../elegibilidade/eleicao-oficial';
import { camposEventoRecepcao, recepcaoDaMembresia } from '../elegibilidade/recepcao-membresia';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { avaliarExercicio } from '../oficiais/exercicio';
import { dataEleicaoDaAta, AtasEleitoraisService } from '../oficiais/atas-eleitorais.service';
import { terminoCincoAnos } from '../oficiais/mandato.service';
import { PrismaService } from '../prisma/prisma.service';
import { AtorSecretaria, dataCivil } from '../secretaria/secretaria-base.service';
import { bloquearChave, hashAto, transacaoSerializavel } from './idempotencia';

const texto = z.string().trim().min(1).max(1000);
const contexto = z.enum(['ASSEMBLEIA_GERAL', 'CONSELHO']);
const regra = z.object({ mandato_anos: z.literal(5), atos: z.object({ eleicao_integrante: contexto, posse_integrante: contexto }) });
const entrada = z.strictObject({
  pessoa_id: z.uuid(), ata_eleicao: z.uuid(), ata_posse: z.uuid(),
  // Clientes antigos ainda podem reenviar os campos de um registro já confirmado.
  trecho_eleicao: texto.optional(), trecho_posse: texto.optional(), indicacao_id: z.uuid().optional(),
  data_posse: z.iso.date().optional(),
  ordenacao: z.union([
    z.strictObject({ historica: z.literal(true), data: z.iso.date().optional(),
      autoridade: texto.max(255).optional(), evidencia: texto.optional() }),
    z.strictObject({ data: z.iso.date(), autoridade: texto, evidencia: texto.optional() }),
  ]).optional(),
  idempotencia: z.uuid(), previa: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const civil = (v: Date) => v.toISOString().slice(0, 10);

@Injectable()
export class MandatoDiretoService {
  constructor(private readonly prisma: PrismaService, private readonly atas: AtasEleitoraisService) {}

  private async orgao(tx: Tx, igreja_id: string, id: string) {
    const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id, ativo: true, tipo_padrao: { in: ['CONSELHO','JUNTA'] } } });
    if (!orgao) throw new NotFoundException('Conselho ou Junta indisponível nesta igreja.');
    return { orgao, oficio: orgao.tipo === 'JUNTA' ? 'DIACONO' as const : 'PRESBITERO_REGENTE' as const };
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
      const dataEleicao = dataEleicaoDaAta(assembleia);
      const versoes = await tx.versao_orgao.findMany({ where: { igreja_id, orgao_id }, orderBy: { inicio: 'asc' } });
      // Para transcrição anterior ao catálogo, identifica a primeira configuração usada para conferir o acervo.
      const historico = !!versoes[0] && dataEleicao < versoes[0].inicio;
      const versao = historico ? versoes[0] : versoes.find(r => r.inicio <= dataEleicao && (!r.fim || dataEleicao < r.fim));
      const regras = regra.safeParse(versao?.configuracao);
      if (!versao || !regras.success || regras.data.atos.eleicao_integrante !== 'ASSEMBLEIA_GERAL') throw new ConflictException('Configuração eleitoral indisponível para esta data.');
      const tipoPosse = regras.data.atos.posse_integrante === 'CONSELHO' ? 'CONSELHO' : 'ASSEMBLEIA';
      const instalacao = await this.atas.ata(tx, ator, acesso, tipoPosse, v.ata_posse);
      const posse = v.data_posse ? dataCivil(v.data_posse) : instalacao.data;
      const evidenciaValida = async (versaoId: string, padrao: string) => tx.documento_versao.findFirst({
        where: { id: versaoId, igreja_id, documento: { contexto: { orgao: { tipo_padrao: padrao } } } }, select: { id: true } });
      if (!await evidenciaValida(assembleia.versao_id, 'ASSEMBLEIA_GERAL') || !await evidenciaValida(instalacao.versao_id, regras.data.atos.posse_integrante))
        throw new BadRequestException('A ata deve pertencer ao órgão identificado na configuração.');
      const hash = hashAto({ ...v, orgao_id, operador: ator.sub });
      await bloquearChave(tx, igreja_id, v.idempotencia);
      const anterior = await tx.mandato_oficial.findUnique({ where: { igreja_id_chave_registro: { igreja_id, chave_registro: v.idempotencia } } });
      if (anterior) {
        if (anterior.hash_registro !== hash) throw new ConflictException('Chave já utilizada com outros dados.');
        if (!confirmar) throw new ConflictException('Este mandato já foi registrado. Consulte os períodos da ficha.');
        return { id: anterior.id, oficial_id: anterior.oficial_id };
      }
      if (v.indicacao_id) throw new BadRequestException('O registro direto de mandato usa as atas de eleição e posse. Reabra o formulário.');
      if (instalacao.data < dataEleicao) throw new BadRequestException('A ata da posse antecede a eleição.');
      if (posse < dataEleicao) throw new BadRequestException('A data da posse deve ser igual ou posterior à eleição.');
      if (posse > instalacao.data) throw new BadRequestException('A data da posse deve ser igual ou anterior à data da ata que a documenta.');
      if (orgao.data_criacao && posse < orgao.data_criacao)
        throw new BadRequestException('A data da posse antecede a instituição do órgão.');
      const referenciaEleicao = v.trecho_eleicao ?? 'Ata da eleição';
      const referenciaPosse = v.trecho_posse ?? 'Ata da posse';

      await tx.$queryRaw`SELECT id FROM pessoas WHERE igreja_id = ${igreja_id} AND id = ${v.pessoa_id} FOR UPDATE`;
      const pessoa = await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id }, select: { sexo: true, nome_completo: true, data_nascimento: true,
        eventos_membresia: { where: { data_evento: { lte: posse } }, select: camposEventoRecepcao } } });
      if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      const eventos = pessoa.eventos_membresia;
      const eleicao = eventoVigente(eventos, dataEleicao), naPosse = eventoVigente(eventos, posse);
      const recepcao = recepcaoDaMembresia(eventos, dataEleicao);
      if (pessoa.data_nascimento > dataEleicao || pessoa.sexo !== 'MASCULINO' || eleicao.situacao !== 'DEFINIDO' || eleicao.evento.rol !== 'COMUNGANTES' ||
          naPosse.situacao !== 'DEFINIDO' || naPosse.evento.rol !== 'COMUNGANTES' || !recepcao || recepcao.id !== recepcaoDaMembresia(eventos, posse)?.id)
        throw new BadRequestException('Confira a membresia e a elegibilidade na eleição e na posse.');
      const politica = await tx.politica_eleicao_oficial.findFirst({ where: { igreja_id, vigente_desde: { lte: dataEleicao },
        OR: [{ vigente_ate: null }, { vigente_ate: { gte: dataEleicao } }] } });
      if (politica?.vigente_ate && politica.vigente_ate < posse) throw new BadRequestException('A política eleitoral termina antes da posse.');
      const bissexto = politica?.aniversario_bissexto ?? 'DIA_28_FEVEREIRO';
      const termino = terminoCincoAnos(posse, bissexto);
      const avaliacao = avaliarEleicaoOficial({ dataEleicao: civil(dataEleicao), dataNascimento: civil(pessoa.data_nascimento),
        dataRecepcao: civil(recepcao.data_evento), evidenciaRecepcao: recepcao.id, capacidadeConfirmada: true, evidenciaCapacidade: referenciaEleicao },
        { idadeMinima: politica?.idade_minima ?? 18, fonte: politica?.fonte ?? versao.fonte, versao: politica?.versao ?? String(versao.numero),
          vigenteDesde: politica ? civil(politica.vigente_desde) : civil(dataEleicao), aniversarioBissexto: bissexto === 'DIA_01_MARCO' ? '01_MARCO' : '28_FEVEREIRO' });
      if (!avaliacao.requisitosAtendidos) throw new BadRequestException(avaliacao.requisitos.filter(r => !r.atendido).map(r => r.motivo));
      const mesmaEleicao = await tx.referencia_ata_oficial.findFirst({ where: { igreja_id, ato: 'ELEICAO', versao: { documento_id: assembleia.documento_id },
        mandato: { oficial: { pessoa_id: v.pessoa_id, tipo: oficio } } }, select: { id: true } });
      if (mesmaEleicao) throw new ConflictException('Esta eleição já originou um mandato para a pessoa neste ofício.');
      const periodos = await tx.mandato_oficial.findMany({ where: { igreja_id, oficial: { pessoa_id: v.pessoa_id } },
        select: { oficial_id: true, data_posse: true, termino_previsto: true, termino_efetivo: true } });
      if (periodos.some(m => m.data_posse <= termino && (m.termino_efetivo ?? m.termino_previsto) >= posse)) throw new ConflictException('A pessoa já possui mandato neste intervalo.');
      const oficial = await tx.oficial.findFirst({ where: { igreja_id, pessoa_id: v.pessoa_id, tipo: oficio }, include: { eventos: true } });
      const fatos = oficial?.eventos ?? [];
      const ordenado = fatos.find(e => e.tipo === 'ORDENACAO' && e.data_efeito <= posse);
      const declaracao = v.ordenacao && 'historica' in v.ordenacao ? v.ordenacao : undefined;
      const dataDeclarada = declaracao?.data ? dataCivil(declaracao.data) : null;
      let novoEvento: { data_efeito: Date; ordem: number; autoridade: string; evidencia: string; observacoes: string | null } | undefined;
      if (v.ordenacao) {
        if (fatos.some(e => e.tipo === 'ORDENACAO'))
          throw new BadRequestException('Já existe uma ordenação registrada para este ofício. Confira o prontuário.');
        const data = v.ordenacao.data ? dataCivil(v.ordenacao.data) : posse;
        if (!(data >= pessoa.data_nascimento && data <= posse && data <= acesso.hoje))
          throw new BadRequestException('A data da ordenação deve estar entre o nascimento e a posse.');
        if (!declaracao && (fatos.length || periodos.some(m => m.oficial_id === oficial?.id)))
          throw new BadRequestException('Confira a ordenação existente ou use a revisão do prontuário para inserção retroativa.');
        const ordem = fatos.reduce((ultima, evento) => +evento.data_efeito === +data ? Math.max(evento.ordem, ultima) : ultima, 0) + 1;
        novoEvento = { data_efeito: data, ordem, autoridade: v.ordenacao.autoridade ?? 'Não informada',
          evidencia: declaracao ? 'Ordenação histórica declarada sem documento apresentado.' : v.ordenacao.evidencia ?? 'Referência documental não informada.',
          observacoes: declaracao && !dataDeclarada ? 'Data da ordenação desconhecida. Reconhecimento a partir da posse.' : null };
      }
      if (!ordenado && !novoEvento)
        throw new BadRequestException('Selecione como registrar a ordenação. Para uma ordenação antiga sem documento disponível, use Registro de ordenação histórico não documentado.');
      const eventosPosse = novoEvento
        ? [...fatos, { id: 'previa', tipo: 'ORDENACAO' as const, evento_restaurado_id: null, ...novoEvento }]
        : fatos;
      if (!avaliarExercicio({ data_posse: posse, termino_previsto: termino, termino_efetivo: null }, eventosPosse, posse).em_exercicio)
        throw new BadRequestException('O exercício do ofício não está comprovado na posse. Consulte o prontuário.');
      const resultado = { nome: pessoa.nome_completo, oficio, data_eleicao: civil(dataEleicao), data_posse: civil(posse),
        termino_previsto: civil(termino), reeleicao: periodos.some(m => m.oficial_id === oficial?.id && m.data_posse < posse),
        versao_orgao_id: versao.id, versao: versao.numero, transcricao_historica: historico,
        ...(declaracao && { ordenacao_historica: true }) };
      const revisao = hashAto({ hash, ...resultado, ordenacao: ordenado?.id, rol_eleicao: eleicao.evento.id,
        rol_posse: naPosse.evento.id, politica: politica?.id, avaliacao, ...(declaracao && { ordem_ordenacao: novoEvento!.ordem }) });
      if (!confirmar) return { ...resultado, previa: revisao };
      if (previa !== revisao) throw new ConflictException('Os dados mudaram. Confira uma nova prévia.');
      const outroAtivo = await tx.oficial.findFirst({ where: { igreja_id, pessoa_id: v.pessoa_id, ativo: true } });
      const titular = oficial ?? await tx.oficial.create({ data: { igreja_id, pessoa_id: v.pessoa_id, tipo: oficio, ativo: !outroAtivo } });
      const registroHistorico = declaracao && await tx.registro_historico_oficial.create({
        data: { igreja_id, oficial_id: titular.id, tipo: 'ORDENACAO', data_evento: dataDeclarada,
          autoridade: declaracao.autoridade, referencia_externa: declaracao.evidencia, situacao_documental: 'PENDENTE',
          idempotencia: randomUUID(), criado_por_id: ator.sub },
        select: { id: true },
      });
      const ordenacao = ordenado ?? await tx.evento_oficial.create({ data: { igreja_id, oficial_id: titular.id, tipo: 'ORDENACAO',
        ...novoEvento! } });
      const vinculoHistorico = registroHistorico ? { ordenacao_historica_id: registroHistorico.id } : {};
      const mandato = await tx.mandato_oficial.create({ data: { igreja_id, orgao_id, oficial_id: titular.id,
        versao_orgao_id: versao.id, chave_registro: v.idempotencia, hash_registro: hash, data_eleicao: dataEleicao,
        data_posse: posse, termino_previsto: termino, autoridade: 'Assembleia Geral', evidencia: 'Referências versionadas da eleição e da posse.',
        avaliacao_eleicao: { ...resultado, avaliacao, ata_eleicao: assembleia.versao_id, ata_posse: instalacao.versao_id, operador_id: ator.sub, atribuicao_id: permissao.atribuicao, origem_autorizacao: permissao.origem, ordenacao_id: ordenacao.id,
          rol_eleicao_evento_id: eleicao.evento.id, rol_posse_evento_id: naPosse.evento.id, ...vinculoHistorico } } });
      await tx.referencia_ata_oficial.createMany({ data: [
        { ato: 'ELEICAO', ata_documento_id: assembleia.documento_id, versao_id: assembleia.versao_id, justificativa: referenciaEleicao },
        { ato: 'POSSE', ata_documento_id: instalacao.documento_id, versao_id: instalacao.versao_id, justificativa: referenciaPosse },
      ].map(r => ({ ...r, igreja_id, mandato_id: mandato.id, sequencia: 1, registrado_por_id: ator.sub })) });
      await tx.evento_autorizacao.create({ data: { igreja_id, operador_id: ator.sub, operador_pessoa_id: permissao.pessoa, pessoa_id: v.pessoa_id,
        acao: 'MANDATO_REGISTRADO', recurso_id: mandato.id, fundamento: 'Eleição e posse documentadas',
        dados: { orgao_id, atribuicao_id: permissao.atribuicao, origem_autorizacao: permissao.origem, ordenacao_id: ordenacao.id, ...vinculoHistorico } } });
      return { id: mandato.id, oficial_id: titular.id };
    });
  }
}
