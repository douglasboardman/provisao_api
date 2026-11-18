import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { atoAnterior, hashAto, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';
import { ComposicaoService } from './composicao.service';

const texto = z.string().trim().min(1).max(1000);
const ato = z.object({ autoridade: texto.max(255), evidencia: texto, idempotencia: z.uuid() });
const cadastro = ato.extend({ nome: texto.max(255), sigla: texto.max(40).nullable(), finalidade: texto }).strict();
const conducao = ato.extend({ pessoa_id: z.uuid(), referencia: texto.max(255), data_reuniao: z.iso.date(), motivo: texto, modalidade: z.enum(['MEMBRO_CONSELHO', 'CONVIDADO']), fundamento: texto, limites_pauta: texto, ratificacao_pendente: z.boolean() }).strict();

@Injectable()
export class ManutencaoOrgaoService {
  constructor(private readonly prisma: PrismaService, private readonly composicao: ComposicaoService) {}

  async alterar(igreja: string, usuario: string, orgao: string, dados: z.infer<typeof cadastro>) {
    const parsed = cadastro.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Cadastro inválido.');
    const { idempotencia, ...v } = parsed.data, chave = idempotencia.toLowerCase();
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuario} AND igreja_id = ${igreja} FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO'] } } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgao} AND igreja_id = ${igreja} FOR UPDATE`;
      const anterior = await tx.orgao_interno.findFirst({ where: { id: orgao, igreja_id: igreja } });
      if (!anterior) throw new NotFoundException('Órgão não encontrado nesta igreja.');
      const hoje = new Date(`${await hojeDaIgreja(tx, igreja)}T00:00:00Z`);
      if (anterior.tipo === 'UNIDADE_MINISTERIAL' && (operador.perfil !== 'GESTOR' || !operador.pessoa_id || !await tx.competencia_unidades.findFirst({ where: { igreja_id: igreja, usuario_id: usuario, pessoa_id: operador.pessoa_id, inicio: { lte: hoje }, OR: [{ fim: null }, { fim: { gt: hoje } }] } }))) throw new ForbiddenException('Competência institucional não comprovada.');
      const repetido = await atoAnterior(tx, { igreja, usuario, orgao, idempotencia: chave, tipo: 'MANUTENCAO', hash: hashAto({ orgao, dados: v }) }, 'orgao_id');
      if (repetido) return { ato_id: repetido.ato_id, orgao_id: orgao };
      if (!anterior.ativo) throw new BadRequestException('Órgão desativado.');
      await tx.orgao_interno.update({ where: { id: orgao }, data: { nome: v.nome, sigla: v.sigla, finalidade: v.finalidade } });
      const registro = await tx.ato_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao, operador_id: usuario, tipo: 'MANUTENCAO', data_efeito: hoje, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia: chave, hash_requisicao: hashAto({ orgao, dados: v }), detalhes: { orgao_id: orgao, anterior: { nome: anterior.nome, sigla: anterior.sigla, finalidade: anterior.finalidade }, novo: { nome: v.nome, sigla: v.sigla, finalidade: v.finalidade } } } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: 'ATUALIZACAO', tabela_afetada: 'orgao_interno', registro_id: orgao, dados_novos: { ato_id: registro.id } } });
      return { ato_id: registro.id, orgao_id: orgao };
    });
  }

  async registrarConducao(igreja: string, usuario: string, orgao: string, dados: z.infer<typeof conducao>) {
    const parsed = conducao.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Condução de reunião inválida.');
    const { idempotencia, ...v } = parsed.data, chave = idempotencia.toLowerCase(), hash = hashAto({ orgao, dados: v });
    return transacaoSerializavel(this.prisma, async tx => {
      if (!await tx.usuarios.findFirst({ where: { id: usuario, igreja_id: igreja, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO'] } } })) throw new ForbiddenException('Operador não autorizado.');
      await tx.$queryRaw`SELECT id FROM orgao_interno WHERE id = ${orgao} AND igreja_id = ${igreja} FOR UPDATE`;
      if (!await tx.orgao_interno.findFirst({ where: { id: orgao, igreja_id: igreja, tipo: 'CONSELHO', ativo: true } })) throw new NotFoundException('Conselho não encontrado nesta igreja.');
      const repetido = await atoAnterior(tx, { igreja, usuario, orgao, idempotencia: chave, tipo: 'CONDUCAO_REUNIAO', hash }, 'orgao_id');
      if (repetido) return { ato_id: repetido.ato_id, orgao_id: orgao };
      if (v.data_reuniao > await hojeDaIgreja(tx, igreja)) throw new BadRequestException('Registre somente reunião já realizada.');
      if (!await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
      const composicao = await this.composicao.consultarNaTransacao(tx, igreja, 'CONSELHO', v.data_reuniao);
      const membro = composicao.membros.find(m => m.pessoa_id === v.pessoa_id);
      if (v.modalidade === 'MEMBRO_CONSELHO' && (!membro || membro.revisao_pendente || composicao.situacao_indeterminada.includes(v.pessoa_id))) throw new BadRequestException('A condução excepcional exige membro do Conselho em exercício comprovado.');
      const registro = await tx.conducao_reuniao_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao, pessoa_id: v.pessoa_id, referencia: v.referencia, data_reuniao: new Date(`${v.data_reuniao}T00:00:00Z`), motivo: v.motivo } });
      const registroAto = await tx.ato_orgao.create({ data: { igreja_id: igreja, orgao_id: orgao, operador_id: usuario, tipo: 'CONDUCAO_REUNIAO', data_efeito: registro.data_reuniao, autoridade: v.autoridade, evidencia: v.evidencia, idempotencia: chave, hash_requisicao: hash, detalhes: { orgao_id: orgao, conducao_id: registro.id, pessoa_id: v.pessoa_id, referencia: v.referencia, motivo: v.motivo, modalidade: v.modalidade, fundamento: v.fundamento, limites_pauta: v.limites_pauta, ratificacao_pendente: v.ratificacao_pendente } } });
      await tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: 'CRIACAO', tabela_afetada: 'ato_orgao', registro_id: registroAto.id } });
      return { ato_id: registroAto.id, orgao_id: orgao };
    });
  }
}
