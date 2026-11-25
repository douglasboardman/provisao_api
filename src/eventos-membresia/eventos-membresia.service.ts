import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { Prisma } from '@prisma/client';
import { ConflictException, Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { valoresDaRegra } from '../regras-relacao-enum/parametros-membresia';
import { eventoVigente } from './estado-temporal';
import { PrismaService } from '../prisma/prisma.service';
import { RegrasRelacaoEnumService } from '../regras-relacao-enum/regras-relacao-enum.service';
import { CreateEventoMembresiaDto } from './dto/create-evento-membresia.dto';
import { UpdateEventoMembresiaDto } from './dto/update-evento-membresia.dto';
import { membresia_tipo_evento as TipoEvento, membresia_rol as MembresiaRol } from '@prisma/client';

const TIPO_EVENTO_LABEL: Record<TipoEvento, string> = {
  [TipoEvento.ADMISSAO]: 'Admissão',
  [TipoEvento.DEMISSAO]: 'Demissão',
  [TipoEvento.MUDANCA_DE_ROL]: 'Mudança de Rol',
};

@Injectable()
export class EventosMembresiaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regrasEnum: RegrasRelacaoEnumService,
  ) {}

  async create(igrejaId: string, dto: CreateEventoMembresiaDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'MEMBRESIA_REGISTRAR', async tx => {
      const pessoa = await tx.pessoas.findFirst({
        where: { id: dto.pessoa_id, igreja_id: igrejaId },
      });
      if (!pessoa) {
        throw new BadRequestException('Pessoa não encontrada nesta igreja.');
      }

      const regras = await this.regrasEnum.getRegrasPorModulo('membresia', igrejaId, tx);
      const nomeRegraMotivacao = `Motivações de ${TIPO_EVENTO_LABEL[dto.tipo_evento]}`;
      const motivacoesPermitidas = valoresDaRegra(regras, nomeRegraMotivacao, dto.tipo_evento);
      if (!motivacoesPermitidas.includes(dto.motivacao_evento)) {
        throw new BadRequestException('Motivação inválida para o tipo de evento.');
      }

      const ultimoEventoPessoa = await this.getUltimoEvento(dto.pessoa_id, igrejaId, tx);
      if (ultimoEventoPessoa) {
        const novaData = new Date(dto.data_evento);
        const ultimaData = new Date(ultimoEventoPessoa.data_evento);
        if (novaData.getTime() === ultimaData.getTime() && (ultimoEventoPessoa.ordem_dia == null || dto.ordem_dia == null || dto.ordem_dia <= ultimoEventoPessoa.ordem_dia)) {
          throw new BadRequestException('Para atos no mesmo dia, confira a ordem existente e informe uma ordem posterior.');
        }
        if (novaData < ultimaData) {
          throw new BadRequestException(
            'A data do novo evento não pode ser anterior à data do último evento registrado no histórico de membresia da pessoa.',
          );
        }
      }

      const data: any = {
        igreja_id: igrejaId,
        pessoa_id: dto.pessoa_id,
        tipo_evento: dto.tipo_evento,
        motivacao_evento: dto.motivacao_evento,
        data_evento: dto.data_evento,
        ordem_dia: dto.ordem_dia,
        igreja_origem: dto.igreja_origem,
        igreja_destino: dto.igreja_destino,
        observacoes: dto.observacoes,
      };

      if (dto.tipo_evento === TipoEvento.DEMISSAO) {
        const rolMapeado = valoresDaRegra(regras, 'Rol de Destino por Motivação de Demissão', dto.motivacao_evento)[0];
        if (!rolMapeado) {
          throw new BadRequestException('Motivação de demissão sem rol de destino configurado.');
        }
        data.rol = rolMapeado;
      } else if (dto.tipo_evento === TipoEvento.MUDANCA_DE_ROL) {
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Mudança de Rol', dto.tipo_evento);
        if (!rolsPermitidos.includes(dto.rol)) {
          throw new BadRequestException('Rol inválido para mudança de rol.');
        }

        const motivacoesPorRol = valoresDaRegra(regras, 'Motivações por Rol de Destino', dto.rol);
        if (!motivacoesPorRol.includes(dto.motivacao_evento)) {
          throw new BadRequestException('Motivação inválida para o rol de destino selecionado.');
        }

        const ultimoEvento = await this.getUltimoEvento(dto.pessoa_id, igrejaId, tx);
        data.rol_origem = ultimoEvento?.rol ?? null;
        data.rol = dto.rol;
      } else {
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Admissão', dto.tipo_evento);
        if (!rolsPermitidos.includes(dto.rol)) {
          throw new BadRequestException('Rol inválido para admissão.');
        }
        data.rol = dto.rol;
      }

      return tx.eventos_membresia.create({
        data,
        include: { pessoas: { select: { id: true, nome_completo: true } } },
      });
    });
  }

  async findAll(igrejaId: string) {
    return this.prisma.eventos_membresia.findMany({
      where: { igreja_id: igrejaId },
      include: { pessoas: { select: { id: true, nome_completo: true } } },
      orderBy: [{ data_evento: 'desc' }, { ordem_dia: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    });
  }

  async findByPessoa(pessoaId: string, igrejaId: string) {
    return this.prisma.eventos_membresia.findMany({
      where: { pessoa_id: pessoaId, igreja_id: igrejaId },
      orderBy: [{ data_evento: 'asc' }, { ordem_dia: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
  }

  async findOne(id: string, igrejaId: string, tx: Tx = this.prisma) {
    const evento = await tx.eventos_membresia.findFirst({
      where: { id, igreja_id: igrejaId },
      include: { pessoas: { select: { id: true, nome_completo: true } } },
    });
    if (!evento) {
      throw new NotFoundException('Evento de membresia não encontrado.');
    }
    return evento;
  }

  async update(id: string, igrejaId: string, dto: UpdateEventoMembresiaDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'MEMBRESIA_EDITAR', async tx => {
      const evento = await this.findOne(id, igrejaId, tx);
      await this.assertIsLastEvent(evento.id, evento.pessoa_id, igrejaId, tx);

      if (dto.data_evento) {
        const penultimoEvento = await tx.eventos_membresia.findFirst({
          where: {
            pessoa_id: evento.pessoa_id,
            igreja_id: igrejaId,
            id: { not: evento.id },
          },
          orderBy: { data_evento: 'desc' },
        });

        if (penultimoEvento) {
          const novaData = new Date(dto.data_evento);
          const penultimaData = new Date(penultimoEvento.data_evento);
          if (novaData < penultimaData) {
            throw new BadRequestException(
              'A data do novo evento não pode ser anterior à data do último evento registrado no histórico de membresia da pessoa.',
            );
          }
        }
      }

      const tipoEfetivo = dto.tipo_evento ?? evento.tipo_evento;
      const motivacaoEfetiva = dto.motivacao_evento ?? evento.motivacao_evento;

      const regras = await this.regrasEnum.getRegrasPorModulo('membresia', igrejaId, tx);
      const nomeRegraMotivacao = `Motivações de ${TIPO_EVENTO_LABEL[tipoEfetivo]}`;
      const motivacoesPermitidas = valoresDaRegra(regras, nomeRegraMotivacao, tipoEfetivo);
      if (!motivacoesPermitidas.includes(motivacaoEfetiva)) {
        throw new BadRequestException('Motivação inválida para este tipo de evento.');
      }

      if (tipoEfetivo === TipoEvento.DEMISSAO) {
        const rolMapeado = valoresDaRegra(regras, 'Rol de Destino por Motivação de Demissão', motivacaoEfetiva)[0];
        if (rolMapeado) dto.rol = rolMapeado as any;
      }

      if (tipoEfetivo === TipoEvento.MUDANCA_DE_ROL) {
        const rolEfetivo = (dto.rol ?? evento.rol) as MembresiaRol;
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Mudança de Rol', tipoEfetivo);
        if (!rolsPermitidos.includes(rolEfetivo)) {
          throw new BadRequestException('Rol inválido para mudança de rol.');
        }
        const motivacoesPorRol = valoresDaRegra(regras, 'Motivações por Rol de Destino', rolEfetivo);
        if (!motivacoesPorRol.includes(motivacaoEfetiva)) {
          throw new BadRequestException('Motivação inválida para o rol de destino selecionado.');
        }
      }

      if (tipoEfetivo === TipoEvento.ADMISSAO) {
        const rolEfetivo = (dto.rol ?? evento.rol) as MembresiaRol;
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Admissão', tipoEfetivo);
        if (!rolsPermitidos.includes(rolEfetivo)) {
          throw new BadRequestException('Rol inválido para admissão.');
        }
      }

      const { pessoa_id: _p, ...safeData } = dto;

      return tx.eventos_membresia.update({
        where: { id },
        data: safeData,
        include: { pessoas: { select: { id: true, nome_completo: true } } },
      });
    });
  }

  async remove(id: string, igrejaId: string, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'MEMBRESIA_EXCLUIR', async tx => {
      const evento = await this.findOne(id, igrejaId, tx);
      await this.assertIsLastEvent(evento.id, evento.pessoa_id, igrejaId, tx);

      try {
        await tx.eventos_membresia.delete({ where: { id } });
      } catch (erro) {
        if (erro instanceof Prisma.PrismaClientKnownRequestError && erro.code === 'P2003') {
          throw new ConflictException('O evento possui vínculos ou registros históricos que precisam ser preservados.');
        }
        throw erro;
      }
      return { message: 'Evento de membresia excluído com sucesso.' };
    });
  }

  private async getUltimoEvento(pessoaId: string, igrejaId: string, tx: Tx = this.prisma) {
    const eventos = await tx.eventos_membresia.findMany({ where: { pessoa_id: pessoaId, igreja_id: igrejaId }, orderBy: { data_evento: 'desc' } });
    if (!eventos.length) return null;
    const vigente = eventoVigente(eventos, eventos[0].data_evento);
    if (vigente.situacao !== 'DEFINIDO') throw new BadRequestException('A ordem dos eventos mais recentes está indefinida; confira o histórico antes de alterá-lo.');
    return vigente.evento;
  }

  private async assertIsLastEvent(eventoId: string, pessoaId: string, igrejaId: string, tx: Tx = this.prisma) {
    const ultimo = await this.getUltimoEvento(pessoaId, igrejaId, tx);
    if (ultimo && ultimo.id !== eventoId) {
      throw new ForbiddenException('Apenas o último evento de uma pessoa pode ser editado ou excluído.');
    }
  }
}
