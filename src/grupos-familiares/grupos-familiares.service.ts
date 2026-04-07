import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateGruposFamiliareDto } from './dto/create-grupos-familiare.dto';
import { UpdateGruposFamiliareDto } from './dto/update-grupos-familiare.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { grupos_familiares } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio relacionada a Grupos Familiares.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class GruposFamiliaresService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um novo grupo familiar vinculado à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createGruposFamiliareDto Dados para criação.
   */
  async create(igreja_id: string, createGruposFamiliareDto: CreateGruposFamiliareDto): Promise<grupos_familiares> {
    return this.prisma.grupos_familiares.create({
      data: { ...createGruposFamiliareDto, igreja_id },
    });
  }

  /**
   * Retorna todos os grupos familiares da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<grupos_familiares[]> {
    return this.prisma.grupos_familiares.findMany({ where: { igreja_id } });
  }

  /**
   * Encontra um grupo familiar pelo ID, garantindo que pertence à mesma igreja.
   * @param id UUID do grupo familiar.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrado nesta igreja.
   */
  async findOne(id: string, igreja_id: string): Promise<grupos_familiares> {
    const grupoFamiliar = await this.prisma.grupos_familiares.findFirst({
      where: { id, igreja_id },
    });

    if (!grupoFamiliar) {
      throw new NotFoundException(`Nenhum grupo familiar com o ID ${id} foi encontrado.`);
    }
    return grupoFamiliar;
  }

  /**
   * Atualiza um grupo familiar, verificando que pertence à mesma igreja.
   * @param id UUID do grupo familiar.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateGruposFamiliareDto Dados para atualização.
   */
  async update(id: string, igreja_id: string, updateGruposFamiliareDto: UpdateGruposFamiliareDto): Promise<grupos_familiares> {
    await this.findOne(id, igreja_id);
    return this.prisma.grupos_familiares.update({ where: { id }, data: updateGruposFamiliareDto });
  }

  /**
   * Remove um grupo familiar, verificando que pertence à mesma igreja.
   * @param id UUID do grupo familiar.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: string, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.grupos_familiares.delete({ where: { id } });
    return { message: `O grupo familiar registrado pelo ID ${id} foi removido com sucesso.` };
  }
}
