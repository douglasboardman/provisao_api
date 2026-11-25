import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateDespesaDto } from './dto/create-despesa.dto';
import { UpdateDespesaDto } from './dto/update-despesa.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { despesas } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio relacionada a Despesas (tipos).
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class DespesasService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um novo tipo de despesa vinculado à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createDespesaDto Dados para criação.
   * @returns O tipo de despesa criado.
   */
  async create(igreja_id: string, createDespesaDto: CreateDespesaDto, ator?: Ator): Promise<despesas> {
    return gravarPorServico(this.prisma, ator, 'DESPESAS_CADASTRAR', async tx => {
      const categoria = createDespesaDto.cat_despesa_id;
      if (categoria && !await tx.cat_despesa.findFirst({ where: { id: categoria, igreja_id }, select: { id: true } }))
        throw new BadRequestException('Categoria indisponível nesta igreja.');
      return tx.despesas.create({ data: { ...createDespesaDto, igreja_id } });
    });
  }

  /**
   * Retorna todos os tipos de despesa da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<despesas[]> {
    const linhas = await this.prisma.despesas.findMany({
      where: { igreja_id },
      include: { cat_despesa: true },
    });
    return linhas.map(l => ({ ...l, cat_despesa: l.cat_despesa.igreja_id === igreja_id ? l.cat_despesa : null }));
  }

  /**
   * Encontra um tipo de despesa pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da despesa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrado nesta igreja.
   */
  async findOne(id: number, igreja_id: string, tx: Tx = this.prisma) {
    const despesa = await tx.despesas.findFirst({
      where: { id, igreja_id },
      include: { cat_despesa: true },
    });

    if (!despesa) {
      throw new NotFoundException(`Despesa com ID ${id} não encontrada.`);
    }
    return { ...despesa, cat_despesa: despesa.cat_despesa.igreja_id === igreja_id ? despesa.cat_despesa : null };
  }

  /**
   * Atualiza um tipo de despesa, verificando que pertence à mesma igreja.
   * @param id ID da despesa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateDespesaDto Dados para atualização.
   */
  async update(id: number, igreja_id: string, updateDespesaDto: UpdateDespesaDto, ator?: Ator): Promise<despesas> {
    return gravarPorServico(this.prisma, ator, 'DESPESAS_EDITAR', async tx => {
      const categoria = updateDespesaDto.cat_despesa_id;
      if (categoria && !await tx.cat_despesa.findFirst({ where: { id: categoria, igreja_id }, select: { id: true } }))
        throw new BadRequestException('Categoria indisponível nesta igreja.');
      await this.findOne(id, igreja_id, tx);
      return tx.despesas.update({ where: { id }, data: updateDespesaDto });
    });
  }

  /**
   * Remove um tipo de despesa, verificando que pertence à mesma igreja.
   * @param id ID da despesa.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string, ator?: Ator): Promise<{ message: string }> {
    return gravarPorServico(this.prisma, ator, 'DESPESAS_EXCLUIR', async tx => {
      await this.findOne(id, igreja_id, tx);
      await tx.despesas.delete({ where: { id } });
      return { message: `Despesa com ID ${id} removida com sucesso.` };
    });
  }
}
