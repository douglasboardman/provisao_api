import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { montarEmail, type TipoEmail } from './modelos-transacionais';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    const port = Number(this.configService.get('SMTP_PORT'));
    this.from = this.configService.get<string>('SMTP_FROM') ?? '';
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port,
      secure: port === 465,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  sendAccessConfirmation(nome: string, email: string, url: string, expiraEm: Date) {
    return this.enviar('confirmacao', nome, email, url, expiraEm);
  }

  sendSignatureInvitation(nome: string, email: string, url: string, id: string, expiraEm: Date) {
    return this.enviar('assinatura', nome, email, url, expiraEm, `<assinatura-${id}@provisao>`);
  }

  sendPasswordSetup(nome: string, email: string, url: string, expiraEm: Date) {
    return this.enviar('ativacao', nome, email, url, expiraEm);
  }

  sendPasswordReset(nome: string, email: string, url: string, expiraEm: Date) {
    return this.enviar('recuperacao', nome, email, url, expiraEm);
  }

  private async enviar(tipo: TipoEmail, nome: string, email: string, url: string, expiraEm: Date, messageId?: string): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from, to: email, messageId, ...montarEmail(tipo, nome, url, expiraEm),
      });
    } catch (error) {
      this.logger.error(`Falha ao enviar e-mail de ${tipo}.`);
      throw error;
    }
  }
}
