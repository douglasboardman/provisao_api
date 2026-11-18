import { Prisma } from '@prisma/client';
import { hashAto, transacaoSerializavel } from './idempotencia';
import { PrismaService } from '../prisma/prisma.service';

describe('idempotência de atos de órgão', () => {
  it('normaliza a ordem das propriedades e diferencia conteúdo', () => {
    expect(hashAto({ b: 2, a: { y: 3, x: 1 } })).toBe(hashAto({ a: { x: 1, y: 3 }, b: 2 }));
    expect(hashAto({ a: 1 })).not.toBe(hashAto({ a: 2 }));
  });

  it('repete conflito de serialização sem repetir outros erros', async () => {
    const conflito = new Prisma.PrismaClientKnownRequestError('conflito', { code: 'P2034', clientVersion: 'teste' });
    const transacao = jest.fn().mockRejectedValueOnce(conflito).mockResolvedValueOnce('registrado');
    const prisma = { $transaction: transacao } as unknown as PrismaService;
    await expect(transacaoSerializavel(prisma, async () => 'registrado')).resolves.toBe('registrado');
    expect(transacao).toHaveBeenCalledTimes(2);
    const conflitoRaw = new Prisma.PrismaClientKnownRequestError('conflito SQL', { code: 'P2010', clientVersion: 'teste', meta: { code: '40001' } });
    transacao.mockReset().mockRejectedValueOnce(conflitoRaw).mockResolvedValueOnce('registrado');
    await expect(transacaoSerializavel(prisma, async () => 'registrado')).resolves.toBe('registrado');
    expect(transacao).toHaveBeenCalledTimes(2);
    transacao.mockReset().mockRejectedValue(new Error('erro de validação'));
    await expect(transacaoSerializavel(prisma, async () => 'registrado')).rejects.toThrow('erro de validação');
    expect(transacao).toHaveBeenCalledTimes(1);
  });
});
