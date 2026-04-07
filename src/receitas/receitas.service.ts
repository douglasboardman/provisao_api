import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateReceitaDto } from './dto/create-receita.dto';
import { UpdateReceitaDto } from './dto/update-receita.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { receitas } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio relacionada a Receitas (tipos).
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class ReceitasService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um novo tipo de receita vinculado à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createReceitaDto Dados para criação.
   * @returns O tipo de receita criado.
   */
  async create(igreja_id: string, createReceitaDto: CreateReceitaDto): Promise<receitas> {
    return this.prisma.receitas.create({ data: { ...createReceitaDto, igreja_id } });
  }

  /**
   * Retorna todos os tipos de receita da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<receitas[]> {
    return this.prisma.receitas.findMany({
      where: { igreja_id },
      include: { cat_receita: true },
    });
  }

  /**
   * Encontra um tipo de receita pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da receita.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrado nesta igreja.
   */
  async findOne(id: number, igreja_id: string): Promise<receitas> {
    const receita = await this.prisma.receitas.findFirst({
      where: { id, igreja_id },
      include: { cat_receita: true },
    });

    if (!receita) {
      throw new NotFoundException(`Receita com ID ${id} não encontrada.`);
    }
    return receita;
  }

  /**
   * Atualiza um tipo de receita, verificando que pertence à mesma igreja.
   * @param id ID da receita.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateReceitaDto Dados para atualização.
   */
  async update(id: number, igreja_id: string, updateReceitaDto: UpdateReceitaDto): Promise<receitas> {
    await this.findOne(id, igreja_id);
    return this.prisma.receitas.update({ where: { id }, data: updateReceitaDto });
  }

  /**
   * Remove um tipo de receita, verificando que pertence à mesma igreja.
   * @param id ID da receita.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.receitas.delete({ where: { id } });
    return { message: `Receita com ID ${id} removida com sucesso.` };
  }
}
