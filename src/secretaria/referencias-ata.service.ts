import { contextosDasAtasRestritas } from './visibilidade-documentos';
import { exigirServicoNaTransacao } from '../autorizacao/escrita-servico';
import { estadoDaLiberacao } from '../autorizacao/liberacao-servico';
import { camposConta, decidirServico } from '../autorizacao/politica';
import { orgaosJuvenisRestritos } from '../orgaos/acesso-sociedades';
import { selecionarDocumentos } from './selecao-documental';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { recursoDaIgreja, type Feature } from '../feature-flags/feature-flags';
import { transacaoSerializavel } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { PrismaService } from '../prisma/prisma.service';
import { SecretariaBaseService, dataCivil, type AtorSecretaria, type Tx } from './secretaria-base.service';
import {
  autorizacaoFinanceira,
  referenciaAta,
  type ReatribuicaoAtos,
  type ChaveAlvoAta,
  type EntradaReferenciaAta,
} from './referencias-ata.dto';
import { validar } from './secretaria.dto';

type Alvo = ChaveAlvoAta & {
  tipo: string;
  titulo: string;
  data: Date;
  orgao_id: string | null;
  criterio: string;
  sensivel: boolean;
};
type Acesso = {
  igreja: string;
  perfil: AtorSecretaria['perfil'];
  restritos: string[];
  orgaosOmitidos: string[];
  contextosOmitidos: string[];
  grupos: string[];
  sensivel: boolean;
  registraSensivel: boolean;
  registraVinculo: boolean;
  registraFinanceiro: boolean;
};
type Revisao = {
  id: string;
  ata_documento_id: string | null;
  versao_id: string | null;
  referencia_externa: Prisma.JsonValue;
  justificativa: string;
  criado_em: Date;
  operador: string;
  situacao: string;
  ata: Prisma.JsonValue;
};

const tamanho = 30;
const recursos: Partial<Record<ChaveAlvoAta['grupo'], Feature>> = {
  MANDATO: 'governanca',
  PASTORAL: 'governanca',
  ORGAO: 'orgaos',
};

