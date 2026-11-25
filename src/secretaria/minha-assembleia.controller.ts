import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { RolesGuard } from '../auth/guards/roles/roles.guard';
import { AuthGuard } from '../auth/auth.guard';
import { assertCsrf, sessionCookie } from '../auth/csrf';
import { AcessoAssembleiaService } from './acesso-assembleia.service';
import { MinhaAssembleiaService } from './minha-assembleia.service';
import { tipoImagemDocumental } from './imagens-documentais';
import { OperacaoContextual, SecretariaGuard } from './secretaria.guard';
import type { AtorSecretaria } from './secretaria-base.service';

@Controller('secretaria/reunioes/:id/presidencia')
@UseGuards(AuthGuard, RolesGuard, SecretariaGuard)
export class PresidenciaAssembleiaController {
  constructor(private readonly servico: AcessoAssembleiaService) {}
  @OperacaoContextual()
  @Get()
  @Header('Cache-Control', 'private, no-store')
  opcoes(@Req() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string) {
    return this.servico.opcoes(req.user, id);
  }
  @OperacaoContextual()
  @Post('conceder')
  conceder(@Req() req: { user: AtorSecretaria }, @Param('id', ParseUUIDPipe) id: string, @Body() b: unknown) {
    return this.servico.conceder(req.user, id, b);
  }
  @OperacaoContextual()
  @Post(':acesso/revogar')
  revogar(
    @Req() req: { user: AtorSecretaria },
    @Param('id', ParseUUIDPipe) id: string,
    @Param('acesso', ParseUUIDPipe) acesso: string,
  ) {
    return this.servico.revogar(req.user, id, acesso);
  }
}

const cookie = 'provisao_assembleia';
const opcoes = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/minha-assembleia',
  secure: process.env.NODE_ENV === 'production',
};
@Controller('minha-assembleia')
export class MinhaAssembleiaController {
  constructor(
    private readonly acesso: AcessoAssembleiaService,
    private readonly servico: MinhaAssembleiaService,
    private readonly config: ConfigService,
  ) {}
  private credencial(req: Request) {
    if (req.method !== 'GET') assertCsrf(req, this.config.get('FRONTEND_URL') ?? 'http://localhost:3001');
    const encontrados = (req.headers.cookie ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(cookie + '='));
    return {
      escopo: req.query.acesso,
      normal: sessionCookie(req),
      temporaria: encontrados.length === 1 ? encontrados[0].slice(cookie.length + 1) : undefined,
    };
  }
  @Post('ativar')
  @Header('Cache-Control', 'no-store')
  async ativar(@Req() req: Request, @Body() b: unknown, @Res({ passthrough: true }) res: Response) {
    const r = await this.acesso.ativar(b, this.credencial(req).normal);
    res.cookie(cookie, r.token, { ...opcoes, expires: r.expira });
    return { id: r.id };
  }
  @Post('sair')
  async sair(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const c = this.credencial(req);
    if (await this.acesso.encerrar(c.temporaria, c.escopo)) res.clearCookie(cookie, opcoes);
    return { encerrado: true };
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  ficha(@Req() req: Request) {
    return this.servico.ficha(this.credencial(req));
  }
  @Get('pessoas')
  @Header('Cache-Control', 'private, no-store')
  pessoas(@Req() req: Request, @Query('busca') q: string) {
    return this.servico.buscar(this.credencial(req), q);
  }
  @Get('anexos/:id')
  async arquivo(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, nome } = await this.servico.arquivo(this.credencial(req), id);
    const imagem = req.query.visualizacao === 'imagem';
    res
      .set({
        'Content-Type': imagem ? tipoImagemDocumental(bytes).mime : 'application/octet-stream',
        'Content-Disposition': imagem ? 'inline' : "attachment; filename*=UTF-8''" + encodeURIComponent(nome),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(bytes);
  }
  @Post('presencas') presencas(@Req() req: Request, @Body() b: unknown) {
    return this.servico.presencas(this.credencial(req), b);
  }
  @Post('salvar') salvar(@Req() req: Request, @Body() b: unknown) {
    return this.servico.salvar(this.credencial(req), b);
  }
  @Post('leitura') leitura(@Req() req: Request, @Body() b: unknown) {
    return this.servico.prepararLeitura(this.credencial(req), b);
  }
  @Post('decidir') decidir(@Req() req: Request, @Body() b: unknown) {
    return this.servico.decidir(this.credencial(req), b);
  }
}
