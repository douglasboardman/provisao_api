import { join } from 'node:path';

const marcaCid = 'marca.provisao@provisao';
const formatoDePrazo = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'long',
  timeStyle: 'short',
});

const modelos = {
  assembleia: {
    assunto: 'Seu acesso à ata da assembleia', titulo: 'Minha assembleia',
    previa: 'A presidência da sessão confirmou sua eleição como secretário.',
    corpo: 'A presidência concedeu acesso temporário para registrar as presenças, redigir a ata e registrar a decisão da assembleia.',
    acao: 'Abrir Minha assembleia', orientacao: 'Este convite é pessoal. Se já possui conta, entre com ela ao aceitar o convite.',
  },
  confirmacao: {
    assunto: 'Confirme seu e-mail para solicitar acesso',
    titulo: 'Confirme seu e-mail',
    previa: 'Sua confirmação permite que a igreja analise o pedido de acesso.',
    corpo: 'Recebemos seu pedido de acesso ao ProVisão. Confirme seu endereço de e-mail para que a administração da igreja possa analisar a solicitação.',
    acao: 'Revisar solicitação',
    orientacao: 'Se você não fez esse pedido, pode ignorar esta mensagem.',
  },
  ativacao: {
    assunto: 'Crie sua senha de acesso',
    titulo: 'Seu primeiro acesso',
    previa: 'A administração da sua igreja liberou seu acesso ao ProVisão.',
    corpo: 'A administração da sua igreja liberou seu acesso ao ProVisão. Crie uma senha para entrar no sistema com este endereço de e-mail.',
    acao: 'Criar minha senha',
    orientacao: 'Se você não esperava este convite, entre em contato com a administração da sua igreja antes de criar a senha.',
  },
  recuperacao: {
    assunto: 'Redefina sua senha',
    titulo: 'Redefinição de senha',
    previa: 'Use seu link pessoal para escolher uma nova senha.',
    corpo: 'Recebemos um pedido para redefinir a senha da sua conta. Abra o link abaixo para escolher uma nova senha.',
    acao: 'Redefinir minha senha',
    orientacao: 'Se você não pediu a redefinição, ignore esta mensagem. Sua senha continua válida.',
  },
  assinatura: {
    assunto: 'Você recebeu um convite para assinar um documento',
    titulo: 'Convite para assinatura',
    previa: 'Leia a versão aprovada do documento no portal de assinatura.',
    corpo: 'Você recebeu um convite da Secretaria para assinar um documento. No portal, baixe e leia a versão aprovada antes de decidir se deseja assinar.',
    acao: 'Abrir portal de assinatura',
    orientacao: 'Este convite é individual. Guarde o link para seu uso. A assinatura depende da sua confirmação no portal.',
  },
};

export type TipoEmail = keyof typeof modelos;

function escaparHtml(texto: string): string {
  return texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function montarEmail(tipo: TipoEmail, nome: string, url: string, expiraEm: Date) {
  const destino = new URL(url);
  if (!['https:', 'http:'].includes(destino.protocol)) throw new Error('Origem inválida para o link do e-mail.');

  const modelo = modelos[tipo];
  const saudacao = nome.trim() ? `Olá, ${nome.trim()}.` : 'Olá.';
  const prazo = formatoDePrazo.format(expiraEm);
  const orientacao = tipo === 'confirmacao' && destino.searchParams.has('cancel_token')
    ? 'Se você não fez esse pedido, pode ignorar a mensagem ou cancelar a solicitação na página de revisão.'
    : modelo.orientacao;
  const subject = `${modelo.assunto} | ProVisão`;
  const text = [
    'ProVisão · Gestão para igrejas', modelo.titulo, saudacao, modelo.corpo,
    `${modelo.acao}\n${url}`, `Link válido até ${prazo} (horário de Brasília).`, orientacao,
  ].join('\n\n');

  // O layout base e a ação continuam legíveis em clientes que removem o bloco de estilos.
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${modelo.titulo}</title>
<style>
  @media only screen and (max-width: 480px) {
    .margem { padding: 12px 8px !important; }
    .conteudo { padding-left: 20px !important; padding-right: 20px !important; }
    .titulo { font-size: 27px !important; line-height: 33px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f8f7fa;font-family:Arial,Helvetica,sans-serif;color:#261a32;">
<div aria-hidden="true" style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${modelo.previa}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f8f7fa">
<tr><td align="center" class="margem" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff"
  style="width:100%;max-width:560px;table-layout:fixed;border:1px solid #e5e0ed;border-radius:14px;border-spacing:0;">
<tr><td class="conteudo" bgcolor="#342440" style="padding:20px 32px;border-radius:13px 13px 0 0;border-bottom:3px solid #c5d44e;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td width="54" valign="middle"><img src="cid:${marcaCid}" width="42" height="42" alt="" style="display:block;border:0;border-radius:8px;"></td>
    <td valign="middle" style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
      <strong style="font-size:22px;line-height:25px;">ProVisão</strong><br>
      <span style="font-size:13px;line-height:18px;color:#e4daee;">Gestão para igrejas</span>
    </td>
  </tr></table>
</td></tr>
<tr><td class="conteudo" style="padding:30px 32px 24px;font-family:Arial,Helvetica,sans-serif;word-wrap:break-word;overflow-wrap:anywhere;">
  <h1 class="titulo" style="margin:0 0 22px;color:#291a35;font-size:30px;line-height:36px;letter-spacing:-0.5px;">${modelo.titulo}</h1>
  <p style="margin:0 0 8px;color:#352a40;font-size:16px;line-height:24px;">${escaparHtml(saudacao)}</p>
  <p style="margin:0 0 22px;color:#463d4e;font-size:16px;line-height:25px;">${modelo.corpo}</p>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td bgcolor="#6a489b" style="border-radius:8px;mso-padding-alt:13px 20px;">
      <a href="${escaparHtml(url)}" style="display:inline-block;padding:13px 20px;color:#ffffff;background-color:#6a489b;border-radius:8px;font-size:16px;font-weight:bold;line-height:20px;text-decoration:none;">${modelo.acao}</a>
    </td>
  </tr></table>
</td></tr>
<tr><td class="conteudo" style="padding:0 32px 28px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
    <td bgcolor="#f4f0f8" style="padding:12px 16px;border-left:3px solid #7959a6;color:#453750;font-size:14px;line-height:21px;">
      <strong>Link válido até</strong><br>${prazo} (horário de Brasília)
    </td>
  </tr></table>
</td></tr>
<tr><td class="conteudo" bgcolor="#fbfafd" style="padding:16px 32px;border-top:1px solid #e9e3ef;border-radius:0 0 13px 13px;color:#5d5364;font-size:14px;line-height:21px;">${orientacao}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;

  return {
    subject, text, html,
    attachments: [{
      filename: 'provisao.png', path: join(__dirname, 'assets', 'provisao.png'),
      cid: marcaCid, contentType: 'image/png', contentDisposition: 'inline' as const,
    }],
  };
}
