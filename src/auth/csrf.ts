import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';

/** Requisições de escrita de navegador devem ser originadas na interface configurada. */
export function assertCsrf(request: Request, frontendUrl: string): void {
  if (request.headers.origin !== frontendUrl || request.headers['x-provisao-request'] !== '1') {
    throw new ForbiddenException('Origem da requisição não autorizada.');
  }
}

export function sessionCookie(request: Request): string | undefined {
  const parts = (request.headers.cookie ?? '').split(';').map(part => part.trim());
  const matches = parts.filter(part => part.startsWith('provisao_session='));
  if (matches.length !== 1) return undefined;
  return matches[0].slice('provisao_session='.length);
}
