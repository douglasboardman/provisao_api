import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import { Prisma } from "@prisma/client";
import { CreateRegraRelacaoEnumDto } from "./dto/create-regra-relacao-enum.dto";
import { UpdateRegraRelacaoEnumDto } from "./dto/update-regra-relacao-enum.dto";

type RegraComValores = Prisma.regras_relacao_enumGetPayload<{
  include: { valores: true };
}>;

@Injectable()
export class RegrasRelacaoEnumService {
  private cache = new Map<string, RegraComValores>();

  constructor(private readonly prisma: PrismaService) {}

  private cacheKey(modulo: string, nome: string): string {
    return `${modulo}:${nome}`;
  }

  private invalidateCache(): void {
    this.cache.clear();
  }

  private async loadRegra(
    modulo: string,
    nome: string,
  ): Promise<RegraComValores | null> {
    const key = this.cacheKey(modulo, nome);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const regra = await this.prisma.regras_relacao_enum.findUnique({
      where: { modulo_nome: { modulo, nome } },
      include: { valores: true },
    });

    if (regra) this.cache.set(key, regra);
    return regra;
  }

  async getValoresPermitidos(
    modulo: string,
    nomeRegra: string,
    valorCassificador: string,
  ): Promise<string[]> {
    const regra = await this.loadRegra(modulo, nomeRegra);
    if (!regra) return [];
    return regra.valores
      .filter((v) => v.valor_classificador === valorCassificador)
      .map((v) => v.valor_classificado);
  }

  async getValorMapeado(
    modulo: string,
    nomeRegra: string,
    valorClassificador: string,
  ): Promise<string | null> {
    const regra = await this.loadRegra(modulo, nomeRegra);
    if (!regra) return null;
    const entry = regra.valores.find(
      (v) => v.valor_classificador === valorClassificador,
    );
    return entry?.valor_classificado ?? null;
  }

  async getRegrasPorModulo(modulo: string): Promise<RegraComValores[]> {
    return this.prisma.regras_relacao_enum.findMany({
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
    this.invalidateCache();
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
    this.invalidateCache();
    return this.prisma.regras_relacao_enum.update({
      where: { id },
      data: dto,
      include: { valores: true },
    });
  }

  async remove(id: string): Promise<void> {
    await this.findOne(id);
    this.invalidateCache();
    await this.prisma.regras_relacao_enum.delete({ where: { id } });
  }

  async replaceValores(
    regraId: string,
    valores: { valor_classificador: string; valor_classificado: string }[],
  ): Promise<RegraComValores> {
    await this.findOne(regraId);
    this.invalidateCache();

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
}
