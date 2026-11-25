import { AutorizacaoModule } from './autorizacao/autorizacao.module';
import { SecretariaModule } from './secretaria/secretaria.module';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';
import { AuditInterceptor } from './logs/audit.interceptor';
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
import { AcoesModule } from './acoes/acoes.module';
import { LancamentosModule } from './lancamentos/lancamentos.module';
import { LogsModule } from './logs/logs.module';
import { IgrejaModule } from './igreja/igreja.module';
import { EventosMembresiaModule } from './eventos-membresia/eventos-membresia.module';
import { TratamentosModule } from './tratamentos/tratamentos.module';
import { ProfissoesModule } from './profissoes/profissoes.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { OficiaisModule } from './oficiais/oficiais.module';
import { OrgaosModule } from './orgaos/orgaos.module';
import { OutboxModule } from './outbox/outbox.module';
import { PrivateStorageModule } from './private-storage/private-storage.module';
import { RegrasRelacaoEnumModule } from './regras-relacao-enum/regras-relacao-enum.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    PrismaModule,
    OutboxModule,
    AuthModule,
    AutorizacaoModule,
    PrivateStorageModule,
    UsuariosModule,
    PessoasModule,
    GruposFamiliaresModule,
    CatDespesaModule,
    CatReceitaModule,
    ContasModule,
    ReceitasModule,
    DespesasModule,
    AcoesModule,
    LancamentosModule,
    LogsModule,
    IgrejaModule,
    EventosMembresiaModule,
    OficiaisModule,
    OrgaosModule,
    SecretariaModule,
    TratamentosModule,
    ProfissoesModule,
    RegrasRelacaoEnumModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
