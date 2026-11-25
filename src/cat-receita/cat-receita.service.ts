import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
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
  async create(igreja_id: string, createCatReceitaDto: CreateCatReceitaDto, ator?: Ator): Promise<cat_receita> {
    return gravarPorServico(this.prisma, ator, 'CATEGORIAS_RECEITA_CADASTRAR', async tx => {
      return tx.cat_receita.create({ data: { ...createCatReceitaDto, igreja_id } });
    });
  }

  /**
   * Retorna todas as categorias de receita da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string) {
    return this.prisma.cat_receita.findMany({
      where: { igreja_id },
      include: { _count: { select: { receitas: true } } },
    });
  }

  /**
   * Encontra uma categoria de receita pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrada nesta igreja.
   */
  async findOne(id: number, igreja_id: string, tx: Tx = this.prisma): Promise<cat_receita> {
    const catReceita = await tx.cat_receita.findFirst({ where: { id, igreja_id } });

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
  async update(id: number, igreja_id: string, updateCatReceitaDto: UpdateCatReceitaDto, ator?: Ator): Promise<cat_receita> {
    return gravarPorServico(this.prisma, ator, 'CATEGORIAS_RECEITA_EDITAR', async tx => {
      await this.findOne(id, igreja_id, tx);
      return tx.cat_receita.update({ where: { id }, data: updateCatReceitaDto });
    });
  }

  /**
   * Remove uma categoria de receita, verificando que pertence à mesma igreja.
   * @param id ID da categoria.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string, ator?: Ator): Promise<{ message: string }> {
    return gravarPorServico(this.prisma, ator, 'CATEGORIAS_RECEITA_EXCLUIR', async tx => {
      await this.findOne(id, igreja_id, tx);
      await tx.cat_receita.delete({ where: { id } });
      return { message: `Categoria de receita com ID ${id} removida com sucesso.` };
    });
  }
}
