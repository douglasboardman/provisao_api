import { contextosDasAtasRestritas } from '../secretaria/visibilidade-documentos';
import { estadoDaLiberacao, exigirRotaLegada } from '../autorizacao/liberacao-servico';
import { selecionarDocumentos, tabelasDocumentais } from '../secretaria/selecao-documental';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { transacaoSerializavel } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { PrismaService } from '../prisma/prisma.service';
import { SecretariaBaseService, dataCivil, type AtorSecretaria, type Tx } from '../secretaria/secretaria-base.service';
import { terminoCincoAnos } from './mandato.service';

const dia = z.iso.date();
const uuid = z.uuid();
const indicacaoSchema = z.object({
  pessoa_id: uuid,
  oficio: z.enum(['DIACONO', 'PRESBITERO_REGENTE']),
  ata_conselho_versao_id: uuid,
  data_assembleia: dia,
}).strict();
const eleicaoSchema = z.object({ indicacao_id: uuid, ata_assembleia_versao_id: uuid, data_posse: dia }).strict();
const tipoAta = z.enum(['CONSELHO', 'ASSEMBLEIA']);
type TipoAta = z.infer<typeof tipoAta>;
type Ata = { versao_id: string; documento_id: string; data: Date; assunto: string; numero: string | null };

const civil = (d: Date) => d.toISOString().slice(0, 10);
const camposMembresia = { id: true, data_evento: true, ordem_dia: true, rol: true } satisfies Prisma.eventos_membresiaSelect;
const maioridade = (nascimento: Date, referencia: Date) => {
  const aniversario = new Date(nascimento);
  aniversario.setUTCFullYear(aniversario.getUTCFullYear() + 18);
  return aniversario <= referencia;
};
function validar<T>(schema: z.ZodType<T>, dados: unknown): T {
  const resultado = schema.safeParse(dados);
  if (!resultado.success) throw new BadRequestException('Dados inválidos para o registro eleitoral.');
  return resultado.data;
}

/** Registra deliberações tomadas pelo Conselho e pela Assembleia. */
@Injectable()
export class IndicacoesEleicaoService {
  constructor(private readonly prisma: PrismaService, private readonly secretaria: SecretariaBaseService) {}

  async acesso(tx: Tx, ator: AtorSecretaria) {
    if (!recursoDaIgreja('secretaria', ator.igreja_id)) throw new NotFoundException('Secretaria indisponível para esta igreja.');
    const usuario = await this.secretaria.operador(tx, ator);
    if (usuario.perfil === 'AUDITOR') throw new ForbiddenException('Operador não autorizado.');
    const hoje = dataCivil(await hojeDaIgreja(tx, ator.igreja_id));
    return { hoje, restritos: await contextosDasAtasRestritas(tx, ator.igreja_id, ator.sub) };
  }

  private escopoAtas(igreja: string, restritos: string[], tipo: TipoAta, hoje: Date, historica = false) {
    const contexto = tipo === 'CONSELHO' ? Prisma.sql`o.tipo = 'CONSELHO'` : Prisma.sql`c.tipo = 'ASSEMBLEIA_GERAL'`;
    return Prisma.sql`
      ${tabelasDocumentais}
      LEFT JOIN orgao_interno o ON o.id = c.orgao_id AND o.igreja_id = c.igreja_id
      WHERE d.igreja_id = ${igreja} AND d.tipo = 'ATA' ${historica ? Prisma.empty : Prisma.sql`AND v.numero = d.versao_atual`}
        AND d.estado IN ('APROVADO', 'EXPEDIDO', 'LEGADA_CONFERIDA')
        AND v.data_documento <= ${hoje}::date AND ${contexto}
        AND (NOT d.restrito ${restritos.length ? Prisma.sql`OR d.contexto_id IN (${Prisma.join(restritos)})` : Prisma.empty})`;
  }

