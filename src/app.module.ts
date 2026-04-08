import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { PessoasModule } from './pessoas/pessoas.module';
import { ConfigModule } from '@nestjs/config';
import { GruposFamiliaresModule } from './grupos-familiares/grupos-familiares.module';
import { CatDespesaModule } from './cat-despesa/cat-despesa.module';
import { CatReceitaModule } from './cat-receita/cat-receita.module';
import { ContasModule } from './contas/contas.module';
import { ReceitasModule } from './receitas/receitas.module';
import { DespesasModule } from './despesas/despesas.module';
import { VinculosMembresiaModule } from './vinculos-membresia/vinculos-membresia.module';
import { AcoesModule } from './acoes/acoes.module';
import { LancamentosModule } from './lancamentos/lancamentos.module';
import { LogsModule } from './logs/logs.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    PrismaModule,
    AuthModule,
    UsuariosModule,
    PessoasModule,
    GruposFamiliaresModule,
    CatDespesaModule,
    CatReceitaModule,
    ContasModule,
    ReceitasModule,
    DespesasModule,
    VinculosMembresiaModule,
    AcoesModule,
    LancamentosModule,
    LogsModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
