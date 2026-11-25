import { exigirServicoNaTransacao } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { CreateRegraRelacaoEnumDto, ReplaceValoresDto } from "./dto/create-regra-relacao-enum.dto";
import { UpdateRegraRelacaoEnumDto } from "./dto/update-regra-relacao-enum.dto";
import { consultarRegrasDaIgreja, regraComValoresLocais } from "./parametros-membresia";

type RegraComValores = Prisma.regras_relacao_enumGetPayload<{
  include: { valores: true };
}>;

@Injectable()
export class RegrasRelacaoEnumService {
  constructor(private readonly prisma: PrismaService) {}

  async getRegrasPorModulo(modulo: string, igreja: string, tx: Tx = this.prisma): Promise<RegraComValores[]> {
    if (modulo === "membresia") return consultarRegrasDaIgreja(this.prisma, igreja);
    return tx.regras_relacao_enum.findMany({
      where: { modulo },
      include: { valores: true },
      orderBy: { nome: "asc" },
    });
  }

  getEnumsDisponiveis(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const enumDef of Prisma.dmmf.datamodel.enums) {
      result[enumDef.name] = enumDef.values.map((v) => v.name);
    }
    return result;
  }

  async findAll(): Promise<RegraComValores[]> {
    return this.prisma.regras_relacao_enum.findMany({
      include: { valores: true },
      orderBy: [{ modulo: "asc" }, { nome: "asc" }],
    });
  }

  async findOne(id: string): Promise<RegraComValores> {
    const regra = await this.prisma.regras_relacao_enum.findUnique({
      where: { id },
      include: { valores: true },
    });
    if (!regra) {
      throw new NotFoundException("Regra de relação de enum não encontrada.");
    }
    return regra;
  }

  async create(dto: CreateRegraRelacaoEnumDto): Promise<RegraComValores> {
    return this.prisma.regras_relacao_enum.create({
      data: dto,
      include: { valores: true },
    });
  }

  async update(
    id: string,
    dto: UpdateRegraRelacaoEnumDto,
  ): Promise<RegraComValores> {
    await this.findOne(id);
    return this.prisma.regras_relacao_enum.update({
      where: { id },
      data: dto,
      include: { valores: true },
    });
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.regras_relacao_enum.delete({ where: { id } });
  }

  async replaceValores(
    regraId: string,
    valores: ReplaceValoresDto["valores"],
  ): Promise<RegraComValores> {
    await this.findOne(regraId);

    return this.prisma.$transaction(async (tx) => {
      await tx.relacao_enum_valores.deleteMany({
        where: { regra_id: regraId },
      });

      if (valores.length > 0) {
        await tx.relacao_enum_valores.createMany({
          data: valores.map((v) => ({
            regra_id: regraId,
            valor_classificador: v.valor_classificador,
            valor_classificado: v.valor_classificado,
          })),
        });
      }

      return tx.regras_relacao_enum.findUniqueOrThrow({
        where: { id: regraId },
        include: { valores: true },
      });
    });
  }

  async replaceValoresDaIgreja(igreja: string, regraId: string, valores: ReplaceValoresDto["valores"], ator?: Ator): Promise<RegraComValores> {
    return this.prisma.$transaction(async tx => {
      await exigirServicoNaTransacao(tx, ator, 'PARAMETROS_EDITAR');
      const bloqueadas = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM regras_relacao_enum WHERE id = ${regraId} AND modulo = 'membresia' FOR UPDATE
      `;
      if (!bloqueadas.length) throw new NotFoundException("Regra de membresia não encontrada.");
      const regra = await tx.regras_relacao_enum.findUniqueOrThrow({ where: { id: regraId } });
      const enums = this.getEnumsDisponiveis();
      const classificadores = enums[regra.enum_classificador] ?? [];
      const classificados = enums[regra.enum_classificado] ?? [];
      const pares = new Set(valores.map(v => JSON.stringify([v.valor_classificador, v.valor_classificado])));
      if (pares.size !== valores.length || valores.some(v => !classificadores.includes(v.valor_classificador) || !classificados.includes(v.valor_classificado))) {
        throw new BadRequestException("A lista contém valores inválidos ou repetidos para esta regra.");
      }
      const linhas = valores.map(valor => ({ id: randomUUID(), ...valor }));
      const local = await tx.parametro_membresia_igreja.upsert({
        where: { igreja_id_regra_id: { igreja_id: igreja, regra_id: regraId } },
        create: { igreja_id: igreja, regra_id: regraId, valores: linhas },
        update: { valores: linhas },
      });
      return regraComValoresLocais(regra, local);
    });
  }
}
