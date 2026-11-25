import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { leituraComposicaoSchema, composicaoPaginaV2Schema, type ImagemPaginaV2, type ComposicaoPaginaV2 } from '../../src/secretaria/composicao-pagina';
import { gerarPdf, type FonteRenderizacao } from '../../src/secretaria/renderizador';
import type { PaginaTextoV2 } from '../../../provisao_frontend/src/api/pagina-v2';
import { montarFolhas } from './folhas-imagens';

const logoId = '053afc13-505d-40cc-822a-9c18a4c510e0', desenhoId = '8708bfcd-7ce4-476e-80ac-80a3087563df';
const nota = '4fc3976b-4b10-48e8-b924-2c8b2ba01afa';
const pasta = resolve('../output/pdf/editor-imagens');
const amostras = join(__dirname, 'amostras');
type P = Extract<ComposicaoPaginaV2['corpo'][number], {tipo: 'paragrafo'}>;
const texto = (texto: string): P => ({ tipo: 'paragrafo', alinhamento: 'esquerda', trechos: [{ tipo: 'texto', texto }] });
const img: ImagemPaginaV2 = {
  tipo: 'imagem', arquivo_id: logoId, ocorrencia_id: '47fabddf-442e-44f8-a4ac-6b6478873601',
  descricao: 'Emblema da secretaria', largura_cm: 4, altura_cm: 4, ajuste: 'ajustar', manter_proporcao: true,
  horizontal: 'esquerda', vertical: 'centro', x_cm: 0, y_cm: 0, relacao: 'a_frente', opacidade: 1, distancia_texto_cm: 0, repeticao: 'primeira',
};
const desenho: ImagemPaginaV2 = { ...img, ocorrencia_id: '46265ad9-5113-49e6-96e9-160633dcef71', arquivo_id: desenhoId,
  descricao: 'Ilustração com contorno transparente', relacao: 'atraves', repeticao: undefined, distancia_texto_cm: 0.15 };
const e = { superior: 0, inferior: 0 };
function amostra(): ComposicaoPaginaV2 {
  const titulo = texto('Secretaria da igreja'); titulo.alinhamento = 'direita';
  titulo.trechos.unshift(img);
  const pauta = texto([
    'O conselho examinou a ilustração que acompanha a proposta de organização do arquivo.',
    'A secretaria sugeriu reunir as atas por série e por ano, mantendo junto de cada uma a referência ao edital que lhe deu origem.',
    'Os documentos em papel continuarão identificados por livro e folha. Para os documentos digitais, a consulta mostrará a versão aprovada e a data de expedição.',
    'Os presentes pediram que a equipe experimente o procedimento com duas reuniões antes de aplicá-lo ao restante do acervo.',
    'A mesa acolheu a sugestão e passou à distribuição das tarefas.',
  ].join(' '));
  pauta.trechos.unshift(desenho);
  const abertura = texto('A mesa abriu a reunião com a leitura do edital de convocação');
  abertura.trechos.push({ tipo: 'referencia_nota', nota_id: nota }, { tipo: 'texto', texto: '.' });
  const itens = [
    'A secretaria apresentou o inventário dos livros existentes e indicou as séries com registros em aberto.',
    'Os editais ficam associados às respectivas atas, de modo que os assuntos convocados possam ser conferidos na reunião.',
    'As pessoas presentes serão registradas uma única vez, ainda que exerçam mais de uma função durante os trabalhos.',
    'A mesa conferirá os nomes dos responsáveis pela redação e pela assinatura antes de encaminhar a minuta.',
    'A equipe verificará a legibilidade dos anexos recebidos e solicitará nova cópia quando houver página incompleta.',
    'Cada folha terá indicação da série a que pertence e do livro em que o documento foi registrado.',
    'A secretaria preparará um índice dos assuntos tratados para facilitar as consultas posteriores ao arquivo.',
    'Os participantes poderão sugerir correções ao texto durante a leitura da minuta, antes da deliberação final.',
    'O responsável pelo livro verificará o espaço disponível para receber a ata e os registros previstos para o período.',
    'Os documentos já aprovados serão consultados na versão correspondente ao registro de assinatura.',
    'A comissão reunirá os exemplos de correspondência e classificará as respostas que ainda exigem providência.',
    'A mesa designará um responsável pelo levantamento de material necessário à conservação das folhas antigas.',
    'As referências aos documentos anteriores serão conferidas por ocasião do encerramento de cada expediente.',
    'O secretário levará à reunião seguinte um resumo das pendências, acompanhado das datas propostas para conclusão.',
    'A cópia de leitura ficará disponível aos responsáveis enquanto se realiza a conferência dos nomes e das datas.',
    'A secretaria registrará as observações sobre o procedimento experimental e apresentará os resultados ao conselho.',
    'Concluída a conferência, o documento seguirá para os signatários indicados pela mesa da reunião.',
    'Encerrados os trabalhos, a mesa solicitou a leitura desta ata e o seu encaminhamento para assinatura.',
  ];
  return composicaoPaginaV2Schema.parse({ versao_formato: 2,
    pagina: { papel: 'A4', orientacao: 'retrato', fonte: 'Noto Serif', tamanho_pt: 12,
      margens_cm: { superior: 2, inferior: 2, esquerda: 2, direita: 2 }, altura_minima_cm: { cabecalho: 2, rodape: 0.7 },
      espacamento_cm: { cabecalho: { ...e, inferior: 0.4 }, corpo: e, rodape: { ...e, superior: 0.2 } } },
    cabecalho: [titulo], rodape: [texto('Acervo da Secretaria')], notas: { [nota]: { texto: 'Edital lido na abertura da reunião.' } },
    corpo: [{ ...texto('Ata de reunião do Conselho'), estilo: 'titulo' }, abertura, pauta,
      ...itens.map((item, i) => texto((i + 1) + '. ' + item))],
  }) satisfies PaginaTextoV2;
}

