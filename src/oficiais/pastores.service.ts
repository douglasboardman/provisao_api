import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { exigirServicoDoUsuario } from '../autorizacao/operacao-atual';
import { exigirServicoHistorico } from './autorizacao-historico';
import { transacaoSerializavel } from '../orgaos/idempotencia';
import { PresidenciaService } from '../orgaos/presidencia.service';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';

const texto = z.string().trim().min(1).max(1000);
export const cadastroPastor = z.object({
  pessoa_id: z.uuid(), funcao: z.enum(['PRESIDENTE', 'AUXILIAR']),
  ordenacao: z.object({ data: z.iso.date(), responsavel: texto, documento: texto }).strict().optional(),
  modalidade: texto, concilio: texto, ato: texto, inicio: z.iso.date(), evidencia: texto,
}).strict();

@Injectable()
export class PastoresService {
  constructor(private readonly prisma: PrismaService, private readonly presidencias: PresidenciaService) {}

  async listar(igreja: string, referencia: string) {
    if (!z.iso.date().safeParse(referencia).success) throw new BadRequestException('Data de referência inválida.');
    const data = new Date(`${referencia}T00:00:00Z`);
    const registros = await this.prisma.oficial.findMany({
      where: { igreja_id: igreja, tipo: 'PRESBITERO_DOCENTE' }, orderBy: { pessoa: { nome_completo: 'asc' } },
      select: { id: true, tipo: true, ativo: true, pessoa: { select: { id: true, nome_completo: true } },
        eventos: { where: { tipo: 'ORDENACAO' }, orderBy: [{ data_efeito: 'asc' }, { ordem: 'asc' }], select: { data_efeito: true, autoridade: true, evidencia: true } },
        vinculos_pastorais: { orderBy: { data_inicio: 'desc' }, select: { id: true, modalidade: true, concilio: true, ato: true, data_inicio: true, data_fim: true, exercicio_institucional: true, evidencia: true } },
        presidencias_conselho: { orderBy: { inicio: 'desc' }, select: { id: true, inicio: true, fim: true } },
      },
    });
    return registros.map(p => ({ ...p, funcao: p.presidencias_conselho.some(v => v.inicio <= data && (!v.fim || v.fim > data)) ? 'PRESIDENTE' : 'AUXILIAR',
      vinculo_na_data: p.vinculos_pastorais.find(v => v.exercicio_institucional && v.data_inicio <= data && (!v.data_fim || v.data_fim >= data)) ?? null }));
  }

  async cadastrar(igreja: string, usuario: string, dados: unknown) {
    const parsed = cadastroPastor.safeParse(dados);
    if (!parsed.success) throw new BadRequestException('Preencha os dados do pastor, da ordenação e do vínculo pastoral corretamente.');
    const v = parsed.data;
    try {
      return await transacaoSerializavel(this.prisma, async tx => {
        await exigirServicoDoUsuario(tx, igreja, usuario, 'OFICIAIS_REGISTRAR');
        // Serializa cadastros desta igreja, incluindo dois candidatos à presidência.
        await tx.$queryRaw`SELECT id FROM igreja WHERE id = ${igreja} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM pessoas WHERE id = ${v.pessoa_id} AND igreja_id = ${igreja} FOR UPDATE`;
        if (!await tx.pessoas.findFirst({ where: { id: v.pessoa_id, igreja_id: igreja }, select: { id: true } })) throw new NotFoundException('Pessoa não encontrada nesta igreja.');
        const hoje = await hojeDaIgreja(tx, igreja);
        if (v.inicio > hoje || (v.ordenacao && v.ordenacao.data > v.inicio)) throw new BadRequestException('A ordenação deve preceder o início do vínculo, que não pode ser futuro.');
        let oficial = await tx.oficial.findFirst({ where: { igreja_id: igreja, pessoa_id: v.pessoa_id, tipo: 'PRESBITERO_DOCENTE' } });
        const auditar = async (tabela: string, id: string, valores: Prisma.InputJsonValue) => tx.logs_atividades.create({ data: { igreja_id: igreja, usuario_id: usuario, acao: 'CRIACAO', tabela_afetada: tabela, registro_id: id, dados_novos: valores } });
        if (!oficial) {
          if (await tx.oficial.findFirst({ where: { igreja_id: igreja, pessoa_id: v.pessoa_id, ativo: true } })) throw new ConflictException('A pessoa já possui outro ofício ativo.');
          oficial = await tx.oficial.create({ data: { igreja_id: igreja, pessoa_id: v.pessoa_id, tipo: 'PRESBITERO_DOCENTE' } });
          await auditar('oficial', oficial.id, { pessoa_id: v.pessoa_id, tipo: oficial.tipo });
        }
        if (!oficial.ativo) throw new BadRequestException('Reative o cadastro do pastor antes de registrar um novo vínculo.');
        const ord = await tx.evento_oficial.findFirst({ where: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO' } });
        if (!ord) {
          if (!v.ordenacao) throw new BadRequestException('Informe os dados da ordenação.');
          await exigirServicoHistorico(tx, igreja, usuario, 'HISTORICO_OFICIAIS_REGISTRAR', true);
          if (await tx.evento_oficial.count({ where: { igreja_id: igreja, oficial_id: oficial.id } })) throw new BadRequestException('Este pastor possui eventos anteriores. Registre a ordenação pela conferência do histórico.');
          const evento = await tx.evento_oficial.create({ data: { igreja_id: igreja, oficial_id: oficial.id, tipo: 'ORDENACAO', data_efeito: new Date(v.ordenacao.data), ordem: 1, autoridade: v.ordenacao.responsavel, evidencia: v.ordenacao.documento } });
          await auditar('evento_oficial', evento.id, v.ordenacao);
        } else if (v.ordenacao) throw new ConflictException('A ordenação já está registrada. Utilize os dados existentes.');
        else if (ord.data_efeito > new Date(v.inicio)) throw new BadRequestException('O vínculo não pode preceder a ordenação.');
        if (await tx.vinculo_pastoral.findFirst({ where: { igreja_id: igreja, oficial_id: oficial.id, exercicio_institucional: true, OR: [{ data_fim: null }, { data_fim: { gte: new Date(v.inicio) } }] } })) throw new ConflictException('Este pastor já possui vínculo que alcança o período informado.');
        if (v.funcao === 'PRESIDENTE' && await tx.presidencia_conselho.findFirst({ where: { igreja_id: igreja, OR: [{ fim: null }, { fim: { gt: new Date(v.inicio) } }] } })) throw new ConflictException('Já existe uma presidência no período. Encerre a anterior antes de registrar o sucessor.');
        const vinculo = await tx.vinculo_pastoral.create({ data: { igreja_id: igreja, oficial_id: oficial.id, modalidade: v.modalidade, concilio: v.concilio, ato: v.ato, data_inicio: new Date(v.inicio), exercicio_institucional: true, evidencia: v.evidencia } });
        await auditar('vinculo_pastoral', vinculo.id, { modalidade: v.modalidade, concilio: v.concilio, ato: v.ato, inicio: v.inicio, evidencia: v.evidencia });
        if (v.funcao === 'PRESIDENTE') await this.presidencias.registrar(igreja, usuario, { oficial_id: oficial.id, inicio: v.inicio, evidencia: v.evidencia, idempotencia: randomUUID() }, tx);
        return { id: oficial.id, vinculo_id: vinculo.id };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2004'].includes(e.code)) throw new ConflictException('O registro conflita com outro cadastro ou período de presidência.');
      throw e;
    }
  }
}
