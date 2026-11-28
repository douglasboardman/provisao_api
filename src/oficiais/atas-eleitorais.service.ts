import { contextosDasAtasRestritas } from '../secretaria/visibilidade-documentos';
import { dataReuniaoAta, selecionarDocumentos, tabelasDocumentais } from '../secretaria/selecao-documental';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { permissaoMandato } from '../orgaos/permissao-mandato';
import { PrismaService } from '../prisma/prisma.service';
import { SecretariaBaseService, dataCivil, type AtorSecretaria, type Tx } from '../secretaria/secretaria-base.service';

const dia = z.iso.date();
const uuid = z.uuid();
const tipoAta = z.enum(['CONSELHO', 'ASSEMBLEIA']);
type TipoAta = z.infer<typeof tipoAta>;
type Ata = { versao_id: string; documento_id: string; data: Date; data_reuniao: string | null; assunto: string; numero: string | null };

export function dataEleicaoDaAta(ata: Ata) {
  const data = dia.safeParse(ata.data_reuniao);
  return data.success ? dataCivil(data.data) : ata.data;
}

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

@Injectable()
export class AtasEleitoraisService {
  constructor(private readonly prisma: PrismaService, private readonly secretaria: SecretariaBaseService) {}

  async acesso(tx: Tx, ator: AtorSecretaria) {
    if (!recursoDaIgreja('secretaria', ator.igreja_id)) throw new NotFoundException('Secretaria indisponível para esta igreja.');
    const usuario = await this.secretaria.operador(tx, ator);
    if (usuario.perfil === 'AUDITOR') throw new ForbiddenException('Operador não autorizado.');
    const hoje = dataCivil(await hojeDaIgreja(tx, ator.igreja_id));
    return { hoje, restritos: await contextosDasAtasRestritas(tx, ator.igreja_id, ator.sub) };
  }

  private async acessoParaSelecaoEleitoral(tx: Tx, ator: AtorSecretaria) {
    if (ator.perfil === 'COMUM') {
      const { sessao_id, auth_version } = ator;
      if (!sessao_id || auth_version === undefined || !await permissaoMandato(tx, { ...ator, sessao_id, auth_version }))
        throw new ForbiddenException('A seleção exige permissão para registrar mandatos.');
    }
    return this.acesso(tx, ator);
  }

  private escopoAtas(igreja: string, restritos: string[], tipo: TipoAta, hoje: Date) {
    const contexto = tipo === 'CONSELHO' ? Prisma.sql`o.tipo = 'CONSELHO'` : Prisma.sql`c.tipo = 'ASSEMBLEIA_GERAL'`;
    return Prisma.sql`
      ${tabelasDocumentais}
      LEFT JOIN orgao_interno o ON o.id = c.orgao_id AND o.igreja_id = c.igreja_id
      WHERE d.igreja_id = ${igreja} AND d.tipo = 'ATA' AND v.numero = d.versao_atual
        AND d.estado IN ('APROVADO', 'EXPEDIDO', 'LEGADA_CONFERIDA')
        AND v.data_documento <= ${hoje}::date AND ${contexto}
        AND (NOT d.restrito ${restritos.length ? Prisma.sql`OR d.contexto_id IN (${Prisma.join(restritos)})` : Prisma.empty})`;
  }

  private async atas(tx: Tx, igreja: string, restritos: string[], tipo: TipoAta, hoje: Date, filtros: { versao?: string; query?: string }) {
    const busca = filtros.query?.replace(/[\\%_]/g, '\\$&');
    const numero = busca && /^\d+$/.test(busca) ? busca.replace(/^0+/, '') : '';
    return tx.$queryRaw<Ata[]>`
      SELECT v.id AS versao_id, d.id AS documento_id, v.data_documento AS data, ${dataReuniaoAta} AS data_reuniao, v.assunto,
        COALESCE(v.numero_original, v.fonte_congelada->>'numero', d.numero::text) AS numero
      ${this.escopoAtas(igreja, restritos, tipo, hoje)}
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

  selecionarAtas(ator: AtorSecretaria, tipo: string, filtros: unknown) {
    const contexto = validar(tipoAta, tipo);
    return this.prisma.$transaction(async tx => {
      const acesso = await this.acessoParaSelecaoEleitoral(tx, ator);
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
      const acesso = await this.acessoParaSelecaoEleitoral(tx, ator);
      const contexto = validar(tipoAta, tipo);
      const ata = await this.ata(tx, ator, acesso, contexto, id);
      const dataReferencia = contexto === 'ASSEMBLEIA' ? dataEleicaoDaAta(ata) : ata.data;
      const pessoas = await tx.pessoas.findMany({
        where: { igreja_id: ator.igreja_id, sexo: 'MASCULINO',
          eventos_membresia: { some: { data_evento: { lte: dataReferencia }, rol: 'COMUNGANTES' } },
          ...(nome ? { nome_completo: { contains: nome, mode: 'insensitive' } } : {}),
        },
        select: { id: true, nome_completo: true, data_nascimento: true, eventos_membresia: {
          where: { data_evento: { lte: acesso.hoje } }, select: camposMembresia,
        } },
        orderBy: [{ nome_completo: 'asc' }, { id: 'asc' }],
      });
      return pessoas.filter(p => {
        const vigente = eventoVigente(p.eventos_membresia, dataReferencia);
        const atual = eventoVigente(p.eventos_membresia, acesso.hoje);
        return maioridade(p.data_nascimento, dataReferencia) && vigente.situacao === 'DEFINIDO' && vigente.evento.rol === 'COMUNGANTES'
          && (contexto === 'ASSEMBLEIA' || (atual.situacao === 'DEFINIDO' && atual.evento.rol === 'COMUNGANTES'));
      }).slice(0, 50).map(({ id, nome_completo }) => ({ id, nome_completo }));
    });
  }

}
