import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type orgao_interno, type versao_orgao } from '@prisma/client';
import { z } from 'zod';
import { contaDaSessao, fundamento, type Ator, type Tx } from '../autorizacao/politica';
import { PrismaService } from '../prisma/prisma.service';
import { presidenciaSociedades } from './acesso-sociedades';
import { hashAto, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';
import { configuracaoOrgao, dataCivilOrgao, diaCivilOrgao, regrasSociedade } from './sociedades-regras';

const meses = z.number().int().min(1).max(60);
const minuta = z.strictObject({
  inicio: z.iso.date(), fonte: fundamento, autoridade: fundamento.max(255), evidencia: fundamento,
  prazo_maximo_meses: meses.optional(), prazo_sugerido_meses: meses.optional(),
  posse_integrante: z.enum(['CONSELHO', 'ASSEMBLEIA_GERAL']).optional(),
});
const aprovacao = z.strictObject({ id: z.uuid(), previa: z.string().regex(/^[0-9a-f]{64}$/) });
type Minuta = z.infer<typeof minuta>;
type Mudanca = { campo: string; antes: string | number; depois: string | number };

function teto(o: orgao_interno, base: versao_orgao) {
  if (o.tipo === 'CONSELHO') return 60;
  if (o.tipo === 'JUNTA' || o.tipo === 'SOCIEDADE_INTERNA' &&
      regrasSociedade.safeParse(configuracaoOrgao(base.configuracao).regra_sociedade).success) return 12;
  if (o.gestao_presidencial && o.constituicao === 'ELEICAO') return 60;
  return null;
}

function preparar(o: orgao_interno, base: versao_orgao, v: Minuta, hoje: string) {
  const inicio = dataCivilOrgao(v.inicio);
  if (v.inicio <= hoje || inicio <= base.inicio)
    throw new BadRequestException('A vigência deve ser futura e posterior à última versão programada.');
  const vigente = configuracaoOrgao(base.configuracao);
  const oficial = o.tipo === 'CONSELHO' || o.tipo === 'JUNTA';
  const limite = teto(o, base);
  const anterior = Number(vigente.cargo_prazo_maximo_meses ?? limite);
  const maximo = v.prazo_maximo_meses ?? anterior;
  const sugestaoAnterior = Number(vigente.cargo_prazo_sugerido_meses ?? anterior);
  const sugestao = v.prazo_sugerido_meses ?? Math.min(sugestaoAnterior, maximo);
  if ((v.prazo_maximo_meses !== undefined || v.prazo_sugerido_meses !== undefined) &&
      (!limite || maximo > limite || sugestao > maximo || v.prazo_sugerido_meses !== undefined && !oficial))
    throw new BadRequestException('Confira os prazos admitidos na configuração deste órgão.');
  if (v.posse_integrante && !oficial) throw new BadRequestException('O contexto da posse aplica-se a Conselho e Junta.');
  const atos = configuracaoOrgao(vigente.atos);
  const config = { ...vigente } as Prisma.InputJsonObject;
  const alteracoes: Mudanca[] = [];
  const registrar = (campo: string, antes: string | number, depois: string | number) => {
    if (antes !== depois) alteracoes.push({ campo, antes, depois });
  };
  registrar('Fonte da configuração', base.fonte, v.fonte);
  const aplicarPrazo = v.prazo_maximo_meses !== undefined || v.prazo_sugerido_meses !== undefined;
  if (aplicarPrazo) {
    registrar('Prazo máximo dos cargos em meses', anterior, maximo);
    if (oficial) registrar('Prazo sugerido dos cargos em meses', sugestaoAnterior, sugestao);
  }
  const posseAnterior = String(atos.posse_integrante ?? 'CONSELHO');
  if (v.posse_integrante) registrar('Órgão que documenta a posse do integrante', posseAnterior, v.posse_integrante);
  if (!alteracoes.length) throw new BadRequestException('Informe uma alteração em relação à última versão.');
  return {
    inicio, alteracoes,
    configuracao: { ...config, ...(aplicarPrazo && { cargo_prazo_maximo_meses: maximo }),
      ...(aplicarPrazo && oficial && { cargo_prazo_sugerido_meses: sugestao }),
      ...(v.posse_integrante && { atos: { ...(atos as Prisma.InputJsonObject), posse_integrante: v.posse_integrante } }) },
  };
}

@Injectable()
export class VersoesInstitucionaisService {
  constructor(private readonly db: PrismaService) {}

  private async contexto(tx: Tx, ator: Ator, id: string, escrita: boolean) {
    const igreja_id = ator.igreja_id;
    if (escrita) {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${ator.sub} AND igreja_id = ${igreja_id} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM sessoes WHERE id = ${ator.sessao_id} AND usuario_id = ${ator.sub} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${id} AND igreja_id = ${igreja_id} FOR UPDATE`;
    }
    const conta = await contaDaSessao(tx, ator);
    const hoje = await hojeDaIgreja(tx, igreja_id);
    const presidencia = await presidenciaSociedades(tx, conta, hoje);
    if (!presidencia && (escrita || conta.perfil !== 'ADMINISTRADOR'))
      throw new ForbiddenException('A adoção exige a conta de atuação da presidência conferida.');
    if (escrita) await tx.$queryRaw`SELECT id FROM presidencia_conselho WHERE id = ${presidencia} AND igreja_id = ${igreja_id} FOR SHARE`;
    const orgao = await tx.orgao_interno.findFirst({ where: { id, igreja_id } });
    if (!orgao) throw new NotFoundException('Órgão indisponível nesta igreja.');
    if (escrita && !orgao.ativo) throw new ConflictException('A adoção exige órgão ativo.');
    const escopo = { igreja_id, orgao_id: id };
    const base = await tx.versao_orgao.findFirst({ where: escopo, orderBy: { numero: 'desc' } });
    if (!base) throw new NotFoundException('A configuração inicial do órgão não foi instalada.');
    return { escopo, orgao, base, hoje, presidencia };
  }

  listar(ator: Ator, id: string) {
    return this.db.$transaction(async tx => {
      const { escopo, orgao, base, hoje, presidencia } = await this.contexto(tx, ator, id, false);
      const [versoes, proposta] = await Promise.all([
        tx.versao_orgao.findMany({ where: escopo, orderBy: { numero: 'desc' }, take: 50,
          select: { id: true, numero: true, fonte: true, inicio: true, fim: true } }),
        tx.proposta_versao_orgao.findUnique({ where: { igreja_id_orgao_id: escopo } }),
      ]);
      return { pode_adotar: !!presidencia && orgao.ativo, hoje, versoes, proposta,
        oficial: orgao.tipo === 'CONSELHO' || orgao.tipo === 'JUNTA', prazo_limite_meses: teto(orgao, base) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  propor(ator: Ator, id: string, dados: unknown) {
    const r = minuta.safeParse(dados);
    if (!r.success) throw new BadRequestException('Confira fonte, autoridade, evidência, data e regras da proposta.');
    const v = r.data;
    return transacaoSerializavel(this.db, async tx => {
      const { escopo, orgao, base, hoje } = await this.contexto(tx, ator, id, true);
      const { alteracoes } = preparar(orgao, base, v, hoje);
      const previa = hashAto({ base: base.id, escopo, v, alteracoes });
      const data = { ...escopo, base_id: base.id, operador_id: ator.sub, entrada: v, alteracoes, previa };
      return tx.proposta_versao_orgao.upsert({ where: { igreja_id_orgao_id: escopo },
        create: data, update: { ...data, atualizado_em: new Date() } });
    });
  }

  adotar(ator: Ator, id: string, dados: unknown) {
    const r = aprovacao.safeParse(dados);
    if (!r.success) throw new BadRequestException('Confirme a proposta e a prévia em vigor.');
    return transacaoSerializavel(this.db, async tx => {
      const { escopo, orgao, base, hoje, presidencia } = await this.contexto(tx, ator, id, true);
      const anterior = await tx.ato_orgao.findUnique({ where: { igreja_id_idempotencia: {
        igreja_id: escopo.igreja_id, idempotencia: r.data.id,
      } } });
      if (anterior) {
        const detalhes = configuracaoOrgao(anterior.detalhes);
        if (anterior.tipo !== 'ADOTAR_CONFIGURACAO' || anterior.orgao_id !== id || anterior.operador_id !== ator.sub ||
            anterior.hash_requisicao !== r.data.previa) throw new ConflictException('A confirmação já foi usada.');
        return { id: detalhes.versao_id, numero: detalhes.numero };
      }
      const proposta = await tx.proposta_versao_orgao.findUnique({ where: { igreja_id_orgao_id: escopo } });
      if (proposta?.id !== r.data.id || proposta.previa !== r.data.previa || proposta.base_id !== base.id)
        throw new ConflictException('A proposta mudou. Consulte as diferenças atualizadas.');
      const v = minuta.parse(proposta.entrada);
      const { inicio, configuracao, alteracoes } = preparar(orgao, base, v, hoje);
      const previa = hashAto({ base: base.id, escopo, v, alteracoes });
      if (previa !== r.data.previa) throw new ConflictException('As regras mudaram. Prepare outra proposta.');

      await tx.versao_orgao.update({ where: { id: base.id }, data: { fim: inicio } });
      const versao = await tx.versao_orgao.create({ data: { ...escopo, numero: base.numero + 1, inicio, fonte: v.fonte, configuracao } });
      await tx.ato_orgao.create({ data: { ...escopo, operador_id: ator.sub, tipo: 'ADOTAR_CONFIGURACAO', data_efeito: inicio,
        idempotencia: proposta.id, hash_requisicao: previa, autoridade: v.autoridade, evidencia: v.evidencia,
        detalhes: { versao_id: versao.id, numero: versao.numero, anterior_id: base.id,
          presidencia_id: presidencia, proponente_id: proposta.operador_id, alteracoes } } });
      await tx.proposta_versao_orgao.delete({ where: { igreja_id_orgao_id: escopo } });
      return { id: versao.id, numero: versao.numero };
    });
  }
}
