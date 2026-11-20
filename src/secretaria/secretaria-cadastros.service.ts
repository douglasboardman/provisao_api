import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SecretariaBaseService, AtorSecretaria, Tx, dataCivil, json } from './secretaria-base.service';
import * as dto from './secretaria.dto';
import { arquivoSemVinculoDeExpedicao, PrivateStorageService } from '../private-storage/private-storage.service';
import { decodificarImagemDocumental, limitePixelsDocumento } from './imagens-documentais';

@Injectable()
export class SecretariaCadastrosService {
  constructor(readonly base: SecretariaBaseService, private readonly storage: PrivateStorageService) {}

  async admin(tx: Tx, a: AtorSecretaria) {
    if ((await this.base.operador(tx, a)).perfil !== 'ADMINISTRADOR') throw new ForbiddenException('Configuração técnica reservada ao administrador.');
  }

  criarContexto(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.contextoSchema, dados);
    return this.base.comando(a, 'CRIAR_CONTEXTO', null, v, async tx => {
      await this.admin(tx, a);
      if ((v.tipo === 'ORGAO') !== !!v.orgao_id) throw new BadRequestException('Órgão obrigatório apenas no contexto de órgão.');
      const orgao = v.orgao_id ? await tx.orgao_interno.findFirst({ where: { id: v.orgao_id, igreja_id: a.igreja_id } }) : null;
      if (v.orgao_id && !orgao) throw new NotFoundException('Órgão não encontrado.');
      const anterior = await tx.contexto_secretaria.findFirst({ where: { igreja_id: a.igreja_id, tipo: v.tipo, orgao_id: v.orgao_id ?? null } });
      if (anterior) return { id: anterior.id };
      const c = await tx.contexto_secretaria.create({ data: { igreja_id: a.igreja_id, tipo: v.tipo, orgao_id: v.orgao_id, nome: orgao?.nome ?? v.nome, sigla: orgao?.sigla ?? v.sigla } });
      return { id: c.id };
    });
  }

  resumoContexto(a: AtorSecretaria, contexto_id: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      await this.base.contexto(tx, a, contexto_id);
      const restritos = (await this.base.concessoes(tx, a, contexto_id)).some(c => c.pode_consultar_restritos);
      const where = { igreja_id: a.igreja_id, contexto_id, ...(restritos ? {} : { restrito: false }) };
      const [documentos, atas, em_edicao, reunioes] = await Promise.all([
        tx.documento.count({ where }), tx.documento.count({ where: { ...where, tipo: 'ATA' } }),
        tx.documento.count({ where: { ...where, estado: 'EM_EDICAO' } }), tx.reuniao.count({ where }),
      ]);
      return { documentos, atas, em_edicao, reunioes };
    }, { isolationLevel: 'RepeatableRead' });
  }

  consultarReuniao(a: AtorSecretaria, id: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      return this.reuniao(tx, a, id);
    });
  }

  async listarContextos(a: AtorSecretaria) {
    return this.base.prisma.$transaction(async tx => {
      const u = await this.base.operador(tx, a);
      const concessoes = await this.base.concessoes(tx, a);
      const contextos = await tx.contexto_secretaria.findMany({ where: { igreja_id: a.igreja_id }, include: { orgao: { select: { tipo: true, constituicao: true } } }, orderBy: { nome: 'asc' } });
      return contextos.map(c => ({ ...c, pode_preparar: ['GESTOR', 'SECRETARIO'].includes(u.perfil) || (u.perfil !== 'AUDITOR' && concessoes.some(g => g.contexto_id === c.id && (g.pode_aprovar || g.pode_deliberar))), pode_aprovar: u.perfil !== 'AUDITOR' && !!u.pessoa_id && concessoes.some(g => g.contexto_id === c.id && g.pode_aprovar), pode_deliberar: u.perfil !== 'AUDITOR' && !!u.pessoa_id && concessoes.some(g => g.contexto_id === c.id && g.pode_deliberar), pode_consultar_restritos: concessoes.some(g => g.contexto_id === c.id && g.pode_consultar_restritos) }));
    });
  }

  conceder(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.competenciaSchema, dados);
    return this.base.comando(a, 'CONCEDER_COMPETENCIA', v.contexto_id, v, async tx => {
      await this.admin(tx, a);
      await this.base.contexto(tx, a, v.contexto_id);
      const titular = await tx.usuarios.findFirst({ where: { id: v.usuario_id, igreja_id: a.igreja_id, ativo: true } });
      if (!titular || !titular.pessoa_id || !['ADMINISTRADOR', 'GESTOR', 'SECRETARIO', 'AUDITOR'].includes(titular.perfil) || (titular.perfil === 'AUDITOR' && (v.pode_aprovar || v.pode_deliberar))) throw new BadRequestException('Titular exige pessoa vinculada e perfil compatível.');
      const { inicio, fim } = v;
      const data = { contexto_id: v.contexto_id, usuario_id: v.usuario_id, pode_aprovar: v.pode_aprovar, pode_deliberar: v.pode_deliberar, pode_consultar_restritos: v.pode_consultar_restritos, autoridade: v.autoridade, evidencia: v.evidencia };
      const c = await tx.competencia_secretaria.create({ data: { ...data, igreja_id: a.igreja_id, pessoa_id: titular.pessoa_id, registrado_por_id: a.sub, inicio: dataCivil(inicio), fim: fim ? dataCivil(fim) : null } });
      return { id: c.id };
    });
  }

  encerrarCompetencia(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.fimCompetenciaSchema, dados);
    return this.base.comando(a, 'ENCERRAR_COMPETENCIA', id, v, async tx => {
      await this.admin(tx, a);
      const c = await tx.competencia_secretaria.findFirst({ where: { id, igreja_id: a.igreja_id } });
      if (!c) throw new NotFoundException('Competência não encontrada.');
      if (c.fim || dataCivil(v.fim) < c.inicio) throw new BadRequestException('Período encerrado ou inválido.');
      await tx.competencia_secretaria.update({ where: { id }, data: { fim: dataCivil(v.fim) } });
      return { id };
    });
  }

  async listarCompetencias(a: AtorSecretaria) {
    return this.base.prisma.$transaction(async tx => {
      await this.admin(tx, a);
      return tx.competencia_secretaria.findMany({ where: { igreja_id: a.igreja_id }, include: { titular: { select: { nome_usuario: true } } }, orderBy: { criado_em: 'desc' }, take: 200 });
    });
  }

  async configurar(tx: Tx, a: AtorSecretaria, contextoId: string, configuracao: dto.ConfiguracaoModelo) {
    const c = await this.base.contexto(tx, a, contextoId);
    if (configuracao.contexto !== c.tipo || (c.orgao && (!configuracao.tipos_orgao.includes(c.orgao.tipo) || !configuracao.constituicoes.includes(c.orgao.constituicao)))) throw new BadRequestException('Modelo não aplicável ao contexto/constituição.');
    const ids = [...new Set(configuracao.cargos_obrigatorios)];
    if (ids.length && (!c.orgao_id || await tx.cargo_orgao.count({ where: { id: { in: ids }, igreja_id: a.igreja_id, orgao_id: c.orgao_id, ativo: true } }) !== ids.length)) throw new BadRequestException('Cargo exigido inexistente neste contexto.');
  }

  private async salvarImagensModelo(tx: Tx, a: AtorSecretaria, contexto: string, versao: string, config: dto.ConfiguracaoModelo, versaoAnterior?: string) {
    const blocos = dto.imagensDaEstrutura(config.estrutura_padrao);
    const ids = [...new Set(blocos.map(b => b.arquivo_id))];
    if (!ids.length) return;
    const arquivos = await tx.arquivo_privado.findMany({
      where: {
        id: { in: ids }, igreja_id: a.igreja_id, artefatos_documento: { none: {} }, livros_historicos: { none: {} }, registros_livro: { none: {} },
          ...arquivoSemVinculoDeExpedicao,
        OR: [{ usuario_id: a.sub }, ...(versaoAnterior ? [{ imagens_modelo: { some: { versao_id: versaoAnterior } } }] : [])],
      },
    });
    const tamanho = arquivos.reduce((total, f) => total + f.tamanho * blocos.filter(b => b.arquivo_id === f.id).length, 0);
    if (ids.length !== arquivos.length || tamanho > 4 * 1024 * 1024) throw new BadRequestException('Imagens do modelo indisponíveis ou acima de 4 MB no total.');
    let totalPixels = 0;
    for (const arquivo of arquivos) {
      if (arquivo.tamanho > 2 * 1024 * 1024) throw new BadRequestException('Cada imagem do modelo deve ter até 2 MB.');
      totalPixels += decodificarImagemDocumental(await this.storage.readVerified(arquivo)).pixels * blocos.filter(b => b.arquivo_id === arquivo.id).length;
      if (totalPixels > limitePixelsDocumento) throw new BadRequestException('As imagens do modelo devem somar até 32 megapixels.');
    }
    await tx.imagem_modelo_documento.createMany({
      data: ids.map(arquivo_id => ({ igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versao, arquivo_id })),
    });
  }

  private conferirFinalidadeTermo(v: { tipo: 'ATA' | 'OUTRO'; finalidade: string; configuracao: dto.ConfiguracaoModelo }) {
    if (dto.finalidadeTermo(v.finalidade) && (v.tipo !== 'OUTRO' || dto.politicaLivro(v.configuracao) !== 'NAO_PERMITE')) {
      throw new BadRequestException('Use tipo OUTRO e vinculação própria para termos de abertura e encerramento.');
    }
  }

  criarModelo(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.modeloSchema, dados);
    this.conferirFinalidadeTermo(v);
    return this.base.comando(a, 'CRIAR_MODELO', v.contexto_id, v, async tx => {
      const u = await this.base.operador(tx, a);
      if (u.perfil !== 'ADMINISTRADOR') await this.base.preparar(tx, a, v.contexto_id);
      await this.configurar(tx, a, v.contexto_id, v.configuracao);
      const m = await tx.modelo_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, nome: v.nome } });
      const versao = await tx.modelo_documento_versao.create({ data: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, modelo_id: m.id, numero: 1, tipo: v.tipo, finalidade: v.finalidade, configuracao: json(v.configuracao) } });
      await this.salvarImagensModelo(tx, a, v.contexto_id, versao.id, v.configuracao);
      return { id: m.id, versao_id: versao.id, revisao: 1 };
    });
  }

  versionarModelo(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.modeloVersaoSchema, dados);
    this.conferirFinalidadeTermo(v);
    return this.base.comando(a, 'VERSIONAR_MODELO', id, v, async tx => {
      const m = await tx.modelo_documento.findFirst({ where: { id, igreja_id: a.igreja_id } });
      if (!m) throw new NotFoundException('Modelo não encontrado.');
      const u = await this.base.operador(tx, a);
      if (u.perfil !== 'ADMINISTRADOR') await this.base.preparar(tx, a, m.contexto_id);
      this.base.conferirRevisao(m.revisao, v.revisao);
      await this.configurar(tx, a, m.contexto_id, v.configuracao);
      const novo = await tx.modelo_documento_versao.create({ data: { igreja_id: a.igreja_id, contexto_id: m.contexto_id, modelo_id: id, numero: m.revisao + 1, tipo: v.tipo, finalidade: v.finalidade, configuracao: json(v.configuracao) } });
      const anterior = await tx.modelo_documento_versao.findUniqueOrThrow({ where: { modelo_id_numero: { modelo_id: id, numero: m.revisao } }, select: { id: true } });
      await this.salvarImagensModelo(tx, a, m.contexto_id, novo.id, v.configuracao, anterior.id);
      await tx.modelo_documento.update({ where: { id }, data: { revisao: { increment: 1 } } });
      return { id, versao_id: novo.id, revisao: m.revisao + 1 };
    });
  }

  async cargos(a: AtorSecretaria, contexto: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      const c = await this.base.contexto(tx, a, contexto);
      return c.orgao_id ? tx.cargo_orgao.findMany({ where: { igreja_id: a.igreja_id, orgao_id: c.orgao_id, ativo: true }, select: { id: true, nome: true }, orderBy: { nome: 'asc' } }) : [];
    });
  }

  async listarModelos(a: AtorSecretaria, contexto: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a); await this.base.contexto(tx, a, contexto);
      return tx.modelo_documento.findMany({ where: { igreja_id: a.igreja_id, contexto_id: contexto }, include: { versoes: { orderBy: { numero: 'desc' } } }, orderBy: { nome: 'asc' } });
    });
  }

  async reuniao(tx: Tx, a: AtorSecretaria, id: string) {
    const r = await tx.reuniao.findFirst({ where: { id, igreja_id: a.igreja_id }, include: { participantes: true } });
    if (!r || (r.restrito && !(await this.base.concessoes(tx, a, r.contexto_id)).some(g => g.pode_consultar_restritos))) throw new NotFoundException('Reunião não encontrada.');
    return r;
  }

  validarModalidadeReuniao(contexto: { tipo: string; orgao: { tipo: string } | null }, modalidade: dto.ReuniaoInput['modalidade']) {
    const assembleia = modalidade === 'AGO' || modalidade === 'AGE';
    if ((contexto.tipo === 'ASSEMBLEIA_GERAL') !== assembleia ||
        (modalidade === 'REGULAR' && contexto.orgao?.tipo !== 'CONSELHO')) {
      throw new BadRequestException('Modalidade da reunião incompatível com o contexto.');
    }
  }

  async validarReuniao(tx: Tx, a: AtorSecretaria, contexto: string, v: dto.ReuniaoInput) {
    this.validarModalidadeReuniao(await this.base.contexto(tx, a, contexto), v.modalidade);
    if (v.restrito) await this.base.competente(tx, a, contexto, 'pode_consultar_restritos');
    const ids = v.participantes.map(p => p.pessoa_id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Informe cada pessoa uma única vez, com seus vários papéis.');
    if (await tx.pessoas.count({ where: { igreja_id: a.igreja_id, id: { in: ids } } }) !== ids.length) throw new BadRequestException('Participante não pertence à igreja.');
    if (v.participantes.filter(p => p.presente).length > v.universo_informado) throw new BadRequestException('Presença maior que universo informado.');
  }

  async participantes(tx: Tx, a: AtorSecretaria, r: { id: string; contexto_id: string }, v: dto.ReuniaoInput) {
    await tx.participante_reuniao.deleteMany({ where: { reuniao_id: r.id, igreja_id: a.igreja_id } });
    for (const p of v.participantes) {
      const pessoa = await tx.pessoas.findFirstOrThrow({ where: { igreja_id: a.igreja_id, id: p.pessoa_id }, select: { nome_completo: true } });
      await tx.participante_reuniao.create({ data: { igreja_id: a.igreja_id, contexto_id: r.contexto_id, reuniao_id: r.id, pessoa_id: p.pessoa_id, presente: p.presente, papeis: [...new Set(p.papeis)], retrato: { nome: pessoa.nome_completo } } });
    }
  }

  criarReuniao(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.reuniaoSchema, dados);
    return this.base.comando(a, 'CRIAR_REUNIAO', v.contexto_id, v, async tx => {
      await this.base.preparar(tx, a, v.contexto_id);
      await this.validarReuniao(tx, a, v.contexto_id, v.dados);
      const r = await tx.reuniao.create({ data: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, restrito: v.dados.restrito, modalidade: v.dados.modalidade, data: dataCivil(v.dados.data), dados: json(v.dados) } });
      await this.participantes(tx, a, r, v.dados);
      return { id: r.id, revisao: 1 };
    });
  }

  editarReuniao(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.editarReuniaoSchema, dados);
    return this.base.comando(a, 'EDITAR_REUNIAO', id, v, async tx => {
      const r = await this.reuniao(tx, a, id);
      await this.base.preparar(tx, a, r.contexto_id);
      this.base.conferirRevisao(r.revisao, v.revisao);
      if (await tx.documento_versao.count({ where: { reuniao_id: id, OR: [{ congelado_em: { not: null } }, { deliberacoes: { some: {} } }] } }) || await tx.deliberacao_ata.count({ where: { reuniao_id: id } })) throw new BadRequestException('Reunião formalizada é preservada; registre reunião/ato complementar.');
      await this.validarReuniao(tx, a, r.contexto_id, v.dados);
      if (r.restrito && !v.dados.restrito) throw new BadRequestException('Sigilo não pode ser removido por edição.');
      await tx.reuniao.update({ where: { id }, data: { restrito: v.dados.restrito, modalidade: v.dados.modalidade, data: dataCivil(v.dados.data), dados: json(v.dados), revisao: { increment: 1 } } });
      await this.participantes(tx, a, r, v.dados);
      return { id, revisao: r.revisao + 1 };
    });
  }

  async listarReunioes(a: AtorSecretaria, contexto: string, pagina: number) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a); await this.base.contexto(tx, a, contexto);
      const restritos = (await this.base.concessoes(tx, a, contexto)).some(g => g.pode_consultar_restritos);
      return tx.reuniao.findMany({ where: { igreja_id: a.igreja_id, contexto_id: contexto, ...(!restritos ? { restrito: false } : {}) }, include: { participantes: true }, orderBy: [{ data: 'desc' }, { id: 'asc' }], skip: pagina * 30, take: 30 });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
