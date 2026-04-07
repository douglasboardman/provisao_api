import { 
  CanActivate, 
  ExecutionContext, 
  Injectable, 
  UnauthorizedException 
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ){}

  /**
   * Método principal do Guard. Determina se a requisição pode prosseguir.
   * @param context O contexto da execução atual (contém a requisição).
   * @returns Um booleano indicando se a rota está liberada.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Extrai o objeto da requisição (request) do contexto.
    const request = context.switchToHttp().getRequest();

    // 2. Extrai o token do cabeçalho da requisição.
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException('Token não encontrado.');
    }

    try {
      // 3. Verifica se o token é válido usando o segredo do .env.
      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('JWT_SECRET')
      });

      // 4. Se o token for válido, anexa o payload (dados do usuário)
      // à requisição. Isso permite que os controllers acessem o usuário logado.
      request['user'] = payload;
    } catch {
      throw new UnauthorizedException('Token inválido.');
    }

    // 5. Se nenhuma das cláusulas de guarda foi acionada, permite que a requisição continue
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
