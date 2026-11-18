import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { SecretariaBaseService, AtorSecretaria, Tx, dataCivil, json } from './secretaria-base.service';
import { SecretariaCadastrosService } from './secretaria-cadastros.service';
import { transacaoComRetentativa } from '../orgaos/idempotencia';
import { ComposicaoService } from '../orgaos/composicao.service';
import { hojeDaIgreja } from '../orgaos/relogio-igreja';
import { eventoVigente } from '../eventos-membresia/estado-temporal';
import * as dto from './secretaria.dto';
import { LivrosService, exigirLivros } from './livros.service';
import { RascunhosService, igrejaSelect, type SignatarioRenderizacao } from './rascunhos.service';
import { arquivoSemVinculoDeExpedicao, PrivateStorageService } from '../private-storage/private-storage.service';
import { assinaturasDisponiveis, cancelarExpedicao, exigirAssinaturas } from './expedicao-estado';
import { decodificarImagemDocumental, limitePixelsDocumento } from './imagens-documentais';
import { entradaResolucoes, salvarResolucoes, validarResolucoes } from './resolucoes';
import { resolucoesSchema } from './resolucoes.dto';

function numeroDocumento(d: { numero: number | null; ano: number | null; sigla: string | null }) {
  return `${String(d.numero).padStart(3, '0')}/${d.ano}/${d.sigla}`;
}

@Injectable()
export class DocumentosService {
  constructor(readonly base: SecretariaBaseService, readonly cadastros: SecretariaCadastrosService, readonly composicao: ComposicaoService, private readonly artefatos: RascunhosService, private readonly storage: PrivateStorageService, private readonly livros: LivrosService) {}

