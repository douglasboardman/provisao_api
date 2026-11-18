import { htmlDocumento, FonteRenderizacao } from './renderizador';
import { conteudoSchema } from './secretaria.dto';

const fonte = (): FonteRenderizacao => ({ tipo: 'OUTRO', titulo: 'Ofício', numero: '1000/2026/CONS', data: '2026-11-17', igreja: { nome: 'Igreja São José', cidade: 'São Paulo' }, conteudo: { teor: 'Olá {{DESTINATARIO}}', campos: { DESTINATARIO: '<script>alert(1)</script>' }, anexos: [], arrolados: [], estrutura: { cabecalho: [], corpo: [{ tipo: 'TABELA', linhas: [['ação', 'oração']] }, { tipo: 'IMAGEM', arquivo_id: 'img', descricao: 'Imagem' }, { tipo: 'ASSINATURAS' }], rodape: [] } }, imagens: { img: 'http://127.0.0.1/private' }, signatarios: ['José'] });

describe('renderização de rascunho', () => {
  it('escapa texto e campos e não inclui imagens externas', () => {
    const html = htmlDocumento(fonte());
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('http://127.0.0.1');
    expect(html).toContain('1000/2026/CONS');
    expect(html).toContain('RASCUNHO');
  });
  it('formata campos tipados e distingue a matriz aprovada do rascunho', () => {
    const f = fonte();
    f.finalidade = 'MATRIZ_APROVADA';
    f.tiposCampos = { DATA: 'DATA', VALOR: 'NUMERO', ATIVO: 'SIM_NAO' };
    f.conteudo.campos = { DATA: '2026-11-17', VALOR: '-0.75', ATIVO: 'NAO' };
    f.conteudo.teor = '{{DATA}} · {{VALOR}} · {{ATIVO}}';
    const html = htmlDocumento(f);
    expect(html).toContain('17/11/2026 · -0,75 · Não');
    expect(html).toContain('Matriz aprovada');
    expect(html).not.toContain('RASCUNHO');
  });
  it('rejeita blocos desconhecidos e conteúdo inesperado', () => {
    expect(conteudoSchema.safeParse({ teor: '', campos: {}, anexos: [], arrolados: [], estrutura: { cabecalho: [], corpo: [{ tipo: 'HTML', html: '<script />' }], rodape: [] } }).success).toBe(false);
  });
});
