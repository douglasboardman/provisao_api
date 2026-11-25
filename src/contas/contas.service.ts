import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { Prisma } from '@prisma/client';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateContaDto } from './dto/create-conta.dto';
import { UpdateContaDto } from './dto/update-conta.dto';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Serviço responsável pela lógica de negócio relacionada a Contas bancárias.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class ContasService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria uma nova conta vinculada à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createContaDto Dados para criação.
   */
  async create(igreja_id: string, createContaDto: CreateContaDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'CONTAS_CADASTRAR', async tx => {
      return tx.contas.create({ data: { ...createContaDto, igreja_id } });
    });
  }

  /**
   * Retorna todas as contas da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async findAll(igreja_id: string) {
    return this.prisma.contas.findMany({
      where: { igreja_id },
      select: {
        id: true,
        descricao: true,
        banco: true,
        tipo_conta: true,
        num_conta: true,
        agencia: true,
        saldo_inicial: true,
        cor_hex: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  /**
   * Encontra uma conta pelo ID, garantindo que pertence à mesma igreja.
   * @param id UUID da conta.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se não encontrada nesta igreja.
   */
  async findOne(id: string, igreja_id: string, tx: Tx = this.prisma) {
    const conta = await tx.contas.findFirst({ where: { id, igreja_id } });

    if (!conta) {
      throw new NotFoundException(`Conta com ID ${id} não encontrada.`);
    }
    return conta;
  }

  /**
   * Atualiza uma conta, verificando que pertence à mesma igreja.
   * @param id UUID da conta.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updateContaDto Dados para atualização.
   */
  async update(id: string, igreja_id: string, updateContaDto: UpdateContaDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'CONTAS_EDITAR', async tx => {
      await this.findOne(id, igreja_id, tx);
      return tx.contas.update({ where: { id }, data: updateContaDto });
    });
  }

  /**
   * Remove uma conta, verificando que pertence à mesma igreja.
   * @param id UUID da conta.
   * @param igreja_id ID da igreja extraído do token JWT.
   */
  async remove(id: string, igreja_id: string, ator?: Ator): Promise<{ message: string }> {
    return gravarPorServico(this.prisma, ator, 'CONTAS_EXCLUIR', async tx => {
      await this.findOne(id, igreja_id, tx);
      try {
        await tx.contas.delete({ where: { id } });
      } catch (erro) {
        if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2003') {
          throw new ConflictException('A conta possui registros associados que precisam ser preservados.');
        }
        throw erro;
      }
      return { message: `Conta com ID ${id} removida com sucesso.` };
    });
  }
}
