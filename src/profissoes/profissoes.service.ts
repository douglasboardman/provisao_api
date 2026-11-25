import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator } from '../autorizacao/politica';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalvarProfissaoDto } from './profissoes.dto';

@Injectable()
export class ProfissoesService {
  constructor(private readonly prisma: PrismaService) {}

  listar(igreja_id: string) {
    return this.prisma.profissoes.findMany({ where: { igreja_id }, orderBy: { nome: 'asc' }, select: { id: true, nome: true } });
  }

  criar(igreja_id: string, { nome }: SalvarProfissaoDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'PROFISSOES_CADASTRAR', async tx => {
      return this.executar(() => tx.profissoes.create({
        data: { igreja_id, nome }, select: { id: true, nome: true },
      }));
    });
  }

  atualizar(igreja_id: string, id: string, { nome }: SalvarProfissaoDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'PROFISSOES_EDITAR', async tx => {
      return this.executar(() => tx.profissoes.update({
        where: { id, igreja_id }, data: { nome }, select: { id: true, nome: true },
      }));
    });
  }

  excluir(igreja_id: string, id: string, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'PROFISSOES_EXCLUIR', async tx => {
      return this.executar(() => tx.profissoes.delete({
        where: { id, igreja_id }, select: { id: true },
      }));
    });
  }

  private async executar<T>(operacao: () => Promise<T>): Promise<T> {
    try {
      return await operacao();
    } catch (erro) {
      if (erro instanceof Prisma.PrismaClientKnownRequestError) {
        if (erro.code === 'P2002') throw new ConflictException('Já existe uma profissão com esse nome nesta igreja.');
        if (erro.code === 'P2003') throw new ConflictException('A profissão está vinculada a um cadastro de pessoa.');
        if (erro.code === 'P2025') throw new NotFoundException('Profissão não encontrada nesta igreja.');
      }
      throw erro;
    }
  }
}
