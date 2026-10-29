import nodemailer, { type Transporter } from "nodemailer"
import { logoAttachments, type MailBrand, mailBrandName, type MailTemplate, renderEmail } from "./layout.js"

export {
  configureMailLinks,
  type EmailContent,
  type EmailFact,
  type EmailSection,
  escapeHtml,
  LOGO_CIDS,
  logoAttachments,
  type MailBrand,
  mailBrandName,
  type MailTemplate,
  renderEmail,
  resetMailLinks,
} from "./layout.js"

export interface MailerEnv {
  host: string
  port: number
  secure?: boolean
  user?: string
  pass?: string
  from: string
  /**
   * El remitente de cada otra marca (latidIA: `MEDICAL_SMTP_FROM`). Sin él, la
   * misma dirección de `from` con el nombre de la marca.
   */
  fromByBrand?: Partial<Record<MailBrand, string>>
}

export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Buzón que recibe las respuestas; sin él responden a `from`, que no lee nadie. */
  replyTo?: string
  /** La marca del correo: decide el remitente. Sin ella, odentIA. */
  brand?: MailBrand
}

/** «odentIA <no-reply@…>» con el nombre de otra marca: «latidIA <no-reply@…>». */
export function senderFor(from: string, brand: MailBrand): string {
  if (brand === "odentia") return from
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim()
  return `${mailBrandName(brand)} <${address}>`
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export function createMailer(env: MailerEnv): Mailer {
  const transporter: Transporter = nodemailer.createTransport({
    host: env.host,
    port: env.port,
    // Sin override, Nodemailer selecciona TLS implícito en 465 y STARTTLS en 587.
    secure: env.secure,
    // Mailpit (dev) no usa auth; solo se envía si hay user.
    auth: env.user ? { user: env.user, pass: env.pass ?? "" } : undefined,
  })
  return {
    async send({ to, subject, html, text, replyTo, brand = "odentia" }) {
      await transporter.sendMail({
        from: env.fromByBrand?.[brand] ?? senderFor(env.from, brand),
        to,
        subject,
        html,
        text,
        ...(replyTo ? { replyTo } : {}),
        attachments: logoAttachments(html),
      })
    },
  }
}

/* ---------- Cuenta y acceso ---------- */

const hello = (firstName?: string) => (firstName ? `Hola, ${firstName}. ` : "Hola. ")

/** La marca del correo de una cuenta: la del dominio por el que se pidió (issue 229). */
type Branded = { brand?: MailBrand | undefined }

export function verifyEmailTemplate({ url, brand }: { url: string } & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: "Verifica tu correo",
    preview: `Un clic y tu cuenta de ${name} queda activa.`,
    title: "Verifica tu correo",
    paragraphs: [`Gracias por registrarte en ${name}. Confirma tu correo para activar tu cuenta.`],
    action: { label: "Verificar mi correo", url },
    note: "Si no creaste esta cuenta, ignora este correo.",
    reason: `Te escribimos porque se creó una cuenta de ${name} con este correo.`,
  })
}

export function changeEmailVerificationTemplate({ url, brand }: { url: string } & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: "Confirma tu nuevo correo",
    preview: "Confirma esta dirección para terminar el cambio.",
    title: "Confirma tu nuevo correo",
    paragraphs: [`Pediste usar esta dirección en tu cuenta de ${name}. Confírmala para terminar el cambio.`],
    action: { label: "Confirmar correo", url },
    note: "Si no fuiste tú, ignora este correo: tu cuenta no cambia.",
    reason: `Te escribimos porque alguien pidió usar este correo en una cuenta de ${name}.`,
  })
}

export function changeEmailConfirmationTemplate({
  newEmail,
  url,
  brand,
}: { newEmail: string; url: string } & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: "Autoriza el cambio de correo",
    preview: `Tu cuenta pasaría a usar ${newEmail}.`,
    title: "Autoriza el cambio de correo",
    paragraphs: [`Recibimos una solicitud para cambiar el correo de tu cuenta de ${name}.`],
    facts: [{ label: "Correo nuevo", value: newEmail }],
    action: { label: "Autorizar cambio", url },
    note: "Si no fuiste tú, ignora este correo y tu cuenta seguirá protegida.",
    reason: `Te escribimos porque se pidió cambiar el correo de tu cuenta de ${name}.`,
  })
}

