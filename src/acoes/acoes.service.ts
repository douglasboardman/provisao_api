import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateAcoeDto } from './dto/create-acoe.dto';
import { UpdateAcoeDto } from './dto/update-acoe.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { acoes } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio relacionada a Ações.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class AcoesService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private prisma: PrismaService) {}

  /**
   * Cria uma nova ação vinculada à igreja do solicitante.
   * Valida que o responsável e a conta referenciados pertencem à mesma igreja,
   * impedindo injeção de FKs cross-tenant.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createAcoeDto Dados para criação.
   * @throws {NotFoundException} Se responsável ou conta não pertencerem a esta igreja.
   */
  async create(igreja_id: string, createAcoeDto: CreateAcoeDto): Promise<acoes> {
    const [responsavel, conta] = await Promise.all([
      this.prisma.pessoas.findFirst({
        where: { id: createAcoeDto.responsavel_pessoa_id, igreja_id },
      }),
      this.prisma.contas.findFirst({
        where: { id: createAcoeDto.conta_id, igreja_id },
      }),
    ]);

    if (!responsavel) {
      throw new NotFoundException('Responsável não encontrado nesta igreja.');
    }
    if (!conta) {
      throw new NotFoundException('Conta não encontrada nesta igreja.');
    }

    return this.prisma.acoes.create({ data: { ...createAcoeDto, igreja_id } });
  }

  /**
   * Retorna todas as ações da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string): Promise<acoes[]> {
    return this.prisma.acoes.findMany({ where: { igreja_id } });
  }

  /**
   * Encontra uma ação pelo ID, garantindo que pertence à mesma igreja.
   * @param id UUID da ação.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrada nesta igreja.
   */
  async findOne(id: string, igreja_id: string): Promise<acoes> {
    const acao = await this.prisma.acoes.findFirst({ where: { id, igreja_id } });

    if (!acao) {
      throw new NotFoundException(`Ação com ID ${id} não encontrada.`);
    }
    return acao;
  }

  /**
   * Atualiza uma ação, verificando que pertence à mesma igreja.
   * @param id UUID da ação.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateAcoeDto Dados para atualização.
   */
  async update(id: string, igreja_id: string, updateAcoeDto: UpdateAcoeDto): Promise<acoes> {
    await this.findOne(id, igreja_id);
    return this.prisma.acoes.update({ where: { id }, data: updateAcoeDto });
  }

  /**
   * Remove uma ação, verificando que pertence à mesma igreja.
   * @param id UUID da ação.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: string, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    await this.prisma.acoes.delete({ where: { id } });
    return { message: `Ação com ID ${id} removida com sucesso.` };
  }
}
