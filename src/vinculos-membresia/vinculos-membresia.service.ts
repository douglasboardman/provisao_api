import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateVinculosMembresiaDto } from './dto/create-vinculos-membresia.dto';
import { UpdateVinculosMembresiaDto } from './dto/update-vinculos-membresia.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { vinculos_membresia } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio relacionada a Vínculos de Membresia.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class VinculosMembresiaService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria um novo vínculo de membresia vinculado à igreja do solicitante.
   * Valida que a pessoa referenciada pertence à mesma igreja para evitar
   * contaminação cruzada de dados entre tenants.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createVinculosMembresiaDto Dados para criação do vínculo.
   * @throws {NotFoundException} Se a pessoa não pertencer a esta igreja.
   */
  async create(igreja_id: string, createVinculosMembresiaDto: CreateVinculosMembresiaDto): Promise<vinculos_membresia> {
    const pessoa = await this.prisma.pessoas.findFirst({
      where: { id: createVinculosMembresiaDto.pessoa_id, igreja_id },
    });
    if (!pessoa) {
      throw new NotFoundException('Pessoa não encontrada nesta igreja.');
    }

    // Regra de negócio: uma pessoa só pode ter UM vínculo ativo por vez
    if (createVinculosMembresiaDto.vinculo_ativo !== false) {
      const vinculoAtivoExistente = await this.prisma.vinculos_membresia.findFirst({
        where: { pessoa_id: createVinculosMembresiaDto.pessoa_id, vinculo_ativo: true },
      });
      if (vinculoAtivoExistente) {
        throw new ConflictException(
          `${pessoa.nome_completo} já possui um vínculo de membresia ativo. ` +
          'Desative o vínculo atual antes de criar um novo, ou cadastre o novo como inativo.',
        );
      }
    }

    return this.prisma.vinculos_membresia.create({
      data: { ...createVinculosMembresiaDto, igreja_id },
      include: { pessoas: { select: { nome_completo: true } } },
    });
  }

  /**
   * Retorna todos os vínculos de membresia da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<vinculos_membresia[]> {
    return this.prisma.vinculos_membresia.findMany({
      where: { igreja_id },
      include: { pessoas: { select: { nome_completo: true } } },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Encontra um vínculo de membresia pelo ID, garantindo que pertence à mesma igreja.
   * @param id UUID do vínculo.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrado nesta igreja.
   */
  async findOne(id: string, igreja_id: string): Promise<vinculos_membresia> {
    const vinculo = await this.prisma.vinculos_membresia.findFirst({
      where: { id, igreja_id },
    });

    if (!vinculo) {
      throw new NotFoundException(`Vínculo de membresia com ID ${id} não encontrado.`);
    }
    return vinculo;
  }

  /**
   * Atualiza um vínculo de membresia, verificando que pertence à mesma igreja.
   * @param id UUID do vínculo.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateVinculosMembresiaDto Dados para atualização.
   */
  async update(id: string, igreja_id: string, updateVinculosMembresiaDto: UpdateVinculosMembresiaDto): Promise<vinculos_membresia> {
    const vinculo = await this.findOne(id, igreja_id);

    // Se a atualização tenta reativar o vínculo, verifica se há outro ativo
    if (updateVinculosMembresiaDto.vinculo_ativo === true && !vinculo.vinculo_ativo) {
      const vinculoAtivoExistente = await this.prisma.vinculos_membresia.findFirst({
        where: { pessoa_id: vinculo.pessoa_id, vinculo_ativo: true, NOT: { id } },
      });
      if (vinculoAtivoExistente) {
        throw new ConflictException(
          'Essa pessoa já possui outro vínculo de membresia ativo. ' +
          'Desative-o antes de reativar este.',
        );
      }
    }

    return this.prisma.vinculos_membresia.update({ where: { id }, data: updateVinculosMembresiaDto });
  }

  /**
   * Remove um vínculo de membresia, verificando que pertence à mesma igreja.
   * @param id UUID do vínculo.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: string, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.vinculos_membresia.delete({ where: { id } });
    return { message: `Vínculo de membresia com ID ${id} removido com sucesso.` };
  }
}
