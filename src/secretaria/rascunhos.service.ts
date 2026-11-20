import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { livro_atas, Prisma, registro_livro, registro_livro_natureza, trabalho_renderizacao } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrivateStorageService } from '../private-storage/private-storage.service';
import { hashAto, transacaoComRetentativa } from '../orgaos/idempotencia';
import { AtorSecretaria, SecretariaBaseService, Tx, json } from './secretaria-base.service';
import { validar, conteudoSchema, configuracaoSchema, imagensDaEstrutura, politicaLivro } from './secretaria.dto';
import { FonteRenderizacao, gerarPdf, htmlDocumento, medirPaginasLivro } from './renderizador';
import { decodificarImagemDocumental, limitePixelsDocumento, logoDocumental } from './imagens-documentais';

import { assinaturasDisponiveis } from './expedicao-estado';
import { livrosDisponiveis } from './livros.service';
import { resolucoesParaMatriz } from './resolucoes';

type Documento = Awaited<ReturnType<SecretariaBaseService['documento']>>;
type Versao = Documento['versoes'][number];
type ArquivoFonte = { id: string; igreja_id: string; tamanho: number; sha256: string };
type FonteTrabalho = { fonte: FonteRenderizacao; arquivos: ArquivoFonte[] };
export type SignatarioRenderizacao = Pick<Versao['arrolados'][number], 'assina' | 'pessoa_id'> & { retrato: unknown };
type VersaoFonte = Pick<Versao, 'modelo' | 'anexos' | 'assunto' | 'data_documento' | 'resolucoes'> & { conteudo: unknown };
type Vinculo = { livro: livro_atas; natureza: registro_livro_natureza };
type Finalidade = 'RASCUNHO' | 'MATRIZ_APROVADA' | 'MEDICAO_LIVRO';
type Igreja = FonteRenderizacao['igreja'] & { url_logo: string | null };
export const igrejaSelect = { nome: true, cnpj: true, url_logo: true, cidade: true, estado: true, logradouro: true, numero: true, bairro: true, cep: true, complemento: true } as const;
const limiteTentativas = 3;
const conflitoDeFila = (erro: unknown) => erro instanceof Prisma.PrismaClientKnownRequestError
  && erro.code === 'P2002'
  && Array.isArray(erro.meta?.target) && erro.meta.target.includes('versao_id');

@Injectable()
export class RascunhosService {
  constructor(private readonly base: SecretariaBaseService, private readonly storage: PrivateStorageService) {}

  private async fonte(tx: Tx, documento: Documento, versao: VersaoFonte, igreja: Igreja, arrolados: SignatarioRenderizacao[], numero: string, contexto: string, finalidade: FonteRenderizacao['finalidade'], vinculo?: Vinculo | null): Promise<FonteTrabalho> {
    if (!versao.modelo) throw new BadRequestException('A ata legada usa o PDF original do acervo.');
    const modelo = await tx.modelo_documento.findUniqueOrThrow({ where: { id: versao.modelo.modelo_id }, select: { nome: true } });
    const config = validar(configuracaoSchema, versao.modelo.configuracao);
    const conteudo = validar(conteudoSchema, versao.conteudo);
    const blocos = imagensDaEstrutura(conteudo.estrutura);
    const imagens = new Set(blocos.map(b => b.arquivo_id));
    const arquivos = versao.anexos.filter(x => imagens.has(x.arquivo_id))
      .map(x => ({ id: x.arquivo_id, igreja_id: documento.igreja_id, ...x.arquivo })).sort((a, b) => a.id.localeCompare(b.id));
    const totalBytes = arquivos.reduce((total, arquivo) => total + arquivo.tamanho * blocos.filter(b => b.arquivo_id === arquivo.id).length, 0);
    if (arquivos.length !== imagens.size || totalBytes > 4 * 1024 * 1024) {
      throw new BadRequestException('Vincule todas as imagens à versão. O total permitido é de 4 MB.');
    }
    const signatarios = arrolados.filter(p => p.assina).sort((a, b) => a.pessoa_id.localeCompare(b.pessoa_id)).map(p => {
      const retrato = p.retrato as { nome: string; cargos?: { nome: string }[] };
      const cargo = retrato.cargos?.map(c => c.nome).join(', ');
      return cargo ? `${retrato.nome} — ${cargo}` : retrato.nome;
    });
    const { url_logo, ...dadosIgreja } = igreja;
    return {
      arquivos,
      fonte: {
        tipo: documento.tipo, titulo: modelo.nome, numero, contexto, finalidade, perfil: config.perfil,
        assunto: versao.assunto,
        registroLivro: politicaLivro(config) !== 'NAO_PERMITE',
        ...(vinculo ? { livro: { numero: vinculo.livro.numero, serie: vinculo.livro.serie, perfil: vinculo.livro.perfil, natureza: vinculo.natureza } } : {}), tiposCampos: config.tipos_campos,
        data: versao.data_documento.toISOString().slice(0, 10), igreja: dadosIgreja,
        logo: await logoDocumental(url_logo), conteudo, signatarios, imagens: {},
        ...(versao.resolucoes.length ? { resolucoes: resolucoesParaMatriz(versao.resolucoes, arrolados) } : {}),
      },
    };
  }

