import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { logs_atividades_acao } from '@prisma/client';
import { AuditInterceptor } from './audit.interceptor';

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let logsService: { registrar: jest.Mock };

  beforeEach(() => {
    logsService = { registrar: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(logsService as never);
  });

  function makeContext(
    method: string,
    path: string,
    user?: { sub: string; igreja_id: string },
    params: Record<string, string> = {},
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method, path, url: path, ip: '127.0.0.1', user, params }),
      }),
    } as unknown as ExecutionContext;
  }

  function makeHandler(response: unknown): CallHandler {
    return { handle: () => of(response) };
  }

  it('não loga GET', (done) => {
    const ctx = makeContext('GET', '/acoes', { sub: 'u1', igreja_id: 'c1' });
    interceptor.intercept(ctx, makeHandler([])).subscribe(() => {
      expect(logsService.registrar).not.toHaveBeenCalled();
      done();
    });
  });

  it('não loga rotas /auth', (done) => {
    const ctx = makeContext('POST', '/auth/login', { sub: 'u1', igreja_id: 'c1' });
    interceptor.intercept(ctx, makeHandler({})).subscribe(() => {
      expect(logsService.registrar).not.toHaveBeenCalled();
      done();
    });
  });

  it('não loga sem req.user (não autenticado)', (done) => {
    const ctx = makeContext('POST', '/acoes', undefined);
    interceptor.intercept(ctx, makeHandler({ id: 'x' })).subscribe(() => {
      expect(logsService.registrar).not.toHaveBeenCalled();
      done();
    });
  });

  it('loga POST como CRIACAO com id da resposta', (done) => {
    const ctx = makeContext('POST', '/acoes', { sub: 'u1', igreja_id: 'c1' });
    interceptor.intercept(ctx, makeHandler({ id: 'new-id' })).subscribe(() => {
      expect(logsService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          acao: logs_atividades_acao.CRIACAO,
          tabela_afetada: 'acoes',
          registro_id: 'new-id',
          usuario_id: 'u1',
          igreja_id: 'c1',
        }),
      );
      done();
    });
  });

  it('loga PATCH como ATUALIZACAO com id dos params', (done) => {
    const ctx = makeContext('PATCH', '/acoes/abc-123', { sub: 'u1', igreja_id: 'c1' }, { id: 'abc-123' });
    interceptor.intercept(ctx, makeHandler({ id: 'abc-123', nome: 'updated' })).subscribe(() => {
      expect(logsService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          acao: logs_atividades_acao.ATUALIZACAO,
          registro_id: 'abc-123',
        }),
      );
      done();
    });
  });

  it('loga DELETE como EXCLUSAO com id dos params', (done) => {
    const ctx = makeContext('DELETE', '/lancamentos/def-456', { sub: 'u1', igreja_id: 'c1' }, { id: 'def-456' });
    interceptor.intercept(ctx, makeHandler({ message: 'deleted' })).subscribe(() => {
      expect(logsService.registrar).toHaveBeenCalledWith(
        expect.objectContaining({
          acao: logs_atividades_acao.EXCLUSAO,
          tabela_afetada: 'lancamentos',
          registro_id: 'def-456',
        }),
      );
      done();
    });
  });
});
