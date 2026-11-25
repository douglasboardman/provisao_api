import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
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
  async create(igreja_id: string, createCatDespesaDto: CreateCatDespesaDto, ator?: Ator): Promise<cat_despesa> {
    return gravarPorServico(this.prisma, ator, 'CATEGORIAS_DESPESA_CADASTRAR', async tx => {
      return tx.cat_despesa.create({ data: { ...createCatDespesaDto, igreja_id } });
    });
  }

  /**
   * Retorna todas as categorias de despesa da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string) {
    return this.prisma.cat_despesa.findMany({
      where: { igreja_id },
      include: { _count: { select: { despesas: true } } },
    });
  }

  /**
   * Encontra uma categoria de despesa pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrada nesta igreja.
   */
  async findOne(id: number, igreja_id: string, tx: Tx = this.prisma): Promise<cat_despesa> {
    const catDespesa = await tx.cat_despesa.findFirst({ where: { id, igreja_id } });

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
  async update(id: number, igreja_id: string, updateCatDespesaDto: UpdateCatDespesaDto, ator?: Ator): Promise<cat_despesa> {
    return gravarPorServico(this.prisma, ator, 'CATEGORIAS_DESPESA_EDITAR', async tx => {
      await this.findOne(id, igreja_id, tx);
      return tx.cat_despesa.update({ where: { id }, data: updateCatDespesaDto });
    });
  }

  /**
   * Remove uma categoria de despesa, verificando que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string, ator?: Ator): Promise<{ message: string }> {
    return gravarPorServico(this.prisma, ator, 'CATEGORIAS_DESPESA_EXCLUIR', async tx => {
      await this.findOne(id, igreja_id, tx);
      await tx.cat_despesa.delete({ where: { id } });
      return { message: `Categoria de despesa com ID ${id} removida com sucesso.` };
    });
  }
}
