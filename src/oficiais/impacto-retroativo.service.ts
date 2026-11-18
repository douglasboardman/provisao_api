import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { usuarios_perfil } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Identifica registros potencialmente afetados; não aplica nem autoriza a alteração. */
@Injectable()
export class ImpactoRetroativoService {
  constructor(private readonly prisma: PrismaService) {}
  async membresia(igrejaId: string, usuarioId: string, pessoaId: string, primeiraDataAfetada: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(primeiraDataAfetada)) throw new BadRequestException('Data de referência inválida.');
    const data = new Date(`${primeiraDataAfetada}T00:00:00.000Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== primeiraDataAfetada) throw new BadRequestException('Data de referência inválida.');
    const [usuario, pessoa] = await Promise.all([
      this.prisma.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO] } }, select: { id: true } }),
      this.prisma.pessoas.findFirst({ where: { id: pessoaId, igreja_id: igrejaId }, select: { id: true } }),
    ]);
    if (!usuario) throw new ForbiddenException('Operador não autorizado nesta igreja.');
    if (!pessoa) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
    const [mandatos, conferencias] = await Promise.all([
      this.prisma.mandato_oficial.findMany({ where: { igreja_id: igrejaId, oficial: { pessoa_id: pessoaId }, OR: [{ termino_efetivo: { gte: data } }, { termino_efetivo: null, termino_previsto: { gte: data } }] }, select: { id: true, data_eleicao: true, data_posse: true, oficial: { select: { id: true, tipo: true } } }, orderBy: [{ data_posse: 'asc' }, { id: 'asc' }] }),
      this.prisma.conferencia_eleicao_oficial.findMany({ where: { igreja_id: igrejaId, pessoa_id: pessoaId, data_eleicao: { gte: data } }, select: { id: true, data_eleicao: true, politica_id: true }, orderBy: [{ data_eleicao: 'asc' }, { id: 'asc' }] }),
    ]);
    return { pessoa_id: pessoaId, primeira_data_afetada: primeiraDataAfetada, mandatos, conferencias,
      observacao: 'Registros potencialmente afetados; a consulta não avalia o efeito concreto nem autoriza a alteração.' };
  }
}