/**
 * Enlace para entrar sin la contraseña («¿Olvidaste tu contraseña?»): deja a la
 * persona dentro de su clínica, donde elige una nueva. `expiresText` es la hora
 * a la que vence en la zona de quien lo pidió («9:20 (hora de Lima)»); sin ella
 * se dice el plazo.
 */
export function accessLinkTemplate({
  firstName,
  url,
  expiresText,
  brand,
}: {
  firstName?: string | undefined
  url: string
  expiresText?: string | undefined
} & Branded): MailTemplate {
  const expires = expiresText ? `vence a las ${expiresText}` : "vence en 30 minutos"
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: `Tu enlace para entrar a ${name}`,
    preview: `Sirve una sola vez y ${expires}.`,
    title: "Tu enlace para entrar",
    paragraphs: [`${hello(firstName)}Pediste entrar sin tu contraseña. Con este botón entras a tu clínica y eliges una nueva.`],
    action: { label: `Entrar a ${name}`, url },
    note: `Sirve una sola vez y ${expires}. Si no lo pediste, ignora este correo: tu contraseña sigue igual.`,
    reason: `Te escribimos porque alguien pidió entrar a tu cuenta de ${name} sin contraseña.`,
  })
}

/**
 * Aviso de que la contraseña cambió, con cuándo («9:12», en la zona de quien la
 * cambió) y desde dónde, y cómo recuperarla si no fue la persona.
 */
export function passwordChangedTemplate({
  firstName,
  whenText,
  deviceText,
  url,
  brand,
}: {
  firstName?: string | undefined
  whenText: string
  deviceText?: string | undefined
  url: string
} & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: `Tu contraseña de ${name} cambió`,
    preview: `Se cambió hoy a las ${whenText}. Si no fuiste tú, recupérala ahora.`,
    title: "Tu contraseña cambió",
    paragraphs: [`${hello(firstName)}Se cambió la contraseña de tu cuenta de ${name} y cerramos tu sesión en los demás equipos.`],
    facts: [
      { label: "Cuándo", value: `Hoy, ${whenText}` },
      ...(deviceText ? [{ label: "Desde", value: deviceText }] : []),
    ],
    action: { label: "No fui yo: recuperar mi cuenta", url },
    note: "Si fuiste tú, no tienes que hacer nada.",
    reason: `Te escribimos porque cambió la contraseña de tu cuenta de ${name}.`,
  })
}

/**
 * Aviso de una versión nueva de los Términos del servicio y el Aviso de
 * privacidad, un mes antes de que rija: qué cambió en pocas líneas y que se
 * aceptan al entrar. Con `replyTo`, quien no está de acuerdo puede responder.
 */
export function legalUpdateTemplate({
  firstName,
  effectiveText,
  changes,
  url,
  replyTo,
  brand,
}: {
  firstName?: string | undefined
  effectiveText: string
  changes: readonly string[]
  url: string
  replyTo?: string | undefined
} & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: `Actualizamos los términos de ${name}`,
    preview: `Rigen desde el ${effectiveText}. Te contamos qué cambió.`,
    title: "Actualizamos los términos",
    paragraphs: [
      `${hello(firstName)}Los Términos del servicio y el Aviso de privacidad cambian y rigen desde el ${effectiveText}. Lo que cambió:`,
    ],
    list: changes,
    action: { label: "Leer los cambios", url },
    note: `La próxima vez que entres te pediremos aceptarlos. Si no estás de acuerdo, ${replyTo ? "responde este correo" : "escríbenos desde Ayuda"} antes de esa fecha.`,
    reason: `Te escribimos porque tienes una cuenta en ${name} y aceptaste la versión anterior.`,
    ...(replyTo ? { replyTo, replies: `Si respondes, tu mensaje llega al equipo de ${name}.` } : {}),
  })
}

