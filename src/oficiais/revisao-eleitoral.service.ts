import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { exigirAcessoSensivel } from './acesso-sensivel.service';
import { CorrecaoMembresiaService } from './correcao-membresia.service';
import { CorrecaoConteudoService } from './correcao-conteudo.service';
import { InsercaoRetroativaService } from './insercao-retroativa.service';
import { OrdenacaoMembresiaService } from './ordenacao-membresia.service';
const texto = z.string().trim().min(1).max(1000);
const conclusaoSchema = z.object({ autoridade: z.string().trim().min(1).max(255), evidencia: texto, conclusao: texto, permite_reutilizacao: z.boolean(), ciente: z.literal(true) }).strict();
const schema = z.object({ operacao: z.enum(['DATA', 'CONTEUDO', 'ORDEM', 'INSERCAO']), oficial_id: z.string().uuid().optional(), proposta: z.record(z.string(), z.unknown()), hash_previa: z.string().regex(/^[a-f0-9]{64}$/), autoridade: z.string().trim().min(1).max(255), evidencia: texto, justificativa: texto, idempotencia: z.string().uuid(), ciente: z.literal(true) }).strict();
type Entrada = z.infer<typeof schema>; type Tx = Prisma.TransactionClient;
const normalizar = (v: unknown): unknown => Array.isArray(v) ? v.map(normalizar) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalizar(x)])) : v;
const igual = (a: unknown, b: unknown) => JSON.stringify(normalizar(a)) === JSON.stringify(normalizar(b));


