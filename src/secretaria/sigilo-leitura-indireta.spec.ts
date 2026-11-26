import { NotFoundException } from '@nestjs/common';
import { verificarSigiloDosAnexos, verificarSigiloDosAnexosDaPessoa } from './sigilo-anexos';
import { permissoesAtas, permissoesAtasDaConta } from './sigilo-ata';
import { LivrosService } from './livros.service';
import { AssinaturasService } from './assinaturas.service';
import type { SecretariaBaseService, Tx } from './secretaria-base.service';
import type { PrivateStorageService } from '../private-storage/private-storage.service';
import type { ComposicaoService } from '../orgaos/composicao.service';
import type { ExpedicaoArquivos } from './expedicao-arquivos';
import type { OutboxService } from '../outbox/outbox.service';
import type { SessionService } from '../auth/session.service';

jest.mock('./sigilo-ata');
jest.mock('../feature-flags/feature-flags', () => ({ featureEnabled: () => true }));

const permissao = { ler: true, classificar: false };
const ator = { sub: 'usuario', igreja_id: 'igreja', perfil: 'ADMINISTRADOR' } as const;
const transacao = (tx: object) => ({ $transaction: (callback: (tx: object) => unknown) => callback(tx) });

describe('sigilo de atas nos caminhos indiretos', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(permissoesAtas).mockResolvedValue(new Map());
    jest.mocked(permissoesAtasDaConta).mockResolvedValue(new Map());
  });

  it('confere todos os contextos de um arquivo compartilhado pelo proprietário ou por convite', async () => {
    const tx = { anexo_documento: { findMany: jest.fn().mockResolvedValue([
      { contexto_id: 'junta' }, { contexto_id: 'conselho' },
    ]) } } as unknown as Tx;
    jest.mocked(permissoesAtasDaConta).mockResolvedValue(new Map([['junta', permissao]]));
    await expect(verificarSigiloDosAnexos(tx, 'igreja', 'usuario', ['arquivo'])).rejects.toBeInstanceOf(NotFoundException);
    jest.mocked(permissoesAtas).mockResolvedValue(new Map([['junta', permissao], ['conselho', permissao]]));
    await expect(verificarSigiloDosAnexosDaPessoa(tx, 'igreja', 'pessoa', ['arquivo'])).resolves.toBeUndefined();
    expect(tx.anexo_documento.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ igreja_id: 'igreja', arquivo_id: { in: ['arquivo'] }, versao: { documento: { tipo: 'ATA', restrito: true } } }),
    }));
  });

  it.each(['historico', 'manifesto', 'compilacao'] as const)('protege o arquivo %s de livro que passou a conter uma ata restrita', async (tipo) => {
    const tx = {
      livro_atas: { findFirst: jest.fn().mockResolvedValue({ id: 'livro', contexto_id: 'junta', restrito: false }), findUniqueOrThrow: jest.fn() },
      documento_versao: { findFirst: jest.fn().mockResolvedValue({ id: 'ata-restrita' }) },
    };
    const base = { prisma: transacao(tx), operador: jest.fn(), contexto: jest.fn() } as unknown as SecretariaBaseService;
    const livros = new LivrosService(base, {} as PrivateStorageService, {} as ComposicaoService);
    await expect(livros.baixar(ator, 'livro', tipo)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.documento_versao.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        igreja_id: 'igreja', contexto_id: 'junta', documento: { tipo: 'ATA', restrito: true },
        ...(tipo === 'historico' ? { livro_id: 'livro' } : { registro_livro: { livro_id: 'livro', estado: 'EFETIVADO' } }),
      }),
    }));
    expect(tx.livro_atas.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('uma imagem compartilhada com ata restrita impede baixar a compilação que a incorporou', async () => {
    const tx = {
      livro_atas: {
        findFirst: jest.fn().mockResolvedValue({ id: 'livro', contexto_id: 'junta', restrito: false }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ registros: [{ versao_id: 'versao-publica' }] }),
      },
      documento_versao: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'imagem-confidencial' }]),
      anexo_documento: { findMany: jest.fn().mockResolvedValue([{ contexto_id: 'conselho' }]) },
    };
    const base = { prisma: transacao(tx), operador: jest.fn(), contexto: jest.fn() } as unknown as SecretariaBaseService;
    const livros = new LivrosService(base, {} as PrivateStorageService, {} as ComposicaoService);
    await expect(livros.baixar(ator, 'livro', 'compilacao')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.anexo_documento.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ arquivo_id: { in: ['imagem-confidencial'] }, arquivo: { imagens_modelo: { none: {} } } }),
    }));
  });

  it('o convite emitido antes do fim do mandato não revela o assunto da ata', async () => {
    const tx = { convite_assinatura: { findUnique: jest.fn().mockResolvedValue({
      arrolado: { assina: true, pessoa_id: 'signatario' }, consumido_em: new Date(), expira_em: new Date(Date.now() + 60000),
      expedicao: { igreja_id: 'igreja', contexto_id: 'junta', modalidade: 'ELETRONICA', matriz: {}, aceite_sha256: 'hash',
        versao: { documento: { tipo: 'ATA', restrito: true }, anexos: [] } },
    }) } };
    const servico = new AssinaturasService({ prisma: transacao(tx) } as unknown as SecretariaBaseService,
      {} as ExpedicaoArquivos, {} as OutboxService, {} as SessionService);
    await expect(servico.consultarConvite({ token: 'a'.repeat(64) })).rejects.toBeInstanceOf(NotFoundException);
    expect(permissoesAtas).toHaveBeenCalledWith(tx, 'igreja', 'signatario');
  });
});
