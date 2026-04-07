import { Injectable, NotFoundException } from '@nestjs/common';
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
  async create(igreja_id: string, createDespesaDto: CreateDespesaDto): Promise<despesas> {
    return this.prisma.despesas.create({ data: { ...createDespesaDto, igreja_id } });
  }

  /**
   * Retorna todos os tipos de despesa da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<despesas[]> {
    return this.prisma.despesas.findMany({
      where: { igreja_id },
      include: { cat_despesa: true },
    });
  }

  /**
   * Encontra um tipo de despesa pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da despesa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrado nesta igreja.
   */
  async findOne(id: number, igreja_id: string): Promise<despesas> {
    const despesa = await this.prisma.despesas.findFirst({
      where: { id, igreja_id },
      include: { cat_despesa: true },
    });

    if (!despesa) {
      throw new NotFoundException(`Despesa com ID ${id} não encontrada.`);
    }
    return despesa;
  }

  /**
   * Atualiza um tipo de despesa, verificando que pertence à mesma igreja.
   * @param id ID da despesa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateDespesaDto Dados para atualização.
   */
  async update(id: number, igreja_id: string, updateDespesaDto: UpdateDespesaDto): Promise<despesas> {
    await this.findOne(id, igreja_id);
    return this.prisma.despesas.update({ where: { id }, data: updateDespesaDto });
  }

  /**
   * Remove um tipo de despesa, verificando que pertence à mesma igreja.
   * @param id ID da despesa.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.despesas.delete({ where: { id } });
    return { message: `Despesa com ID ${id} removida com sucesso.` };
  }
}
