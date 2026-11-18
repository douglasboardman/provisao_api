import { AdminKeyGuard } from './admin-key.guard';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

describe('AdminKeyGuard', () => {
  let guard: AdminKeyGuard;
  let configService: { get: jest.Mock };

  beforeEach(() => {
    configService = { get: jest.fn().mockReturnValue('secret-key') };
    guard = new AdminKeyGuard(configService as unknown as ConfigService);
  });

  function makeContext(key?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: key ? { 'x-admin-key': key } : {} }),
      }),
    } as unknown as ExecutionContext;
  }

  it('permite quando a chave está correta', () => {
    expect(guard.canActivate(makeContext('secret-key'))).toBe(true);
  });

  it('lança ForbiddenException quando a chave está errada', () => {
    expect(() => guard.canActivate(makeContext('wrong-key'))).toThrow(ForbiddenException);
  });

  it('lança ForbiddenException quando nenhuma chave é enviada', () => {
    expect(() => guard.canActivate(makeContext())).toThrow(ForbiddenException);
  });

  it('lança ForbiddenException quando ADMIN_KEY não está configurada (fail-closed)', () => {
    configService.get.mockReturnValue(undefined);
    expect(() => guard.canActivate(makeContext('any-key'))).toThrow(ForbiddenException);
  });
});
