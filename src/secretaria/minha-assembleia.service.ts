import { verificarSigiloDosAnexosDaPessoa } from './sigilo-anexos';
import { conferirApuracoes, conferirVotacao } from './mesa-assembleia';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { transacaoSerializavel } from '../orgaos/idempotencia';
import { PrivateStorageService } from '../private-storage/private-storage.service';
import { AcessoAssembleiaService, type CredencialAssembleia } from './acesso-assembleia.service';
import { SecretariaCadastrosService } from './secretaria-cadastros.service';
import { json, type Tx } from './secretaria-base.service';
import * as dto from './secretaria.dto';
import { entradaResolucoes, incluirResolucoes, salvarResolucoes, validarResolucoes } from './resolucoes';
import { resolucoesSchema } from './resolucoes.dto';
import { ocorrencias, paginaTextoSchema, valoresPaginaSchema } from './composicao-pagina';
import { prepararCampos } from './campos-documento';
import { pendenciasConteudo, pendenciasMesa, pendenciasAssinaturasReuniao } from './pendencias-tramitacao';
import { conferirCargaDeImagem } from './imagens-documentais';
import { numerarAta } from './numeracao-ata-livro';

const revisoes = { revisao: z.number().int().positive(), revisao_reuniao: z.number().int().positive() };
const edicao = z.strictObject({
  ...revisoes,
  teor: z.string().max(200000),
  composicao: paginaTextoSchema.optional(),
  estrutura: dto.estruturaSchema.optional(),
  manuais: valoresPaginaSchema.optional(),
  campos: z.record(z.string(), z.string().max(10000)).optional(),
  resolucoes: resolucoesSchema,
});
const presenca = z.strictObject({
  ...revisoes,
  pessoas: z
    .array(z.strictObject({ id: z.uuid(), presente: z.boolean(), arrolado: z.boolean(), pode_propor: z.boolean() }))
    .max(1000),
  universo: z.number().int().nonnegative(),
  minimo: z.number().int().nonnegative(),
  conferir: z.boolean(),
  competencia: z.string().trim().max(1000),
  fundamento: z.string().trim().max(1000),
});
type Acesso = Awaited<ReturnType<AcessoAssembleiaService['sessao']>>;

@Injectable()
export class MinhaAssembleiaService {
  constructor(
    private readonly acesso: AcessoAssembleiaService,
    private readonly cadastros: SecretariaCadastrosService,
    private readonly arquivos: PrivateStorageService,
  ) {}

  private async carregar(tx: Tx, c: CredencialAssembleia) {
    const g = await this.acesso.sessao(tx, c);
    const ata = await tx.documento_versao.findUniqueOrThrow({
      where: { id: g.versao_id },
      include: {
        modelo: true,
        livro: true,
        resolucoes: incluirResolucoes,
        arrolados: true,
        deliberacoes: { orderBy: { criado_em: 'desc' }, take: 1 },
      },
    });
    const r = await this.cadastros.carregarReuniao(tx, g.igreja_id, g.reuniao_id);
    return {
      g,
      ata,
      r,
      doc: g.versao.documento,
      dados: dto.reuniaoDadosSchema.parse(r.dados),
      config: dto.configuracaoSchema.parse(ata.modelo?.configuracao),
      conteudo: dto.conteudoSchema.parse(ata.conteudo),
    };
  }

  // Os modelos anteriores ao editor de página usam códigos em vez de IDs da biblioteca.
  private async camposLegadosEditaveis(
    tx: Tx,
    igreja: string,
    config: dto.ConfiguracaoModelo,
    conteudo: dto.VersaoInput['conteudo'],
  ) {
    const codigos = new Set([
      ...config.campos_obrigatorios,
      ...Object.keys(config.tipos_campos ?? {}),
      ...Object.keys(conteudo.campos),
    ]);
    if (!codigos.size) return [];
    const biblioteca = await tx.campo_secretaria.findMany({
      where: { igreja_id: igreja, codigo: { in: [...codigos] } },
      select: { codigo: true, id: true, origem: true },
    });
    for (const campo of biblioteca) {
      if (
        campo.codigo &&
        (campo.origem !== 'manual' || conteudo.valores?.[campo.id]?.origem.tipo === 'documento_anterior')
      )
        codigos.delete(campo.codigo);
    }
    return [...codigos];
  }