  async validarVersao(tx: Tx, a: AtorSecretaria, contexto: string, documento: string, v: dto.VersaoInput, atualId?: string, restrito = false) {
    const m = await tx.modelo_documento_versao.findFirst({
      where: { id: v.modelo_versao_id, igreja_id: a.igreja_id, contexto_id: contexto },
      include: { imagens: { select: { arquivo_id: true } } },
    });
    if (!m) throw new BadRequestException('Versão do modelo não pertence ao contexto.');
    const config = dto.validar(dto.configuracaoSchema, m.configuracao);
    const vinculo = await this.livros.validarVinculo(tx, a, contexto, restrito, m, config, v, atualId);
    dto.validarCampos(config, v.conteudo.campos);
    await this.cadastros.configurar(tx, a, contexto, config);
    const c = await this.base.contexto(tx, a, contexto);
    if (m.tipo === 'ATA' && !v.reuniao_id) throw new BadRequestException('Ata exige reunião.');
    if (m.tipo !== 'ATA' && v.reuniao_id) throw new BadRequestException('Reunião exclusiva de ata.');
    let dadosReuniao: dto.ReuniaoInput | undefined;
    if (v.reuniao_id) {
      const r = await this.cadastros.reuniao(tx, a, v.reuniao_id);
      if (r.contexto_id !== contexto || r.data > dataCivil(v.data_documento) || (r.restrito && !restrito)) throw new BadRequestException('Reunião/contexto, data ou sigilo incompatíveis.');
      dadosReuniao = dto.validar(dto.reuniaoDadosSchema, r.dados);
    }
    validarResolucoes(v, config, dadosReuniao);
    if (config.motivador === 'NAO_PERMITE' && v.motivador_id) throw new BadRequestException('Modelo não permite motivador.');
    await this.base.conferirMotivador(tx, a, v.motivador_id, documento, atualId);
    // Referência a acervo restrito não pode ser publicada em documento aberto.
    if (v.motivador_id) {
      const motivador = await tx.documento_versao.findUniqueOrThrow({ where: { id: v.motivador_id }, include: { documento: true } });
      if (motivador.documento.restrito && !restrito) throw new BadRequestException('Documento motivado deve preservar o sigilo da fonte.');
    }
    const ids = v.conteudo.arrolados.map(p => p.pessoa_id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Uma pessoa deve ser arrolada uma única vez com todos os papéis.');
    if (await tx.pessoas.count({ where: { id: { in: ids }, igreja_id: a.igreja_id } }) !== ids.length) throw new BadRequestException('Arrolado de outra igreja.');
    for (const p of v.conteudo.arrolados) {
      const cargos = dto.cargosDoArrolado(p);
      if (cargos.length && (!c.orgao_id || await tx.cargo_orgao.count({ where: { id: { in: cargos }, igreja_id: a.igreja_id, orgao_id: c.orgao_id, ativo: true } }) !== cargos.length)) throw new BadRequestException('Cargo não existe neste contexto.');
    }
    const imagensModelo = new Set(m.imagens.map(imagem => imagem.arquivo_id));
    const imagens = dto.imagensDaEstrutura(v.conteudo.estrutura ?? (!documento ? config.estrutura_padrao : undefined));
    if (!documento) {
      v.conteudo.estrutura ??= config.estrutura_padrao;
      for (const imagem of imagens) {
        if (imagensModelo.has(imagem.arquivo_id) && !v.conteudo.anexos.some(a => a.arquivo_id === imagem.arquivo_id)) {
          v.conteudo.anexos.push({ arquivo_id: imagem.arquivo_id, nome: imagem.descricao.trim() || 'Imagem do modelo' });
        }
      }
    }
    const arquivos = v.conteudo.anexos.map(p => p.arquivo_id);
    if (arquivos.length > 50) throw new BadRequestException('Até 50 anexos por versão.');
    if (new Set(arquivos).size !== arquivos.length) throw new BadRequestException('Anexo duplicado.');
    if (imagens.some(b => !arquivos.includes(b.arquivo_id))) throw new BadRequestException('Imagem deve ser um anexo privado da versão.');
    let totalImagens = 0;
    let totalPixels = 0;
    for (const id of arquivos) {
      // Novos anexos só podem usar upload próprio. Um anexo já vinculado pode ser mantido nas versões seguintes.
      const f = await tx.arquivo_privado.findFirst({ where: { id, igreja_id: a.igreja_id, artefatos_documento: { none: {} }, livros_historicos: { none: {} }, registros_livro: { none: {} }, ...arquivoSemVinculoDeExpedicao } });
      if (!f || (f.usuario_id !== a.sub && !imagensModelo.has(id) && !await tx.anexo_documento.findFirst({ where: { arquivo_id: id, igreja_id: a.igreja_id, versao: { documento_id: documento } } }))) throw new BadRequestException('Anexo privado indisponível para vinculação.');
      const usos = imagens.filter(b => b.arquivo_id === id).length;
      if (!usos) continue;
      totalImagens += f.tamanho * usos;
      if (f.tamanho > 2 * 1024 * 1024 || totalImagens > 4 * 1024 * 1024) throw new BadRequestException('Imagens de até 2 MB cada e 4 MB no total.');
      totalPixels += decodificarImagemDocumental(await this.storage.readVerified(f)).pixels * usos;
      if (totalPixels > limitePixelsDocumento) throw new BadRequestException('As imagens do documento devem somar até 32 megapixels.');
    }
    return { m, config, c, vinculo };
  }

  private async retratoArrolado(tx: Tx, a: AtorSecretaria, orgao: string | null, p: dto.VersaoInput['conteudo']['arrolados'][number]) {
    const pessoa = await tx.pessoas.findFirstOrThrow({ where: { id: p.pessoa_id, igreja_id: a.igreja_id }, select: { nome_completo: true, email: true } });
    const ids = dto.cargosDoArrolado(p);
    const cargos = ids.length ? await tx.cargo_orgao.findMany({ where: { id: { in: ids }, igreja_id: a.igreja_id, orgao_id: orgao! }, select: { id: true, nome: true, codigo: true } }) : [];
    cargos.sort((a, b) => a.id.localeCompare(b.id));
    return { nome: pessoa.nome_completo, email: pessoa.email, cargo: cargos[0] ?? null, cargos, fundamento: p.fundamento };
  }

  async salvarArroladosAnexos(tx: Tx, a: AtorSecretaria, versaoId: string, contexto: string, conteudo: dto.VersaoInput['conteudo']) {
    const c = await this.base.contexto(tx, a, contexto);
    await tx.cargo_arrolado_documento.deleteMany({ where: { versao_id: versaoId } });
    await tx.arrolado_documento.deleteMany({ where: { versao_id: versaoId } });
    await tx.anexo_documento.deleteMany({ where: { versao_id: versaoId } });
    for (const p of conteudo.arrolados) {
      const retrato = await this.retratoArrolado(tx, a, c.orgao_id, p);
      const arrolado = await tx.arrolado_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versaoId, pessoa_id: p.pessoa_id, cargo_id: p.cargo_id, orgao_id: p.cargo_id ? c.orgao_id : null, papeis: [...new Set(p.papeis)], assina: p.assina, obrigatorio: p.obrigatorio, responsavel: p.responsavel, retrato: json(retrato) } });
      for (const cargo of retrato.cargos) await tx.cargo_arrolado_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versaoId, arrolado_id: arrolado.id, cargo_id: cargo.id, orgao_id: c.orgao_id! } });
    }
    for (const p of conteudo.anexos) await tx.anexo_documento.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: versaoId, arquivo_id: p.arquivo_id, nome: p.nome } });
  }

  async novaVersao(tx: Tx, a: AtorSecretaria, documento: string, contexto: string, numero: number, v: dto.VersaoInput, retifica?: string) {
    const r = await tx.documento_versao.create({ data: { igreja_id: a.igreja_id, contexto_id: contexto, documento_id: documento, numero, modelo_versao_id: v.modelo_versao_id, livro_id: v.livro_id, reuniao_id: v.reuniao_id, motivador_id: v.motivador_id, assunto: v.assunto, data_documento: dataCivil(v.data_documento), conteudo: json(v.conteudo), retifica_versao_id: retifica } });
    await this.salvarArroladosAnexos(tx, a, r.id, contexto, v.conteudo);
    await salvarResolucoes(tx, { igreja_id: a.igreja_id, contexto_id: contexto, versao_id: r.id }, v.resolucoes);
    return r;
  }

  criar(a: AtorSecretaria, dados: unknown) {
    const v = dto.validar(dto.documentoSchema, dados);
    return this.base.comando(a, 'CRIAR_DOCUMENTO', v.contexto_id, v, async tx => {
      await this.base.preparar(tx, a, v.contexto_id);
      if (v.restrito) await this.base.competente(tx, a, v.contexto_id, 'pode_consultar_restritos');
      const entrada = structuredClone(v.versao);
      const { m, config, vinculo } = await this.validarVersao(tx, a, v.contexto_id, '', entrada, undefined, v.restrito);
      await this.livros.fixarTermo(tx, vinculo);
      const d = await tx.documento.create({ data: { igreja_id: a.igreja_id, contexto_id: v.contexto_id, restrito: v.restrito, tipo: m.tipo, perfil: m.tipo === 'ATA' ? config.perfil : 'CORRESPONDENCIA' } });
      await this.novaVersao(tx, a, d.id, v.contexto_id, 1, entrada);
      return { id: d.id, revisao: 1 };
    });
  }

  editar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.editarDocumentoSchema, dados);
    return this.base.comando(a, 'EDITAR_DOCUMENTO', id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.preparar(tx, a, d.contexto_id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('Conteúdo formalizado exige retificação/versionamento.');
      const atual = d.versoes.find(r => r.numero === d.versao_atual)!;
      if (atual.livro_id) exigirLivros();
      const versao = { ...v.versao, resolucoes: v.versao.resolucoes ?? entradaResolucoes(atual.resolucoes) };
      const { m, config, vinculo } = await this.validarVersao(tx, a, d.contexto_id, id, versao, atual.id, d.restrito);
      if ((dto.finalidadeTermo(atual.modelo.finalidade) || dto.finalidadeTermo(m.finalidade)) &&
          (atual.modelo.finalidade !== m.finalidade || atual.livro_id !== v.versao.livro_id)) {
        throw new BadRequestException('A finalidade e o livro de um termo são definidos na criação.');
      }
      await this.livros.fixarTermo(tx, vinculo);
      if (m.tipo !== d.tipo || (m.tipo === 'ATA' && config.perfil !== d.perfil) || (d.ano && d.ano !== Number(v.versao.data_documento.slice(0, 4)))) throw new BadRequestException('Tipo, série e ano reservado não podem mudar.');
      if (atual.congelado_em) throw new BadRequestException('Versão congelada.');
      await tx.documento_versao.update({ where: { id: atual.id }, data: { modelo_versao_id: v.versao.modelo_versao_id, livro_id: v.versao.livro_id ?? null, reuniao_id: v.versao.reuniao_id, motivador_id: v.versao.motivador_id, assunto: v.versao.assunto, data_documento: dataCivil(v.versao.data_documento), conteudo: json(v.versao.conteudo), revisao_conteudo: { increment: 1 } } });
      const escopo = { versao_id: atual.id, igreja_id: a.igreja_id, contexto_id: d.contexto_id };
      await tx.resolucao.deleteMany({ where: escopo });
      await this.salvarArroladosAnexos(tx, a, atual.id, d.contexto_id, versao.conteudo);
      await salvarResolucoes(tx, escopo, versao.resolucoes);
      await tx.documento.update({ where: { id }, data: { encaminhado_em: null, revisao: { increment: 1 } } });
      return { id, revisao: d.revisao + 1 };
    });
  }

  async conferirAprovacao(tx: Tx, a: AtorSecretaria, d: Awaited<ReturnType<SecretariaBaseService['documento']>>) {
    const atual = d.versoes.find(v => v.numero === d.versao_atual)!;
    const entrada = { modelo_versao_id: atual.modelo_versao_id, livro_id: atual.livro_id, reuniao_id: atual.reuniao_id, motivador_id: atual.motivador_id, assunto: atual.assunto, data_documento: atual.data_documento.toISOString().slice(0, 10), conteudo: dto.validar(dto.conteudoSchema, atual.conteudo), resolucoes: dto.validar(resolucoesSchema, entradaResolucoes(atual.resolucoes)) };
    const { config, c, vinculo } = await this.validarVersao(tx, a, d.contexto_id, d.id, entrada, atual.id, d.restrito);
    const estrutura = entrada.conteudo.estrutura;
    const blocos = estrutura ? Object.values(estrutura).flat() : [];
    const textos = blocos.flatMap(b => b.tipo === 'TEXTO' ? [b.texto] : b.tipo === 'LISTA' ? b.itens : b.tipo === 'TABELA' ? b.linhas.flat() : []);
    if (!entrada.resolucoes.length && !entrada.conteudo.teor.trim() && !textos.some(t => t.trim())) throw new BadRequestException('Teor obrigatório para encaminhar/aprovar.');
    for (const texto of [entrada.conteudo.teor, ...textos]) {
      const padrao = /\{\{([^{}]*)\}\}/g;
      if (/\{\{|\}\}/.test(texto.replace(padrao, ''))) throw new BadRequestException('Use {{CODIGO}} para inserir um campo.');
      for (const campo of texto.matchAll(padrao)) {
        if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(campo[1]) || !entrada.conteudo.campos[campo[1]]?.trim()) throw new BadRequestException(`Campo não resolvido: ${campo[1].slice(0, 80)}.`);
      }
    }
    for (const chave of config.campos_obrigatorios) if (!entrada.conteudo.campos[chave]?.trim()) throw new BadRequestException(`Campo obrigatório: ${chave}.`);
    if (config.motivador === 'OBRIGATORIO' && !atual.motivador_id) throw new BadRequestException('Motivador obrigatório.');
    if (config.resolucoes === 'OBRIGATORIO' && !entrada.resolucoes.length) throw new BadRequestException('Modelo exige ao menos uma resolução.');
    const obrigatorios = entrada.conteudo.arrolados.filter(p => p.assina && p.obrigatorio);
    if (!obrigatorios.length || !entrada.conteudo.arrolados.some(p => p.responsavel)) throw new BadRequestException('Exige responsável e ao menos um signatário obrigatório.');
    for (const papel of config.papeis_obrigatorios) if (!obrigatorios.some(p => p.papeis.includes(papel))) throw new BadRequestException(`Signatário obrigatório para papel ${papel}.`);
    for (const cargo of config.cargos_obrigatorios) if (!obrigatorios.some(p => dto.cargosDoArrolado(p).includes(cargo))) throw new BadRequestException('Signatário de cargo exigido ausente.');
    for (const p of entrada.conteudo.arrolados) {
      if ((p.assina || p.responsavel) && !p.fundamento) throw new BadRequestException('Documente o fundamento de cada signatário e responsável.');
      for (const cargoId of dto.cargosDoArrolado(p)) {
        const ocupacoes = await tx.ocupacao_cargo.findMany({ where: { igreja_id: a.igreja_id, orgao_id: c.orgao_id!, cargo_id: cargoId, pessoa_id: p.pessoa_id, inicio: { lte: atual.data_documento }, AND: [{ OR: [{ fim: null }, { fim: { gt: atual.data_documento } }] }, { OR: [{ termino_previsto: null }, { termino_previsto: { gte: atual.data_documento } }] }] } });
        if (ocupacoes.length !== 1) throw new BadRequestException('Ocupação do cargo ausente ou indeterminada na data do ato.');
        if (c.orgao && c.orgao.tipo !== 'UNIDADE_MINISTERIAL') {
          const membros = await this.composicao.consultarNaTransacao(tx, a.igreja_id, c.orgao.tipo, entrada.data_documento);
          if (!membros.membros.some(m => m.pessoa_id === p.pessoa_id && !m.revisao_pendente)) throw new BadRequestException('Exercício institucional do signatário não confirmado.');
        } else {
          const eventos = await tx.eventos_membresia.findMany({ where: { igreja_id: a.igreja_id, pessoa_id: p.pessoa_id, data_evento: { lte: atual.data_documento } } });
          const rol = eventoVigente(eventos, atual.data_documento);
          if (rol.situacao !== 'DEFINIDO' || rol.evento.rol !== 'COMUNGANTES') throw new BadRequestException('Membresia vigente do dirigente não confirmada.');
        }
      }
    }
    const competenciaTermo = vinculo && await this.livros.conferirResponsabilidade(tx, vinculo, entrada);
    if (d.tipo === 'ATA') {
      const r = await this.cadastros.reuniao(tx, a, atual.reuniao_id!);
      const dados = dto.validar(dto.reuniaoDadosSchema, r.dados);
      if (!dados.quorum_conferido || r.participantes.filter(p => p.presente).length < dados.quorum_minimo) throw new BadRequestException('Quórum da reunião deve ser conferido e atendido.');
      for (const papel of ['PRESIDENTE', 'SECRETARIO']) if (!r.participantes.some(p => p.presente && p.papeis.includes(papel))) throw new BadRequestException(`Mesa exige ${papel} presente.`);
    }
    return { atual, entrada, config, c, vinculo, competenciaTermo };
  }

  private conferirProntidao(d: Awaited<ReturnType<SecretariaBaseService['documento']>>, atual: typeof d.versoes[number]) {
    if (!d.encaminhado_em || !d.numero) throw new BadRequestException('Encaminhe a versão antes de aprovar.');
    if (d.tipo === 'ATA' && (atual.deliberacoes.at(-1)?.resultado !== 'APROVADA' || atual.deliberacoes.at(-1)?.revisao_conteudo !== atual.revisao_conteudo)) {
      throw new BadRequestException('Registre a aprovação deliberativa desta versão da ata.');
    }
  }

  medir(a: AtorSecretaria, id: string, dados: unknown) {
    exigirLivros();
    const v = dto.validar(dto.medicaoLivroSchema, dados);
    return transacaoComRetentativa(this.base.prisma, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.preparar(tx, a, d.contexto_id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('A medição exige documento em edição.');
      const { atual, entrada, c, vinculo } = await this.conferirAprovacao(tx, a, d);
      this.conferirProntidao(d, atual);
      if (!vinculo) throw new BadRequestException('A versão não está vinculada a um livro.');
      const igreja = await tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: igrejaSelect });
      const signatarios: SignatarioRenderizacao[] = [];
      for (const p of entrada.conteudo.arrolados) {
        signatarios.push({ pessoa_id: p.pessoa_id, assina: p.assina, retrato: await this.retratoArrolado(tx, a, c.orgao_id, p) });
      }
      const fonte = await this.artefatos.fonteMatriz(tx, d, { ...atual, conteudo: entrada.conteudo }, igreja, signatarios, numeroDocumento(d), c.orgao?.nome ?? c.nome, vinculo);
      return this.artefatos.enfileirarMedicao(tx, a, d, atual, fonte);
    }, Prisma.TransactionIsolationLevel.Serializable, erro => erro instanceof Prisma.PrismaClientKnownRequestError &&
      erro.code === 'P2002' && Array.isArray(erro.meta?.target) && erro.meta.target.includes('versao_id'));
  }

  executar(a: AtorSecretaria, id: string, operacao: 'encaminhar' | 'aprovar' | 'cancelar' | 'anular', dados: unknown) {
    const aprovacao = operacao === 'aprovar' ? dto.validar(dto.aprovacaoSchema, dados) : null;
    const v = aprovacao ?? dto.validar(dto.comandoSchema, dados);
    const modalidade = aprovacao?.modalidade;
    if (operacao === 'aprovar' && modalidade) exigirAssinaturas();
    if (operacao === 'aprovar' && assinaturasDisponiveis() && !modalidade) throw new BadRequestException('Selecione a modalidade de assinatura.');
    return this.base.comando(a, operacao.toUpperCase(), id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (operacao === 'encaminhar') await this.base.preparar(tx, a, d.contexto_id);
      else await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
      const versaoAtual = d.versoes.find(r => r.numero === d.versao_atual)!;
      if (versaoAtual.livro_id) exigirLivros();
      if (operacao === 'cancelar' || operacao === 'anular') {
        if (operacao === 'anular' ? d.estado !== 'EXPEDIDO' : !['EM_EDICAO', 'APROVADO'].includes(d.estado)) throw new BadRequestException('Transição de estado inválida.');
        if (operacao === 'cancelar') await cancelarExpedicao(tx, versaoAtual.id);
        if (operacao === 'cancelar' && versaoAtual.livro_id) {
          await this.livros.cancelarReserva(tx, versaoAtual.id);
          if (dto.finalidadeTermo(versaoAtual.modelo.finalidade)) {
            await tx.livro_atas.update({ where: { id: versaoAtual.livro_id }, data: { revisao: { increment: 1 } } });
          }
        }
        if (operacao === 'anular' && versaoAtual.livro_id && dto.finalidadeTermo(versaoAtual.modelo.finalidade)) {
          throw new BadRequestException('Termo efetivado integra o acervo e exige ato complementar.');
        }
        await tx.documento.update({ where: { id }, data: { estado: operacao === 'anular' ? 'ANULADO' : 'CANCELADO', revisao: { increment: 1 } } });
        return { id, revisao: d.revisao + 1 };
      }
      if (d.estado !== 'EM_EDICAO') throw new BadRequestException('Documento deve estar em edição.');
      const { atual, entrada, c, vinculo, competenciaTermo } = await this.conferirAprovacao(tx, a, d);
      if (operacao === 'encaminhar') {
        if (!d.numero) {
          const ano = Number(entrada.data_documento.slice(0, 4));
          const contador = await tx.contador_documento.upsert({ where: { igreja_id_contexto_id_tipo_perfil_ano: { igreja_id: a.igreja_id, contexto_id: d.contexto_id, tipo: d.tipo, perfil: d.perfil, ano } }, create: { igreja_id: a.igreja_id, contexto_id: d.contexto_id, tipo: d.tipo, perfil: d.perfil, ano, ultimo: 1 }, update: { ultimo: { increment: 1 } } });
          await tx.documento.update({ where: { id }, data: { numero: contador.ultimo, ano, sigla: c.orgao?.sigla ?? c.sigla } });
        }
        await tx.documento.update({ where: { id }, data: { encaminhado_em: new Date(), revisao: { increment: 1 } } });
      } else {
        if (entrada.data_documento > await hojeDaIgreja(tx, a.igreja_id)) throw new BadRequestException('Documento futuro não pode ser aprovado.');
        this.conferirProntidao(d, atual);
        const aprovador = await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
        const competenciasAprovador = (await this.base.concessoes(tx, a, d.contexto_id)).filter(c => c.pode_aprovar).map(c => c.id);
        const igreja = await tx.igreja.findUniqueOrThrow({ where: { id: a.igreja_id }, select: igrejaSelect });
        // Atualiza retratos sem trocar os arrolados usados pelas resoluções.
        const arrolados: typeof atual.arrolados = [];
        const porPessoa = new Map(atual.arrolados.map(p => [p.pessoa_id, p.id]));
        for (const p of entrada.conteudo.arrolados) {
          const retrato = await this.retratoArrolado(tx, a, c.orgao_id, p);
          arrolados.push(await tx.arrolado_documento.update({
            where: { id: porPessoa.get(p.pessoa_id)! }, data: { retrato: json(retrato) },
          }));
        }
        const reuniao = atual.reuniao_id ? await this.cadastros.reuniao(tx, a, atual.reuniao_id) : null;
        const numero = numeroDocumento(d);
        const nomeContexto = c.orgao?.nome ?? c.nome;
        const fonte = await this.artefatos.fonteMatriz(tx, d, { ...atual, conteudo: entrada.conteudo }, igreja, arrolados, numero, nomeContexto, vinculo);
        const reserva = vinculo ? await this.livros.reservar(tx, vinculo, atual, await this.artefatos.paginasMedidas(tx, d, atual, fonte)) : null;
        const paginacao = reserva && vinculo ? {
          ...reserva, numero_livro: vinculo.livro.numero, serie_livro: vinculo.livro.serie,
        } : null;
        if (reserva) this.artefatos.fixarPaginacao(fonte, reserva);
        await tx.documento_versao.update({ where: { id: atual.id }, data: { conteudo: json(entrada.conteudo), congelado_em: new Date(), fonte_congelada: json({ igreja, contexto: { id: c.id, tipo: c.tipo, nome: nomeContexto, sigla: d.sigla, orgao: c.orgao ? { tipo: c.orgao.tipo, constituicao: c.orgao.constituicao } : null }, modelo: atual.modelo, numero, arrolados, anexos: atual.anexos, reuniao, ...(entrada.resolucoes.length ? { resolucoes: entrada.resolucoes } : {}), ...(paginacao ? { registro_livro: paginacao } : {}), ...(competenciaTermo ? { competencia_termo: competenciaTermo } : {}), deliberacao: atual.deliberacoes.at(-1) ?? null, aprovacao_tecnica: { usuario_id: a.sub, pessoa_id: aprovador.pessoa_id, nome: aprovador.nome_usuario, perfil: aprovador.perfil, competencias_ids: competenciasAprovador, autoridade: v.autoridade, evidencia: v.evidencia, data: new Date().toISOString() } }) } });
        if (modalidade) {
          const fuso = await tx.configuracao_fuso_igreja.findUnique({ where: { igreja_id: a.igreja_id } });
          await tx.expedicao_documento.create({ data: {
            versao_id: atual.id, igreja_id: a.igreja_id, contexto_id: d.contexto_id, operador_id: a.sub,
            modalidade, fuso_iana: fuso?.fuso_iana ?? 'UTC', codigo_verificacao: randomBytes(16).toString('hex'),
          } });
        }
        await this.artefatos.enfileirarMatriz(tx, a, d, atual, fonte);
        await tx.documento.update({ where: { id }, data: { estado: 'APROVADO', revisao: { increment: 1 } } });
      }
      return { id, revisao: d.revisao + 1 };
    });
  }

  deliberar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.deliberacaoSchema, dados);
    return this.base.comando(a, 'DELIBERAR_ATA', id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      this.base.conferirRevisao(d.revisao, v.revisao);
      await this.base.competente(tx, a, d.contexto_id, 'pode_deliberar');
      if (d.tipo !== 'ATA' || d.estado !== 'EM_EDICAO') throw new BadRequestException('Deliberação exige ata em edição.');
      if (v.data > await hojeDaIgreja(tx, a.igreja_id)) throw new BadRequestException('Deliberação futura não pode ser registrada.');
      const atual = d.versoes.find(r => r.numero === d.versao_atual)!;
      const r = await this.cadastros.reuniao(tx, a, v.reuniao_id);
      const origem = await this.cadastros.reuniao(tx, a, atual.reuniao_id!);
      const rd = dto.validar(dto.reuniaoDadosSchema, r.dados);
      if (r.contexto_id !== d.contexto_id || r.data < origem.data || dataCivil(v.data).getTime() !== r.data.getTime() || (r.restrito && !d.restrito) || !rd.quorum_conferido || r.participantes.filter(p => p.presente).length < rd.quorum_minimo) throw new BadRequestException('Reunião deliberativa, data, sigilo ou quórum incompatíveis.');
      for (const papel of ['PRESIDENTE', 'SECRETARIO']) if (!r.participantes.some(p => p.presente && p.papeis.includes(papel))) throw new BadRequestException('Mesa deliberativa incompleta.');
      await tx.deliberacao_ata.create({ data: { igreja_id: a.igreja_id, contexto_id: d.contexto_id, versao_id: atual.id, revisao_conteudo: atual.revisao_conteudo, reuniao_id: r.id, data: dataCivil(v.data), resultado: v.resultado, autoridade: v.autoridade, evidencia: v.evidencia } });
      await tx.documento.update({ where: { id }, data: { revisao: { increment: 1 } } });
      return { id, revisao: d.revisao + 1 };
    });
  }

  retificar(a: AtorSecretaria, id: string, dados: unknown) {
    const v = dto.validar(dto.retificarSchema, dados);
    return this.base.comando(a, 'RETIFICAR_DOCUMENTO', id, v, async tx => {
      const d = await this.base.documento(tx, a, id);
      await this.base.competente(tx, a, d.contexto_id, 'pode_aprovar');
      this.base.conferirRevisao(d.revisao, v.revisao);
      if (!['APROVADO', 'EXPEDIDO', 'ANULADO'].includes(d.estado)) throw new BadRequestException('Retificação exige versão aprovada ou expedida.');
      const atual = d.versoes.find(r => r.numero === d.versao_atual)!;
      if (atual.livro_id) exigirLivros();
      if (dto.finalidadeTermo(atual.modelo.finalidade)) throw new BadRequestException('Cancele o termo pendente e crie um novo termo, ou vincule um ato complementar ao livro encerrado.');
      const versao = { ...v.versao, resolucoes: v.versao.resolucoes ?? entradaResolucoes(atual.resolucoes) };
      const { m, config } = await this.validarVersao(tx, a, d.contexto_id, id, versao, atual.id, d.restrito);
      if (dto.finalidadeTermo(m.finalidade)) throw new BadRequestException('Termo de livro deve ser criado como novo documento.');
      if (m.tipo !== d.tipo || (d.tipo === 'ATA' && config.perfil !== d.perfil)) throw new BadRequestException('Tipo e perfil devem ser preservados.');
      if (d.estado === 'EXPEDIDO' || d.estado === 'ANULADO') {
        const novo = await tx.documento.create({ data: { igreja_id: a.igreja_id, contexto_id: d.contexto_id, tipo: d.tipo, perfil: d.perfil, restrito: d.restrito } });
        await this.novaVersao(tx, a, novo.id, d.contexto_id, 1, versao, atual.id);
        return { id: novo.id, revisao: 1 };
      }
      if (d.ano && d.ano !== Number(v.versao.data_documento.slice(0, 4))) throw new BadRequestException('Ano reservado não pode mudar.');
      await cancelarExpedicao(tx, atual.id);
      if (atual.livro_id) await this.livros.cancelarReserva(tx, atual.id);
      await this.novaVersao(tx, a, id, d.contexto_id, d.versao_atual + 1, versao, atual.id);
      await tx.documento.update({ where: { id }, data: { versao_atual: { increment: 1 }, revisao: { increment: 1 }, estado: 'EM_EDICAO', encaminhado_em: null } });
      return { id, revisao: d.revisao + 1 };
    });
  }

  async listar(a: AtorSecretaria, contexto: string, pagina: number) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a); await this.base.contexto(tx, a, contexto);
      const restritos = (await this.base.concessoes(tx, a, contexto)).some(g => g.pode_consultar_restritos);
      const rows = await tx.documento.findMany({ where: { igreja_id: a.igreja_id, contexto_id: contexto, ...(!restritos ? { restrito: false } : {}) }, select: { id: true, estado: true, revisao: true, versao_atual: true, tipo: true, numero: true, ano: true, sigla: true, restrito: true, encaminhado_em: true, versoes: { select: { id: true, numero: true, assunto: true, data_documento: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }], skip: pagina * 30, take: 30 });
      return rows.map(r => ({ ...r, versoes: r.versoes.filter(v => v.numero === r.versao_atual) }));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async historico(a: AtorSecretaria, id: string, pagina: number) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      await this.base.documento(tx, a, id);
      const comandos = await tx.comando_secretaria.findMany({ where: { igreja_id: a.igreja_id, OR: [{ alvo_id: id }, { resultado: { path: ['id'], equals: id } }] }, select: { id: true, operacao: true, criado_em: true, dados: true, usuario: { select: { nome_usuario: true } } }, orderBy: [{ criado_em: 'desc' }, { id: 'asc' }], take: 30, skip: pagina * 30 });
      return comandos.map(c => {
        const dados = c.dados as Record<string, unknown>;
        return { id: c.id, operacao: c.operacao, criado_em: c.criado_em, operador: c.usuario.nome_usuario, autoridade: typeof dados.autoridade === 'string' ? dados.autoridade : null, evidencia: typeof dados.evidencia === 'string' ? dados.evidencia : null };
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async detalhe(a: AtorSecretaria, id: string) {
    return this.base.prisma.$transaction(async tx => {
      await this.base.operador(tx, a);
      const d = await this.base.documento(tx, a, id);
      await tx.logs_atividades.create({ data: { igreja_id: a.igreja_id, usuario_id: a.sub, acao: 'CONSULTA', tabela_afetada: 'documento', registro_id: id } });
      return d;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