  private async enfileirar(tx: Tx, ator: AtorSecretaria, versao: Versao, revisao: number, finalidade: Finalidade, fonte: FonteTrabalho, medicaoRevisao?: number) {
    const job = await tx.trabalho_renderizacao.create({
      data: { igreja_id: ator.igreja_id, contexto_id: versao.contexto_id, versao_id: versao.id, revisao_documento: revisao, usuario_id: ator.sub, finalidade, fonte: json(fonte), medicao_revisao: medicaoRevisao },
    });
    return this.resumo(job);
  }

  async fonteMatriz(tx: Tx, d: Documento, v: VersaoFonte, igreja: Igreja, arrolados: SignatarioRenderizacao[], numero: string, contexto: string, vinculo?: Vinculo | null) {
    const fonte = await this.fonte(tx, d, v, igreja, arrolados, numero, contexto, 'MATRIZ_APROVADA', vinculo);
    if (assinaturasDisponiveis()) fonte.fonte.assinaturaSeparada = true;
    try { htmlDocumento(fonte.fonte); }
    catch { throw new BadRequestException('A fonte da matriz excede o limite de renderização. Reduza o conteúdo ou as repetições de campos.'); }
    return fonte;
  }

  enfileirarMatriz(tx: Tx, a: AtorSecretaria, d: Documento, v: Versao, fonte: FonteTrabalho) {
    return this.enfileirar(tx, a, v, d.revisao + 1, 'MATRIZ_APROVADA', fonte);
  }

  private medicaoRecente(tx: Tx, versao: string, revisao?: number) {
    return tx.trabalho_renderizacao.findFirst({
      where: { versao_id: versao, finalidade: 'MEDICAO_LIVRO', medicao_revisao: revisao },
      orderBy: { revisao_documento: 'asc' },
    });
  }

  private mesmaFonte(medicao: trabalho_renderizacao, fonte: FonteTrabalho) {
    return hashAto(medicao.fonte as Prisma.JsonObject) === hashAto(json(fonte) as Prisma.JsonObject);
  }

  async enfileirarMedicao(tx: Tx, a: AtorSecretaria, d: Documento, v: Versao, fonte: FonteTrabalho) {
    const anterior = await this.medicaoRecente(tx, v.id);
    if (anterior?.medicao_revisao === d.revisao && this.mesmaFonte(anterior, fonte)) return this.repetirFalha(tx, anterior);
    // A sequência negativa preserva a chave de rascunhos e matrizes das versões anteriores.
    return this.enfileirar(tx, a, v, (anterior?.revisao_documento ?? 0) - 1, 'MEDICAO_LIVRO', fonte, d.revisao);
  }