export function invitationTemplate({
  organizationName,
  inviterName,
  url,
  brand,
}: {
  organizationName: string
  inviterName: string
  url: string
} & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: `Te invitaron a ${organizationName}`,
    preview: `${inviterName} te invitó a unirte al equipo en ${name}.`,
    title: `Te invitaron a ${organizationName}`,
    paragraphs: [`Hola. ${inviterName} te invitó a unirte al equipo de ${organizationName} en ${name}.`],
    action: { label: "Aceptar invitación", url },
    note: "Entras con tu correo y eliges tu contraseña. Si no conoces a esta clínica, ignora este correo.",
    reason: `Te escribimos porque ${inviterName} te invitó desde ${name}.`,
  })
}

/**
 * La clínica pide verificación en dos pasos a todo su equipo (ADR 0106): a
 * quien aún no la tiene, con la app que necesita, antes de que se la pidan en
 * plena atención.
 */
export function teamTwoFactorRequiredTemplate({
  firstName,
  organizationName,
  url,
  brand,
}: {
  firstName?: string | undefined
  organizationName: string
  url: string
} & Branded): MailTemplate {
  const name = mailBrandName(brand)
  return renderEmail({
    brand,
    subject: `${organizationName} pide verificación en dos pasos`,
    preview: "Actívala una vez desde tu teléfono; tarda un par de minutos.",
    title: "Activa tu verificación en dos pasos",
    paragraphs: [
      `${hello(firstName)}${organizationName} pide a todo su equipo entrar con su contraseña y un código de 6 dígitos de una app de su teléfono. Si alguien consigue tu contraseña, sin tu teléfono no entra.`,
      "Instala una de estas apps (gratis, en Android y iPhone, y guardan copia en tu cuenta por si cambias de teléfono):",
    ],
    list: ["Google Authenticator", "Microsoft Authenticator"],
    action: { label: "Activarla ahora", url },
    note: `Si ya usas otra app de códigos, también sirve. Hasta que la actives, ${organizationName} te la pedirá al entrar.`,
    reason: `Te escribimos porque eres parte del equipo de ${organizationName} en ${name}.`,
  })
}

/** Invitación al personal de odentIA (Administración y Soporte). */
export function staffInvitationTemplate({ url }: { url: string }): MailTemplate {
  return renderEmail({
    subject: "Te invitaron al equipo de odentIA",
    preview: "Acepta con tu cuenta verificada. La invitación vence en 7 días.",
    title: "Te invitaron al equipo de odentIA",
    paragraphs: ["Hola. Te invitaron al personal de odentIA. Acepta con tu cuenta verificada."],
    action: { label: "Aceptar invitación", url },
    note: "La invitación vence en 7 días. Si no la esperabas, ignora este correo.",
    reason: "Te escribimos porque alguien del equipo de odentIA te invitó.",
  })
}

/**
 * Recordatorios de una cuenta sin terminar: sin verificar a los 3 días (se
 * borra a los 30) o verificada y sin clínica. Informativos, no publicidad.
 */
export function accountReminderTemplate(
  input: ({ kind: "sin_verificar"; url: string; days: number } | { kind: "sin_clinica"; url: string }) & Branded,
): MailTemplate {
  const brand = input.brand
  const name = mailBrandName(brand)
  if (input.kind === "sin_verificar") {
    return renderEmail({
    brand,
      subject: `Completa tu cuenta de ${name}`,
      preview: "Verifícala o, si no la necesitas, se eliminará a los 30 días.",
      title: "Completa tu cuenta",
      paragraphs: [
        `Hola. Creaste una cuenta en ${name}, pero aún no la verificaste ni pertenece a ninguna clínica.`,
        `Si quieres usarla, verifica tu correo con este botón. Sirve durante ${input.days} días; después, entra con tu correo y pide otro enlace.`,
      ],
      action: { label: "Verificar mi correo", url: input.url },
      note: "Si no la necesitas, no hagas nada: la cuenta se eliminará automáticamente a los 30 días.",
      reason: `Te escribimos porque se creó una cuenta de ${name} con este correo. Es un aviso informativo, no publicidad.`,
    })
  }
  return renderEmail({
    brand,
    subject: `Tu cuenta de ${name} está verificada: crea o acepta tu clínica`,
    preview: "Crea tu clínica o acepta la invitación que te enviaron.",
    title: "Crea o acepta tu clínica",
    paragraphs: ["Hola. Tu cuenta ya está verificada, pero aún no pertenece a ninguna clínica."],
    action: { label: "Crear mi clínica", url: input.url },
    note: "Si te invitaron a una clínica, acepta la invitación desde el correo que te enviaron.",
    reason: `Te escribimos porque tu cuenta de ${name} aún no tiene clínica. Es un aviso informativo, no publicidad.`,
  })
}

