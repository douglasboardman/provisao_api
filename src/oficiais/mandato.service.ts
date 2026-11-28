import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { estadoDaLiberacao, exigirOperacaoDisponivel, exigirRotaLegada } from '../autorizacao/liberacao-servico';
import type { Ator } from '../autorizacao/politica';
import { permissaoMandato } from '../orgaos/permissao-mandato';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, membresia_rol, pessoas_sexo, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { avaliarEleicaoOficial } from '../elegibilidade/eleicao-oficial';
import { camposEventoRecepcao, recepcaoDaMembresia } from '../elegibilidade/recepcao-membresia';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { avaliarExercicio } from './exercicio';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { tabelasDocumentais } from '../secretaria/selecao-documental';
import { contextosDasAtasRestritas } from '../secretaria/visibilidade-documentos';

const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const schema = z.object({ conferencia_id: z.string().uuid(), data_posse: dia, autoridade: z.string().trim().min(1).max(1000), evidencia: z.string().trim().min(1).max(1000), evidencia_capacidade_posse: z.string().trim().min(1).max(1000) }).strict();
const excecaoSchema = z.object({ oficialTransferido: z.boolean(), autoridade: z.string().trim().min(1), evidencia: z.string().trim().min(1) }).strict();
const recepcaoRegistradaSchema = z.object({ evento_recepcao_id: z.string() });
const fimMandato = z.object({ data_efeito: dia, motivo: z.string().trim().min(1).max(1000) });
const encerramentoSchema = z.union([
  fimMandato.extend({ ata_encerramento: z.uuid() }).strict(),
  fimMandato.extend({ autoridade: z.string().trim().min(1).max(1000), evidencia: z.string().trim().min(1).max(1000) }).strict(),
]);
type AtaEncerramento = { documento_id: string; versao_id: string; autoridade: string };
type Entrada = z.infer<typeof schema>;
type Encerramento = z.infer<typeof encerramentoSchema>;
const data = (s: string) => new Date(`${s}T00:00:00.000Z`);
const civil = (d: Date) => d.toISOString().slice(0, 10);
export function terminoCincoAnos(inicio: Date, marco: 'DIA_28_FEVEREIRO' | 'DIA_01_MARCO') {
  const ano = inicio.getUTCFullYear() + 5, mes = inicio.getUTCMonth(), diaMes = inicio.getUTCDate();
  const fimMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  const limite = diaMes > fimMes && marco === 'DIA_01_MARCO' ? new Date(Date.UTC(ano, mes + 1, 1)) : new Date(Date.UTC(ano, mes, Math.min(diaMes, fimMes)));
  limite.setUTCDate(limite.getUTCDate() - 1);
  return limite;
}

/** Registro documental de eleição e posse; não representa deliberação nem votação pelo sistema. */
@Injectable()
export class MandatoService {
  constructor(private readonly prisma: PrismaService) {}

