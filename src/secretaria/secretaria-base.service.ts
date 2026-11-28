import { permissoesAtas, permissoesAtasDaConta } from './sigilo-ata';
import type { Conta } from '../autorizacao/politica';
import { orgaosDeAtuacao, presidenciaSociedades } from '../orgaos/acesso-sociedades';
import { sociedadeJuvenil } from '../orgaos/sociedades-regras';
import { mesaVigente } from './mesa-assembleia';
import { contaDaSessao, papeisDaConta, type Ator } from '../autorizacao/politica';
import { AtuacaoModeloService, type AcaoModelo } from './atuacao-modelo.service';
import { configuracaoSchema } from './secretaria.dto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, usuarios_perfil, type competencia_secretaria } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { conflitoDeTransacao, hashAto, transacaoComRetentativa } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { incluirResolucoes } from './resolucoes';

export interface AtorSecretaria extends Partial<Ator> { sub: string; igreja_id: string; perfil: usuarios_perfil }
export type Tx = Prisma.TransactionClient;
export const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const dataCivil = (v: string) => new Date(`${v}T00:00:00.000Z`);

@Injectable()
export class SecretariaBaseService {
  constructor(readonly prisma: PrismaService, readonly atuacao: AtuacaoModeloService) {}

  async operador(tx: Tx, ator: AtorSecretaria, consultarAtas = false) {
    if (ator.perfil === 'COMUM') {
      if (!ator.sessao_id || ator.auth_version === undefined) throw new ForbiddenException('Sessão institucional indisponível.');
      const conta = await contaDaSessao(tx, { ...ator, sessao_id: ator.sessao_id, auth_version: ator.auth_version });
      if (conta.perfil !== 'COMUM') throw new ForbiddenException('Perfil da conta alterado.');
    }
    const u = await tx.usuarios.findFirst({ where: { id: ator.sub, igreja_id: ator.igreja_id, ativo: true } });
    if (!u) throw new ForbiddenException('Operador não autorizado.');
    return u;
  }

