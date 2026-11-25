import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Browser, chromium, Locator, Page } from 'playwright';

export const origemFrontend = 'http://localhost:3001';

export class NavegadorSecretaria {
  private constructor(private readonly browser: Browser) {}

  static async abrir() {
    return new NavegadorSecretaria(await chromium.launch());
  }

  fechar() {
    return this.browser.close();
  }

  private async visitar<T>(caminho: string, cookie: string | undefined, acao: (page: Page) => Promise<T>) {
    const contexto = await this.browser.newContext({ locale: 'pt-BR' });
    try {
      if (cookie) {
        const separador = cookie.indexOf('=');
        const name = cookie.slice(0, separador);
        const path = name === 'provisao_assembleia' ? '/minha-assembleia' : '/';
        await contexto.addCookies([
          { name, value: cookie.slice(separador + 1), domain: 'localhost', path, httpOnly: true, sameSite: 'Lax' },
        ]);
      }
      const page = await contexto.newPage();
      await page.goto(origemFrontend + caminho);
      return await acao(page);
    } finally {
      await contexto.close();
    }
  }

  assinar(token: string, cookie?: string) {
    return this.visitar('/assinaturas/convite#' + token, cookie, async (page) => {
      await page.getByRole('button', { name: 'Baixar matriz aprovada para leitura' }).click();
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Confirmar assinatura' }).click();
      await page.getByText(/Assinatura eletrônica registrada/).waitFor();
    });
  }

  conceder(reuniao: string, versao: string, cookie: string) {
    return this.visitar('/assembleia/' + reuniao + '/presidencia', cookie, async (page) => {
      await page.getByLabel('Minuta da assembleia').selectOption(versao);
      const resposta = page.waitForResponse(
        (r) => r.url().endsWith('/presidencia/conceder') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: /Conceder acesso e enviar convite|Reenviar convite/ }).click();
      const concessao = await resposta;
      expect(concessao.status()).toBe(201);
      return (await concessao.json()).id as string;
    });
  }

  ativarERedigir(token: string) {
    return this.visitar('/minha-assembleia#' + token, undefined, async (page) => {
      await page.getByRole('button', { name: 'Aceitar convite' }).click();
      await page.getByRole('button', { name: 'Presenças e arrolados', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Editar ata' }).click();
      const texto = 'Texto inicial registrado pelo secretário eleito.';
      await page.getByLabel('Texto da ata').fill(texto);
      await page.getByRole('button', { name: 'Prévia da ata' }).click();
      await page.getByText(texto, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Voltar à edição' }).click();
      await page.getByRole('button', { name: 'Salvar ata' }).click();
      await page.getByText('Registro salvo.').waitFor();
      const cookie = (await page.context().cookies()).find((c) => c.name === 'provisao_assembleia')!;
      return cookie.name + '=' + cookie.value;
    });
  }

  registrarDecisao(acesso: string, cookie: string) {
    return this.visitar('/minha-assembleia?acesso=' + acesso, cookie, async (page) => {
      await page.getByRole('button', { name: 'Aprovação e assinaturas' }).click();
      await page.getByLabel('Registro da leitura e da decisão').fill('Revisão lida e aprovada.');
      await page.getByRole('button', { name: 'Registrar decisão coletiva' }).click();
      await page.getByText(/Decisão registrada · APROVADA/).waitFor();
    });
  }

  prepararTermo(contexto: string, cookie: string) {
    return this.visitar('/secretaria?contexto=' + contexto + '&aba=livros', cookie, async (page) => {
      await page.getByRole('button', { name: 'Consultar livro' }).click();
      await page.getByRole('button', { name: 'Criar termo de abertura' }).click();
      await page
        .getByText(/Secretário responsável pelo livro/i)
        .first()
        .waitFor();
    });
  }

  conferirAcervo(contexto: string, cookie: string, ata: Buffer, hashDasPaginas: string, manifesto: Buffer, compilacao: Buffer) {
    return this.visitar('/secretaria?contexto=' + contexto + '&aba=livros', cookie, async (page) => {
      await page.getByRole('button', { name: 'Consultar livro' }).click();
      const livro = page.getByRole('region', { name: 'Detalhes do livro' });
      await livro.getByText(/^1 ata efetivada ·/).waitFor();
      const registro = livro.getByRole('article').filter({ hasText: 'Ata de reunião ordinária' });
      async function baixar(link: Locator) {
        const recebimento = page.waitForEvent('download');
        await link.click();
        const download = await recebimento;
        const caminho = await download.path();
        expect(caminho).toBeTruthy();
        return readFile(caminho!);
      }
      const paginas = await baixar(registro.getByRole('link', { name: 'Baixar páginas do registro' }));
      expect(createHash('sha256').update(paginas).digest('hex')).toBe(hashDasPaginas);
      expect(await baixar(livro.getByRole('link', { name: 'Baixar manifesto de fechamento' }))).toEqual(manifesto);
      const copia = await baixar(livro.getByRole('link', { name: 'Baixar compilação para leitura' }));
      const texto = (pdf: Buffer) => execFileSync('pdftotext', ['-layout', '-', '-'], { input: pdf, encoding: 'utf8' });
      expect(texto(copia)).toBe(texto(compilacao));
      await registro.getByRole('button', { name: 'Abrir documento' }).click();
      expect(await baixar(page.getByRole('link', { name: 'Baixar PDF expedido' }))).toEqual(ata);
    });
  }

  consultarJunta(contexto: string, cookie: string, funcao: 'presidente' | 'secretario') {
    return this.visitar('/secretaria?contexto=' + contexto + '&aba=reunioes', cookie, async (page) => {
      if (funcao === 'presidente') await page.getByRole('button', { name: 'Agendar reunião' }).waitFor();
      await page.getByRole('button', { name: 'Consultar', exact: true }).click();
      await page.getByText('Visitas aos membros').first().waitFor();
      if (funcao === 'secretario') {
        await page.getByRole('button', { name: 'Preparar ata' }).click();
        await page.waitForURL('**/editor/documentos/novo?**');
      }
    });
  }
}
