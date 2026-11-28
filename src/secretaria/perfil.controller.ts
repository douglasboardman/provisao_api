import { ContaComum } from '../autorizacao/politica';
import { contextosDasAtasRestritas, filtroVisibilidadeDocumentos } from './visibilidade-documentos';
import { Controller, Get, Header, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { recursosDaSessao } from '../feature-flags/feature-flags';
import { SecretariaBaseService, type AtorSecretaria } from './secretaria-base.service';

@Controller('perfil')
@UseGuards(AuthGuard)
export class PerfilController {
  constructor(private readonly base: SecretariaBaseService) {}

  @ContaComum()
  @Get()
  @Header('Cache-Control', 'private, no-store')
  consultar(@Request() req: { user: AtorSecretaria }) {
    const ator = req.user;
    const igreja_id = ator.igreja_id;
    return this.base.prisma.$transaction(
      async (tx) => {
        const conta = await tx.usuarios.findFirstOrThrow({
          where: { id: ator.sub, igreja_id, ativo: true },
          select: { pessoa_id: true, igreja: { select: { nome: true } } },
        });
        const pessoa =
          conta.pessoa_id &&
          (await tx.pessoas.findFirst({
            where: { id: conta.pessoa_id, igreja_id },
            select: {
              id: true,
              nome_completo: true,
              email: true,
              telefone_celular: true,
              cidade: true,
              estado: true,
              data_nascimento: true,
              grupo_familiar_id: true,
            },
          }));
        if (!pessoa) return { igreja: conta.igreja.nome, pessoa: null };
        const pessoa_id = pessoa.id;
        const recursos = recursosDaSessao(igreja_id);
        const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id }, include: { orgao: true } });
        const operador = await this.base.operador(tx, ator);
        const permitidos: string[] = [];
        for (const c of contextos) if (await this.base.contextoVisivel(tx, c, operador)) permitidos.push(c.id);
        const institucional = permitidos.length > 0;
        const secretaria = institucional && recursos.secretaria;
        const concessoes = secretaria ? await this.base.concessoes(tx, ator) : [];
        const visibilidade = {
          contexto_id: { in: permitidos },
          OR: [
            { restrito: false },
            { contexto_id: { in: concessoes.filter((c) => c.pode_consultar_restritos).map((c) => c.contexto_id) } },
          ],
        };
        const documentosVisiveis = secretaria ? { contexto_id: { in: permitidos }, ...filtroVisibilidadeDocumentos(concessoes.filter(c => c.pode_consultar_restritos).map(c => c.contexto_id),
          await contextosDasAtasRestritas(tx, igreja_id, ator.sub)) } : {};
        const [familia, eventos, contribuicoes, mandatos, reunioes, proposicoes] = await Promise.all([
          pessoa.grupo_familiar_id
            ? tx.grupos_familiares.findFirst({
                where: { id: pessoa.grupo_familiar_id, igreja_id },
                select: {
                  nome_familia: true,
                  pessoas: {
                    where: { igreja_id },
                    select: { id: true, nome_completo: true },
                    orderBy: { nome_completo: 'asc' },
                  },
                },
              })
            : null,
          tx.eventos_membresia.findMany({
            where: { igreja_id, pessoa_id },
            select: { id: true, tipo_evento: true, data_evento: true, rol: true },
            orderBy: [{ data_evento: 'desc' }, { ordem_dia: 'desc' }, { id: 'asc' }],
          }),
          tx.lancamentos.findMany({
            where: { igreja_id, pessoa_id, tipo_transacao: 'RECEITA' },
            select: { id: true, data_transacao: true, valor: true },
            orderBy: { data_transacao: 'desc' },
          }),
          recursos.governanca
            ? tx.mandato_oficial.findMany({
                where: { igreja_id, oficial: { pessoa_id, igreja_id } },
                select: {
                  id: true,
                  oficial: { select: { tipo: true } },
                  data_posse: true,
                  termino_previsto: true,
                  termino_efetivo: true,
                },
                orderBy: { data_posse: 'desc' },
              })
            : null,
          secretaria
            ? tx.participante_reuniao.findMany({
                where: { igreja_id, pessoa_id, presente: true, reuniao: visibilidade },
                select: {
                  id: true,
                  reuniao: { select: { modalidade: true, data: true, contexto: { select: { nome: true } } } },
                },
                orderBy: { reuniao: { data: 'desc' } },
              })
            : null,
          secretaria
            ? tx.resolucao.findMany({
                where: {
                  igreja_id,
                  proponentes: { some: { arrolado: { pessoa_id, igreja_id } } },
                  versao: { congelado_em: { not: null }, legada_superada: false, documento: documentosVisiveis },
                },
                select: {
                  id: true,
                  assunto: true,
                  resultado: true,
                  versao: { select: { numero: true, data_documento: true } },
                },
                orderBy: [{ versao: { data_documento: 'desc' } }, { ordem: 'asc' }],
              })
            : null,
        ]);
        return { igreja: conta.igreja.nome, pessoa, familia, eventos, contribuicoes, mandatos, reunioes, proposicoes };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
