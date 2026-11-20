import { Prisma } from '@prisma/client';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatePessoaDto } from './dto/create-pessoa.dto';
import { UpdatePessoaDto } from './dto/update-pessoa.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { Cpf } from 'src/core/classes/cpf.class';
import { pessoas } from '@prisma/client';

/**
 * Serviço responsável pela lógica de negócio relacionada a Pessoas.
 * Todas as operações são isoladas por `igreja_id` para garantir a separação
 * de dados entre tenants (igrejas).
 */
@Injectable()
export class PessoasService {
  /** @param prisma O cliente Prisma para interações com o banco de dados. */
  constructor(private readonly prisma: PrismaService) {}

  private async conferirProfissao(igreja_id: string, profissao_id?: string | null) {
    if (!profissao_id) return;
    const profissao = await this.prisma.profissoes.findFirst({ where: { id: profissao_id, igreja_id }, select: { id: true } });
    if (!profissao) throw new BadRequestException('Selecione uma profissão cadastrada nesta igreja.');
  }

  /**
   * Cria um novo registro de pessoa vinculado à igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param createPessoaDto Dados para a criação da pessoa.
   * @returns A pessoa criada.
   */
  async create(igreja_id: string, createPessoaDto: CreatePessoaDto): Promise<pessoas> {
    const { data_nascimento, cpf, ...restOfDto } = createPessoaDto;

    if (restOfDto.conjuge_id) {
      const conjuge = await this.prisma.pessoas.findFirst({ where: { id: restOfDto.conjuge_id, igreja_id } });
      if (!conjuge) {
        throw new NotFoundException(`Pessoa (cônjuge) com o ID ${restOfDto.conjuge_id} não encontrada.`);
      }
    }

    await this.conferirProfissao(igreja_id, restOfDto.profissao_id);
    return this.prisma.pessoas.create({
      data: {
        ...restOfDto,
        data_nascimento: new Date(data_nascimento),
        cpf: cpf ? Cpf.create(cpf).value : null,
        igreja_id,
      },
    });
  }

  /**
   * Retorna todas as pessoas da igreja do solicitante.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Lista de pessoas.
   */
  async findAll(igreja_id: string): Promise<pessoas[]> {
    return this.prisma.pessoas.findMany({
      where: { igreja_id },
      include: { grupos_familiares: true, tratamentos: true },
    });
  }

  /**
   * Encontra uma pessoa pelo ID, garantindo que pertence à mesma igreja.
   * @param id UUID da pessoa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @throws {NotFoundException} Se a pessoa não existir nesta igreja.
   */
  async findOne(id: string, igreja_id: string): Promise<pessoas> {
    const pessoa = await this.prisma.pessoas.findFirst({ where: { id, igreja_id } });

    if (!pessoa) {
      throw new NotFoundException(`Pessoa com o ID ${id} não encontrada.`);
    }
    return pessoa;
  }

  /**
   * Atualiza uma pessoa, verificando que pertence à mesma igreja.
   * @param id UUID da pessoa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @param updatePessoaDto Dados para atualização.
   * @returns A pessoa atualizada.
   */
  async update(id: string, igreja_id: string, updatePessoaDto: UpdatePessoaDto): Promise<pessoas> {
    await this.findOne(id, igreja_id);

    const { data_nascimento, cpf, ...restOfDto } = updatePessoaDto;

    if (restOfDto.conjuge_id) {
      if (restOfDto.conjuge_id === id) {
        throw new NotFoundException(`Uma pessoa não pode ser cônjuge de si mesma.`);
      }
      const conjuge = await this.prisma.pessoas.findFirst({ where: { id: restOfDto.conjuge_id, igreja_id } });
      if (!conjuge) {
        throw new NotFoundException(`Pessoa (cônjuge) com o ID ${restOfDto.conjuge_id} não encontrada.`);
      }
    }
    await this.conferirProfissao(igreja_id, restOfDto.profissao_id);
    const dataToUpdate: Record<string, unknown> = { ...restOfDto };

    if (data_nascimento) {
      dataToUpdate.data_nascimento = new Date(data_nascimento);
    }
    if (cpf) {
      dataToUpdate.cpf = Cpf.create(cpf).value;
    }

    return this.prisma.pessoas.update({ where: { id }, data: dataToUpdate });
  }

  /**
   * Remove uma pessoa, verificando que pertence à mesma igreja.
   * @param id UUID da pessoa.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns Mensagem de confirmação.
   */
  async remove(id: string, igreja_id: string): Promise<{ message: string }> {
    await this.findOne(id, igreja_id);
    try {
      await this.prisma.pessoas.delete({ where: { id } });
    } catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2003') {
        throw new ConflictException('A pessoa possui registros históricos que precisam ser preservados.');
      }
      throw erro;
    }
    return { message: `A pessoa registrada pelo ID ${id} foi removida com sucesso.` };
  }

  /**
   * Associa ou desassocia uma pessoa de um grupo familiar, garantindo que ambos
   * pertencem à mesma igreja para evitar contaminação cruzada de dados.
   * @param idPessoa UUID da pessoa.
   * @param idFamilia UUID do grupo familiar, ou null para desassociar.
   * @param igreja_id ID da igreja extraído do token JWT.
   * @returns A pessoa com o grupo familiar atualizado.
   */
  async setFamilia(idPessoa: string, idFamilia: string | null, igreja_id: string): Promise<pessoas> {
    return this.prisma.$transaction(async (tx) => {
      const pessoa = await tx.pessoas.findFirst({ where: { id: idPessoa, igreja_id } });
      if (!pessoa) {
        throw new NotFoundException(`Pessoa com o ID '${idPessoa}' não encontrada.`);
      }

      if (idFamilia !== null) {
        const grupoFamiliar = await tx.grupos_familiares.findFirst({
          where: { id: idFamilia, igreja_id },
        });
        if (!grupoFamiliar) {
          throw new NotFoundException(`Grupo Familiar com ID '${idFamilia}' não foi encontrado.`);
        }
      }

      return tx.pessoas.update({
        where: { id: idPessoa },
        data: { grupo_familiar_id: idFamilia },
      });
    });
  }
}
