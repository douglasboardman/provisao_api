import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  const verify = jest.fn();
  const guard = new AuthGuard({ verify } as any, { get: () => 'https://app.example' } as any);
  const request: any = { method: 'GET', headers: { cookie: 'provisao_session=abc' } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }) };
  beforeEach(() => { jest.resetAllMocks(); request.method = 'GET'; request.headers = { cookie: 'provisao_session=abc' }; });
  it('carrega identidade atual da sessão', async () => {
    verify.mockResolvedValue({ id: 'u', igreja_id: 'i', perfil: 'OPERADOR', nome_usuario: 'Nome', email_login: 'u@example.invalid' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(expect.objectContaining({ sub: 'u', igreja_id: 'i', perfil: 'OPERADOR' }));
  });
  it('não aceita JWT legado no cabeçalho', async () => {
    request.headers = { authorization: 'Bearer antigo' };
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('nega escrita sem origem e cabeçalho esperados', async () => {
    request.method = 'POST';
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    request.headers.origin = 'https://app.example';
    request.headers['x-provisao-request'] = '1';
    verify.mockResolvedValue({ id: 'u', igreja_id: 'i', perfil: 'OPERADOR' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
