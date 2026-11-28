import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { recursoDaIgreja } from '../feature-flags/feature-flags';
import { hashAto, transacaoSerializavel } from '../orgaos/idempotencia';
import { PrismaService } from '../prisma/prisma.service';
import { rotulosServico, servicosDeConsulta, servicosDeHistorico } from './catalogo-servicos';
import { servicosLiberaveis, type ServicoLiberavel } from './liberacao-servico';
import { camposConta, contaDaSessao, decisaoAtribuicoes, fundamento, type Ator, type Tx } from './politica';
import { RotasServicosService } from './rotas-servicos.service';
import { filtrarAtribuicoesDeModelos } from './validade-modelo';

const acaoSchema = z.enum(servicosLiberaveis);
const confirmacao = z.strictObject({
  estado: z.enum(['ATRIBUICAO', 'PAUSADO']),
  revisao: z.number().int().nonnegative(),
  previa: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  fundamento,
}).refine(v => v.estado === 'PAUSADO' || !!v.previa, 'Gere e confira a prévia da liberação.');

@Injectable()
export class LiberacoesService {
  constructor(private readonly db: PrismaService, private readonly rotas: RotasServicosService) {}

  private async administrador(tx: Tx, ator: Ator, escrita: boolean) {
    const conta = await contaDaSessao(tx, ator);
    if (conta.perfil !== 'ADMINISTRADOR' || (escrita && !conta.pessoa_id))
      throw new ForbiddenException('A homologação exige administração técnica identificada.');
    return conta;
  }

  private validarAcao(valor: string) {
    const acao = acaoSchema.safeParse(valor);
    if (!acao.success) throw new BadRequestException('Esta operação ainda não tem liberação individual.');
    return acao.data;
  }

  listar(ator: Ator) {
    return this.db.$transaction(async tx => {
      await this.administrador(tx, ator, false);
      const registradas = await tx.liberacao_servico.findMany({ where: { igreja_id: ator.igreja_id } });
      const porAcao = new Map(registradas.map(r => [r.acao, r]));
      return servicosLiberaveis.map(acao => ({ acao, rotulo: rotulosServico[acao], permite_pausar: !servicosDeConsulta.has(acao),
        estado: porAcao.get(acao)?.estado ?? 'ATRIBUICAO', revisao: porAcao.get(acao)?.revisao ?? 0,
      }));
    });
  }

  private async avaliar(tx: Tx, igreja_id: string, acao: ServicoLiberavel) {
    const escopo = { igreja_id, acao };
    const historico = servicosDeHistorico.some(a => a === acao);
    const acesso = acao === 'ACESSO_CONSULTAR' || acao === 'ACESSO_ANALISAR';
    const [registro, contas, atribuidas, competencias, restricoes] = await Promise.all([
      tx.liberacao_servico.findUnique({ where: { igreja_id_acao: escopo } }),
      tx.usuarios.findMany({ where: { igreja_id, ativo: true }, select: { ...camposConta, nome_usuario: true },
        orderBy: { id: 'asc' } }),
      tx.atribuicao_servico.findMany({ where: { ...escopo, revogado_em: null }, orderBy: [{ inicio: 'desc' }, { id: 'asc' }] }),
      acesso ? tx.competencia_acesso.findMany({ where: { igreja_id, revogado_em: null }, select: { usuario_id: true, pessoa_id: true } }) : undefined,
      historico ? tx.acesso_eventos_sensiveis.findMany({ where: { igreja_id, revogado_em: null },
        select: { usuario_id: true, pode_consultar: true, pode_registrar: true } }) : undefined,
    ]);
    const agora = new Date();
    const rotas = this.rotas.listar().filter(r => r.acao === acao);
    const retiradas = this.rotas.retiradas(acao);
    const diferencas = (await Promise.all(contas.map(async conta => {
      const concessoes = await filtrarAtribuicoesDeModelos(tx, conta, atribuidas.filter(r => r.usuario_id === conta.id), agora);
      const decisao = decisaoAtribuicoes(conta, acao, concessoes, agora);
      const podePorAtribuicao = decisao.permite && (acao !== 'MANDATOS_REGISTRAR' || !!conta.pessoa_id);
      const antesPorRota = (_perfis: string[], retirada: boolean, _contextual = false) => !retirada && registro?.estado !== 'PAUSADO' && podePorAtribuicao;
      return [
        ...rotas.map(r => {
          const ordenacao = r.rota === 'POST /oficiais/:id/eventos';
          const acervo = r.rota.endsWith('/:id/acervo-historico');
          const concessao = !historico || ordenacao || acervo || !!restricoes?.some(p => p.usuario_id === conta.id &&
            (servicosDeConsulta.has(acao) ? p.pode_consultar : p.pode_registrar));
          const escopo = r.contextual ? 'Mandato histórico sem órgão associado'
            : ordenacao ? 'Ordenação. Os demais eventos exigem concessão específica'
              : historico && !acervo ? 'Com concessão específica de acesso restrito' : undefined;
          return { rota: r.rota, antes: concessao && antesPorRota(r.perfis, false, r.contextual),
            depois: concessao && podePorAtribuicao, ...(escopo && { escopo }) };
        }),
        ...retiradas.map(r => ({ rota: r.rota, antes: antesPorRota(r.perfis, true), depois: false, escopo: 'Entrada duplicada retirada' })),
      ].filter(r => r.antes !== r.depois).map(r => ({ ...r, usuario_id: conta.id, nome: conta.nome_usuario, perfil: conta.perfil,
        motivo: decisao.motivo }));
    }))).flat();
    const revisao = registro?.revisao ?? 0;
    const previa = hashAto({ igreja_id, acao, revisao, diferencas, contas: contas.map(c => ({
      id: c.id, pessoa: c.pessoa_id, perfil: c.perfil, geracao: c.geracao_vinculo, versao: c.auth_version,
    })), atribuicoes: atribuidas.map(a => ({
      id: a.id, geracao: a.geracao_vinculo, inicio: a.inicio.toISOString(), fim: a.fim?.toISOString() ?? null,
    })) });
    return { previa, revisao, diferencas, contas_ativas: contas.length, acao, rotulo: rotulosServico[acao] };
  }