@Injectable()
export class ReferenciasAtaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly base: SecretariaBaseService,
  ) {}

  private async acesso(tx: Tx, ator: AtorSecretaria): Promise<Acesso> {
    const u = await tx.usuarios.findFirst({
      where: { id: ator.sub, igreja_id: ator.igreja_id, ativo: true },
      select: camposConta,
    });
    if (!u) {
      throw new ForbiddenException('Operador não autorizado.');
    }
    const operacoes = ['VINCULOS_DOCUMENTAIS_CONSULTAR', 'VINCULOS_DOCUMENTAIS_REGISTRAR',
      'AUTORIZACOES_FINANCEIRAS_CONSULTAR', 'AUTORIZACOES_FINANCEIRAS_REGISTRAR'] as const;
    const modos = await Promise.all(operacoes.map(acao => estadoDaLiberacao(tx, u.igreja_id, acao)));
    const [vinculos, registraVinculo, financeiro, registraFinanceiro] = await Promise.all(
      operacoes.map(async (acao, i) => modos[i] !== 'PAUSADO' && (await decidirServico(tx, u, acao)).permite),
    );
    const grupos = [
      ...((vinculos || registraVinculo) ? [
        'MEMBRESIA', ...Object.entries(recursos).filter(([, recurso]) => recursoDaIgreja(recurso, ator.igreja_id)).map(([grupo]) => grupo),
      ] : []),
      ...((financeiro || registraFinanceiro) ? ['FINANCEIRO'] : []),
    ];
    if (!grupos.length) throw new ForbiddenException('Operador não autorizado.');
    const restritos = await contextosDasAtasRestritas(tx, ator.igreja_id, ator.sub);
    const sensivel =
      !vinculos && !registraVinculo
        ? null
        : await tx.acesso_eventos_sensiveis.findFirst({
            where: { igreja_id: ator.igreja_id, usuario_id: ator.sub, revogado_em: null },
            select: { pode_registrar: true, pode_consultar: true },
          });
    const orgaosOmitidos = await orgaosJuvenisRestritos(tx, u, await hojeDaIgreja(tx, ator.igreja_id));
    const contextosOmitidos = orgaosOmitidos.length ? await tx.contexto_secretaria.findMany({ where: { igreja_id: ator.igreja_id,
      orgao_id: { in: orgaosOmitidos } }, select: { id: true } }) : [];
    return {
      igreja: ator.igreja_id,
      orgaosOmitidos,
      contextosOmitidos: contextosOmitidos.map(c => c.id).filter(id => !restritos.includes(id)),
      perfil: u.perfil,
      grupos,
      restritos,
      sensivel: Boolean(sensivel?.pode_consultar),
      registraSensivel: Boolean(sensivel?.pode_registrar),
      registraVinculo,
      registraFinanceiro,
    };
  }

  private alvoVisivel(acesso: Acesso) {
    return Prisma.sql`a.igreja_id = ${acesso.igreja} AND a.grupo IN (${Prisma.join(acesso.grupos)})
      AND (NOT a.sensivel OR ${acesso.sensivel})
      ${acesso.orgaosOmitidos.length ? Prisma.sql`AND (a.orgao_id IS NULL OR a.orgao_id NOT IN (${Prisma.join(acesso.orgaosOmitidos)}))` : Prisma.empty}`;
  }

  private documentoVisivel(acesso: Acesso) {
    const restrito = acesso.restritos.length ? Prisma.sql`(NOT d.restrito OR d.contexto_id IN (${Prisma.join(acesso.restritos)}))` : Prisma.sql`NOT d.restrito`;
    return Prisma.sql`(${restrito}
      ${acesso.contextosOmitidos.length ? Prisma.sql`AND d.contexto_id NOT IN (${Prisma.join(acesso.contextosOmitidos)})` : Prisma.empty})`;
  }

  private async alvo(tx: Tx, acesso: Acesso, chave: ChaveAlvoAta) {
    const [alvo] = await tx.$queryRaw<Alvo[]>`
      SELECT a.* FROM e09_alvo a
      WHERE ${this.alvoVisivel(acesso)} AND a.grupo = ${chave.grupo}
        AND a.alvo_id = ${chave.alvo_id} AND a.etapa = ${chave.etapa}
    `;
    if (!alvo) throw new NotFoundException('Ato não encontrado ou indisponível.');
    return alvo;
  }

  private contextoCompativel(alvo: Alvo) {
    switch (alvo.criterio) {
      case 'ASSEMBLEIA':
        return Prisma.sql`c.tipo = 'ASSEMBLEIA_GERAL'`;
      case 'ORGAO':
        return Prisma.sql`c.orgao_id = ${alvo.orgao_id}`;
      case 'CONSELHO_OU_ASSEMBLEIA':
        return Prisma.sql`(o.tipo = 'CONSELHO' OR c.tipo = 'ASSEMBLEIA_GERAL')`;
      default:
        return Prisma.sql`o.tipo = 'CONSELHO'`;
    }
  }

  private atasCompativeis(acesso: Acesso, alvo: Alvo) {
    return Prisma.sql`
      FROM documento_versao v
      JOIN documento d ON d.id = v.documento_id AND d.igreja_id = v.igreja_id
      JOIN contexto_secretaria c ON c.id = d.contexto_id AND c.igreja_id = d.igreja_id
      LEFT JOIN orgao_interno o ON o.id = c.orgao_id AND o.igreja_id = c.igreja_id
      LEFT JOIN expedicao_documento e ON e.versao_id = v.id
      WHERE d.igreja_id = ${acesso.igreja} AND d.tipo = 'ATA'
        AND d.estado NOT IN ('CANCELADO', 'ANULADO')
        AND (v.numero = d.versao_atual OR e.estado = 'CONCLUIDA')
        AND ${this.documentoVisivel(acesso)} AND ${this.contextoCompativel(alvo)}
        AND (NOT ${alvo.sensivel} OR d.restrito)
    `;
  }

  async buscar(ator: AtorSecretaria, chave: ChaveAlvoAta, filtros: unknown) {
    return this.prisma.$transaction(
      async (tx) => {
        const acesso = await this.acesso(tx, ator);
        const alvo = await this.alvo(tx, acesso, chave);
        const reunioes = !acesso.grupos.some(grupo => grupo !== 'FINANCEIRO') ? [] :
          (await this.base.concessoes(tx, ator)).filter(c => c.pode_consultar_restritos).map(c => c.contexto_id);
        return selecionarDocumentos(tx, this.atasCompativeis(acesso, alvo), filtros, false, reunioes);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private situacao() {
    return Prisma.sql`CASE
      WHEN r.id IS NULL THEN 'PENDENTE'
      WHEN r.referencia_externa IS NOT NULL THEN 'EXTERNA_CONFERIDA'
      WHEN r.versao_id IS NULL THEN 'PENDENTE'
      WHEN d.estado = 'ANULADO' THEN 'ANULADA'
      WHEN v.legada_superada THEN 'SUPERADA'
      WHEN d.estado = 'LEGADA_CONFERIDA' THEN 'LEGADA_CONFERIDA'
      WHEN e.estado = 'CONCLUIDA' AND e.expedido_em IS NOT NULL AND e.arquivo_final_id IS NOT NULL THEN 'FORMALIZADA'
      WHEN d.estado = 'CANCELADO' OR v.numero <> d.versao_atual THEN 'SUPERADA'
      ELSE 'MINUTA_VINCULADA' END`;
  }

  private async historico(tx: Tx, acesso: Acesso, chave: ChaveAlvoAta, pagina: number) {
    return tx.$queryRaw<Revisao[]>`
      SELECT r.id, r.ata_documento_id, r.versao_id, r.referencia_externa,
        r.justificativa, r.criado_em, u.nome_usuario AS operador, ${this.situacao()} AS situacao,
        CASE WHEN d.id IS NOT NULL THEN jsonb_build_object(
          'documento_id', d.id, 'contexto_id', d.contexto_id, 'versao_id', v.id, 'numero', d.numero, 'ano', d.ano, 'sigla', d.sigla,
          'data', v.data_documento, 'versao', v.numero, 'estado', d.estado,
          'contexto', coalesce(v.fonte_congelada #>> '{contexto,nome}', c.nome),
          'numero_formatado', coalesce(v.numero_original, v.fonte_congelada->>'numero', d.identificacao_livro)) END AS ata
      FROM e09_referencia r
      JOIN usuarios u ON u.id = r.registrado_por_id AND u.igreja_id = r.igreja_id
      LEFT JOIN documento_versao v ON v.id = r.versao_id AND v.igreja_id = r.igreja_id
      LEFT JOIN documento d ON d.id = r.ata_documento_id AND d.igreja_id = r.igreja_id
      LEFT JOIN contexto_secretaria c ON c.id = d.contexto_id
      LEFT JOIN expedicao_documento e ON e.versao_id = v.id
      WHERE r.igreja_id = ${acesso.igreja} AND r.grupo = ${chave.grupo}
        AND r.alvo_id = ${chave.alvo_id} AND r.etapa = ${chave.etapa}
        AND (d.id IS NULL OR ${this.documentoVisivel(acesso)})
      ORDER BY r.sequencia DESC OFFSET ${pagina * tamanho} LIMIT ${tamanho + 1}
    `;
  }

  private ultima(tx: Tx, acesso: Acesso, chave: ChaveAlvoAta) {
    return tx.$queryRaw<{ id: string; sequencia: number; visivel: boolean }[]>`
      SELECT r.id, r.sequencia, (d.id IS NULL OR ${this.documentoVisivel(acesso)}) AS visivel
      FROM e09_referencia r LEFT JOIN documento d ON d.id = r.ata_documento_id AND d.igreja_id = r.igreja_id
      WHERE r.igreja_id = ${acesso.igreja} AND r.grupo = ${chave.grupo}
        AND r.alvo_id = ${chave.alvo_id} AND r.etapa = ${chave.etapa}
      ORDER BY r.sequencia DESC LIMIT 1
    `;
  }

  async consultar(ator: AtorSecretaria, chave: ChaveAlvoAta, pagina: number) {
    return this.prisma.$transaction(
      async (tx) => {
        const acesso = await this.acesso(tx, ator);
        const alvo = await this.alvo(tx, acesso, chave);
        const [ultima] = await this.ultima(tx, acesso, chave);
        if (ultima && !ultima.visivel) throw new NotFoundException('Referência indisponível.');
        const historico = this.pagina(await this.historico(tx, acesso, chave, pagina));
        return {
          ...historico,
          situacao: ultima ? (pagina === 0 ? historico.itens[0]?.situacao : undefined) : 'PENDENTE',
          pode_editar: this.podeEditar(acesso, alvo),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private podeEditar(acesso: Acesso, alvo: Alvo) {
    const pode = acesso.registraVinculo && (alvo.grupo !== 'FINANCEIRO' || acesso.registraFinanceiro);
    return pode && (!alvo.sensivel || acesso.registraSensivel);
  }

  async registrar(ator: AtorSecretaria, chave: ChaveAlvoAta, entrada: unknown) {
    const dados = validar(referenciaAta, entrada);
    try {
      return await transacaoSerializavel(this.prisma, async (tx) => {
        if (ator.sessao_id && ator.auth_version !== undefined) {
          await exigirServicoNaTransacao(tx, { ...ator, sessao_id: ator.sessao_id, auth_version: ator.auth_version }, 'VINCULOS_DOCUMENTAIS_REGISTRAR');
        } else {
          throw new ForbiddenException('Sessão indisponível.');
        }
        const acesso = await this.acesso(tx, ator);
        const alvo = await this.alvo(tx, acesso, chave);
        if (!this.podeEditar(acesso, alvo))
          throw new ForbiddenException('Perfil sem permissão para corrigir esta referência.');
        const [ultima] = await this.ultima(tx, acesso, chave);
        if (ultima && !ultima.visivel) throw new NotFoundException('Referência indisponível.');
        if ((ultima?.id ?? null) !== dados.revisao_esperada) {
          throw new ConflictException('Referência alterada. Recarregue antes de corrigir.');
        }
        if (dados.versao_id) {
          const [ata] = await tx.$queryRaw<{ id: string }[]>`
            SELECT v.id ${this.atasCompativeis(acesso, alvo)}
            AND v.id = ${dados.versao_id} AND d.id = ${dados.ata_documento_id} LIMIT 1
          `;
          if (!ata) throw new BadRequestException('Ata ou contexto incompatível ou indisponível.');
        }
        return this.gravar(tx, ator, chave, dados, (ultima?.sequencia ?? 0) + 1);
      });
    } catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002') {
        throw new ConflictException('Referência alterada. Recarregue antes de corrigir.');
      }
      throw erro;
    }
  }

  private async gravar(
    tx: Tx,
    ator: AtorSecretaria,
    chave: ChaveAlvoAta,
    dados: EntradaReferenciaAta,
    sequencia: number,
  ) {
    const comum = {
      igreja_id: ator.igreja_id,
      registrado_por_id: ator.sub,
      sequencia,
      ata_documento_id: dados.ata_documento_id,
      versao_id: dados.versao_id,
      referencia_externa: dados.referencia_externa,
      justificativa: dados.justificativa,
    };
    const registro = await this.inserir(tx, chave, comum);
    await tx.logs_atividades.create({
      data: {
        igreja_id: ator.igreja_id,
        usuario_id: ator.sub,
        acao: 'ATUALIZACAO',
        tabela_afetada: 'referencia_ata',
        registro_id: registro.id,
        dados_novos: { operacao: sequencia === 1 ? 'INCLUSAO' : 'CORRECAO' },
      },
    });
    return { id: registro.id };
  }

  private inserir(
    tx: Tx,
    chave: ChaveAlvoAta,
    dados: Omit<Prisma.referencia_ata_membresiaUncheckedCreateInput, 'evento_id'>,
  ) {
    switch (chave.grupo) {
      case 'MEMBRESIA':
        return tx.referencia_ata_membresia.create({ data: { ...dados, evento_id: chave.alvo_id } });
      case 'MANDATO':
      case 'PASTORAL':
        return tx.referencia_ata_oficial.create({
          data: {
            ...dados,
            ato: chave.etapa,
            ...(chave.grupo === 'MANDATO' ? { mandato_id: chave.alvo_id } : { vinculo_id: chave.alvo_id }),
          },
        });
      case 'ORGAO':
      case 'FINANCEIRO':
        return tx.referencia_ata_institucional.create({
          data: {
            ...dados,
            etapa: chave.etapa,
            ...(chave.grupo === 'ORGAO' ? { ato_orgao_id: chave.alvo_id } : { autorizacao_id: chave.alvo_id }),
          },
        });
    }
  }

  private situacoesAtuais(acesso: Acesso, filtrar: Prisma.Sql) {
    return Prisma.sql`
      SELECT a.grupo, a.alvo_id, a.etapa, a.tipo, a.titulo, a.data, a.orgao_id,
        v.numero AS versao, ${this.situacao()} AS situacao
      FROM e09_alvo a
      LEFT JOIN LATERAL (
        SELECT * FROM e09_referencia ref WHERE ref.igreja_id = a.igreja_id
          AND ref.grupo = a.grupo AND ref.alvo_id = a.alvo_id AND ref.etapa = a.etapa
        ORDER BY ref.sequencia DESC LIMIT 1
      ) r ON true
      LEFT JOIN documento_versao v ON v.id = r.versao_id AND v.igreja_id = a.igreja_id
      LEFT JOIN documento d ON d.id = r.ata_documento_id AND d.igreja_id = a.igreja_id
      LEFT JOIN expedicao_documento e ON e.versao_id = v.id
      WHERE ${this.alvoVisivel(acesso)} AND (d.id IS NULL OR ${this.documentoVisivel(acesso)})
        AND ${filtrar}
    `;
  }

  async vinculados(ator: AtorSecretaria, id: string, pagina: number) {
    return this.prisma.$transaction(
      async (tx) => {
        const acesso = await this.acesso(tx, ator);
        if (!acesso.grupos.some(grupo => grupo !== 'FINANCEIRO')) throw new ForbiddenException('Consulta reservada à Secretaria.');
        const [ata] = (await tx.$queryRaw`
        SELECT d.id FROM documento d WHERE d.id = ${id} AND d.igreja_id = ${acesso.igreja}
        AND d.tipo = 'ATA' AND ${this.documentoVisivel(acesso)}
      `) as { id: string }[];
        if (!ata) throw new NotFoundException('Ata não encontrada.');
        const itens = (await tx.$queryRaw`
        ${this.situacoesAtuais(acesso, Prisma.sql`r.ata_documento_id = ${id}`)}
        ORDER BY a.data DESC, a.grupo, a.alvo_id, a.etapa OFFSET ${pagina * tamanho} LIMIT ${tamanho + 1}
      `) as unknown[];
        return this.pagina(itens);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private async atosParaReatribuir(tx: Tx, ator: AtorSecretaria, documento: string) {
    const acesso = await this.acesso(tx, ator);
    await this.base.documento(tx, ator, documento);
    const atos = await tx.$queryRaw<(Alvo & { referencia_id: string; sequencia: number; versao_id: string })[]>`
      SELECT a.*, r.id AS referencia_id, r.sequencia, r.versao_id
      FROM e09_alvo a
      JOIN LATERAL (
        SELECT * FROM e09_referencia ref WHERE ref.igreja_id=a.igreja_id
          AND ref.grupo=a.grupo AND ref.alvo_id=a.alvo_id AND ref.etapa=a.etapa
        ORDER BY ref.sequencia DESC LIMIT 1
      ) r ON true
      WHERE ${this.alvoVisivel(acesso)} AND r.ata_documento_id=${documento}
      ORDER BY a.data, a.grupo, a.alvo_id, a.etapa
    `;
    const [contagem] = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total FROM e09_referencia r
      WHERE r.igreja_id=${ator.igreja_id} AND r.ata_documento_id=${documento}
        AND NOT EXISTS (SELECT 1 FROM e09_referencia posterior
          WHERE posterior.igreja_id=r.igreja_id AND posterior.grupo=r.grupo
            AND posterior.alvo_id=r.alvo_id AND posterior.etapa=r.etapa AND posterior.sequencia>r.sequencia)
    `;
    if (Number(contagem.total) !== atos.length)
      throw new ForbiddenException('Há atos vinculados que seu acesso não permite consultar. A edição exige a conferência por um responsável com acesso a esses atos.');
    return { acesso, atos };
  }

  async prepararReatribuicao(ator: AtorSecretaria, documento: string) {
    return this.prisma.$transaction(async tx => {
      const { acesso, atos } = await this.atosParaReatribuir(tx, ator, documento);
      return atos.map(ato => ({
        referencia_id: ato.referencia_id, grupo: ato.grupo, alvo_id: ato.alvo_id,
        etapa: ato.etapa, tipo: ato.tipo, titulo: ato.titulo, data: ato.data,
        pode_reatribuir: this.podeEditar(acesso, ato),
      }));
    }, { isolationLevel: 'RepeatableRead' });
  }

  // Executado na mesma transação da nova versão. Nunca altera o histórico anterior.
  async reatribuirNaEdicao(tx: Tx, ator: AtorSecretaria, origem: string,
    documento: string, versao: string, escolha?: ReatribuicaoAtos) {
    const { acesso, atos } = await this.atosParaReatribuir(tx, ator, origem);
    const vistas = new Set(escolha?.vistas ?? []);
    if ((atos.length > 0 && !escolha) || vistas.size !== atos.length || atos.some(a => !vistas.has(a.referencia_id)))
      throw new ConflictException('Confira os atos vinculados antes de salvar. A lista pode ter sido alterada.');
    const selecionadas = new Set(escolha?.selecionadas ?? []);
    if ([...selecionadas].some(id => !vistas.has(id))) throw new BadRequestException('Seleção de atos inválida.');
    if (!selecionadas.size) return;
    if (ator.sessao_id && ator.auth_version !== undefined) {
      await exigirServicoNaTransacao(tx, { ...ator, sessao_id: ator.sessao_id, auth_version: ator.auth_version }, 'VINCULOS_DOCUMENTAIS_REGISTRAR');
    } else {
      throw new ForbiddenException('Sessão indisponível.');
    }
    const destino = await tx.documento_versao.findFirst({ where: { id: versao, documento_id: documento, igreja_id: ator.igreja_id } });
    if (!destino) throw new BadRequestException('Versão de destino indisponível.');
    for (const ato of atos.filter(a => selecionadas.has(a.referencia_id))) {
      if (!this.podeEditar(acesso, ato)) throw new ForbiddenException('Sem permissão para reatribuir este ato.');
      await this.gravar(tx, ator, ato, {
        ata_documento_id: documento, versao_id: versao, revisao_esperada: ato.referencia_id,
        justificativa: 'Reatribuição à nova versão da ata, confirmada na edição. Referência anterior: ' + ato.referencia_id,
      }, ato.sequencia + 1);
    }
  }

  async pendencias(ator: AtorSecretaria, pagina: number, grupo?: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const acesso = await this.acesso(tx, ator);
        const itens = (await tx.$queryRaw`
        ${this.situacoesAtuais(
          acesso,
          Prisma.sql`(a.acompanha OR r.id IS NOT NULL)
          AND ${this.situacao()} NOT IN ('FORMALIZADA', 'EXTERNA_CONFERIDA', 'LEGADA_CONFERIDA')
          ${grupo ? Prisma.sql`AND a.grupo = ${grupo}` : Prisma.empty}`,
        )}
        ORDER BY a.data DESC NULLS LAST, a.grupo, a.alvo_id, a.etapa OFFSET ${pagina * tamanho} LIMIT ${tamanho + 1}
      `) as unknown[];
        return this.pagina(itens);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private pagina<T>(itens: T[]) {
    return { itens: itens.slice(0, tamanho), tem_proxima: itens.length > tamanho };
  }

  async listarFinanceiro(ator: AtorSecretaria, pagina: number, projeto?: string, conta?: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const acesso = await this.acesso(tx, ator);
        const itens = (await tx.$queryRaw`
        SELECT f.id, f.tipo, f.assunto, f.data_decisao, f.autoridade, f.evidencia,
          p.nome AS projeto, c.descricao AS conta, ${this.situacao()} AS situacao
        FROM autorizacao_financeira_documental f
        LEFT JOIN acoes p ON p.id = f.projeto_id AND p.igreja_id = f.igreja_id
        LEFT JOIN contas c ON c.id = f.conta_id AND c.igreja_id = f.igreja_id
        LEFT JOIN LATERAL (SELECT * FROM referencia_ata_institucional r
          WHERE r.igreja_id = f.igreja_id AND r.autorizacao_id = f.id ORDER BY r.sequencia DESC LIMIT 1) r ON true
        LEFT JOIN documento d ON d.id = r.ata_documento_id AND d.igreja_id = f.igreja_id
        LEFT JOIN documento_versao v ON v.id = r.versao_id AND v.igreja_id = f.igreja_id
        LEFT JOIN expedicao_documento e ON e.versao_id = v.id
        WHERE f.igreja_id = ${acesso.igreja} AND (d.id IS NULL OR ${this.documentoVisivel(acesso)})
          ${projeto ? Prisma.sql`AND f.projeto_id = ${projeto}` : Prisma.empty}
          ${conta ? Prisma.sql`AND f.conta_id = ${conta}` : Prisma.empty}
        ORDER BY f.data_decisao DESC, f.id OFFSET ${pagina * tamanho} LIMIT ${tamanho + 1}
      `) as unknown[];
        return { ...this.pagina(itens), pode_criar: acesso.registraFinanceiro };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async registrarFinanceiro(ator: AtorSecretaria, entrada: unknown) {
    const dados = validar(autorizacaoFinanceira, entrada);
    const { idempotencia, tipo, assunto, data_decisao, autoridade, evidencia, projeto_id, conta_id } = dados;
    try {
      return await transacaoSerializavel(this.prisma, async (tx) => {
        if (ator.sessao_id && ator.auth_version !== undefined) {
          await exigirServicoNaTransacao(tx, { ...ator, sessao_id: ator.sessao_id, auth_version: ator.auth_version }, 'AUTORIZACOES_FINANCEIRAS_REGISTRAR');
        } else {
          throw new ForbiddenException('Sessão indisponível.');
        }
        const acesso = await this.acesso(tx, ator);
        if (!acesso.registraFinanceiro)
          throw new ForbiddenException('Perfil sem permissão para registrar autorizações financeiras.');
        if (data_decisao > (await hojeDaIgreja(tx, acesso.igreja)))
          throw new BadRequestException('A data da decisão deve corresponder a um ato já realizado.');
        const data = {
          tipo,
          assunto,
          data_decisao: dataCivil(data_decisao),
          autoridade,
          evidencia,
          projeto_id,
          conta_id,
        };
        const anterior = await tx.autorizacao_financeira_documental.findFirst({
          where: {
            id: idempotencia,
            igreja_id: acesso.igreja,
            registrado_por_id: ator.sub,
            ...data,
            projeto_id: projeto_id ?? null,
            conta_id: conta_id ?? null,
          },
        });
        if (anterior) return { id: anterior.id };
        if (
          projeto_id &&
          !(await tx.acoes.findFirst({ where: { id: projeto_id, igreja_id: acesso.igreja }, select: { id: true } }))
        )
          throw new NotFoundException('Projeto não encontrado.');
        if (
          conta_id &&
          !(await tx.contas.findFirst({ where: { id: conta_id, igreja_id: acesso.igreja }, select: { id: true } }))
        )
          throw new NotFoundException('Conta não encontrada.');
        const registro = await tx.autorizacao_financeira_documental.create({
          data: { ...data, id: idempotencia, igreja_id: acesso.igreja, registrado_por_id: ator.sub },
          select: { id: true },
        });
        await tx.logs_atividades.create({
          data: {
            igreja_id: acesso.igreja,
            usuario_id: ator.sub,
            acao: 'CRIACAO',
            tabela_afetada: 'autorizacao_financeira_documental',
            registro_id: registro.id,
            dados_novos: { operacao: 'REGISTRO_DOCUMENTAL' },
          },
        });
        return registro;
      });
    } catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2002') {
        throw new ConflictException('Registro já recebido. Consulte as autorizações registradas.');
      }
      throw erro;
    }
  }
}
