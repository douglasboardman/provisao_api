import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateCatReceitaDto } from './dto/create-cat-receita.dto';
import { UpdateCatReceitaDto } from './dto/update-cat-receita.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { cat_receita } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio de Categorias de Receita.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class CatReceitaService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria uma nova categoria de receita vinculada à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createCatReceitaDto Dados para criação.
   */
  async create(igreja_id: string, createCatReceitaDto: CreateCatReceitaDto): Promise<cat_receita> {
    return this.prisma.cat_receita.create({ data: { ...createCatReceitaDto, igreja_id } });
  }

  /**
   * Retorna todas as categorias de receita da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<cat_receita[]> {
    return this.prisma.cat_receita.findMany({ where: { igreja_id } });
  }

  /**
   * Encontra uma categoria de receita pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrada nesta igreja.
   */
  async findOne(id: number, igreja_id: string): Promise<cat_receita> {
    const catReceita = await this.prisma.cat_receita.findFirst({ where: { id, igreja_id } });

    if (!catReceita) {
      throw new NotFoundException(`Categoria de receita com ID ${id} não encontrada.`);
    }
    return catReceita;
  }

  /**
   * Atualiza uma categoria de receita, verificando que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateCatReceitaDto Dados para atualização.
   */
  async update(id: number, igreja_id: string, updateCatReceitaDto: UpdateCatReceitaDto): Promise<cat_receita> {
    await this.findOne(id, igreja_id);
    return this.prisma.cat_receita.update({ where: { id }, data: updateCatReceitaDto });
  }

  /**
   * Remove uma categoria de receita, verificando que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.cat_receita.delete({ where: { id } });
    return { message: `Categoria de receita com ID ${id} removida com sucesso.` };
  }
}
