import { exigirServicoDoUsuario, podeServico } from '../autorizacao/operacao-atual';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
const texto = z.string().trim().min(1);
const politicaSchema = z.object({ ativo: z.boolean(), dias_antecedencia: z.number().int().min(1).max(365), dias_apos_termino: z.number().int().min(0).max(365), fuso_iana: texto.max(100), autoridade: texto.max(255), fundamento: texto.max(1000) }).strict();
const inscricaoSchema = z.object({ usuario_id: z.string().uuid() }).strict();
type Tx = Prisma.TransactionClient;
function diaNoFuso(agora: Date, fuso: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora);
  const parte = (tipo: string) => parts.find(p => p.type === tipo)?.value;
  return `${parte('year')}-${parte('month')}-${parte('day')}`;
}
function janela(agora: Date, fuso: string, dias: number, atraso: number) {
  const inicio = new Date(`${diaNoFuso(agora, fuso)}T00:00:00.000Z`), fim = new Date(inicio);
  fim.setUTCDate(fim.getUTCDate() + dias);
  const inicioAtraso = new Date(inicio); inicioAtraso.setUTCDate(inicioAtraso.getUTCDate() - atraso);
  return { inicio, fim, inicioAtraso };
}
@Injectable()
export class NotificacoesMandatoService {
  constructor(private readonly prisma: PrismaService) {}
  private async administrador(tx: Tx, igreja: string, usuario: string) {
    const ator = await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: usuarios_perfil.ADMINISTRADOR }, select: { id: true } });
    if (!ator) throw new ForbiddenException('Operador não autorizado.');
  }
  private async usuarioValido(tx: Tx, igreja: string, usuario: string) {
    return exigirServicoDoUsuario(tx, igreja, usuario, 'OFICIAIS_CONSULTAR');
  }
  async configurar(igreja: string, usuario: string, dados: z.infer<typeof politicaSchema>) {
    const parsed = politicaSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Configuração de alertas inválida.');
    const v = parsed.data;
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: v.fuso_iana }).format(new Date()); } catch { throw new BadRequestException('Fuso horário inválido.'); }
    return this.prisma.$transaction(async tx => {
      await this.administrador(tx, igreja, usuario);
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja} FOR UPDATE`;
      const anterior = await tx.politica_alerta_oficiais.findUnique({ where: { igreja_id: igreja } });
      const politica = await tx.politica_alerta_oficiais.upsert({ where: { igreja_id: igreja }, create: { igreja_id: igreja, alterado_por_id: usuario, ...v }, update: { alterado_por_id: usuario, ...v } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: anterior ? logs_atividades_acao.ATUALIZACAO : logs_atividades_acao.CRIACAO, tabela_afetada: 'politica_alerta_oficiais', registro_id: igreja, dados_antigos: anterior ? { ativo: anterior.ativo, dias_antecedencia: anterior.dias_antecedencia, dias_apos_termino: anterior.dias_apos_termino, fuso_iana: anterior.fuso_iana, autoridade: anterior.autoridade, fundamento: anterior.fundamento } : Prisma.DbNull, dados_novos: v } });
      return politica;
    });
  }
  async adicionarDestinatario(igreja: string, usuario: string, dados: z.infer<typeof inscricaoSchema>) {
    const parsed = inscricaoSchema.safeParse(dados); if (!parsed.success) throw new BadRequestException('Destinatário inválido.');
    return this.prisma.$transaction(async tx => {
      await this.administrador(tx, igreja, usuario);
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja} FOR UPDATE`;
      const alvo = await tx.usuarios.findFirst({ where: { id: parsed.data.usuario_id, igreja_id: igreja, ativo: true },  });
      if (!alvo || !await podeServico(tx, alvo, 'OFICIAIS_CONSULTAR')) throw new NotFoundException('Destinatário ativo não encontrado nesta igreja.');
      const existente = await tx.inscricao_alerta_oficial.findFirst({ where: { igreja_id: igreja, usuario_id: alvo.id, revogado_em: null } });
      if (existente) return existente;
      const registro = await tx.inscricao_alerta_oficial.create({ data: { igreja_id: igreja, usuario_id: alvo.id, criado_por_id: usuario } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'inscricao_alerta_oficial', registro_id: registro.id, dados_novos: { usuario_id: alvo.id } } });
      return registro;
    });
  }
  async removerDestinatario(igreja: string, usuario: string, inscricaoId: string) {
    return this.prisma.$transaction(async tx => {
      await this.administrador(tx, igreja, usuario);
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja} FOR UPDATE`;
      const inscricao = await tx.inscricao_alerta_oficial.findFirst({ where: { id: inscricaoId, igreja_id: igreja, revogado_em: null } });
      if (!inscricao) throw new NotFoundException('Inscrição ativa não encontrada nesta igreja.');
      const registro = await tx.inscricao_alerta_oficial.update({ where: { id: inscricao.id }, data: { revogado_em: new Date() } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: logs_atividades_acao.ATUALIZACAO, tabela_afetada: 'inscricao_alerta_oficial', registro_id: registro.id, dados_novos: { revogada: true } } });
      return { revogada: true };
    });
  }
  async configuracao(igreja: string, usuario: string) {
    return this.prisma.$transaction(async tx => {
      await this.administrador(tx, igreja, usuario);
      const [politica, destinatarios, execucao] = await Promise.all([
        tx.politica_alerta_oficiais.findUnique({ where: { igreja_id: igreja } }),
        tx.inscricao_alerta_oficial.findMany({ where: { igreja_id: igreja, revogado_em: null }, select: { id: true, usuario_id: true, usuario: { select: { nome_usuario: true, ativo: true, perfil: true } } }, orderBy: { criado_em: 'asc' } }),
        tx.execucao_alerta_oficiais.findUnique({ where: { igreja_id: igreja } }),
      ]);
      return { politica, destinatarios, execucao };
    });
  }
  /** Chamado pelo worker; criar novamente é seguro e não modifica a autoridade atual. */
  async gerar(agora = new Date()) {
    const politicas = await this.prisma.politica_alerta_oficiais.findMany({ where: { ativo: true, igreja: { ativa: true } } });
    let criados = 0, falhas = 0;
    for (const politica of politicas) {
      const tentativa = new Date();
      try {
        const { inicio, fim, inicioAtraso } = janela(agora, politica.fuso_iana, politica.dias_antecedencia, politica.dias_apos_termino);
        const [candidatos, mandatos] = await Promise.all([
          this.prisma.inscricao_alerta_oficial.findMany({ where: { igreja_id: politica.igreja_id, revogado_em: null, usuario: { ativo: true } }, select: { id: true, usuario_id: true, usuario: true } }),
          this.prisma.mandato_oficial.findMany({ where: { igreja_id: politica.igreja_id, data_posse: { lte: inicio }, OR: [{ termino_efetivo: { gte: inicioAtraso, lte: fim } }, { termino_efetivo: null, termino_previsto: { gte: inicioAtraso, lte: fim } }] }, select: { id: true, termino_efetivo: true, termino_previsto: true } }),
        ]);
        const inscritos: typeof candidatos = [];
        for (const inscrito of candidatos) if (await podeServico(this.prisma, inscrito.usuario, 'OFICIAIS_CONSULTAR')) inscritos.push(inscrito);
        const dados = mandatos.flatMap(m => inscritos.map(i => ({ igreja_id: politica.igreja_id, mandato_id: m.id, usuario_id: i.usuario_id, inscricao_id: i.id, data_termino: m.termino_efetivo ?? m.termino_previsto })));
        const total = dados.length ? (await this.prisma.alerta_mandato.createMany({ data: dados, skipDuplicates: true })).count : 0;
        criados += total;
        await this.prisma.execucao_alerta_oficiais.upsert({ where: { igreja_id: politica.igreja_id }, create: { igreja_id: politica.igreja_id, ultima_tentativa: tentativa, ultimo_sucesso: tentativa, ultimo_erro: null, ultimo_total_criado: total }, update: { ultima_tentativa: tentativa, ultimo_sucesso: tentativa, ultimo_erro: null, ultimo_total_criado: total } });
      } catch {
        falhas++;
        // A mensagem persistida é fixa e não contém detalhes de dados ou infraestrutura.
        try { await this.prisma.execucao_alerta_oficiais.upsert({ where: { igreja_id: politica.igreja_id }, create: { igreja_id: politica.igreja_id, ultima_tentativa: tentativa, ultimo_erro: 'FALHA_GERACAO' }, update: { ultima_tentativa: tentativa, ultimo_erro: 'FALHA_GERACAO' } }); } catch { /* O worker também registra falha operacional genérica. */ }
      }
    }
    return { criados, falhas };
  }
  async minhas(igreja: string, usuario: string, agora = new Date()) {
    return this.prisma.$transaction(async tx => {
      await this.usuarioValido(tx, igreja, usuario);
      const [politica, inscricao] = await Promise.all([
        tx.politica_alerta_oficiais.findUnique({ where: { igreja_id: igreja } }),
        tx.inscricao_alerta_oficial.findFirst({ where: { igreja_id: igreja, usuario_id: usuario, revogado_em: null }, select: { id: true } }),
      ]);
      if (!politica?.ativo || !inscricao) return [];
      const { inicio, fim, inicioAtraso } = janela(agora, politica.fuso_iana, politica.dias_antecedencia, politica.dias_apos_termino);
      const registros = await tx.alerta_mandato.findMany({ where: { igreja_id: igreja, usuario_id: usuario, inscricao_id: inscricao.id, data_termino: { gte: inicioAtraso, lte: fim } }, select: { id: true, data_termino: true, lido_em: true, mandato: { select: { data_posse: true, termino_efetivo: true, termino_previsto: true, oficial: { select: { tipo: true, pessoa: { select: { nome_completo: true } } } } } } }, orderBy: [{ data_termino: 'asc' }, { id: 'asc' }] });
      return registros.filter(r => r.mandato.data_posse <= inicio && (r.mandato.termino_efetivo ?? r.mandato.termino_previsto).getTime() === r.data_termino.getTime())
        .map(r => ({ id: r.id, data_termino: r.data_termino, lido_em: r.lido_em, nome: r.mandato.oficial.pessoa.nome_completo, tipo: r.mandato.oficial.tipo }));
    });
  }
  async marcarLida(igreja: string, usuario: string, id: string) {
    return this.prisma.$transaction(async tx => {
      await this.usuarioValido(tx, igreja, usuario);
      const inscricao = await tx.inscricao_alerta_oficial.findFirst({ where: { igreja_id: igreja, usuario_id: usuario, revogado_em: null }, select: { id: true } });
      if (!inscricao) throw new NotFoundException('Notificação não encontrada.');
      const atual = await tx.alerta_mandato.findFirst({ where: { id, igreja_id: igreja, usuario_id: usuario, inscricao_id: inscricao.id }, select: { id: true, lido_em: true } });
      if (!atual) throw new NotFoundException('Notificação não encontrada.');
      if (!atual.lido_em) await tx.alerta_mandato.updateMany({ where: { id, igreja_id: igreja, usuario_id: usuario, lido_em: null }, data: { lido_em: new Date() } });
      return { lida: true };
    });
  }
}
