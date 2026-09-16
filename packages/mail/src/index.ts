import nodemailer, { type Transporter } from "nodemailer"

export interface MailerEnv {
  host: string
  port: number
  secure?: boolean
  user?: string
  pass?: string
  from: string
}

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export function createMailer(env: MailerEnv): Mailer {
  const transporter: Transporter = nodemailer.createTransport({
    host: env.host,
    port: env.port,
    secure: env.secure ?? false,
    // Mailpit (dev) no usa auth; solo se envía si hay user.
    auth: env.user ? { user: env.user, pass: env.pass ?? "" } : undefined,
  })
  return {
    async send({ to, subject, html, text }) {
      await transporter.sendMail({ from: env.from, to, subject, html, text })
    },
  }
}

export interface MailTemplate {
  subject: string
  html: string
  text: string
}

function layout(title: string, bodyHtml: string, ctaUrl: string, ctaLabel: string): string {
  return `<!doctype html>
<html lang="es-PE">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;color:#18181b">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <h1 style="margin:0 0 16px;font-size:20px">${title}</h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6">${bodyHtml}</p>
      <a href="${ctaUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px">${ctaLabel}</a>
      <p style="margin:24px 0 0;font-size:12px;color:#71717a">Si el botón no funciona, copia este enlace:<br>${ctaUrl}</p>
    </div>
  </body>
</html>`
}

export function verifyEmailTemplate({ url }: { url: string }): MailTemplate {
  return {
    subject: "Verifica tu correo — odentIA",
    html: layout(
      "Verifica tu correo",
      "Gracias por registrarte en odentIA. Confirma tu dirección de correo para activar tu cuenta.",
      url,
      "Verificar correo",
    ),
    text: `Verifica tu correo en odentIA: ${url}`,
  }
}

export function changeEmailVerificationTemplate({ url }: { url: string }): MailTemplate {
  return {
    subject: "Confirma tu nuevo correo — odentIA",
    html: layout(
      "Confirma tu nuevo correo",
      "Recibimos una solicitud para cambiar el correo de tu cuenta. Confirma esta nueva dirección para completar el cambio. Si no fuiste tú, ignora este mensaje.",
      url,
      "Confirmar correo",
    ),
    text: `Confirma tu nuevo correo en odentIA: ${url}`,
  }
}

export function changeEmailConfirmationTemplate({
  newEmail,
  url,
}: {
  newEmail: string
  url: string
}): MailTemplate {
  return {
    subject: "Solicitud de cambio de correo — odentIA",
    html: layout(
      "Solicitud de cambio de correo",
      `Recibimos una solicitud para cambiar el correo de tu cuenta a <strong>${newEmail}</strong>. Autoriza el cambio para continuar. Si no fuiste tú, ignora este mensaje y tu cuenta seguirá protegida.`,
      url,
      "Autorizar cambio",
    ),
    text: `Autoriza el cambio de correo a ${newEmail} en odentIA: ${url}`,
  }
}

export function resetPasswordTemplate({ url }: { url: string }): MailTemplate {
  return {
    subject: "Restablece tu contraseña — odentIA",
    html: layout(
      "Restablece tu contraseña",
      "Recibimos una solicitud para restablecer tu contraseña. Si no fuiste tú, ignora este mensaje.",
      url,
      "Restablecer contraseña",
    ),
    text: `Restablece tu contraseña en odentIA: ${url}`,
  }
}

export function invitationTemplate({
  organizationName,
  inviterName,
  url,
}: {
  organizationName: string
  inviterName: string
  url: string
}): MailTemplate {
  return {
    subject: `Invitación a ${organizationName} — odentIA`,
    html: layout(
      `Te invitaron a ${organizationName}`,
      `${inviterName} te invitó a unirte a <strong>${organizationName}</strong> en odentIA.`,
      url,
      "Aceptar invitación",
    ),
    text: `${inviterName} te invitó a ${organizationName} en odentIA. Acepta aquí: ${url}`,
  }
}
