import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { usuarios_perfil } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Consulta direta por data: não depende do worker e não atribui competência. */
@Injectable()
export class AlertasOficiaisService {
  constructor(private readonly prisma: PrismaService) {}
  async mandatos(igrejaId: string, usuarioId: string, dataReferencia: string, dias: number) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataReferencia) || !Number.isInteger(dias) || dias < 0 || dias > 366) throw new BadRequestException('Data ou período de alerta inválido.');
    const inicio = new Date(`${dataReferencia}T00:00:00.000Z`);
    if (!Number.isFinite(inicio.getTime()) || inicio.toISOString().slice(0, 10) !== dataReferencia) throw new BadRequestException('Data ou período de alerta inválido.');
    const fim = new Date(inicio.getTime()); fim.setUTCDate(fim.getUTCDate() + dias);
    const usuario = await this.prisma.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: { in: [usuarios_perfil.ADMINISTRADOR, usuarios_perfil.GESTOR, usuarios_perfil.SECRETARIO] } }, select: { id: true } });
    if (!usuario) throw new ForbiddenException('Operador não autorizado nesta igreja.');
    const registros = await this.prisma.mandato_oficial.findMany({
      where: { igreja_id: igrejaId, data_posse: { lte: fim }, OR: [
        { termino_efetivo: { gte: inicio, lte: fim } },
        { termino_efetivo: null, termino_previsto: { gte: inicio, lte: fim } },
      ] },
      select: { id: true, data_posse: true, termino_previsto: true, termino_efetivo: true, oficial: { select: { id: true, tipo: true, pessoa: { select: { id: true, nome_completo: true } } } } },
    });
    return registros.map(r => ({ ...r, data_alerta: r.termino_efetivo ?? r.termino_previsto, natureza: r.termino_efetivo ? 'ENCERRAMENTO_REGISTRADO' : 'TERMINO_PREVISTO' }))
      .sort((a, b) => a.data_alerta.getTime() - b.data_alerta.getTime() || a.id.localeCompare(b.id));
  }
}