/* ---------- Avisos de soporte: solo avisan, nunca llevan el texto del caso ---------- */

const SUPPORT_KIND_LABEL = { pregunta: "Pregunta", problema: "Problema", acceso: "Acceso", cobro: "Revisión de cobro" } as const
export type SupportCaseKindLabel = keyof typeof SUPPORT_KIND_LABEL

/**
 * Al buzón de soporte: se abrió un caso o la clínica respondió. Tipo, clínica,
 * pantalla, quién y el enlace a Soporte; el texto de la clínica se queda en la
 * plataforma.
 */
export function supportInboxNoticeTemplate({
  kind,
  clinic,
  caseKind,
  screen,
  who,
  role,
  url,
}: {
  kind: "caso_nuevo" | "clinica_respondio"
  /** Nula en los casos de acceso, que no son de una clínica. */
  clinic: string | null
  caseKind: SupportCaseKindLabel
  screen: string
  who: string
  role: string
  url: string
}): MailTemplate {
  const clinicName = clinic ?? "Sin clínica"
  const label = SUPPORT_KIND_LABEL[caseKind]
  const by = role ? `${who} (${role.toLowerCase()})` : who
  const line =
    kind === "caso_nuevo" ? `${label} desde ${screen}, por ${by}.` : `${by} respondió en su caso: ${label} desde ${screen}.`
  return renderEmail({
    subject: kind === "caso_nuevo" ? `Caso nuevo · ${clinicName} · ${label}` : `La clínica respondió · ${clinicName}`,
    preview: line,
    internal: "Soporte",
    title: kind === "caso_nuevo" ? `Caso nuevo: ${label.toLowerCase()}` : "La clínica respondió",
    paragraphs: [kind === "caso_nuevo" ? `Se abrió un caso desde ${screen}.` : `${by} respondió en su caso.`],
    facts: [
      { label: "Clínica", value: clinicName },
      { label: "Quién", value: by },
      { label: "Pantalla", value: screen },
      { label: "Tipo", value: label },
    ],
    action: { label: "Abrir en Soporte", url },
    reason: "Aviso interno del equipo de odentIA. Lo que escribió la clínica no viaja por correo: se lee en Soporte.",
  })
}

/**
 * A quien preguntó, si no vio la respuesta de soporte. Tampoco lleva el texto
 * de la respuesta: el botón abre Ayuda en «Tus casos con soporte».
 */
export function supportReplyNoticeTemplate({
  kind,
  caseKind,
  topic,
  url,
  brand,
}: {
  kind: "respuesta" | "necesita_algo"
  caseKind: SupportCaseKindLabel
  /** El nombre corto de la pantalla del caso: «Automatizaciones». */
  topic: string
  url: string
} & Branded): MailTemplate {
  const name = mailBrandName(brand)
  const about = `«${SUPPORT_KIND_LABEL[caseKind]} · ${topic}»`
  const subject =
    kind === "necesita_algo" ? `Soporte de ${name} necesita algo de ti` : `Soporte de ${name} respondió tu caso`
  const first =
    kind === "necesita_algo"
      ? `Soporte necesita un dato o un permiso tuyo sobre ${about}.`
      : `Tienes una respuesta sobre ${about}.`
  return renderEmail({
    brand,
    subject,
    preview: first,
    title: kind === "necesita_algo" ? "Soporte necesita algo de ti" : "Soporte respondió tu caso",
    paragraphs: [`Hola. ${first} Responde desde ${name}: ahí está todo el caso.`],
    action: { label: kind === "necesita_algo" ? `Responder en ${name}` : "Ver la respuesta", url },
    reason: `Te escribimos porque abriste un caso con soporte de ${name} y aún no viste la respuesta.`,
  })
}