  previa(ator: Ator, codigo: string) {
    const acao = this.validarAcao(codigo);
    return this.db.$transaction(async tx => {
      await this.administrador(tx, ator, false);
      return this.avaliar(tx, ator.igreja_id, acao);
    }, { isolationLevel: 'RepeatableRead' });
  }

  executar(ator: Ator, codigo: string, entrada: unknown) {
    const acao = this.validarAcao(codigo), parsed = confirmacao.safeParse(entrada);
    if (!parsed.success) throw new BadRequestException('Confira o fundamento, o estado e a prévia da liberação.');
    const pedido = parsed.data, igreja_id = ator.igreja_id;
    if (pedido.estado === 'PAUSADO' && servicosDeConsulta.has(acao))
      throw new BadRequestException('A suspensão é reservada a operações de escrita.');
    return transacaoSerializavel(this.db, async tx => {
      // Produz uma nova versão da linha que as gravações bloqueiam. Uma transação serializável
      // com snapshot anterior precisa repetir a leitura em vez de usar a política anterior ao corte.
      await tx.$executeRaw`UPDATE igreja SET mfa_obrigatorio = mfa_obrigatorio WHERE id = ${igreja_id}`;
      const operador = await this.administrador(tx, ator, true);
      const atual = await tx.liberacao_servico.findUnique({ where: { igreja_id_acao: { igreja_id, acao } } });
      if ((atual?.revisao ?? 0) !== pedido.revisao) throw new ConflictException('A situação mudou. Atualize a liberação.');
      if (atual?.estado === pedido.estado) throw new ConflictException('A operação já está nessa situação.');
      const revisao = pedido.revisao + 1;
      if (pedido.estado === 'ATRIBUICAO') {
        if (acao === 'MANDATOS_REGISTRAR' && !(['governanca','orgaos','orgaos_gestao','secretaria'] as const).every(
          recurso => recursoDaIgreja(recurso, igreja_id))) throw new ConflictException('A ficha, a gestão de órgãos e a Secretaria devem estar disponíveis na igreja.');
        const avaliacao = await this.avaliar(tx, igreja_id, acao);
        if (avaliacao.previa !== pedido.previa) throw new ConflictException('Os acessos mudaram. Confira uma nova prévia.');
      }
      const r = await tx.liberacao_servico.upsert({ where: { igreja_id_acao: { igreja_id, acao } },
        create: { igreja_id, acao, estado: pedido.estado, revisao }, update: { estado: pedido.estado, revisao } });
      await tx.evento_autorizacao.create({ data: { igreja_id, operador_id: operador.id, operador_pessoa_id: operador.pessoa_id,
        acao: 'LIBERAR_SERVICO', recurso_id: acao, fundamento: pedido.fundamento,
        dados: { anterior: atual?.estado ?? 'ATRIBUICAO', estado: pedido.estado, revisao, previa: pedido.previa ?? null },
      } });
      return r;
    });
  }
}