// Sintéticos e reproduzíveis. As três faixas distinguem recorte de redimensionamento.
function criarArquivos() {
  const c = document.createElement('canvas'); c.width = c.height = 200;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ed980b'; g.fillRect(0, 0, 200, 50);
  g.fillStyle = '#38586e'; g.fillRect(0, 50, 200, 100);
  g.fillStyle = '#b23c55'; g.fillRect(0, 150, 200, 50);
  g.fillStyle = 'white'; g.font = 'bold 32px serif'; g.textAlign = 'center'; g.fillText('SEC',100,112);
  const logo = c.toDataURL();
  g.clearRect(0, 0, 200, 200); g.fillStyle = '#467c65';
  g.beginPath(); g.moveTo(0, 0); g.lineTo(200, 0); g.lineTo(28, 200); g.lineTo(0, 200); g.fill();
  return { logo, desenho: c.toDataURL() };
}

async function executar() {
  await mkdir(pasta, { recursive: true });
  const anterior: FonteRenderizacao = JSON.parse(await readFile(join(amostras, 'pagina-v1.json'), 'utf8'));
  assert.deepEqual(leituraComposicaoSchema.parse(anterior.conteudo.composicao), anterior.conteudo.composicao);
  await writeFile(join(pasta, 'legado.pdf'), await gerarPdf(anterior));
  execFileSync('pdftoppm', ['-scale-to', '800', '-singlefile', '-png', join(pasta, 'legado.pdf'), join(pasta, 'legado')]);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: {width: 850, height: 1200} });
    const font = await readFile(require.resolve('@fontsource/noto-serif/files/noto-serif-latin-400-normal.woff2'));
    await page.setContent('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Ata de demonstração · Editor da Secretaria</title><style>@font-face{font-family:"Noto Serif";src:url(data:font/woff2;base64,' + font.toString('base64') + ')}' +
      '@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;color:#20303b}article{width:21cm;height:29.7cm;background:white;display:flex;flex-direction:column;break-after:page;line-height:1.42}article:last-child{break-after:auto}article>*{flex:none}header,footer{position:relative;overflow:clip;isolation:isolate}header p{font-size:14pt}footer{font-size:10pt}main p{display:flow-root;margin:0 0 2mm}p{margin:0}h2{margin:0 0 3mm;font-size:17pt}aside{margin-top:auto;font-size:10pt}aside p{border-top:1px solid;padding-top:2mm}sup{font-size:.7em;line-height:0}</style>');
    await page.evaluate(() => document.fonts.load('12pt "Noto Serif"').then(() => true));
    const arte = await page.evaluate(criarArquivos);
    const arquivos = { [logoId]: arte.logo, [desenhoId]: arte.desenho };
    const comp = amostra();
    async function montar(documento: ComposicaoPaginaV2) {
      await page.evaluate(montarFolhas, { comp: composicaoPaginaV2Schema.parse(documento), arquivos });
    }
    await montar(comp);
    assert.equal(await page.locator('article').count(), 2);
    assert.equal(await page.locator('article:nth-child(2) header img').count(), 0);
    assert.equal(await page.locator('article:first-child aside p').innerText(), '1. ' + comp.notas[nota].texto);
    assert.equal(await page.locator('article:nth-child(2) aside p').count(), 0);
    const geometria = await page.evaluate(() => {
      const header = document.querySelector('header')!.getBoundingClientRect();
      const imagem = document.querySelector('header img')!.getBoundingClientRect();
      const p = document.querySelector('main img')!.parentElement!;
      const range = document.createRange(); range.selectNodeContents(p.lastChild!);
      const linhas = Array.from(range.getClientRects()).filter(r => r.top < p.getBoundingClientRect().top + 140);
      return { alturaBloco: header.height, alturaImagem: imagem.height, topoRecortado: header.top - imagem.top,
        linhas: linhas.map(l => l.left), ancora: p.getBoundingClientRect().y };
    });
    const cm = 96 / 2.54;
    assert(Math.abs(geometria.alturaBloco - 2 * cm) < 1);
    assert(Math.abs(geometria.alturaImagem - 4 * cm) < 1);
    assert(Math.abs(geometria.topoRecortado - cm) < 1);
    assert(geometria.linhas.length >= 3 && geometria.linhas[0] - geometria.linhas.at(-1)! > 40);
    for (const n of [1,2]) await page.locator('article').nth(n-1).screenshot({ path: join(pasta, 'navegador-' + n + '.png') });
    await writeFile(join(pasta, 'previa.html'), await page.content());
    await page.pdf({ path: join(pasta, 'ata.pdf'), preferCSSPageSize: true, printBackground: true });

    // Conferir as outras duas arestas, crescimento pela escrita e herança da âncora.
    for (const vertical of ['topo', 'base'] as const) {
      const alterada = structuredClone(comp);
      const logo = (alterada.cabecalho[0] as P).trechos[0];
      assert(logo.tipo === 'imagem'); logo.vertical = vertical;
      await montar(alterada);
      const distancia = await page.locator('header img').evaluate(el => {
        const h = el.closest('header')!.getBoundingClientRect(), i = el.getBoundingClientRect();
        return { topo: h.top - i.top, base: h.bottom - i.bottom };
      });
      assert(Math.abs(distancia[vertical]) < 1);
    }
    // Controle com a mesma imagem e o mesmo texto, agora circundando a caixa inteira.
    const retangular = structuredClone(comp);
    const triangulo = (retangular.corpo[2] as P).trechos[0];
    assert(triangulo.tipo === 'imagem'); triangulo.relacao = 'ao_redor';
    await montar(retangular);
    const bordas = await page.locator('main img').evaluate(el => {
      const p = el.parentElement!, range = document.createRange();
      range.selectNodeContents(p.lastChild!);
      return Array.from(range.getClientRects()).slice(0, 4).map(l => l.left);
    });
    assert(Math.max(...bordas) - Math.min(...bordas) < 1);
    const expandida = structuredClone(comp);
    expandida.cabecalho.push(...Array.from({length: 5}, () => texto('Texto adicional do cabeçalho')));
    await montar(expandida);
    assert((await page.locator('header').first().boundingBox())!.height > 2 * cm + 20);
    const repetida = structuredClone(comp);
    const marca = (repetida.cabecalho[0] as P).trechos[0];
    assert(marca.tipo === 'imagem'); marca.repeticao = 'todas';
    await montar(repetida);
    assert.equal(await page.locator('article:nth-child(2) header img').count(), 1);
    const movida = structuredClone(comp);
    movida.corpo.push(...movida.corpo.splice(2, 1));
    await montar(movida);
    assert.equal(await page.locator('article:last-child main img').count(), 1);
    await writeFile(join(pasta, 'composicao-v2.json'), JSON.stringify(comp, null, 2));
    execFileSync('python3', [join(__dirname, 'verificar-imagens.py'), pasta, amostras], { stdio: 'inherit' });
    console.log('Geometria no navegador (px a 96 dpi)', geometria);
  } finally { await browser.close(); }
}
executar().catch(e => { console.error(e); process.exitCode = 1; });
