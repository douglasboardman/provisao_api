import { gravarPorServico } from '../autorizacao/escrita-servico';
import type { Ator, Tx } from '../autorizacao/politica';
import { Prisma } from '@prisma/client';
import { ConflictException, Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { valoresDaRegra } from '../regras-relacao-enum/parametros-membresia';
import { fontesDaMovimentacao, apresentarDocumentacao, temFundamentoDocumental } from './documentacao';
import { eventoVigente, sequenciaConferida } from './estado-temporal';
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

const dataCivil = (data: Date) => new Date(data.toISOString().slice(0, 10));

function conferirOrdemNoMesmoDia(data: Date, ordem: number | null | undefined, anterior: { data_evento: Date; ordem_dia: number | null }) {
  if (data.getTime() === anterior.data_evento.getTime() && (anterior.ordem_dia == null || ordem == null || ordem <= anterior.ordem_dia)) {
    throw new BadRequestException('Para atos no mesmo dia, confira a ordem existente e informe uma ordem posterior.');
  }
}

@Injectable()
export class EventosMembresiaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regrasEnum: RegrasRelacaoEnumService,
  ) {}

  async create(igrejaId: string, dto: CreateEventoMembresiaDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'MEMBRESIA_REGISTRAR', async tx => {
      const pessoa = await this.bloquearPessoa(dto.pessoa_id, igrejaId, tx);
      if (!pessoa) {
        throw new BadRequestException('Pessoa não encontrada nesta igreja.');
      }

      const regras = await this.regrasEnum.getRegrasPorModulo('membresia', igrejaId, tx);
      const nomeRegraMotivacao = `Motivações de ${TIPO_EVENTO_LABEL[dto.tipo_evento]}`;
      const motivacoesPermitidas = valoresDaRegra(regras, nomeRegraMotivacao, dto.tipo_evento);
      if (!motivacoesPermitidas.includes(dto.motivacao_evento)) {
        throw new BadRequestException('Motivação inválida para o tipo de evento.');
      }

      const historico = await this.historico(dto.pessoa_id, igrejaId, tx);
      if (!historico.every(temFundamentoDocumental)) {
        throw new BadRequestException('Confira a documentação das movimentações anteriores antes de registrar um novo ato.');
      }
      const ultimoEventoPessoa = this.ultimoEvento(historico);
      if (dto.tipo_evento !== TipoEvento.ADMISSAO && (!ultimoEventoPessoa || ultimoEventoPessoa.tipo_evento === TipoEvento.DEMISSAO)) {
        throw new BadRequestException('A movimentação exige um vínculo de membresia vigente e documentado.');
      }

      const novaData = dataCivil(dto.data_evento);
      if (ultimoEventoPessoa) {
        conferirOrdemNoMesmoDia(novaData, dto.ordem_dia, ultimoEventoPessoa);
        if (novaData < ultimoEventoPessoa.data_evento) {
          throw new BadRequestException(
            'A data do novo evento não pode ser anterior à data do último evento registrado no histórico de membresia da pessoa.',
          );
        }
      }

      const data: Prisma.eventos_membresiaUncheckedCreateInput = {
        igreja_id: igrejaId,
        pessoa_id: dto.pessoa_id,
        tipo_evento: dto.tipo_evento,
        motivacao_evento: dto.motivacao_evento,
        data_evento: novaData,
        rol: dto.rol,
        ordem_dia: dto.ordem_dia,
        igreja_origem: dto.igreja_origem,
        igreja_destino: dto.igreja_destino,
        referencia_documental: dto.referencia_documental,
        observacoes: dto.observacoes,
      };

      if (dto.tipo_evento === TipoEvento.DEMISSAO) {
        const rolMapeado = valoresDaRegra(regras, 'Rol de Destino por Motivação de Demissão', dto.motivacao_evento)[0];
        if (!rolMapeado) {
          throw new BadRequestException('Motivação de demissão sem rol de destino configurado.');
        }
        data.rol = rolMapeado as MembresiaRol;
      } else if (dto.tipo_evento === TipoEvento.MUDANCA_DE_ROL) {
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Mudança de Rol', dto.tipo_evento);
        if (!rolsPermitidos.includes(dto.rol)) {
          throw new BadRequestException('Rol inválido para mudança de rol.');
        }

        const motivacoesPorRol = valoresDaRegra(regras, 'Motivações por Rol de Destino', dto.rol);
        if (!motivacoesPorRol.includes(dto.motivacao_evento)) {
          throw new BadRequestException('Motivação inválida para o rol de destino selecionado.');
        }

        data.rol_origem = ultimoEventoPessoa?.rol ?? null;
      } else {
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Admissão', dto.tipo_evento);
        if (!rolsPermitidos.includes(dto.rol)) {
          throw new BadRequestException('Rol inválido para admissão.');
        }
      }

      return tx.eventos_membresia.create({
        data,
        include: { pessoas: { select: { id: true, nome_completo: true } } },
      });
    });
  }

  async findAll(igrejaId: string) {
    const eventos = await this.prisma.eventos_membresia.findMany({
      where: { igreja_id: igrejaId },
      include: { ...fontesDaMovimentacao, pessoas: { select: { id: true, nome_completo: true } } },
      orderBy: [{ data_evento: 'desc' }, { ordem_dia: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    });
    return eventos.map(apresentarDocumentacao);
  }

  async findByPessoa(pessoaId: string, igrejaId: string) {
    const eventos = await this.prisma.eventos_membresia.findMany({
      where: { pessoa_id: pessoaId, igreja_id: igrejaId },
      include: fontesDaMovimentacao,
      orderBy: [{ data_evento: 'asc' }, { ordem_dia: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
    return eventos.map(apresentarDocumentacao);
  }

  async findOne(id: string, igrejaId: string, tx: Tx = this.prisma) {
    const evento = await tx.eventos_membresia.findFirst({
      where: { id, igreja_id: igrejaId },
      include: { ...fontesDaMovimentacao, pessoas: { select: { id: true, nome_completo: true } } },
    });
    if (!evento) {
      throw new NotFoundException('Evento de membresia não encontrado.');
    }
    return apresentarDocumentacao(evento);
  }

  async update(id: string, igrejaId: string, dto: UpdateEventoMembresiaDto, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'MEMBRESIA_EDITAR', async tx => {
      const evento = await this.findOne(id, igrejaId, tx);
      await this.bloquearPessoa(evento.pessoa_id, igrejaId, tx);
      const historico = await this.historico(evento.pessoa_id, igrejaId, tx);
      const ultimo = this.exigirUltimoEvento(evento.id, historico);
      const novaData = dto.data_evento && dataCivil(dto.data_evento);
      if (novaData && novaData.getTime() !== ultimo.data_evento.getTime()) {
        const penultimoEvento = this.ultimoEvento(historico.filter(e => e.id !== id));
        if (penultimoEvento) {
          conferirOrdemNoMesmoDia(novaData, ultimo.ordem_dia, penultimoEvento);
          if (novaData < penultimoEvento.data_evento) {
            throw new BadRequestException(
              'A data do novo evento não pode ser anterior à data do último evento registrado no histórico de membresia da pessoa.',
            );
          }
        }
      }

      const tipoEfetivo = dto.tipo_evento ?? ultimo.tipo_evento;
      const motivacaoEfetiva = dto.motivacao_evento ?? ultimo.motivacao_evento;

      const regras = await this.regrasEnum.getRegrasPorModulo('membresia', igrejaId, tx);
      const nomeRegraMotivacao = `Motivações de ${TIPO_EVENTO_LABEL[tipoEfetivo]}`;
      const motivacoesPermitidas = valoresDaRegra(regras, nomeRegraMotivacao, tipoEfetivo);
      if (!motivacoesPermitidas.includes(motivacaoEfetiva)) {
        throw new BadRequestException('Motivação inválida para este tipo de evento.');
      }

      if (tipoEfetivo === TipoEvento.DEMISSAO) {
        const rolMapeado = valoresDaRegra(regras, 'Rol de Destino por Motivação de Demissão', motivacaoEfetiva)[0];
        if (rolMapeado) dto.rol = rolMapeado as MembresiaRol;
      }

      if (tipoEfetivo === TipoEvento.MUDANCA_DE_ROL) {
        const rolEfetivo = (dto.rol ?? ultimo.rol) as MembresiaRol;
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
        const rolEfetivo = (dto.rol ?? ultimo.rol) as MembresiaRol;
        const rolsPermitidos = valoresDaRegra(regras, 'Rols de Admissão', tipoEfetivo);
        if (!rolsPermitidos.includes(rolEfetivo)) {
          throw new BadRequestException('Rol inválido para admissão.');
        }
      }

      const { pessoa_id: _p, ...safeData } = dto;

      return tx.eventos_membresia.update({
        where: { id },
        data: { ...safeData, data_evento: novaData },
        include: { pessoas: { select: { id: true, nome_completo: true } } },
      });
    });
  }

  async remove(id: string, igrejaId: string, ator?: Ator) {
    return gravarPorServico(this.prisma, ator, 'MEMBRESIA_EXCLUIR', async tx => {
      const evento = await this.findOne(id, igrejaId, tx);
      await this.bloquearPessoa(evento.pessoa_id, igrejaId, tx);
      this.exigirUltimoEvento(evento.id, await this.historico(evento.pessoa_id, igrejaId, tx));

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

  private async bloquearPessoa(pessoaId: string, igrejaId: string, tx: Tx) {
    const [pessoa] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM pessoas WHERE id = ${pessoaId} AND igreja_id = ${igrejaId} FOR UPDATE`;
    return pessoa;
  }

  private historico(pessoaId: string, igrejaId: string, tx: Tx) {
    return tx.eventos_membresia.findMany({ where: { pessoa_id: pessoaId, igreja_id: igrejaId }, include: fontesDaMovimentacao, orderBy: { data_evento: 'desc' } });
  }

  private ultimoEvento(eventos: Awaited<ReturnType<EventosMembresiaService['historico']>>) {
    if (!eventos.length) return null;
    if (!sequenciaConferida(eventos)) throw new BadRequestException('Confira a ordem dos atos na mesma data antes de alterar o histórico.');
    const vigente = eventoVigente(eventos, eventos[0].data_evento);
    return vigente.situacao === 'DEFINIDO' ? vigente.evento : null;
  }

  private exigirUltimoEvento(eventoId: string, eventos: Awaited<ReturnType<EventosMembresiaService['historico']>>) {
    const ultimo = this.ultimoEvento(eventos);
    if (ultimo?.id !== eventoId) {
      throw new ForbiddenException('Apenas o último evento de uma pessoa pode ser editado ou excluído.');
    }
    return ultimo;
  }
}