  async comando(ator: AtorSecretaria, operacao: string, alvo: string | null, dados: { idempotencia: string }, executar: (tx: Tx) => Promise<unknown>, autorizar?: (tx: Tx) => Promise<void>) {
    const disputaDeChave = (erro: unknown) => {
      if (!(erro instanceof Prisma.PrismaClientKnownRequestError) || erro.code !== 'P2002') return false;
      const colunas = erro.meta?.target;
      return Array.isArray(colunas) && ((colunas.includes('igreja_id') && colunas.includes('chave')) ||
        (operacao === 'ASSEMBLEIA_FOLHA' && colunas.includes('reuniao_id') && colunas.includes('versao')));
    };
    return transacaoComRetentativa(this.prisma, async tx => {
      const operador = await this.operador(tx, ator, operacao === 'SIGILO_ATA');
      if (operador.perfil === 'AUDITOR' && operacao !== 'SIGILO_ATA') throw new ForbiddenException('Perfil de consulta não pode executar comandos.');
      if ((operacao.startsWith('CAMPO_') || operacao.startsWith('LOCAL_')) && !await this.podeGerirCadastros(tx, operador)) throw new ForbiddenException('Cadastro de campos reservado à Secretaria.');
      if (['CRIAR_MODELO', 'EDITAR_MODELO', 'SALVAR_RASCUNHO_MODELO', 'PUBLICAR_MODELO', 'VERSIONAR_MODELO'].includes(operacao)) {
        const contextoId = operacao === 'CRIAR_MODELO' ? alvo : (await tx.modelo_documento.findFirst({
          where: { id: alvo ?? '', igreja_id: ator.igreja_id }, select: { contexto_id: true },
        }))?.contexto_id;
        if (!contextoId) throw new NotFoundException('Modelo não encontrado.');
        const contexto = await this.contextoAtivo(tx, ator, contextoId);
        if (operador.perfil !== 'ADMINISTRADOR' && !await this.podeEditarAtaLegada(tx, contexto, operador))
          throw new ForbiddenException('Gestão de modelos reservada à administração ou à secretaria em exercício neste contexto.');
      }
      await autorizar?.(tx);
      const chave = dados.idempotencia.toLowerCase(), hash = hashAto({ operacao, alvo, dados });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ator.igreja_id + ':secretaria:' + chave}, 0))`;
      const anterior = await tx.comando_secretaria.findUnique({ where: { igreja_id_chave: { igreja_id: ator.igreja_id, chave } } });
      if (anterior) {
        if (anterior.hash !== hash || anterior.usuario_id !== ator.sub) throw new ConflictException('Chave de repetição já utilizada.');
        // A idempotência não preserva permissões revogadas nem expõe conteúdo restrito.
        if (operacao.startsWith('LIVRO_')) {
          const resultado = anterior.resultado as Record<string, unknown>;
          const livro = typeof resultado.id === 'string' ? await tx.livro_atas.findFirst({ where: { id: resultado.id, igreja_id: ator.igreja_id } }) : null;
          if (!livro) throw new ConflictException('Livro anterior indisponível.');
          if (livro.restrito) await this.competente(tx, ator, livro.contexto_id, 'pode_consultar_restritos');
          if (operacao === 'LIVRO_CRIAR') await this.preparar(tx, ator, livro.contexto_id);
          else await this.competente(tx, ator, livro.contexto_id, 'pode_aprovar');
        }
        if (operacao.includes('DOCUMENTO') || ['ENCAMINHAR', 'APROVAR', 'CANCELAR', 'ANULAR', 'DELIBERAR_ATA'].includes(operacao)) {
          const resultado = anterior.resultado as Record<string, unknown>;
          const documentoId = ['CRIAR_DOCUMENTO', 'CRIAR_DOCUMENTO_LEGADO'].includes(operacao) ? resultado.id : alvo;
          if (typeof documentoId !== 'string') throw new ConflictException('Resultado anterior indisponível.');
          const documento = await this.documento(tx, ator, documentoId);
          if (operacao === 'EDITAR_DOCUMENTO_LEGADO') await this.exigirEdicaoAtaLegada(tx, ator, documento.contexto_id);
          else if (['CRIAR_DOCUMENTO', 'EDITAR_DOCUMENTO', 'ENCAMINHAR'].includes(operacao)) {
            const modelo = documento.versoes.find(v => v.numero === documento.versao_atual)?.modelo;
            if (!modelo) throw new ConflictException('Modelo anterior indisponível.');
            const acao = operacao === 'EDITAR_DOCUMENTO' || (operacao === 'ENCAMINHAR' && operador.perfil === 'COMUM') ? 'editar' : operacao === 'CRIAR_DOCUMENTO' && 'acao' in dados && dados.acao === 'preparar' ? 'preparar' : 'criar';
            if (operador.perfil === 'COMUM') {
              const versao = documento.versoes.find(v => v.numero === documento.versao_atual);
              if (versao?.reuniao_id && documento.tipo === 'ATA' && await mesaVigente(tx, { id: versao.reuniao_id, igreja_id: ator.igreja_id, contexto_id: documento.contexto_id }))
                throw new ForbiddenException('A redação desta sessão está sob a mesa.');
            }
            await this.autorizarModelo(tx, ator, documento.contexto_id, modelo.configuracao, acao, operacao !== 'CRIAR_DOCUMENTO');
          }
          else await this.competente(tx, ator, documento.contexto_id, operacao === 'DELIBERAR_ATA' ? 'pode_deliberar' : 'pode_aprovar');
        }
        if (['CRIAR_CONTEXTO', 'CONCEDER_COMPETENCIA', 'ENCERRAR_COMPETENCIA'].includes(operacao) && operador.perfil !== 'ADMINISTRADOR') throw new ForbiddenException('Configuração técnica reservada ao administrador.');
        return anterior.resultado;
      }
      const resultado = await executar(tx);
      const r = json(resultado);
      const comando = await tx.comando_secretaria.create({ data: { igreja_id: ator.igreja_id, usuario_id: ator.sub, chave, operacao, alvo_id: alvo, hash, dados: json(dados), resultado: r } });
      await tx.logs_atividades.create({ data: { igreja_id: ator.igreja_id, usuario_id: ator.sub, acao: 'ATUALIZACAO', tabela_afetada: 'comando_secretaria', registro_id: comando.id, dados_novos: { operacao, alvo_id: alvo } } });
      return r;
    }, Prisma.TransactionIsolationLevel.Serializable, disputaDeChave, 7).catch((erro: unknown) => {
      if (conflitoDeTransacao(erro) || disputaDeChave(erro)) throw new ConflictException('A Secretaria está processando operações concorrentes. Tente novamente.');
      throw erro;
    });
  }

  async contexto(tx: Tx, ator: AtorSecretaria, id: string) {
    const c = await tx.contexto_secretaria.findFirst({ where: { id, igreja_id: ator.igreja_id }, include: { orgao: true } });
    if (!c) throw new NotFoundException('Contexto não encontrado nesta igreja.');
    if ((ator.perfil === 'COMUM' || sociedadeJuvenil(c.orgao.tipo_padrao)) && !await this.contextoVisivel(tx, c, await this.operador(tx, ator)))
      throw new NotFoundException('Contexto indisponível para esta conta de atuação.');
    return { ...c, nome: c.orgao.nome, sigla: c.orgao.sigla ?? c.sigla };
  }

  async contextoDeAtas(tx: Tx, ator: AtorSecretaria, id: string) {
    const conta = await this.operador(tx, ator, true);
    const c = await tx.contexto_secretaria.findFirst({ where: { id, igreja_id: ator.igreja_id }, include: { orgao: true } });
    if (!c) throw new NotFoundException('Contexto indisponível.');
    const somenteAtas = !await this.contextoVisivel(tx, c, conta);
    if (somenteAtas && !(await permissoesAtas(tx, ator.igreja_id, conta.pessoa_id)).get(id)?.ler)
      throw new NotFoundException('Contexto indisponível.');
    return { contexto: c, somenteAtas };
  }

  async contextoVisivel(tx: Tx, contexto: Parameters<AtuacaoModeloService['papeis']>[1] & {
    orgao: { tipo: string; ativo: boolean; tipo_padrao: string | null; gestao_presidencial: boolean };
  }, conta: Conta) {
    const juvenil = sociedadeJuvenil(contexto.orgao.tipo_padrao);
    if (conta.perfil !== 'COMUM' && !juvenil) return true;
    const dia = await hojeDaIgreja(tx, contexto.igreja_id);
    if (!juvenil && (await this.competenciasDaConta(tx, conta, dia, contexto.id)).length) return true;
    if (contexto.orgao.tipo === 'SOCIEDADE_INTERNA' || contexto.orgao.gestao_presidencial) {
      if (await presidenciaSociedades(tx, conta, dia)) return true;
      return (await orgaosDeAtuacao(tx, conta, dia)).includes(contexto.orgao_id!);
    }
    return (await this.papeisContextuais(tx, contexto, conta)).size > 0;
  }

  async papeisContextuais(tx: Tx, contexto: Parameters<AtuacaoModeloService['papeis']>[1],
    conta: Conta, dia?: string) {
    if (!(['CONSELHO', 'JUNTA', 'ASSEMBLEIA_GERAL', 'SOCIEDADE_INTERNA'].includes(contexto.orgao?.tipo ?? '') || contexto.orgao?.gestao_presidencial) || !conta.conta_atuacao || !conta.pessoa_id)
      return new Set<string>();
    const referencia = dia ?? await hojeDaIgreja(tx, contexto.igreja_id);
    const cargos = await this.atuacao.papeis(tx, contexto, conta.pessoa_id, referencia);
    const papeis = (await papeisDaConta(tx, conta, cargos, referencia)).papeis;
    if (contexto.orgao?.tipo !== 'ASSEMBLEIA_GERAL' || !papeis.size) return papeis;
    const secretaria = await tx.cargo_orgao.findMany({ where: { id: { in: [...papeis] }, igreja_id: contexto.igreja_id,
      orgao: { tipo: 'CONSELHO', ativo: true }, OR: [{ funcao: 'SECRETARIO' }, { codigo: { in: ['SECRETARIO','PRIMEIRO_SECRETARIO','SEGUNDO_SECRETARIO'] } }] },
      select: { id: true } });
    return new Set(secretaria.map(cargo => cargo.id));
  }

  private async competenciasDaConta(tx: Tx, conta: Conta, dia: string, contexto?: string): Promise<competencia_secretaria[]> {
    if (!conta.pessoa_id) return [];
    const hoje = dataCivil(dia);
    return tx.competencia_secretaria.findMany({ where: { igreja_id: conta.igreja_id, usuario_id: conta.id, pessoa_id: conta.pessoa_id,
      ...(contexto && { contexto_id: contexto }), ...(conta.perfil === 'COMUM' && { geracao_vinculo: conta.geracao_vinculo }),
      inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }],
    } });
  }

  async concessoes(tx: Tx, ator: AtorSecretaria, contexto?: string): Promise<competencia_secretaria[]> {
    const conta = await tx.usuarios.findFirst({ where: { id: ator.sub, igreja_id: ator.igreja_id, ativo: true } });
    return conta ? this.competenciasDaConta(tx, conta, await hojeDaIgreja(tx, ator.igreja_id), contexto) : [];
  }

  async podeEditarAtaLegada(tx: Tx, contexto: Parameters<AtuacaoModeloService['papeis']>[1], conta: Conta) {
    if (!conta.ativo || contexto.orgao?.ativo !== true) return false;
    if (conta.perfil !== 'COMUM' || !conta.conta_atuacao || !conta.pessoa_id) return false;
    const papeis = await this.papeisContextuais(tx, contexto, conta);
    if (!papeis.size) return false;
    return !!await tx.cargo_orgao.findFirst({ where: {
      igreja_id: conta.igreja_id, id: { in: [...papeis] }, ativo: true,
      OR: [{ funcao: 'SECRETARIO' }, { codigo: { in: ['SECRETARIO', 'PRIMEIRO_SECRETARIO', 'SEGUNDO_SECRETARIO'] } }],
    }, select: { id: true } });
  }

  async podeGerirCadastros(tx: Tx, conta: Conta) {
    if (!conta.ativo) return false;
    if (conta.perfil === 'ADMINISTRADOR') return true;
    if (conta.perfil !== 'COMUM' || !conta.conta_atuacao) return false;
    const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: conta.igreja_id, orgao: { ativo: true } }, include: { orgao: true } });
    for (const contexto of contextos) if (await this.podeEditarAtaLegada(tx, contexto, conta)) return true;
    return false;
  }

  async exigirEdicaoAtaLegada(tx: Tx, ator: AtorSecretaria, contextoId: string) {
    const conta = await this.operador(tx, ator);
    const contexto = await this.contexto(tx, ator, contextoId);
    if (!await this.podeEditarAtaLegada(tx, contexto, conta))
      throw new ForbiddenException('Edição de ata legada reservada à secretaria em exercício neste contexto.');
  }

  async podePreparar(tx: Tx, ator: AtorSecretaria, contexto: string, u: { perfil: usuarios_perfil }) {
    if (u.perfil === 'COMUM') { await this.contexto(tx, ator, contexto); return true; }
    return (u.perfil !== 'AUDITOR' && (await this.concessoes(tx, ator, contexto)).some(c => c.pode_aprovar || c.pode_deliberar));
  }

  async contextoAtivo(tx: Tx, ator: AtorSecretaria, contexto: string) {
    const c = await this.contexto(tx, ator, contexto);
    if (!c.orgao.ativo) throw new ForbiddenException('O órgão está inativo para novos atos.');
    return c;
  }

  async preparar(tx: Tx, ator: AtorSecretaria, contexto: string) {
    const u = await this.operador(tx, ator);
    await this.contextoAtivo(tx, ator, contexto);
    if (await this.podePreparar(tx, ator, contexto, u)) return u;
    throw new ForbiddenException('Preparação reservada à secretaria ou gestor habilitado.');
  }

  async autorizarModelo(tx: Tx, ator: AtorSecretaria, contexto: string, configuracao: Prisma.JsonValue, acao: AcaoModelo, existente = false) {
    const u = await this.preparar(tx, ator, contexto);
    const c = await this.contexto(tx, ator, contexto);
    const regra = configuracaoSchema.parse(configuracao).atuacao;
    if (!regra) {
      throw new ConflictException('Defina os cargos autorizados e publique uma nova versão deste modelo.');
    }
    if (u.perfil === 'COMUM') {
      const papeis = await this.papeisContextuais(tx, c, u);
      const pode = c.orgao.tipo === 'ASSEMBLEIA_GERAL' ? acao !== 'criar' && regra.preparar.some(id => papeis.has(id))
        : (acao === 'editar' ? [...regra.criar, ...regra.preparar] : regra[acao]).some(id => papeis.has(id));
      if (!pode)
        throw new ForbiddenException('Seu cargo vigente precisa estar habilitado nesta ação do modelo.');
      return;
    }
    await this.atuacao.exigir(tx, c, u.pessoa_id, regra, acao);
  }

  async competente(tx: Tx, ator: AtorSecretaria, contexto: string, acao: 'pode_aprovar' | 'pode_deliberar' | 'pode_consultar_restritos' | 'pode_instalar_mesa') {
    const u = await this.operador(tx, ator);
    if (acao === 'pode_consultar_restritos') await this.contexto(tx, ator, contexto);
    else await this.contextoAtivo(tx, ator, contexto);
    if ((acao !== 'pode_consultar_restritos' && (u.perfil === 'AUDITOR' || !u.pessoa_id)) || !(await this.concessoes(tx, ator, contexto)).some(c => c[acao])) throw new ForbiddenException('Competência institucional explícita necessária neste contexto.');
    return u;
  }

  async documento(tx: Tx, ator: AtorSecretaria, id: string) {
    const d = await tx.documento.findFirst({ where: { id, igreja_id: ator.igreja_id }, include: { versoes: { orderBy: { numero: 'asc' }, include: { livro: { select: { perfil: true } }, modelo: true, arrolados: true, resolucoes: incluirResolucoes, anexos: { include: { arquivo: { select: { sha256: true, tamanho: true } } } }, deliberacoes: { orderBy: { criado_em: 'asc' }, include: { mesa: { select: { ordem: true, presidente_nome: true, secretario_nome: true } } } } } } } });
    if (!d) throw new NotFoundException('Documento não encontrado nesta igreja.');
    if (d.tipo === 'ATA') {
      if (d.restrito) {
        if (!(await permissoesAtasDaConta(tx, ator.igreja_id, ator.sub)).get(d.contexto_id)?.ler)
          throw new NotFoundException('Documento não encontrado nesta igreja.');
      } else await this.contextoDeAtas(tx, ator, d.contexto_id);
    } else {
      await this.operador(tx, ator);
      await this.contexto(tx, ator, d.contexto_id);
      if (d.restrito && !(await this.concessoes(tx, ator, d.contexto_id)).some(c => c.pode_consultar_restritos))
        throw new NotFoundException('Documento não encontrado nesta igreja.');
    }
    return d;
  }

  conferirRevisao(atual: number, esperada: number) {
    if (atual !== esperada) throw new ConflictException(`Registro alterado por outra operação. A revisão atual é ${atual}. Recarregue antes de continuar.`);
  }

  async conferirMotivador(tx: Tx, ator: AtorSecretaria, versaoId: string | null, documentoId: string, atualId?: string) {
    const visitados = new Set<string>();
    let id = versaoId;
    while (id) {
      if (id === atualId || visitados.has(id) || visitados.size >= 100) throw new BadRequestException('Ciclo de motivadores não permitido.');
      visitados.add(id);
      const v = await tx.documento_versao.findFirst({ where: { id, igreja_id: ator.igreja_id }, include: { documento: true } });
      if (!v || v.documento.id === documentoId) throw new BadRequestException('Motivador inválido ou autorreferente.');
      await this.documento(tx, ator, v.documento_id);
      id = v.motivador_id;
    }
  }
}