  private async atas(tx: Tx, igreja: string, restritos: string[], tipo: TipoAta, hoje: Date, filtros: { versao?: string; query?: string; historica?: boolean }) {
    const busca = filtros.query?.replace(/[\\%_]/g, '\\$&');
    const numero = busca && /^\d+$/.test(busca) ? busca.replace(/^0+/, '') : '';
    return tx.$queryRaw<Ata[]>`
      SELECT v.id AS versao_id, d.id AS documento_id, v.data_documento AS data, v.assunto,
        COALESCE(v.numero_original, v.fonte_congelada->>'numero', d.numero::text) AS numero
      ${this.escopoAtas(igreja, restritos, tipo, hoje, filtros.historica)}
        ${filtros.versao ? Prisma.sql`AND v.id = ${filtros.versao}` : Prisma.empty}
        ${busca ? Prisma.sql`AND (
          v.assunto ILIKE ${'%' + busca + '%'} OR COALESCE(v.numero_original, d.numero::text) ILIKE ${busca + '%'}
          ${numero ? Prisma.sql`OR ltrim(v.numero_original, '0') = ${numero}` : Prisma.empty}
        )` : Prisma.empty}
      ORDER BY v.data_documento DESC, d.id LIMIT 40
      ${filtros.versao ? Prisma.sql`FOR SHARE OF d, v` : Prisma.empty}
    `;
  }

  async ata(tx: Tx, ator: AtorSecretaria, acesso: { hoje: Date; restritos: string[] }, tipo: TipoAta, versao: string) {
    const [documento] = await this.atas(tx, ator.igreja_id, acesso.restritos, tipo, acesso.hoje, { versao });
    if (!documento) throw new NotFoundException('Ata indisponível ou incompatível com o ato.');
    return documento;
  }

  indicacoesDoMandato(tx: Tx, ator: AtorSecretaria, acesso: { hoje: Date; restritos: string[] },
    pessoa_id: string, oficio: 'DIACONO' | 'PRESBITERO_REGENTE', eleicao: Date) {
    return tx.indicacao_eleicao_oficial.findMany({
      where: { igreja_id: ator.igreja_id, pessoa_id, oficio, data_assembleia: eleicao, mandato: null,
        ata_conselho: { data_documento: { lte: eleicao }, documento: { tipo: 'ATA',
          estado: { in: ['APROVADO', 'EXPEDIDO', 'LEGADA_CONFERIDA'] }, contexto: { orgao: { tipo: 'CONSELHO' } },
          OR: [{ restrito: false }, { contexto_id: { in: acesso.restritos } }],
        } },
      },
      select: { id: true, ata_conselho: { select: { id: true, assunto: true, data_documento: true } } },
    });
  }

  async antecedenteDoMandato(tx: Tx, ator: AtorSecretaria, acesso: { hoje: Date; restritos: string[] },
    id: string, pessoa: string, oficio: 'DIACONO' | 'PRESBITERO_REGENTE', eleicao: Date) {
    await tx.$queryRaw`SELECT id FROM indicacao_eleicao_oficial WHERE id = ${id} AND igreja_id = ${ator.igreja_id} FOR UPDATE`;
    const resultado = (await this.indicacoesDoMandato(tx, ator, acesso, pessoa, oficio, eleicao)).find(i => i.id === id);
    if (!resultado) throw new NotFoundException('Indicação disponível para esta pessoa, ofício e eleição não encontrada.');
    const [ata] = await this.atas(tx, ator.igreja_id, acesso.restritos, 'CONSELHO', acesso.hoje,
      { versao: resultado.ata_conselho.id, historica: true });
    if (!ata) throw new NotFoundException('Ata da indicação indisponível.');
    return resultado;
  }