  async encerrar(igrejaId: string, usuarioId: string, mandatoId: string, dados: Encerramento, ator?: Ator) {
    const parsed = encerramentoSchema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados de encerramento inválidos.');
    const v = parsed.data, efeito = data(v.data_efeito);
    return this.prisma.$transaction(async tx => {
      const estado = await estadoDaLiberacao(tx, igrejaId, 'MANDATOS_REGISTRAR', true);
      exigirOperacaoDisponivel(estado);
      const operador = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true,
        perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.COMUM] } },
        select: { perfil: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado nesta igreja.');
      // Serializa o encerramento com prévias e inclusões de eventos do oficial.
      await tx.$queryRaw`SELECT o.id FROM oficial o JOIN mandato_oficial m ON m.oficial_id = o.id AND m.igreja_id = o.igreja_id WHERE m.id = ${mandatoId} AND m.igreja_id = ${igrejaId} FOR UPDATE OF o`;
      const mandatos = await tx.$queryRaw<Array<{ id: string; orgao_id: string | null; pessoa_id: string; data_posse: Date; termino_previsto: Date; termino_efetivo: Date | null }>>`
        SELECT m.id, m.orgao_id, o.pessoa_id, m.data_posse, m.termino_previsto, m.termino_efetivo FROM mandato_oficial m JOIN oficial o ON o.id=m.oficial_id AND o.igreja_id=m.igreja_id WHERE m.id = ${mandatoId} AND m.igreja_id = ${igrejaId} FOR UPDATE OF m`;
      const atual = mandatos[0];
      if (!atual) throw new NotFoundException('Mandato não encontrado nesta igreja.');
      let poder: Awaited<ReturnType<typeof permissaoMandato>> = null;
      if (atual.orgao_id || estado === 'ATRIBUICAO' || operador.perfil === usuarios_perfil.COMUM) {
        poder = ator && ator.igreja_id === igrejaId && ator.sub === usuarioId ? await permissaoMandato(tx, ator) : null;
        if (!poder || poder.pessoa === atual.pessoa_id) throw new ForbiddenException('O encerramento exige serviço vigente e operador distinto do titular.');
      }
      if (atual.termino_efetivo || efeito < atual.data_posse || efeito > atual.termino_previsto)
        throw new BadRequestException('Mandato já encerrado ou data de encerramento inválida.');

      const secretariaAtiva = recursoDaIgreja('secretaria', igrejaId);
      let ata: AtaEncerramento | undefined;
      let autoridade: string, evidencia: string;
      if ('ata_encerramento' in v) {
        if (!secretariaAtiva) throw new NotFoundException('Secretaria indisponível.');
        const restritos = await contextosDasAtasRestritas(tx, igrejaId, usuarioId);
        const hoje = await hojeDaIgreja(tx, igrejaId);
        [ata] = await tx.$queryRaw<AtaEncerramento[]>`
          SELECT d.id AS documento_id, v.id AS versao_id, o.nome AS autoridade
          ${tabelasDocumentais}
          JOIN orgao_interno o ON o.id = c.orgao_id AND o.igreja_id = c.igreja_id
          WHERE d.igreja_id = ${igrejaId} AND v.id = ${v.ata_encerramento} AND o.tipo = 'CONSELHO'
            AND d.tipo = 'ATA' AND v.numero = d.versao_atual AND d.estado IN ('APROVADO','EXPEDIDO','LEGADA_CONFERIDA')
            AND v.data_documento <= ${data(hoje)}::date
            AND (NOT d.restrito ${restritos.length ? Prisma.sql`OR d.contexto_id IN (${Prisma.join(restritos)})` : Prisma.empty})
          FOR SHARE OF d, v
        `;
        if (!ata) throw new NotFoundException('Ata de encerramento indisponível.');
        autoridade = ata.autoridade;
        evidencia = 'Ata de registro do encerramento';
      } else {
        if (secretariaAtiva) throw new BadRequestException('Selecione a ata que registra o encerramento.');
        ({ autoridade, evidencia } = v);
      }

      const referencia = ata ? { ata_versao_id: ata.versao_id } : {};
      if (poder) await tx.evento_autorizacao.create({ data: { igreja_id: igrejaId, operador_id: usuarioId, operador_pessoa_id: poder.pessoa,
        pessoa_id: atual.pessoa_id, acao: 'MANDATO_ENCERRADO', recurso_id: mandatoId, fundamento: autoridade,
        dados: { orgao_id: atual.orgao_id, atribuicao_id: poder.atribuicao, origem_autorizacao: poder.origem, data_efeito: v.data_efeito, ...referencia } } });
      const encerrado = await tx.mandato_oficial.update({ where: { id: mandatoId }, data: { termino_efetivo: efeito, motivo_encerramento: v.motivo } });
      if (ata) await tx.referencia_ata_oficial.create({ data: { igreja_id: igrejaId, mandato_id: mandatoId, ato: 'ENCERRAMENTO',
        ata_documento_id: ata.documento_id, versao_id: ata.versao_id, justificativa: evidencia, sequencia: 1, registrado_por_id: usuarioId } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'mandato_oficial', registro_id: mandatoId,
        dados_antigos: { termino_efetivo: null, motivo_encerramento: null }, dados_novos: { termino_efetivo: v.data_efeito, motivo_encerramento: v.motivo, autoridade, evidencia, ...referencia } } });
      return encerrado;
    });
  }

  async registrar(igrejaId: string, usuarioId: string, oficialId: string, dados: Entrada) {
    const parsed = schema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados do mandato inválidos.');
    const v = parsed.data, posse = data(v.data_posse);
    return this.prisma.$transaction(async tx => {
      exigirRotaLegada(await estadoDaLiberacao(tx, igrejaId, 'MANDATOS_REGISTRAR', true));
      const operador = await exigirServicoDoUsuario(tx, igrejaId, usuarioId, 'MANDATOS_REGISTRAR');
      if (!operador) throw new ForbiddenException('Operador não autorizado nesta igreja.');
      // A mesma linha é bloqueada pelo trigger de alterações de membresia.
      const oficiais = await tx.$queryRaw<Array<{ id: string; pessoa_id: string; tipo: string; data_nascimento: Date; sexo: pessoas_sexo }>>`
        SELECT o.id, o.pessoa_id, o.tipo, p.data_nascimento, p.sexo FROM oficial o
        JOIN pessoas p ON p.id = o.pessoa_id AND p.igreja_id = o.igreja_id
        WHERE o.id = ${oficialId} AND o.igreja_id = ${igrejaId} FOR UPDATE OF o, p`;
      const oficial = oficiais[0];
      if (!oficial) throw new NotFoundException('Oficial não encontrado nesta igreja.');
      if (oficial.tipo === 'PRESBITERO_DOCENTE') throw new BadRequestException('Docente segue vínculo pastoral próprio.');
      if (oficial.sexo !== 'MASCULINO') throw new BadRequestException('O registro de mandato exige pessoa do sexo masculino.');
      await tx.$queryRaw`SELECT id FROM conferencia_eleicao_oficial WHERE id = ${v.conferencia_id} AND igreja_id = ${igrejaId} FOR SHARE`;
      const conferencia = await tx.conferencia_eleicao_oficial.findFirst({ where: { id: v.conferencia_id, igreja_id: igrejaId, pessoa_id: oficial.pessoa_id }, include: { politica: true } });
      if (!conferencia) throw new NotFoundException('Conferência não encontrada para esta pessoa e igreja.');
      if (await tx.revisao_eleitoral_item.findFirst({ where: { igreja_id: igrejaId, conferencia_id: conferencia.id, OR: [{ revisado_em: null }, { permite_reutilizacao: false }] }, select: { id: true } })) throw new BadRequestException('Conferência sinalizada para revisão institucional não pode ser usada em novo mandato.');
      await tx.$queryRaw`SELECT id FROM politica_eleicao_oficial WHERE id = ${conferencia.politica_id} AND igreja_id = ${igrejaId} FOR SHARE`;
      // Releitura após obter o bloqueio evita usar uma política alterada enquanto aguardava.
      const politicaAtual = await tx.politica_eleicao_oficial.findFirst({ where: { id: conferencia.politica_id, igreja_id: igrejaId } });
      if (!politicaAtual) throw new NotFoundException('Política normativa não encontrada.');
      const eleicao = conferencia.data_eleicao, politica = politicaAtual;
      if (posse < eleicao || politica.vigente_desde > eleicao || (politica.vigente_ate && politica.vigente_ate < posse)) throw new BadRequestException('Datas incompatíveis com eleição ou política.');
      const [eventosMembresia, eventosOficiais] = await Promise.all([
        tx.eventos_membresia.findMany({ where: { igreja_id: igrejaId, pessoa_id: oficial.pessoa_id, data_evento: { lte: posse } }, select: camposEventoRecepcao }),
        tx.evento_oficial.findMany({ where: { igreja_id: igrejaId, oficial_id: oficialId }, orderBy: [{ data_efeito: 'asc' }, { ordem: 'asc' }] }),
      ]);
      const conferirRol = (referencia: Date) => {
        const vigente = eventoVigente(eventosMembresia, referencia);
        if (vigente.situacao !== 'DEFINIDO' || vigente.evento.rol !== membresia_rol.COMUNGANTES) throw new BadRequestException('Membresia comungante não comprovada ou ordem de eventos ambígua.');
        return vigente.evento.id;
      };
      const rolEleicao = conferirRol(eleicao);
      const rolPosse = conferirRol(posse);
      const recepcaoRegistrada = recepcaoRegistradaSchema.safeParse(conferencia.resultado);
      if (recepcaoRegistrada.success) {
        const recepcaoEleicao = recepcaoDaMembresia(eventosMembresia, eleicao);
        if (recepcaoEleicao?.id !== recepcaoRegistrada.data.evento_recepcao_id || civil(recepcaoEleicao.data_evento) !== civil(conferencia.data_recepcao)) {
          throw new BadRequestException('O registro de recepção mudou desde a conferência. Faça uma nova conferência eleitoral.');
        }
        const recepcaoPosse = recepcaoDaMembresia(eventosMembresia, posse);
        if (recepcaoPosse?.id !== recepcaoEleicao.id) {
          throw new BadRequestException('A membresia vigente na posse não corresponde ao vínculo conferido na eleição.');
        }
      }
      const excecao = conferencia.excecao_transferencia === null ? undefined : excecaoSchema.safeParse(conferencia.excecao_transferencia);
      if (excecao && !excecao.success) throw new BadRequestException('Exceção de transferência inválida.');
      const norma = { idadeMinima: politica.idade_minima, fonte: politica.fonte, versao: politica.versao, vigenteDesde: civil(politica.vigente_desde), aniversarioBissexto: politica.aniversario_bissexto === 'DIA_28_FEVEREIRO' ? '28_FEVEREIRO' as const : '01_MARCO' as const };
      const base = { dataRecepcao: civil(conferencia.data_recepcao), evidenciaRecepcao: conferencia.evidencia_recepcao, dataNascimento: civil(oficial.data_nascimento), capacidadeConfirmada: conferencia.capacidade_confirmada, evidenciaCapacidade: conferencia.evidencia_capacidade, excecaoTransferencia: excecao?.success ? excecao.data : undefined };
      let avaliacaoEleicao: ReturnType<typeof avaliarEleicaoOficial>, avaliacaoPosse: ReturnType<typeof avaliarEleicaoOficial>;
      try {
        avaliacaoEleicao = avaliarEleicaoOficial({ ...base, dataEleicao: civil(eleicao) }, norma);
        avaliacaoPosse = avaliarEleicaoOficial({ ...base, dataEleicao: v.data_posse, capacidadeConfirmada: true, evidenciaCapacidade: v.evidencia_capacidade_posse }, norma);
      } catch { throw new BadRequestException('Dados históricos inconsistentes com a eleição ou posse.'); }
      if (!avaliacaoEleicao.requisitosAtendidos || !avaliacaoPosse.requisitosAtendidos) throw new BadRequestException('Requisitos eleitorais ou da posse não atendidos.');
      const termino = terminoCincoAnos(posse, politica.aniversario_bissexto);
      const exercicio = avaliarExercicio({ data_posse: posse, termino_previsto: termino, termino_efetivo: null }, eventosOficiais, posse);
      if (!exercicio.em_exercicio) throw new BadRequestException(`Ofício não está apto à posse: ${exercicio.motivo}.`);
      const avaliacao = { eleicao: avaliacaoEleicao, posse: avaliacaoPosse, rol_eleicao_evento_id: rolEleicao, rol_posse_evento_id: rolPosse, conferencia_id: conferencia.id, evidencia_capacidade_posse: v.evidencia_capacidade_posse };
      const mandato = await tx.mandato_oficial.create({ data: { igreja_id: igrejaId, oficial_id: oficialId, conferencia_id: conferencia.id, data_eleicao: eleicao, data_posse: posse, termino_previsto: termino, autoridade: v.autoridade, evidencia: v.evidencia, avaliacao_eleicao: avaliacao } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'mandato_oficial', registro_id: mandato.id, dados_novos: { oficial_id: oficialId, conferencia_id: conferencia.id, data_eleicao: civil(eleicao), data_posse: v.data_posse, termino_previsto: civil(termino) } } });
      return mandato;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
