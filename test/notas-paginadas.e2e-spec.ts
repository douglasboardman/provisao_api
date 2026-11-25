import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gerarPdf, medirPaginasLivro, type FonteRenderizacao } from '../src/secretaria/renderizador';
import { paginaTextoSchema } from '../src/secretaria/composicao-pagina';

const nota = randomUUID(), segunda = randomUUID(), pauta = randomUUID();
function fonte(quantidade: number, texto: string): FonteRenderizacao {
  const espaco = { superior: 0, inferior: 0 };
  const paragrafo = (texto: string) => ({ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'texto', texto }] });
  const composicao = paginaTextoSchema.parse({
    versao_formato: 1, notas_ativas: true, pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
      margens_cm: { superior: 2, inferior: 2, esquerda: 2, direita: 2 }, espacamento_cm: { cabecalho: espaco, corpo: espaco, rodape: espaco } },
    cabecalho: [paragrafo('Secretaria da assembleia')], rodape: [paragrafo('Arquivo permanente')],
    corpo: [{ ...paragrafo(''), trechos: [{ tipo: 'campo', campo_id: pauta, apresentacao: 'lista_numerada' }] },
      { ...paragrafo(''), trechos: [{ tipo: 'texto', texto: 'Deliberação' }, { tipo: 'referencia_nota', nota_id: nota },
        { tipo: 'texto', texto: ' final' }, { tipo: 'referencia_nota', nota_id: segunda }] }],
    notas: { [nota]: { texto }, [segunda]: { texto: 'Decisão registrada.' } },
  });
  return { tipo: 'ATA', titulo: 'Ata', numero: '001/2026', data: '2026-01-12', igreja: { nome: 'Igreja' },
    signatarios: [], imagens: {}, conteudo: { composicao, teor: '', arrolados: [], campos: {}, anexos: [], valores: {
      [pauta]: { tipo: 'texto', multiplo: true, origem: { tipo: 'manual' }, ajustado_manualmente: false, valor: Array.from({ length: quantidade }, (_,i) => 'Pauta item ' + (i + 1)) },
    } } };
}
const porPagina = (pdf: Buffer) => execFileSync('pdftotext', ['-layout','-','-'], { input: pdf, encoding: 'utf8' }).trimEnd().split('\f');

