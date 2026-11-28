import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));
describe('identificação por igreja', () => {
  const prisma = { $queryRaw: jest.fn(), usuarios: { findUnique: jest.fn(), findFirst: jest.fn() } };
  const jwt = { signAsync: jest.fn().mockResolvedValue('token') };
  const outbox = { enqueue: jest.fn() };
  const logs = { registrar: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(prisma as any, jwt as any, outbox as any, logs as any);
  beforeEach(() => { jest.clearAllMocks(); });
  it('consulta login pela chave composta da igreja e e-mail', async () => {
    prisma.$queryRaw.mockResolvedValue([{ id: 'u' }]);
    prisma.usuarios.findUnique.mockResolvedValue({ id: 'u', igreja_id: 'igreja-b', email_login: 'igual@example.invalid', nome_usuario: 'Teste', perfil: 'COMUM', ativo: true, senha_hash: 'hash' });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    await expect(service.signIn('igual@example.invalid', 'senha', 'igreja-b')).resolves.toEqual({ access_token: 'token' });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'igreja-b', 'igual@example.invalid');
    expect(prisma.usuarios.findUnique).toHaveBeenCalledWith({ where: { id: 'u' } });
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ igreja_id: 'igreja-b', sub: 'u' }));
  });
  it('não autentica conta ausente na igreja indicada', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.signIn('igual@example.invalid', 'senha', 'outra')).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('consulta recuperação apenas na igreja solicitada', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await service.forgotPassword('igual@example.invalid', 'igreja-a');
    expect(prisma.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'igreja-a', 'igual@example.invalid');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