  private conferir(
    s: Awaited<ReturnType<typeof this.carregar>>,
    v: { revisao: number; revisao_reuniao: number },
    editar = true,
  ) {
    if (s.doc.revisao !== v.revisao || s.r.revisao !== v.revisao_reuniao)
      throw new ConflictException('Há uma revisão mais recente. Reabra a ata para conferir.');
    if (editar && s.doc.encaminhado_em) throw new ConflictException('A redação enviada para leitura está encerrada.');
  }
  private async auditar(tx: Tx, g: Acesso, operacao: string, revisao: number) {
    await tx.ato_acesso_assembleia.create({ data: { acesso_id: g.id, operacao, revisao } });
    await tx.documento.update({ where: { id: g.versao.documento_id }, data: { revisao: { increment: 1 } } });
    return { revisao: revisao + 1 };
  }

  ficha(c: CredencialAssembleia) {
    return this.acesso.db.$transaction(
      async (tx) => {
        const { g, ata, r, doc, dados, config, conteudo } = await this.carregar(tx, c);
        const pessoas = new Map(
          ata.arrolados.map((p) => [
            p.pessoa_id,
            {
              id: p.pessoa_id,
              nome: (p.retrato as { nome: string }).nome,
              presente: false,
              pode_propor: false,
              arrolado: true,
            },
          ]),
        );
        for (const p of r.participantes)
          pessoas.set(p.pessoa_id, {
            id: p.pessoa_id,
            nome: (p.retrato as { nome: string }).nome,
            presente: p.presente,
            pode_propor: !!dados.participantes.find((v) => v.pessoa_id === p.pessoa_id)?.pode_propor,
            arrolado: pessoas.has(p.pessoa_id),
          });
        return {
          acesso: g.id,
          versao: ata.id,
          revisao: doc.revisao,
          revisao_reuniao: r.revisao,
          titulo: ata.assunto,
          data: dados.data,
          local: dados.local,
          presidente: g.mesa.presidente_nome,
          secretario: g.mesa.secretario_nome,
          titulares: [g.mesa.oficial.pessoa_id, g.mesa.secretario_id],
          expira: g.expira_em,
          votacao: conferirVotacao(g.mesa, r.participantes, dados.quorum_minimo, false),
          pessoas: [...pessoas.values()].map(p => ({ ...p, direito_voto: Array.isArray(g.mesa.votantes_confirmados) ? g.mesa.votantes_confirmados.includes(p.id) : null })),
          universo: dados.universo_informado,
          minimo: dados.quorum_minimo,
          conferir: dados.quorum_conferido,
          competencia: dados.competencia,
          fundamento: dados.fundamento_quorum,
          encerrada: !!dados.fim,
          fim: dados.fim,
          encaminhada: !!doc.encaminhado_em,
          decisao:
            ata.deliberacoes[0]?.revisao_conteudo === ata.revisao_conteudo ? ata.deliberacoes[0].resultado : null,
          teor: conteudo.teor,
          estrutura: conteudo.estrutura,
          composicao: conteudo.composicao,
          campos: conteudo.campos,
          tipos_campos: config.tipos_campos,
          margens_concilio: ata.livro?.perfil === 'CONCILIO_IPB_2025',
          signatarios: ata.arrolados
            .filter((p) => p.assina)
            .map((p) => {
              const retrato = p.retrato as { cargos?: { nome: string }[]; cargo?: { nome: string } | null };
              return {
                pessoa_id: p.pessoa_id,
                assina: true,
                cargos: retrato.cargos?.map((c) => c.nome) ?? (retrato.cargo ? [retrato.cargo.nome] : []),
              };
            }),
          campos_editaveis: await this.camposLegadosEditaveis(tx, g.igreja_id, config, conteudo),
          valores: conteudo.valores,
          definicoes: config.definicoes,
          resolucoes: entradaResolucoes(ata.resolucoes),
          politica: config.resolucoes,
          pauta: r.itens_pauta.map((p) => ({ id: p.id, ordem: p.ordem, descricao: p.descricao })),
          anexos: conteudo.anexos,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  private pessoasDaSessao(s: Awaited<ReturnType<typeof this.carregar>>) {
    return new Set([...s.r.participantes.map(p => p.pessoa_id), ...s.ata.arrolados.map(p => p.pessoa_id),
      ...(Array.isArray(s.g.mesa.votantes_confirmados) ? s.g.mesa.votantes_confirmados as string[] : [])]);
  }

  buscar(c: CredencialAssembleia, busca: string) {
    const termo = dto.validar(z.string().trim().min(2).max(120), busca);
    return this.acesso.db.$transaction(async tx => {
      const s = await this.carregar(tx, c);
      const pessoas = await tx.pessoas.findMany({ where: { igreja_id: s.g.igreja_id, id: { in: [...this.pessoasDaSessao(s)] },
        nome_completo: { contains: termo, mode: 'insensitive' } }, select: { id: true, nome_completo: true },
        orderBy: [{ nome_completo: 'asc' }, { id: 'asc' }], take: 25 });
      const votantes = s.g.mesa.votantes_confirmados;
      return pessoas.map(p => ({ id: p.id, nome: p.nome_completo, direito_voto: Array.isArray(votantes) ? votantes.includes(p.id) : null }));
    }, { isolationLevel: 'RepeatableRead' });
  }

  arquivo(c: CredencialAssembleia, id: string) {
    return this.acesso.db.$transaction(async (tx) => {
      const g = await this.acesso.sessao(tx, c);
      const anexo = await tx.anexo_documento.findFirst({
        where: { arquivo_id: id, versao_id: g.versao_id, igreja_id: g.igreja_id },
        include: { arquivo: true },
      });
      if (!anexo) throw new NotFoundException('Anexo indisponível nesta ata.');
      await verificarSigiloDosAnexosDaPessoa(tx, g.igreja_id, g.mesa.secretario_id, [anexo.arquivo_id]);
      return { bytes: await this.arquivos.readVerified(anexo.arquivo), nome: anexo.nome };
    });
  }

  private async atualizarCampos(
    tx: Tx,
    s: Awaited<ReturnType<typeof this.carregar>>,
    rs: z.infer<typeof resolucoesSchema>,
  ) {
    const { ata, conteudo, config, doc, g } = s;
    const dinamicos = [
      'presentes',
      'deliberacoes_reuniao',
      'horario_encerramento_reuniao',
      'horario_encerramento_reuniao_por_extenso',
      'numero_documento',
      'numero_documento_por_extenso',
    ];
    const definicoes = Object.fromEntries(
      Object.entries(config.definicoes ?? {}).filter(
        ([id, d]) => dinamicos.includes(d.origem) && conteudo.valores?.[id]?.origem.tipo !== 'documento_anterior',
      ),
    );
    const versao: dto.VersaoInput = {
      modelo_versao_id: ata.modelo_versao_id!,
      reuniao_id: s.r.id,
      motivador_id: ata.motivador_id,
      assunto: ata.assunto,
      data_documento: ata.data_documento.toISOString().slice(0, 10),
      resolucoes: rs,
      conteudo: { ...conteudo, composicao: undefined, valores: {} },
    };
    await prepararCampos(
      tx,
      g.igreja_id,
      { ...config, definicoes },
      versao,
      { reuniao: s.r, previsto: false },
      {},
      doc.numero,
    );
    conteudo.valores = { ...conteudo.valores, ...versao.conteudo.valores };
    await tx.documento_versao.update({
      where: { id: ata.id },
      data: { conteudo: json(conteudo), revisao_conteudo: { increment: 1 } },
    });
  }

  salvar(c: CredencialAssembleia, body: unknown) {
    const v = dto.validar(edicao, body);
    return transacaoSerializavel(this.acesso.db, async (tx) => {
      const s = await this.carregar(tx, c);
      this.conferir(s, v);
      const { config, conteudo, ata, g } = s;
      if (!!v.composicao !== !!conteudo.composicao || !!v.estrutura !== !!conteudo.estrutura)
        throw new BadRequestException('Preserve o formato desta minuta.');
      const imagens = dto.imagensDaEstrutura(v.estrutura, v.composicao);
      const ocorrenciasPorArquivo = new Map<string, number>();
      for (const imagem of imagens)
        ocorrenciasPorArquivo.set(imagem.arquivo_id, (ocorrenciasPorArquivo.get(imagem.arquivo_id) ?? 0) + 1);
      if (ocorrenciasPorArquivo.size) {
        const arquivos = await tx.anexo_documento.findMany({
          where: {
            versao_id: g.versao_id,
            igreja_id: g.igreja_id,
            arquivo_id: { in: [...ocorrenciasPorArquivo.keys()] },
          },
          include: { arquivo: true },
        });
        if (arquivos.length !== ocorrenciasPorArquivo.size)
          throw new BadRequestException('Use imagens vinculadas a esta versão.');
        const carga = { bytes: 0, pixels: 0 };
        for (const { arquivo } of arquivos)
          await conferirCargaDeImagem(carga, arquivo.tamanho, ocorrenciasPorArquivo.get(arquivo.id)!, () =>
            this.arquivos.readVerified(arquivo),
          );
      }
      if (
        ocorrencias(v.composicao).some((i) => {
          const campo = config.definicoes?.[i.campo_id];
          return !campo || (!campo.multiplo && (i.apresentacao !== 'individual' || i.indice));
        })
      )
        throw new BadRequestException('Use os campos e os anexos disponíveis nesta versão.');
      for (const [id, valor] of Object.entries(v.manuais ?? {})) {
        const d = config.definicoes?.[id];
        if (
          d?.origem !== 'manual' ||
          valor.origem.tipo !== 'manual' ||
          conteudo.valores?.[id]?.origem.tipo === 'documento_anterior' ||
          valor.tipo !== d.tipo ||
          valor.multiplo !== d.multiplo
        )
          throw new BadRequestException('Campo manual indisponível.');
        (conteudo.valores ??= {})[id] = { ...valor, ajustado_manualmente: true };
      }
      const permitidos = await this.camposLegadosEditaveis(tx, g.igreja_id, config, conteudo);
      for (const [k, valor] of Object.entries(v.campos ?? {})) {
        if (!permitidos.includes(k)) throw new BadRequestException('Campo indisponível.');
        conteudo.campos[k] = valor;
      }
      Object.assign(conteudo, { teor: v.teor, estrutura: v.estrutura, composicao: v.composicao });
      dto.validar(dto.conteudoSchema, conteudo);
      dto.validarCampos(config, conteudo.campos);
      conferirApuracoes(g.mesa, s.r.participantes, v.resolucoes);
      validarResolucoes(
        {
          motivador_id: ata.motivador_id,
          modelo_versao_id: ata.modelo_versao_id!,
          reuniao_id: s.r.id,
          data_documento: s.dados.data,
          assunto: ata.assunto,
          conteudo,
          resolucoes: v.resolucoes,
        },
        config,
        s.dados,
        s.r.itens_pauta,
      );
      const escopo = { versao_id: ata.id, igreja_id: g.igreja_id, contexto_id: g.contexto_id };
      await tx.resolucao.deleteMany({ where: escopo });
      await salvarResolucoes(tx, escopo, v.resolucoes);
      await this.atualizarCampos(tx, s, v.resolucoes);
      return this.auditar(tx, g, 'SALVAR', v.revisao);
    });
  }

  presencas(c: CredencialAssembleia, body: unknown) {
    const v = dto.validar(presenca, body);
    return transacaoSerializavel(this.acesso.db, async (tx) => {
      const s = await this.carregar(tx, c);
      this.conferir(s, v);
      if (s.dados.fim) throw new ConflictException('A presença foi encerrada.');
      const { g, ata, conteudo, dados } = s;
      const elegiveis = this.pessoasDaSessao(s);
      const pessoas = new Map(v.pessoas.map((p) => [p.id, p]));
      if (
        pessoas.size !== v.pessoas.length ||
        v.pessoas.some((p) => !elegiveis.has(p.id) || (p.pode_propor && !p.presente)) ||
        [g.mesa.oficial.pessoa_id, g.mesa.secretario_id].some(
          (id) => !pessoas.get(id)?.presente || !pessoas.get(id)?.arrolado,
        )
      )
        throw new BadRequestException('Confira os participantes e mantenha os dois titulares presentes e arrolados.');
      const presentes = v.pessoas.filter((p) => p.presente);
      if (presentes.length > v.universo)
        throw new BadRequestException('Confira o universo e o quórum.');
      const participantes = v.pessoas.map((p) => ({
        pessoa_id: p.id,
        papeis: dados.participantes.find((x) => x.pessoa_id === p.id)?.papeis ?? ['PARTICIPANTE'],
        presente: p.presente,
        pode_propor: p.pode_propor,
      }));
      conferirVotacao(g.mesa, participantes, v.minimo, v.conferir);
      const novos = dto.validar(dto.reuniaoDadosSchema, {
        ...dados,
        participantes,
        universo_informado: v.universo,
        quorum_minimo: v.minimo,
        quorum_conferido: v.conferir,
        competencia: v.competencia,
        fundamento_quorum: v.fundamento,
      });
      const rs = entradaResolucoes(ata.resolucoes);
      conferirApuracoes(g.mesa, participantes, rs);
      if (s.config.assinaturas_reuniao === 'PRESENTES' && presentes.some((p) => !p.arrolado))
        throw new BadRequestException('Arrole os presentes para que possam assinar esta ata.');
      const antigos = conteudo.arrolados;
      const retirados = antigos.filter((p) => !pessoas.get(p.pessoa_id)?.arrolado);
      if (retirados.some((p) => p.assina || p.obrigatorio || p.cargo_id || p.cargos_ids.length))
        throw new BadRequestException('Preserve os arrolados com responsabilidades já atribuídas.');
      conteudo.arrolados = antigos.filter((p) => pessoas.get(p.pessoa_id)?.arrolado);
      if (s.config.assinaturas_reuniao === 'PRESENTES') {
        const novosSignatarios = conteudo.arrolados.filter(
          (p) => pessoas.get(p.pessoa_id)?.presente && !(p.assina && p.obrigatorio),
        );
        for (const p of novosSignatarios)
          Object.assign(p, {
            assina: true,
            obrigatorio: true,
            fundamento: p.fundamento || 'Presença confirmada pela secretaria da assembleia.',
          });
        await tx.arrolado_documento.updateMany({
          where: { versao_id: ata.id, pessoa_id: { in: novosSignatarios.map((p) => p.pessoa_id) } },
          data: { assina: true, obrigatorio: true },
        });
      }
      for (const p of v.pessoas.filter((p) => p.arrolado && !antigos.some((x) => x.pessoa_id === p.id))) {
        const assina = s.config.assinaturas_reuniao === 'PRESENTES' && p.presente;
        const novo = {
          pessoa_id: p.id,
          papeis: ['PARTICIPANTE'],
          assina,
          obrigatorio: assina,
          responsavel: false,
          cargo_id: null,
          cargos_ids: [],
          fundamento: 'Arrolado pela secretaria da assembleia.',
        };
        conteudo.arrolados.push(novo);
        const pessoa = await tx.pessoas.findUniqueOrThrow({
          where: { id: p.id },
          select: { nome_completo: true, email: true },
        });
        await tx.arrolado_documento.create({
          data: {
            igreja_id: g.igreja_id,
            contexto_id: g.contexto_id,
            versao_id: ata.id,
            pessoa_id: p.id,
            papeis: novo.papeis,
            assina,
            obrigatorio: assina,
            responsavel: false,
            retrato: {
              nome: pessoa.nome_completo,
              email: pessoa.email,
              fundamento: novo.fundamento,
              cargos: [],
              cargo: null,
            },
          },
        });
      }
      validarResolucoes(
        {
          motivador_id: ata.motivador_id,
          modelo_versao_id: ata.modelo_versao_id!,
          reuniao_id: s.r.id,
          data_documento: dados.data,
          assunto: ata.assunto,
          conteudo,
          resolucoes: rs,
        },
        s.config,
        novos,
        s.r.itens_pauta,
      );
      await tx.arrolado_documento.deleteMany({
        where: { versao_id: ata.id, pessoa_id: { in: retirados.map((p) => p.pessoa_id) } },
      });
      await tx.reuniao.update({ where: { id: s.r.id }, data: { dados: json(novos), revisao: { increment: 1 } } });
      await this.cadastros.participantes(tx, g, s.r, novos);
      s.r = await this.cadastros.carregarReuniao(tx, g.igreja_id, g.reuniao_id);
      await this.atualizarCampos(tx, s, rs);
      return this.auditar(tx, g, 'PRESENCAS', v.revisao);
    });
  }

  prepararLeitura(c: CredencialAssembleia, body: unknown) {
    const v = dto.validar(z.strictObject({ ...revisoes, fim: z.iso.datetime({ offset: true }) }), body);
    return transacaoSerializavel(this.acesso.db, async (tx) => {
      const s = await this.carregar(tx, c);
      this.conferir(s, v);
      const { ata, doc, g, dados, config, conteudo } = s;
      if (
        new Date(v.fim) > new Date() ||
        new Date(v.fim) < g.mesa.vigente_desde ||
        (dados.fim && new Date(dados.fim).getTime() !== new Date(v.fim).getTime())
      )
        throw new BadRequestException('Confira a hora de encerramento da sessão.');
      const encerrada = dto.validar(dto.reuniaoDadosSchema, { ...dados, fim: v.fim, situacao: 'ENCERRADA' });
      await tx.reuniao.update({ where: { id: s.r.id }, data: { dados: json(encerrada), revisao: { increment: 1 } } });
      s.r = await this.cadastros.carregarReuniao(tx, g.igreja_id, g.reuniao_id);
      const contexto = await tx.contexto_secretaria.findUniqueOrThrow({ where: { id: g.contexto_id } });
      if (!doc.numero && ata.livro) await numerarAta(tx, doc, { conteudo }, ata.livro, contexto.nome, ata.livro.id);
      if (!doc.numero) {
        const ano = ata.data_documento.getUTCFullYear(),
          serie = { igreja_id: g.igreja_id, contexto_id: g.contexto_id, tipo: doc.tipo, perfil: doc.perfil, ano };
        const contador = await tx.contador_documento.upsert({
          where: { igreja_id_contexto_id_tipo_perfil_ano: serie },
          create: { ...serie, ultimo: 1 },
          update: { ultimo: { increment: 1 } },
        });
        Object.assign(doc, { numero: contador.ultimo, ano, sigla: contexto.sigla });
      }
      await this.atualizarCampos(tx, s, entradaResolucoes(ata.resolucoes));
      const pendencias = [
        ...pendenciasConteudo(config, conteudo, ata.motivador_id, ata.resolucoes.length),
        ...pendenciasMesa(encerrada, s.r.participantes, conteudo),
        ...pendenciasAssinaturasReuniao(config.assinaturas_reuniao, s.r.participantes, conteudo),
      ];
      if (pendencias.length) throw new BadRequestException(pendencias[0].mensagem);
      await tx.documento.update({
        where: { id: doc.id },
        data: { numero: doc.numero, ano: doc.ano, sigla: doc.sigla, encaminhado_em: new Date() },
      });
      return this.auditar(tx, g, 'LEITURA', v.revisao);
    });
  }

  decidir(c: CredencialAssembleia, body: unknown) {
    const v = dto.validar(
      z.strictObject({ ...revisoes, resultado: z.enum(['APROVADA', 'REJEITADA', 'ADIADA']), evidencia: dto.texto }),
      body,
    );
    return transacaoSerializavel(this.acesso.db, async (tx) => {
      const s = await this.carregar(tx, c);
      this.conferir(s, v, false);
      if (
        !s.doc.encaminhado_em ||
        !s.dados.quorum_conferido ||
        s.ata.deliberacoes[0]?.revisao_conteudo === s.ata.revisao_conteudo
      )
        throw new ConflictException('A decisão exige uma revisão preparada para leitura e pendente de deliberação.');
      await tx.deliberacao_ata.create({
        data: {
          conferencia_votacao: json(conferirVotacao(s.g.mesa, s.r.participantes, s.dados.quorum_minimo, true)),
          acesso_assembleia_id: s.g.id,
          mesa_id: s.g.mesa_id,
          versao_id: s.ata.id,
          igreja_id: s.g.igreja_id,
          contexto_id: s.g.contexto_id,
          reuniao_id: s.r.id,
          data: s.r.data,
          revisao_conteudo: s.ata.revisao_conteudo,
          resultado: v.resultado,
          autoridade: 'Assembleia Geral',
          evidencia: v.evidencia,
        },
      });
      return this.auditar(tx, s.g, 'DELIBERAR', v.revisao);
    });
  }
}
