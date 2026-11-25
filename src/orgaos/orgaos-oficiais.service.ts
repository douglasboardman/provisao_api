import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { logs_atividades_acao } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { atoAnterior, hashAto, transacaoSerializavel } from './idempotencia';
import { hojeDaIgreja } from './relogio-igreja';

const entrada = z.object({ tipo: z.enum(['CONSELHO', 'JUNTA']), nome: z.string().trim().min(1).max(255), sigla: z.string().trim().min(1).max(40).optional(), finalidade: z.string().trim().min(1).max(1000), data_criacao: z.iso.date(), idempotencia: z.uuid() }).strict();

/** Cadastro dos órgãos oficiais da igreja; não concede cargos ou competência ao operador. */
@Injectable()
export class OrgaosOficiaisService {
  constructor(private readonly prisma: PrismaService) {}

  async registrar(igrejaId: string, usuarioId: string, dados: z.infer<typeof entrada>) {
    const parsed = entrada.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Dados do órgão inválidos.');
    const { idempotencia: chave, ...v } = parsed.data, idempotencia = chave.toLowerCase();
    const hash = hashAto({ operacao: 'CADASTRO_OFICIAL', dados: v });
    const data = new Date(`${v.data_criacao}T00:00:00.000Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== v.data_criacao) throw new BadRequestException('Data de criação inválida.');
    return transacaoSerializavel(this.prisma, async tx => {
      await tx.$queryRaw`SELECT id FROM usuarios WHERE id = ${usuarioId} AND igreja_id = ${igrejaId} FOR UPDATE`;
      const operador = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: ['ADMINISTRADOR', 'GESTOR', 'SECRETARIO'] } }, select: { id: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const hoje = await hojeDaIgreja(tx, igrejaId);
      const repetido = await atoAnterior(tx, { igreja: igrejaId, usuario: usuarioId, idempotencia, tipo: 'CADASTRO_OFICIAL', hash }, 'orgao_id');
      if (repetido) {
        if (!repetido.ocupacao_id) throw new BadRequestException('Resultado anterior indisponível.');
        return { id: repetido.ocupacao_id };
      }
      if (v.data_criacao > hoje) throw new BadRequestException('Data de criação inválida.');
      await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igrejaId} FOR UPDATE`;
      if (await tx.orgao_interno.findFirst({ where: { igreja_id: igrejaId, tipo: v.tipo }, select: { id: true } })) {
        throw new ConflictException('Este órgão já possui cadastro nesta igreja.');
      }
      const orgao = await tx.orgao_interno.create({ data: { igreja_id: igrejaId, tipo: v.tipo, constituicao: 'OFICIAL', nome: v.nome, sigla: v.sigla, finalidade: v.finalidade, data_criacao: data, criador_id: operador.id } });
      await tx.$executeRaw`SELECT instalar_estrutura_institucional(${igrejaId}, ${v.tipo})`;
      await tx.ato_orgao.create({ data: { igreja_id: igrejaId, orgao_id: orgao.id, operador_id: usuarioId, tipo: 'CADASTRO_OFICIAL', data_efeito: data, idempotencia, hash_requisicao: hash, detalhes: { orgao_id: orgao.id } } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO, tabela_afetada: 'orgao_interno', registro_id: orgao.id, dados_novos: { tipo: orgao.tipo, data_criacao: v.data_criacao } } });
      return { id: orgao.id };
    });
  }
}