  async paginasMedidas(tx: Tx, d: Documento, v: Versao, fonte: FonteTrabalho) {
    const medicao = await this.medicaoRecente(tx, v.id, d.revisao);
    if (medicao?.estado !== 'CONCLUIDO' || !medicao.paginas_medidas || !this.mesmaFonte(medicao, fonte)) {
      throw new BadRequestException('Meça novamente a paginação desta versão antes de aprovar a matriz.');
    }
    return medicao.paginas_medidas;
  }

  fixarPaginacao(fonte: FonteTrabalho, reserva: registro_livro) {
    if (!fonte.fonte.livro) throw new Error('Fonte de matriz sem livro.');
    fonte.fonte.livro.paginas = reserva.posicao_fim - reserva.posicao_inicio + 1;
    fonte.fonte.livro.numeroVisivel = reserva.numero_visivel_inicio;
  }

  async solicitar(a: AtorSecretaria, id: string, revisao: number) {
    return transacaoComRetentativa(this.base.prisma, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.preparar(tx, a, d.contexto_id);
      this.base.conferirRevisao(d.revisao, revisao);
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('Rascunho exige documento em edição.');
      const v = d.versoes.find(x => x.numero === d.versao_atual)!;
      const trabalho = await tx.trabalho_renderizacao.findUnique({ where: { versao_id_revisao_documento: { versao_id: v.id, revisao_documento: revisao } } });
      if (trabalho) return this.repetirFalha(tx, trabalho);
      const igreja = await tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: igrejaSelect });
      const contexto = await this.base.contexto(tx, a, d.contexto_id);
      const numero = d.numero ? `${String(d.numero).padStart(3, '0')}/${d.ano}/${d.sigla}` : 'SEM NÚMERO RESERVADO';
      const fonte = await this.fonte(tx, d, v, igreja, v.arrolados, numero, contexto.orgao?.nome ?? contexto.nome, 'RASCUNHO');
      return this.enfileirar(tx, a, v, revisao, 'RASCUNHO', fonte);
    }, Prisma.TransactionIsolationLevel.Serializable, conflitoDeFila);
  }

  async solicitarMatriz(a: AtorSecretaria, id: string, versaoId: string) {
    return transacaoComRetentativa(this.base.prisma, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
      const v = d.versoes.find(item => item.id === versaoId && item.congelado_em);
      if (!v) throw new NotFoundException('Versão aprovada não encontrada.');
      const job = await tx.trabalho_renderizacao.findFirst({ where: { versao_id: v.id, finalidade: 'MATRIZ_APROVADA' } });
      if (job) return this.repetirFalha(tx, job);
      // Somente versões legadas, congeladas antes da E05, não têm trabalho de matriz.
      const legado = v.fonte_congelada as unknown as { igreja: Igreja; contexto: { nome: string }; numero: string; arrolados: Versao['arrolados'] } | null;
      if (!legado?.numero || !legado.contexto?.nome || !legado.igreja?.nome) throw new BadRequestException('Fonte histórica incompleta.');
      // Não há evidência dos bytes do logo na versão legada. Só a identidade textual está congelada.
      const fonte = await this.fonte(tx, d, v, { ...legado.igreja, url_logo: null }, legado.arrolados, legado.numero, legado.contexto.nome, 'MATRIZ_APROVADA');
      return this.enfileirar(tx, a, v, 0, 'MATRIZ_APROVADA', fonte);
    }, Prisma.TransactionIsolationLevel.Serializable, conflitoDeFila);
  }

  private async repetirFalha(tx: Tx, job: trabalho_renderizacao) {
    if (job.estado !== 'FALHOU') return this.resumo(job);
    const reset = await tx.trabalho_renderizacao.update({
      where: { id: job.id }, data: { estado: 'PENDENTE', tentativas: 0, executar_apos: new Date() },
    });
    return this.resumo(reset);
  }

  private resumo(job: Pick<trabalho_renderizacao, 'id' | 'estado' | 'finalidade' | 'versao_id' | 'revisao_documento' | 'medicao_revisao' | 'paginas_medidas'>) {
    return { id: job.id, estado: job.estado, finalidade: job.finalidade, versao_id: job.versao_id, revisao_documento: job.medicao_revisao ?? job.revisao_documento, paginas_medidas: job.paginas_medidas };
  }

  private visivel(d: Documento, job: trabalho_renderizacao) {
    return job.finalidade === 'MATRIZ_APROVADA' || (d.estado === 'EM_EDICAO' && (job.medicao_revisao ?? job.revisao_documento) === d.revisao &&
      (job.finalidade !== 'MEDICAO_LIVRO' || livrosDisponiveis()));
  }

  async listar(a: AtorSecretaria, documento: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      const d = await this.base.documento(tx, a, documento);
      const jobs = await tx.trabalho_renderizacao.findMany({
        where: {
          igreja_id: a.igreja_id, versao: { documento_id: d.id },
          OR: [{ finalidade: 'MATRIZ_APROVADA' }, { finalidade: 'RASCUNHO', revisao_documento: d.estado === 'EM_EDICAO' ? d.revisao : -1 }],
        },
        select: { id: true, estado: true, finalidade: true, revisao_documento: true, medicao_revisao: true, paginas_medidas: true, versao_id: true, arquivo: { select: { sha256: true, tamanho: true } } },
      });
      const atual = d.versoes.find(v => v.numero === d.versao_atual);
      const medicao = d.estado === 'EM_EDICAO' && livrosDisponiveis() && atual?.livro_id ? await this.medicaoRecente(tx, atual.id, d.revisao) : null;
      return [...jobs, ...(medicao ? [{ ...medicao, arquivo: null }] : [])].map(job => ({ ...this.resumo(job), sha256: job.arquivo?.sha256 ?? null, tamanho: job.arquivo?.tamanho ?? null }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async autorizado(tx: Tx, a: AtorSecretaria, documento: string, id: string) {
    await this.base.operador(tx, a);
    const d = await this.base.documento(tx, a, documento);
    const job = await tx.trabalho_renderizacao.findFirst({ where: { id, igreja_id: a.igreja_id, versao: { documento_id: d.id } }, include: { arquivo: true } });
    if (!job) throw new NotFoundException('Artefato não encontrado.');
    return { job, visivel: this.visivel(d, job) };
  }

  async consultar(a: AtorSecretaria, documento: string, id: string) {
    return this.base.prisma.$transaction(async tx => {
      const { job, visivel } = await this.autorizado(tx, a, documento, id);
      return { ...this.resumo(job), estado: visivel ? job.estado : 'OBSOLETO', disponivel: visivel && !!job.arquivo, sha256: visivel ? job.arquivo?.sha256 ?? null : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async baixar(a: AtorSecretaria, documento: string, id: string) {
    const { job, visivel } = await this.base.prisma.$transaction(tx => this.autorizado(tx, a, documento, id),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    if (!visivel || !job.arquivo) throw new NotFoundException('Artefato não disponível.');
    const bytes = await this.storage.readAuthorized(a, job.arquivo, 'anexo_documento_consulta');
    return { bytes, nome: job.finalidade === 'MATRIZ_APROVADA' ? 'matriz-aprovada.pdf' : 'rascunho.pdf' };
  }

  limparTemporarios() { return this.storage.clearRenderTemps(); }

  private async reservar(lease: string) {
    return this.base.prisma.$transaction(async tx => {
      const [lock] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('provisao:renderizacao:e05')) AS ok`;
      if (!lock.ok) return null;
      const agora = new Date();
      if (await tx.trabalho_renderizacao.findFirst({ where: { estado: 'PROCESSANDO', reserva_ate: { gt: agora } }, select: { id: true } })) return null;
      await tx.trabalho_renderizacao.updateMany({
        where: { estado: 'PROCESSANDO', reserva_ate: { lte: agora }, tentativas: { gte: limiteTentativas } },
        data: { estado: 'FALHOU', reserva_id: null, reserva_ate: null },
      });
      const candidato = await tx.trabalho_renderizacao.findFirst({
        where: { ...(!livrosDisponiveis() ? { finalidade: { not: 'MEDICAO_LIVRO' } } : {}), OR: [{ estado: 'PENDENTE', executar_apos: { lte: agora } }, { estado: 'PROCESSANDO', reserva_ate: { lte: agora } }] },
        orderBy: [{ criado_em: 'asc' }, { id: 'asc' }], select: { id: true },
      });
      if (!candidato) return null;
      return tx.trabalho_renderizacao.update({
        where: { id: candidato.id },
        data: { estado: 'PROCESSANDO', reserva_id: lease, reserva_ate: new Date(Date.now() + 120000), tentativas: { increment: 1 } },
        include: { versao: { select: { numero: true, documento: { select: { estado: true, revisao: true, versao_atual: true } } } } },
      });
    });
  }

  private async concluir(job: trabalho_renderizacao, lease: string, pdf?: Buffer, paginas?: number) {
    await this.base.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM trabalho_renderizacao WHERE id = ${job.id} FOR UPDATE`;
      if (!await tx.trabalho_renderizacao.findFirst({ where: { id: job.id, reserva_id: lease, estado: 'PROCESSANDO' }, select: { id: true } })) return;
      const [documento] = await tx.$queryRaw<{ estado: string; revisao: number; versao_atual: number; numero: number; congelado_em: Date | null }[]>`
        SELECT d.estado, d.revisao, d.versao_atual, v.numero, v.congelado_em
        FROM documento d JOIN documento_versao v ON v.documento_id = d.id
        WHERE v.id = ${job.versao_id} AND v.igreja_id = ${job.igreja_id} FOR UPDATE OF d`;
      const valido = job.finalidade === 'MATRIZ_APROVADA' ? !!documento?.congelado_em :
        documento?.estado === 'EM_EDICAO' && documento.revisao === (job.medicao_revisao ?? job.revisao_documento) && documento.versao_atual === documento.numero;
      const arquivo = valido && pdf
        ? await this.storage.saveArtifact(tx, { sub: job.usuario_id, igreja_id: job.igreja_id }, job.id, pdf)
        : null;
      await tx.trabalho_renderizacao.update({
        where: { id: job.id },
        data: { estado: arquivo || (valido && paginas) ? 'CONCLUIDO' : 'OBSOLETO', arquivo_id: arquivo?.id, paginas_medidas: valido ? paginas : undefined, concluido_em: new Date(), reserva_id: null, reserva_ate: null },
      });
    }, { timeout: 10000 });
  }

  async executarUm() {
    const lease = randomUUID();
    const job = await this.reservar(lease);
    if (!job) return false;
    try {
      const { documento, numero } = job.versao;
      if (job.finalidade !== 'MATRIZ_APROVADA' && (documento.estado !== 'EM_EDICAO' || documento.revisao !== (job.medicao_revisao ?? job.revisao_documento) || documento.versao_atual !== numero)) {
        await this.concluir(job, lease);
        return true;
      }
      const { fonte, arquivos } = job.fonte as unknown as FonteTrabalho;
      const blocos = imagensDaEstrutura(fonte.conteudo.estrutura);
      let totalPixels = 0;
      for (const arquivo of arquivos) {
        const imagem = decodificarImagemDocumental(await this.storage.readVerified(arquivo));
        totalPixels += imagem.pixels * blocos.filter(b => b.arquivo_id === arquivo.id).length;
        if (totalPixels > limitePixelsDocumento) throw new Error('Imagens ultrapassam 32 megapixels.');
        fonte.imagens[arquivo.id] = imagem.uri;
      }
      const pdf = await gerarPdf(fonte);
      if (job.finalidade === 'MEDICAO_LIVRO') {
        await this.concluir(job, lease, undefined, await medirPaginasLivro(pdf, fonte.livro));
      } else {
        await this.concluir(job, lease, pdf);
      }
    } catch {
      await this.base.prisma.trabalho_renderizacao.updateMany({
        where: { id: job.id, reserva_id: lease, estado: 'PROCESSANDO' },
        data: { estado: job.tentativas >= limiteTentativas ? 'FALHOU' : 'PENDENTE', executar_apos: new Date(Date.now() + 15000 * job.tentativas), reserva_id: null, reserva_ate: null },
      });
    }
    return true;
  }
}