@Injectable()
export class RevisaoEleitoralService {
  constructor(private readonly prisma: PrismaService, private readonly data: CorrecaoMembresiaService, private readonly conteudo: CorrecaoConteudoService, private readonly ordem: OrdenacaoMembresiaService, private readonly insercao: InsercaoRetroativaService) {}
  private async autorizar(tx: Tx, igreja: string, usuario: string, acao: 'consultar' | 'registrar') {
    const perfis: usuarios_perfil[] = [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO]; if (acao === 'consultar') perfis.push(usuarios_perfil.AUDITOR);
    if (!await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: { in: perfis } }, select: { id: true } })) throw new ForbiddenException('Operador não autorizado nesta igreja.');
    await exigirAcessoSensivel(tx, igreja, usuario, acao);
  }
  async listar(igreja: string, usuario: string, pessoa: string) {
    return this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'consultar'); if (!await tx.pessoas.findFirst({ where: { id: pessoa, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.'); const r = await tx.decisao_revisao_eleitoral.findMany({ where: { igreja_id: igreja, pessoa_id: pessoa }, select: { id: true, operacao: true, hash_previa: true, autoridade: true, evidencia: true, justificativa: true, criado_em: true, aplicado_em: true, criado_por: { select: { nome_usuario: true } }, itens: { select: { id: true, conferencia_id: true, mandato_id: true, revisado_em: true, autoridade_revisao: true, evidencia_revisao: true, conclusao_revisao: true, permite_reutilizacao: true, revisado_por: { select: { nome_usuario: true } } } } }, orderBy: { criado_em: 'desc' } }); await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CONSULTA, tabela_afetada: 'revisao_eleitoral_consulta', registro_id: pessoa } }); return r; });
  }
  async concluir(igreja: string, usuario: string, itemId: string, dados: z.infer<typeof conclusaoSchema>) {
    const parsed = conclusaoSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Conclusão inválida.');
    const v = parsed.data;
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar');
      await tx.$queryRaw`SELECT id FROM revisao_eleitoral_item WHERE id = ${itemId} AND igreja_id = ${igreja} FOR UPDATE`;
      const item = await tx.revisao_eleitoral_item.findFirst({ where: { id: itemId, igreja_id: igreja }, include: { decisao: { select: { aplicado_em: true } } } });
      if (!item || !item.decisao.aplicado_em) throw new NotFoundException('Revisão pendente não encontrada nesta igreja.');
      if (item.mandato_id && v.permite_reutilizacao) throw new BadRequestException('A reutilização só se aplica a uma conferência.');
      if (item.revisado_em) {
        if (item.revisado_por_id !== usuario || item.autoridade_revisao !== v.autoridade || item.evidencia_revisao !== v.evidencia || item.conclusao_revisao !== v.conclusao || item.permite_reutilizacao !== v.permite_reutilizacao) throw new ConflictException('Esta revisão já foi concluída com outros dados.');
        return item;
      }
      const resultado = await tx.revisao_eleitoral_item.update({ where: { id: itemId }, data: { revisado_em: new Date(), revisado_por_id: usuario, autoridade_revisao: v.autoridade, evidencia_revisao: v.evidencia, conclusao_revisao: v.conclusao, permite_reutilizacao: v.permite_reutilizacao } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'decisao_revisao_eleitoral', registro_id: item.decisao_id } });
      return resultado;
    });
  }
  async registrar(igreja: string, usuario: string, pessoa: string, dados: Entrada) {
    const parsed = schema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Decisão formal inválida.');
    const v = parsed.data, chave = v.idempotencia.toLowerCase();
    if (v.oficial_id && v.operacao !== 'DATA' && v.operacao !== 'ORDEM') throw new BadRequestException('Alvo de oficial não se aplica a esta operação.');
    const anterior = await this.prisma.$transaction(async tx => { await this.autorizar(tx, igreja, usuario, 'registrar'); return tx.decisao_revisao_eleitoral.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } } }); });
    if (v.oficial_id && !await this.prisma.oficial.findFirst({ where: { id: v.oficial_id, igreja_id: igreja, pessoa_id: pessoa }, select: { id: true } })) throw new NotFoundException('Oficial não encontrado para esta pessoa e igreja.');
    if (anterior) {
      if (anterior.pessoa_id !== pessoa || anterior.criado_por_id !== usuario || anterior.operacao !== v.operacao || anterior.hash_previa !== v.hash_previa || !igual(anterior.proposta, v.proposta) || anterior.autoridade !== v.autoridade || anterior.evidencia !== v.evidencia || anterior.justificativa !== v.justificativa) throw new ConflictException('Chave já utilizada para outra decisão.');
      return anterior;
    }
    const alvo = v.oficial_id ?? pessoa, porPessoa = !v.oficial_id;
    const previa = v.operacao === 'DATA' ? await this.data.previa(igreja, usuario, alvo, v.proposta as never, porPessoa) : v.operacao === 'CONTEUDO' ? await this.conteudo.previa(igreja, usuario, pessoa, v.proposta as never) : v.operacao === 'ORDEM' ? await this.ordem.previa(igreja, usuario, alvo, v.proposta as never, porPessoa) : await this.insercao.previa(igreja, usuario, pessoa, v.proposta as never);
    if (previa.hash !== v.hash_previa) throw new ConflictException('Os dados mudaram; gere nova prévia antes da decisão.');
    if (!previa.bloqueada || ('origens_invalidadas' in previa && previa.origens_invalidadas.length) || ('origem_seguinte_invalida' in previa && previa.origem_seguinte_invalida) || ('inconsistencias_rol_origem' in previa && previa.inconsistencias_rol_origem.length)) throw new BadRequestException('A decisão se aplica apenas ao impacto eleitoral, após resolver inconsistências de origem.');
    return this.prisma.$transaction(async tx => {
      await this.autorizar(tx, igreja, usuario, 'registrar');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${igreja + ':decisao-eleitoral:' + chave}, 0))`;
      const existente = await tx.decisao_revisao_eleitoral.findUnique({ where: { igreja_id_idempotencia: { igreja_id: igreja, idempotencia: chave } } });
      if (existente) {
        if (existente.pessoa_id !== pessoa || existente.criado_por_id !== usuario || existente.operacao !== v.operacao || existente.hash_previa !== v.hash_previa || !igual(existente.proposta, v.proposta) || existente.autoridade !== v.autoridade || existente.evidencia !== v.evidencia || existente.justificativa !== v.justificativa) throw new ConflictException('Chave já utilizada para outra decisão.');
        return existente;
      }
      const registro = await tx.decisao_revisao_eleitoral.create({ data: { igreja_id: igreja, pessoa_id: pessoa, operacao: v.operacao, hash_previa: v.hash_previa, proposta: v.proposta as Prisma.InputJsonObject, impacto: previa, autoridade: v.autoridade, evidencia: v.evidencia, justificativa: v.justificativa, idempotencia: chave, criado_por_id: usuario } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'decisao_revisao_eleitoral', registro_id: registro.id } });
      return registro;
    });
  }
}
