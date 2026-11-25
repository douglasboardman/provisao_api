import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  async create(igreja_id: string, createReceitaDto: CreateReceitaDto, ator?: Ator): Promise<receitas> {
    return gravarPorServico(this.prisma, ator, 'RECEITAS_CADASTRAR', async tx => {
      const categoria = createReceitaDto.cat_receita_id;
      if (categoria && !await tx.cat_receita.findFirst({ where: { id: categoria, igreja_id }, select: { id: true } }))
        throw new BadRequestException('Categoria indisponível nesta igreja.');
      return tx.receitas.create({ data: { ...createReceitaDto, igreja_id } });
    });
  }

  /**
   * Retorna todos os tipos de receita da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<receitas[]> {
    const linhas = await this.prisma.receitas.findMany({
      where: { igreja_id },
      include: { cat_receita: true },
    });
    return linhas.map(l => ({ ...l, cat_receita: l.cat_receita.igreja_id === igreja_id ? l.cat_receita : null }));
  }

  /**
   * Encontra um tipo de receita pelo ID, garantindo que pertence à mesma igreja.
   * @param id ID da receita.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrado nesta igreja.
   */
  async findOne(id: number, igreja_id: string, tx: Tx = this.prisma) {
    const receita = await tx.receitas.findFirst({
      where: { id, igreja_id },
      include: { cat_receita: true },
    });

    if (!receita) {
      throw new NotFoundException(`Receita com ID ${id} não encontrada.`);
    }
    return { ...receita, cat_receita: receita.cat_receita.igreja_id === igreja_id ? receita.cat_receita : null };
  }

  /**
   * Atualiza um tipo de receita, verificando que pertence à mesma igreja.
   * @param id ID da receita.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateReceitaDto Dados para atualização.
   */
  async update(id: number, igreja_id: string, updateReceitaDto: UpdateReceitaDto, ator?: Ator): Promise<receitas> {
    return gravarPorServico(this.prisma, ator, 'RECEITAS_EDITAR', async tx => {
      const categoria = updateReceitaDto.cat_receita_id;
      if (categoria && !await tx.cat_receita.findFirst({ where: { id: categoria, igreja_id }, select: { id: true } }))
        throw new BadRequestException('Categoria indisponível nesta igreja.');
      await this.findOne(id, igreja_id, tx);
      return tx.receitas.update({ where: { id }, data: updateReceitaDto });
    });
  }

  /**
   * Remove um tipo de receita, verificando que pertence à mesma igreja.
   * @param id ID da receita.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: number, igreja_id: string, ator?: Ator): Promise<{ message: string }> {
    return gravarPorServico(this.prisma, ator, 'RECEITAS_EXCLUIR', async tx => {
      await this.findOne(id, igreja_id, tx);
      await tx.receitas.delete({ where: { id } });
      return { message: `Receita com ID ${id} removida com sucesso.` };
    });
  }
}
