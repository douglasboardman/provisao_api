import { Controller, Get, UseGuards, Request } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard, ALL_ROLES } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';

/**
 * Controller responsável pelos endpoints de agregação do Dashboard.
 * Leitura permitida a todos os perfis autenticados.
 */
@UseGuards(AuthGuard, RolesGuard)
@Roles(...ALL_ROLES)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * Retorna o resumo consolidado de KPIs para o dashboard.
   * Inclui: financeiro do mês, saldo consolidado, membresia e últimos lançamentos.
   * Rota: GET /dashboard/resumo
   */
  @Get('resumo')
  getResumo(@Request() req) {
    return this.dashboardService.getResumo(req.user.igreja_id);
  }
}
