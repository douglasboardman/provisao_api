import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Serviço centralizado para envio de e-mails transacionais do sistema ProVisão.
 * Utiliza nodemailer com transporte SMTP configurado via variáveis de ambiente.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    const port = this.configService.get<number>('SMTP_PORT');
    this.from = this.configService.get<string>('SMTP_FROM') ?? '';
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  /**
   * Envia o e-mail de boas-vindas com o link para o usuário definir sua senha
   * pela primeira vez, após a aprovação pelo administrador.
   * @param nomeUsuario Nome de usuário do destinatário.
   * @param emailLogin E-mail de destino.
   * @param setupUrl URL completa com o token para definição de senha.
   */
  async sendPasswordSetup(nomeUsuario: string, emailLogin: string, setupUrl: string): Promise<void> {
    const from = this.from;
    try {
      await this.transporter.sendMail({
        from,
        to: emailLogin,
        subject: 'Bem-vindo ao ProVisão — Defina sua senha de acesso',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Bem-vindo ao ProVisão, ${nomeUsuario}!</h2>
            <p>
              Seu cadastro foi aprovado pelo administrador da sua igreja.
              Clique no botão abaixo para definir sua senha e ter acesso ao sistema:
            </p>
            <p style="text-align: center; margin: 32px 0;">
              <a href="${setupUrl}"
                 style="background-color: #4f46e5; color: white; padding: 12px 24px;
                        text-decoration: none; border-radius: 6px; font-weight: bold;">
                Definir minha senha
              </a>
            </p>
            <p style="color: #6b7280; font-size: 14px;">
              Este link é válido por <strong>48 horas</strong>.
              Se não solicitou o cadastro, ignore este e-mail.
            </p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
            <p style="color: #9ca3af; font-size: 12px;">ProVisão — Sistema de Gestão para Igrejas</p>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Falha ao enviar e-mail de configuração de senha para ${emailLogin}`, error);
      throw error;
    }
  }

  /**
   * Envia o e-mail de redefinição de senha para o usuário que solicitou
   * a recuperação via "Esqueci minha senha".
   * @param nomeUsuario Nome de usuário do destinatário.
   * @param emailLogin E-mail de destino.
   * @param resetUrl URL completa com o token para redefinição de senha.
   */
  async sendPasswordReset(nomeUsuario: string, emailLogin: string, resetUrl: string): Promise<void> {
    const from = this.from;
    try {
      await this.transporter.sendMail({
        from,
        to: emailLogin,
        subject: 'ProVisão — Solicitação de redefinição de senha',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Redefinição de senha — ProVisão</h2>
            <p>Olá, <strong>${nomeUsuario}</strong>!</p>
            <p>
              Recebemos uma solicitação para redefinir a senha da sua conta.
              Clique no botão abaixo para criar uma nova senha:
            </p>
            <p style="text-align: center; margin: 32px 0;">
              <a href="${resetUrl}"
                 style="background-color: #dc2626; color: white; padding: 12px 24px;
                        text-decoration: none; border-radius: 6px; font-weight: bold;">
                Redefinir minha senha
              </a>
            </p>
            <p style="color: #6b7280; font-size: 14px;">
              Este link é válido por <strong>1 hora</strong>.
              Se não foi você, ignore este e-mail — sua senha permanece a mesma.
            </p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
            <p style="color: #9ca3af; font-size: 12px;">ProVisão — Sistema de Gestão para Igrejas</p>
          </div>
        `,
      });
    } catch (error) {
      this.logger.error(`Falha ao enviar e-mail de redefinição de senha para ${emailLogin}`, error);
      throw error;
    }
  }
}