describe('saída paginada de notas pela renderização documental', () => {
  const editor = resolve(__dirname, '../../provisao_frontend/src/pages/secretaria/editor/paginar-notas.ts');
  if (existsSync(editor)) it('utiliza o mesmo algoritmo nos dois aplicativos', () => {
    expect(readFileSync(editor, 'utf8')).toBe(readFileSync(resolve(__dirname, '../src/secretaria/paginar-notas.ts'), 'utf8'));
  });
  if (existsSync(editor)) it.each([
    ['motor-imagens.ts', 'export interface FaixaImagem'],
    ['leitura-paginada.ts', 'export const estiloLeitura'],
    ['complementos-leitura.ts', 'const escape'],
  ])('mantém %s compatível entre a prévia e a impressão', (arquivo, inicio) => {
    const implementacao = (caminho: string) => {
      const fonte = readFileSync(caminho, 'utf8');
      expect(fonte).toContain(inicio);
      return fonte.slice(fonte.indexOf(inicio));
    };
    expect(implementacao(resolve(editor, '..', arquivo))).toBe(implementacao(resolve(__dirname, '../src/secretaria', arquivo)));
  });
  it('respeita a quebra convertida e imprime a nota inserida na célula da página seguinte', async () => {
    const f = fonte(1, 'Nota da tabela.');
    const c = f.conteudo.composicao!;
    if (c.versao_formato !== 1) throw new Error('Esta prova usa a composição original.');
    const paragrafo = c.corpo[1];
    if (paragrafo.tipo !== 'paragrafo') throw new Error('A prova precisa de um parágrafo anotado.');
    c.corpo = [c.corpo[0], { tipo: 'quebra' }, { tipo: 'tabela', primeira_linha_cabecalho: false, linhas: [[[paragrafo]]] }];
    const folhas = porPagina(await gerarPdf(f));
    expect(folhas).toHaveLength(2);
    expect(folhas[0]).toContain('Pauta item 1');
    expect(folhas[0]).not.toContain('Deliberação');
    expect(folhas[1]).toContain('Deliberação');
    expect(folhas[1]).toContain('1. Nota da tabela.');
  });
  it('move a nota com a palavra após expansão da pauta e conserva cabeçalho e rodapé', async () => {
    for (const quantidade of [2, 60]) {
      const paginas = porPagina(await gerarPdf(fonte(quantidade, 'Fonte do edital.')));
      expect(paginas.length).toBe(quantidade === 2 ? 1 : 2);
      const anotada = paginas.findIndex(p => p.includes('Deliberação'));
      expect(anotada).toBe(paginas.length - 1);
      expect(paginas[anotada]).toContain('1. Fonte do edital.');
      expect(paginas[anotada]).toContain('2. Decisão registrada.');
      for (const p of paginas) {
        expect(p).toContain('Arquivo permanente');
        expect(p).toContain('Secretaria da assembleia');
      }
      expect(paginas.join('').match(/Deliberação/g)).toHaveLength(1);
      expect(paginas.join('').match(/Pauta item /g)).toHaveLength(quantidade);
    }
  }, 60000);
  it('divide um parágrafo entre folhas e preserva o texto de duas notas extensas na mesma linha', async () => {
    const f = fonte(0, 'Primeiro fundamento. '.repeat(430).trim());
    const p = f.conteudo.composicao!;
    p.notas[segunda].texto = 'Segundo fundamento. '.repeat(390).trim();
    const paragrafo = p.corpo[1];
    if (paragrafo.tipo !== 'paragrafo') throw Error('Exemplo inválido');
    paragrafo.trechos.unshift({ tipo: 'texto', texto: 'Pauta discutida. '.repeat(460) });
    p.corpo = [paragrafo];
    const paginas = porPagina(await gerarPdf(f));
    const indice = paginas.findIndex(pg => pg.includes('Deliberação'));
    expect(indice).toBeGreaterThan(0);
    expect(paginas[indice]).toContain('1. Primeiro');
    expect(paginas[indice]).toContain('2. Segundo');
    expect(paginas.slice(0, indice).join('')).not.toContain('fundamento');
    const texto = paginas.join(' ').replace(/\d+\. \(continuação\)/g, '').replace(/\s+/g, ' ');
    expect(texto.match(/Pauta discutida\./g)).toHaveLength(460);
    expect(texto.match(/fundamento\./g)).toHaveLength(820);
  }, 60000);
  it.each([1, 2])('continua notas extensas e conserva a medição na matriz numerada (composição v%i)', async formato => {
    const f = fonte(1, 'Início da nota extensa. ' + 'Texto de conferência. '.repeat(600) + 'Fim da nota.');
    const comp = f.conteudo.composicao!;
    if (formato === 2) f.conteudo.composicao = paginaTextoSchema.parse({ ...comp, versao_formato: 2,
      pagina: { ...comp.pagina, altura_minima_cm: { cabecalho: 0, rodape: 0 } } });
    f.finalidade = 'MATRIZ_APROVADA';
    const livro = { numero: 1, serie: 'ATA', perfil: 'LOCAL_V1', natureza: 'ATA_ORIGINAL' as const };
    const medicao = await gerarPdf({ ...f, livro });
    const paginas = await medirPaginasLivro(medicao, livro);
    const matriz = porPagina(await gerarPdf({ ...f, livro: { ...livro, paginas, numeroVisivel: 12 } }));
    expect(paginas).toBeGreaterThan(1);
    expect(matriz).toHaveLength(paginas);
    expect(matriz[0]).toContain('Deliberação');
    expect(matriz[0]).toContain('Início da nota extensa.');
    expect(matriz[0]).toContain('2. Decisão registrada.');
    expect(matriz.slice(1).every(p => p.includes('1. (continuação)'))).toBe(true);
    expect(matriz.join('').match(/Fim da nota\./g)).toHaveLength(1);
    expect(matriz.join('').match(/conferência\./g)).toHaveLength(600);
  }, 60000);
});
