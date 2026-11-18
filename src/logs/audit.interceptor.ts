import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { logs_atividades_acao } from '@prisma/client';
import { LogsService } from './logs.service';

const HTTP_TO_ACAO: Record<string, logs_atividades_acao> = {
  POST: logs_atividades_acao.CRIACAO,
  PATCH: logs_atividades_acao.ATUALIZACAO,
  PUT: logs_atividades_acao.ATUALIZACAO,
  DELETE: logs_atividades_acao.EXCLUSAO,
};

interface JwtUser {
  sub: string;
  igreja_id: string;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly logsService: LogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      path: string;
      url: string;
      ip: string;
      params: Record<string, string>;
      user?: JwtUser;
    }>();

    const acao = HTTP_TO_ACAO[req.method];
    if (!acao || !req.user || (req.path.startsWith('/auth') || req.path === '/secretaria' || req.path.startsWith('/secretaria/') || req.path === '/oficiais' || req.path.startsWith('/oficiais/') || (req.path.startsWith('/eventos-membresia/') && req.path.endsWith('/ordem-inicial')))) {
      return next.handle();
    }

    const user = req.user;

    return next.handle().pipe(
      tap((response: unknown) => {
        const tabelaAfetada = req.path.split('/').filter(Boolean)[0] ?? 'unknown';
        const registroId =
          req.method === 'POST'
            ? ((response as Record<string, unknown>)?.id as string | null) ?? null
            : req.params?.id ?? null;

        this.logsService
          .registrar({
            igreja_id: user.igreja_id,
            usuario_id: user.sub,
            acao,
            tabela_afetada: tabelaAfetada,
            registro_id: registroId,
            ip_address: req.ip,
            dados_novos: { endpoint: req.url },
          })
          .catch(() => {});
      }),
    );
  }
}
