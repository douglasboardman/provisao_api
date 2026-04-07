import { Controller, Get, UseGuards, Request, Query } from '@nestjs/common';
import { LogsService } from './logs.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { RolesGuard } from 'src/auth/guards/roles/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { usuarios_perfil as Perfil } from '@prisma/client';

@UseGuards(AuthGuard, RolesGuard)
@Roles(Perfil.ADMINISTRADOR, Perfil.AUDITOR)
@Controller('logs')
export class LogsController {
    constructor(private readonly logsService: LogsService) { }

    @Get()
    findAll(@Request() req, @Query('page') page?: string) {
        return this.logsService.findAll(req.user.igreja_id, page ? (parseInt(page) || 1) : 1);
    }
}