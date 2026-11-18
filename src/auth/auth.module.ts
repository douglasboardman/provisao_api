import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { MfaService } from 'src/mfa/mfa.service';
import { EmergencyRecoveryService } from 'src/mfa/emergency-recovery.service';
import { AccessRequestsModule } from 'src/access-requests/access-requests.module';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailModule } from 'src/email/email.module';
import { LogsModule } from 'src/logs/logs.module';

@Global()
@Module({
  imports: [
    AccessRequestsModule,
    JwtModule.registerAsync({
      global: true,
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1h' },
      }),
      inject: [ConfigService],
    }),
    EmailModule,
    LogsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionService, MfaService, EmergencyRecoveryService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
