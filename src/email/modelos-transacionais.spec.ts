import { readFileSync } from 'node:fs';
import { montarEmail, type TipoEmail } from './modelos-transacionais';

const validade = new Date('2026-11-22T01:30:00Z');
const dados: [TipoEmail, string, string][] = [
  ['confirmacao', '/auth/confirm-access?token=exemplo&cancel_token=outro', 'Revisar solicitação'],
  ['ativacao', '/auth/set-password?token=exemplo', 'Criar minha senha'],
  ['recuperacao', '/auth/set-password?token=exemplo', 'Redefinir minha senha'],
  ['assinatura', '/assinaturas/convite#exemplo', 'Abrir portal de assinatura'],
];

describe('Modelos de e-mail transacional', () => {
  it.each(dados)('preserva ação, destino e prazo em HTML e texto para %s', (tipo, caminho, acao) => {
    const url = 'https://provisao.example.invalid' + caminho;
    const nome = 'Ana & João <Silva>';
    const email = montarEmail(tipo, nome, url, validade);
    expect(email.html).toContain(`href="${url.replace(/&/g, '&amp;')}"`);
    expect(email.text).toContain(url);
    expect(email.html).toContain('Ana &amp; João &lt;Silva&gt;');
    expect(email.text).toContain(nome);
    for (const corpo of [email.text, email.html]) {
      expect(corpo).toContain(acao);
      expect(corpo).toContain('21 de novembro de 2026');
      expect(corpo).toContain('22:30');
      expect(corpo).toContain('horário de Brasília');
    }
    const [logo] = email.attachments;
    expect(email.html).toContain(`src="cid:${logo.cid}"`);
    expect(readFileSync(logo.path).subarray(1, 4).toString()).toBe('PNG');
  });

  it('só oferece cancelamento se o link emitido permitir', () => {
    const base = 'https://provisao.example.invalid/auth/confirm-access?token=exemplo';
    for (const campo of ['text', 'html'] as const) {
      expect(montarEmail('confirmacao', 'Ana', base, validade)[campo]).not.toContain('cancelar');
      expect(montarEmail('confirmacao', 'Ana', base + '&cancel_token=outro', validade)[campo]).toContain('cancelar');
    }
  });
});
