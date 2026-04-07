import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateCatDespesaDto } from './dto/create-cat-despesa.dto';
import { UpdateCatDespesaDto } from './dto/update-cat-despesa.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { cat_despesa } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio de Categorias de Despesa.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class CatDespesaService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria uma nova categoria de despesa vinculada à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createCatDespesaDto Dados para criação.
   */
  async create(igreja_id: string, createCatDespesaDto: CreateCatDespesaDto): Promise<cat_despesa> {
    return this.prisma.cat_despesa.create({ data: { ...createCatDespesaDto, igreja_id } });
  }

  /**
   * Retorna todas as categorias de despesa da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<cat_despesa[]> {
    return this.prisma.cat_despesa.findMany({ where: { igreja_id } });
  }

  /**
   * Encontra uma categoria de despesa pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrada nesta igreja.
   */
  async findOne(id: number, igreja_id: string): Promise<cat_despesa> {
    const catDespesa = await this.prisma.cat_despesa.findFirst({ where: { id, igreja_id } });

    if (!catDespesa) {
      throw new NotFoundException(`Categoria de despesa com ID ${id} não encontrada.`);
    }
    return catDespesa;
  }

  /**
   * Atualiza uma categoria de despesa, verificando que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateCatDespesaDto Dados para atualização.
   */
  async update(id: number, igreja_id: string, updateCatDespesaDto: UpdateCatDespesaDto): Promise<cat_despesa> {
    await this.findOne(id, igreja_id);
    return this.prisma.cat_despesa.update({ where: { id }, data: updateCatDespesaDto });
  }

  /**
   * Remove uma categoria de despesa, verificando que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.cat_despesa.delete({ where: { id } });
    return { message: `Categoria de despesa com ID ${id} removida com sucesso.` };
  }
}