  selecionarAtas(ator: AtorSecretaria, tipo: string, filtros: unknown) {
    const contexto = validar(tipoAta, tipo);
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acesso(tx, ator);
      const reunioes = (await this.secretaria.concessoes(tx, ator)).filter(c => c.pode_consultar_restritos).map(c => c.contexto_id);
      return selecionarDocumentos(tx, this.escopoAtas(ator.igreja_id, acesso.restritos, contexto, acesso.hoje), filtros, false, reunioes);
    }, { isolationLevel: 'RepeatableRead' });
  }

  listarAtas(ator: AtorSecretaria, tipo: string, busca?: string) {
    const filtro = validar(tipoAta, tipo), query = validar(z.string().trim().max(100).optional(), busca);
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acesso(tx, ator);
      return this.atas(tx, ator.igreja_id, acesso.restritos, filtro, acesso.hoje, { query });
    });
  }

  candidatos(ator: AtorSecretaria, versao: string, busca?: string, tipo: string = 'CONSELHO') {
    const id = validar(uuid, versao), nome = validar(z.string().trim().max(100).optional(), busca);
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acesso(tx, ator);
      const contexto = validar(tipoAta, tipo);
      const ata = await this.ata(tx, ator, acesso, contexto, id);
      const pessoas = await tx.pessoas.findMany({
        where: { igreja_id: ator.igreja_id, sexo: 'MASCULINO',
          eventos_membresia: { some: { data_evento: { lte: ata.data }, rol: 'COMUNGANTES' } },
          ...(nome ? { nome_completo: { contains: nome, mode: 'insensitive' } } : {}),
        },
        select: { id: true, nome_completo: true, data_nascimento: true, eventos_membresia: {
          where: { data_evento: { lte: acesso.hoje } }, select: camposMembresia,
        } },
        orderBy: [{ nome_completo: 'asc' }, { id: 'asc' }],
      });
      return pessoas.filter(p => {
        const vigente = eventoVigente(p.eventos_membresia, ata.data);
        const atual = eventoVigente(p.eventos_membresia, acesso.hoje);
        return maioridade(p.data_nascimento, ata.data) && vigente.situacao === 'DEFINIDO' && vigente.evento.rol === 'COMUNGANTES'
          && (contexto === 'ASSEMBLEIA' || (atual.situacao === 'DEFINIDO' && atual.evento.rol === 'COMUNGANTES'));
      }).slice(0, 50).map(({ id, nome_completo }) => ({ id, nome_completo }));
    });
  }

  async listar(ator: AtorSecretaria, versao?: string) {
    const id = validar(uuid.optional(), versao);
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acesso(tx, ator);
      const assembleia = id ? await this.ata(tx, ator, acesso, 'ASSEMBLEIA', id) : undefined;
      return tx.indicacao_eleicao_oficial.findMany({
        where: { igreja_id: ator.igreja_id, mandato: null,
          data_assembleia: assembleia?.data ?? { gte: acesso.hoje },
          ata_conselho: { documento: {
            estado: { in: ['APROVADO', 'EXPEDIDO', 'LEGADA_CONFERIDA'] },
            OR: [{ restrito: false }, { contexto_id: { in: acesso.restritos } }],
          } },
        },
        select: { id: true, oficio: true, data_assembleia: true, pessoa: { select: { nome_completo: true } } },
        orderBy: [{ data_assembleia: 'asc' }, { pessoa: { nome_completo: 'asc' } }, { id: 'asc' }],
      });
    });
  }

  historico(ator: AtorSecretaria, id?: string, cursor?: string) {
    if (cursor) validar(uuid, cursor);
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acesso(tx, ator);
      const igreja_id = ator.igreja_id;
      const oficial = id ? await tx.oficial.findFirst({ where: { id, igreja_id } }) : null;
      if (id && !oficial) throw new NotFoundException('Ofício indisponível.');
      const where = { igreja_id, ...(oficial && { pessoa_id: oficial.pessoa_id, oficio: oficial.tipo }),
        ata_conselho: { documento: { OR: [{ restrito: false }, { contexto_id: { in: acesso.restritos } }] } } };
      if (cursor && !await tx.indicacao_eleicao_oficial.findFirst({ where: { ...where, id: cursor }, select: { id: true } })) throw new BadRequestException('Cursor inválido.');
      const rows = await tx.indicacao_eleicao_oficial.findMany({ where,
        select: { id: true, data_assembleia: true, oficio: true, pessoa: { select: { nome_completo: true } },
          mandato: { select: { id: true } }, ata_conselho: { select: { id: true, contexto_id: true, documento_id: true } } },
        orderBy: [{ data_assembleia: 'desc' }, { id: 'asc' }], take: 31, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      return { itens: rows.slice(0,30), proximo_cursor: rows.length > 30 ? rows[29].id : null };
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async membro(tx: Tx, igreja: string, pessoa: string, referencia: Date) {
    await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${pessoa} AND igreja_id = ${igreja} FOR UPDATE`;
    const cadastro = await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: {
      sexo: true, data_nascimento: true, eventos_membresia: { where: { data_evento: { lte: referencia } }, select: camposMembresia },
    } });
    if (!cadastro) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
    const vigente = eventoVigente(cadastro.eventos_membresia, referencia);
    if (cadastro.sexo !== 'MASCULINO' || !maioridade(cadastro.data_nascimento, referencia) ||
        vigente.situacao !== 'DEFINIDO' || vigente.evento.rol !== 'COMUNGANTES') {
      throw new BadRequestException('O registro exige membro comungante do sexo masculino com 18 anos completos na data do ato.');
    }
    return vigente.evento.id;
  }

  registrar(ator: AtorSecretaria, dados: unknown) {
    const v = validar(indicacaoSchema, dados);
    return transacaoSerializavel(this.prisma, async tx => {
      const igreja = ator.igreja_id, acesso = await this.acesso(tx, ator);
      const conselho = await this.ata(tx, ator, acesso, 'CONSELHO', v.ata_conselho_versao_id);
      const assembleia = dataCivil(v.data_assembleia);
      if (assembleia < conselho.data) throw new BadRequestException('A assembleia deve ocorrer na data da indicação ou depois.');
      await this.membro(tx, igreja, v.pessoa_id, conselho.data);
      if (conselho.data.getTime() !== acesso.hoje.getTime()) await this.membro(tx, igreja, v.pessoa_id, acesso.hoje);
      const indicacao = await tx.indicacao_eleicao_oficial.create({
        data: { ...v, data_assembleia: assembleia, igreja_id: igreja, registrado_por_id: ator.sub },
        select: { id: true },
      });
      await this.auditar(tx, ator, 'indicacao_eleicao_oficial', indicacao.id, v);
      return indicacao;
    });
  }

  registrarMandato(ator: AtorSecretaria, dados: unknown) {
    const v = validar(eleicaoSchema, dados);
    return transacaoSerializavel(this.prisma, async tx => {
      exigirRotaLegada(await estadoDaLiberacao(tx, ator.igreja_id, 'MANDATOS_REGISTRAR', true));
      const igreja = ator.igreja_id, acesso = await this.acesso(tx, ator);
      const assembleia = await this.ata(tx, ator, acesso, 'ASSEMBLEIA', v.ata_assembleia_versao_id);
      await tx.$queryRaw`SELECT id FROM indicacao_eleicao_oficial WHERE id = ${v.indicacao_id} AND igreja_id = ${igreja} FOR UPDATE`;
      const indicacao = await tx.indicacao_eleicao_oficial.findFirst({
        where: { id: v.indicacao_id, igreja_id: igreja }, include: { mandato: { select: { id: true } } },
      });
      if (!indicacao) throw new NotFoundException('Indicação não encontrada nesta igreja.');
      const conselho = await this.ata(tx, ator, acesso, 'CONSELHO', indicacao.ata_conselho_versao_id);
      if (indicacao.mandato) throw new ConflictException('Esta indicação já foi usada.');
      if (assembleia.data.getTime() !== indicacao.data_assembleia.getTime() || assembleia.data < conselho.data) {
        throw new BadRequestException('A ata deve corresponder à assembleia para a qual o Conselho indicou o candidato.');
      }
      const posse = dataCivil(v.data_posse);
      if (posse < assembleia.data) throw new BadRequestException('A posse deve ocorrer na data da eleição ou depois.');
      const politica = await tx.politica_eleicao_oficial.findFirst({
        where: { igreja_id: igreja, vigente_desde: { lte: assembleia.data }, OR: [{ vigente_ate: null }, { vigente_ate: { gte: assembleia.data } }] },
        select: { aniversario_bissexto: true },
      });
      const termino = terminoCincoAnos(posse, politica?.aniversario_bissexto ?? 'DIA_28_FEVEREIRO');
      await this.membro(tx, igreja, indicacao.pessoa_id, conselho.data);
      const evento = await this.membro(tx, igreja, indicacao.pessoa_id, assembleia.data);
      const eventoPosse = await this.membro(tx, igreja, indicacao.pessoa_id, posse);
      if (await tx.mandato_oficial.findFirst({ where: {
        igreja_id: igreja, oficial: { pessoa_id: indicacao.pessoa_id },
        data_posse: { lte: termino }, OR: [{ termino_efetivo: { gte: posse } }, { termino_efetivo: null, termino_previsto: { gte: posse } }],
      }, select: { id: true } })) throw new ConflictException('Já existe um mandato dessa pessoa no período da posse.');
      const anterior = await tx.oficial.findFirst({
        where: { igreja_id: igreja, pessoa_id: indicacao.pessoa_id, ativo: true, tipo: { not: indicacao.oficio } },
      });
      if (anterior) {
        await tx.oficial.update({ where: { id: anterior.id }, data: { ativo: false } });
        await this.auditar(tx, ator, 'oficial', anterior.id, { ativo: false, indicacao_id: indicacao.id }, { ativo: true });
      }
      const oficial = await tx.oficial.upsert({
        where: { igreja_id_pessoa_id_tipo: { igreja_id: igreja, pessoa_id: indicacao.pessoa_id, tipo: indicacao.oficio } },
        create: { igreja_id: igreja, pessoa_id: indicacao.pessoa_id, tipo: indicacao.oficio, ativo: true },
        update: { ativo: true },
      });
      const mandato = await tx.mandato_oficial.create({
        data: {
          igreja_id: igreja, oficial_id: oficial.id, indicacao_id: indicacao.id, data_eleicao: assembleia.data,
          data_posse: posse, termino_previsto: termino,
          autoridade: 'Assembleia Geral', evidencia: `Ata da Assembleia, versão ${assembleia.versao_id}.`,
          avaliacao_eleicao: { indicacao_id: indicacao.id, rol_eleicao_evento_id: evento, rol_posse_evento_id: eventoPosse },
        },
        select: { id: true, oficial_id: true },
      });
      await tx.referencia_ata_oficial.create({ data: {
        igreja_id: igreja, mandato_id: mandato.id, ato: 'ELEICAO', ata_documento_id: assembleia.documento_id,
        versao_id: assembleia.versao_id, justificativa: 'Ata informada no registro da eleição.',
        sequencia: 1, registrado_por_id: ator.sub,
      } });
      await this.auditar(tx, ator, 'mandato_oficial', mandato.id, {
        ...v, oficial_id: oficial.id, data_eleicao: civil(assembleia.data), termino_previsto: civil(termino), ativo: true,
      });
      return mandato;
    });
  }

  private auditar(tx: Tx, ator: AtorSecretaria, tabela: string, id: string, dados: Prisma.InputJsonObject, anteriores?: Prisma.InputJsonObject) {
    return tx.logs_atividades.create({ data: {
      igreja_id: ator.igreja_id, usuario_id: ator.sub, acao: anteriores ? 'ATUALIZACAO' : 'CRIACAO',
      tabela_afetada: tabela, registro_id: id, dados_novos: dados, dados_antigos: anteriores,
    } });
  }
}
