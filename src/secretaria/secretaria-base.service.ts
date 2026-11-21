import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, usuarios_perfil } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { conflitoDeTransacao, hashAto, transacaoSerializavel } from '../orgaos/idempotencia';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { incluirResolucoes } from './resolucoes';

export interface AtorSecretaria { sub: string; igreja_id: string; perfil: usuarios_perfil }
export type Tx = Prisma.TransactionClient;
export const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const dataCivil = (v: string) => new Date(`${v}T00:00:00.000Z`);

@Injectable()
export class SecretariaBaseService {
  constructor(readonly prisma: PrismaService) {}

  async operador(tx: Tx, ator: AtorSecretaria) {
    const u = await tx.usuarios.findFirst({ where: { id: ator.sub, igreja_id: ator.igreja_id, ativo: true } });
    if (!u || !['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', 'AUDITOR'].includes(u.perfil)) throw new ForbiddenException('Operador não autorizado.');
    return u;
  }

  async comando(ator: AtorSecretaria, operacao: string, alvo: string | null, dados: { idempotencia: string }, executar: (tx: Tx) => Promise<unknown>) {
    return transacaoSerializavel(this.prisma, async tx => {
      const operador = await this.operador(tx, ator);
      if (operador.perfil === 'AUDITOR') throw new ForbiddenException('Perfil de consulta não pode executar comandos.');
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
          if (operacao === 'EDITAR_DOCUMENTO_LEGADO') this.exigirSecretario(operador);
          else if (['CRIAR_DOCUMENTO', 'EDITAR_DOCUMENTO', 'ENCAMINHAR'].includes(operacao)) await this.preparar(tx, ator, documento.contexto_id);
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
    }, 7).catch((erro: unknown) => {
      if (conflitoDeTransacao(erro)) throw new ConflictException('A Secretaria está processando operações concorrentes. Tente novamente.');
      throw erro;
    });
  }

  async contexto(tx: Tx, ator: AtorSecretaria, id: string) {
    const c = await tx.contexto_secretaria.findFirst({ where: { id, igreja_id: ator.igreja_id }, include: { orgao: true } });
    if (!c) throw new NotFoundException('Contexto não encontrado nesta igreja.');
    return c;
  }

  async concessoes(tx: Tx, ator: AtorSecretaria, contexto?: string) {
    const usuario = await tx.usuarios.findFirst({ where: { id: ator.sub, igreja_id: ator.igreja_id, ativo: true }, select: { pessoa_id: true } });
    if (!usuario?.pessoa_id) return [];
    const hoje = dataCivil(await hojeDaIgreja(tx, ator.igreja_id));
    return tx.competencia_secretaria.findMany({ where: { igreja_id: ator.igreja_id, usuario_id: ator.sub, pessoa_id: usuario.pessoa_id, ...(contexto ? { contexto_id: contexto } : {}), inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }] } });
  }

  exigirSecretario(operador: { perfil: usuarios_perfil }) {
    if (operador.perfil !== 'SECRETARIO') throw new ForbiddenException('Edição de ata legada reservada ao secretário.');
  }

  async preparar(tx: Tx, ator: AtorSecretaria, contexto: string) {
    const u = await this.operador(tx, ator);
    await this.contexto(tx, ator, contexto);
    if (u.perfil === 'SECRETARIO' || u.perfil === 'GESTOR') return;
    if (u.perfil !== 'AUDITOR' && (await this.concessoes(tx, ator, contexto)).some(c => c.pode_aprovar || c.pode_deliberar)) return;
    throw new ForbiddenException('Preparação reservada à secretaria ou gestor habilitado.');
  }

  async competente(tx: Tx, ator: AtorSecretaria, contexto: string, acao: 'pode_aprovar' | 'pode_deliberar' | 'pode_consultar_restritos') {
    const u = await this.operador(tx, ator);
    await this.contexto(tx, ator, contexto);
    if ((acao !== 'pode_consultar_restritos' && (u.perfil === 'AUDITOR' || !u.pessoa_id)) || !(await this.concessoes(tx, ator, contexto)).some(c => c[acao])) throw new ForbiddenException('Competência institucional explícita necessária neste contexto.');
    return u;
  }

  async documento(tx: Tx, ator: AtorSecretaria, id: string) {
    const d = await tx.documento.findFirst({ where: { id, igreja_id: ator.igreja_id }, include: { versoes: { orderBy: { numero: 'asc' }, include: { modelo: true, arrolados: true, resolucoes: incluirResolucoes, anexos: { include: { arquivo: { select: { sha256: true, tamanho: true } } } }, deliberacoes: { orderBy: { criado_em: 'asc' } } } } } });
    if (!d) throw new NotFoundException('Documento não encontrado nesta igreja.');
    if (d.restrito && !(await this.concessoes(tx, ator, d.contexto_id)).some(c => c.pode_consultar_restritos)) throw new NotFoundException('Documento não encontrado nesta igreja.');
    return d;
  }

  conferirRevisao(atual: number, esperada: number) {
    if (atual !== esperada) throw new ConflictException('Registro alterado por outra operação. Recarregue antes de continuar.');
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
