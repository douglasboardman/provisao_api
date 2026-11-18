import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { convencao_bissexto, logs_atividades_acao, Prisma, usuarios_perfil } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
const dia = z.iso.date().refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; });
const esquema = z.object({
  versao: z.string().trim().min(1).max(100), fonte: z.string().trim().min(1).max(500),
  autoridade: z.string().trim().min(1).max(255), idade_minima: z.number().int().min(0).max(120),
  aniversario_bissexto: z.nativeEnum(convencao_bissexto), vigente_desde: dia, vigente_ate: dia.nullable(),
}).strict().refine(v => !v.vigente_ate || v.vigente_ate >= v.vigente_desde);
type Entrada = z.infer<typeof esquema>;

/** Registra a fonte e a autoridade declaradas; o operador não é presumido autoridade institucional. */
@Injectable()
export class PoliticaEleicaoService {
  constructor(private readonly prisma: PrismaService) {}
  async registrar(igrejaId: string, usuarioId: string, dados: Entrada) {
    const parsed = esquema.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Política normativa inválida.');
    const v = parsed.data;
    return this.prisma.$transaction(async tx => {
      const operador = await tx.usuarios.findFirst({ where: { id: usuarioId, igreja_id: igrejaId, ativo: true, perfil: usuarios_perfil.ADMINISTRADOR }, select: { id: true } });
      if (!operador) throw new ForbiddenException('Operador não autorizado.');
      const politica = await tx.politica_eleicao_oficial.create({ data: {
        igreja_id: igrejaId, criado_por_id: usuarioId, versao: v.versao, fonte: v.fonte, autoridade: v.autoridade,
        idade_minima: v.idade_minima, aniversario_bissexto: v.aniversario_bissexto,
        vigente_desde: new Date(`${v.vigente_desde}T00:00:00.000Z`), vigente_ate: v.vigente_ate ? new Date(`${v.vigente_ate}T00:00:00.000Z`) : null,
      } });
      await tx.logs_atividades.create({ data: { igreja_id: igrejaId, usuario_id: usuarioId, acao: logs_atividades_acao.CRIACAO,
        tabela_afetada: 'politica_eleicao_oficial', registro_id: politica.id, dados_novos: { ...v } } });
      return politica;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
