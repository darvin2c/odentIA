// Vista previa de todos los correos que envía odentIA, con datos de ejemplo
// (issue 163). Sin argumentos los manda al SMTP de desarrollo (Mailpit):
//   pnpm --filter @odentia/services mail:preview
// Con `--html <carpeta>` los deja como archivos para abrirlos en el navegador,
// con el logotipo puesto en línea en vez de adjunto.
import { reportDigestEmail } from "./report-digest.js"
import { formatFigure } from "./report-figures.js"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  accessLinkTemplate,
  accountReminderTemplate,
  changeEmailConfirmationTemplate,
  changeEmailVerificationTemplate,
  configureMailLinks,
  createMailer,
  invitationTemplate,
  legalUpdateTemplate,
  logoAttachments,
  type MailTemplate,
  passwordChangedTemplate,
  staffInvitationTemplate,
  supportInboxNoticeTemplate,
  supportReplyNoticeTemplate,
  verifyEmailTemplate,
} from "@odentia/mail"
import { type ConsumerComplaintSheet, consumerComplaintEmails, consumerComplaintResponseEmails } from "./consumer-complaints.js"
import {
  founderInvitationEmail,
  saasAlertEmail,
  saasBillingUrl,
  saasChargeIssuedEmail,
  saasOverdueEmail,
  saasPlanStartedEmail,
  saasRestrictedEmail,
  saasRestrictionSoonEmail,
  saasSettlementEmail,
  saasTrialEndedEmail,
  waitlistReceivedEmail,
} from "./saas-emails.js"

const webUrl = process.env.WEB_URL ?? "https://app.odentia.localhost"
const adminUrl = process.env.ADMIN_URL ?? "https://admin.odentia.localhost"
configureMailLinks(webUrl)

const url = `${webUrl}/vista-previa?token=7f3a9c`
const billing = saasBillingUrl(webUrl, "org_ejemplo")
const clinic = "Clínica Sonrisa"

const sheet: ConsumerComplaintSheet = {
  id: "00000000-0000-0000-0000-000000000014",
  number: "2026-000014",
  year: 2026,
  submissionId: "00000000-0000-0000-0000-000000000015",
  kind: "reclamo",
  status: "respondido",
  consumerName: "Rosa Quispe Mamani",
  consumerAddress: "Av. Ejemplo 123, Lima",
  documentType: "dni",
  documentNumber: "40123458",
  phone: "+51 999 000 111",
  email: "rosa@ejemplo.test",
  isMinor: false,
  guardianName: null,
  itemType: "servicio",
  itemDescription: "Plan de odentIA de la clínica.",
  amountMinor: null,
  amountCurrency: null,
  detail: "Se cobró dos veces el mismo mes.\nAdjunto los dos cargos.",
  request: "Que se devuelva el cargo repetido.",
  providerResponse: "Hola, Rosa. Revisamos tu cuenta y devolvimos el cargo repetido.",
  respondedAt: new Date("2026-10-20T15:00:00Z"),
  respondedByUserId: null,
  responseEmailSent: false,
  privacyAcceptedAt: new Date("2026-10-18T21:05:00Z"),
  emailSent: true,
  createdAt: new Date("2026-10-18T21:05:00Z"),
  updatedAt: new Date("2026-10-20T15:00:00Z"),
}
const complaintOptions = { replyTo: "reclamos@odentia.localhost", reviewUrl: `${adminUrl}/complaints` }
const received = consumerComplaintEmails({ ...sheet, providerResponse: null, respondedAt: null }, complaintOptions)
const answered = consumerComplaintResponseEmails(sheet, complaintOptions)

/** Lo cobrado de la semana del ejemplo, en la clínica de ejemplo (Perú). */
const sampleCollected = formatFigure(1_160_000, "money", { currency: "PEN", locale: "es-PE" })

const MAILS: Record<string, MailTemplate> = {
  "01-verifica-tu-correo": verifyEmailTemplate({ url }),
  "02-confirma-tu-nuevo-correo": changeEmailVerificationTemplate({ url }),
  "03-autoriza-el-cambio-de-correo": changeEmailConfirmationTemplate({ newEmail: "lucia@nuevo.test", url }),
  "04-tu-enlace-para-entrar": accessLinkTemplate({ firstName: "Lucía", url, expiresText: "9:42 (hora de Lima)" }),
  "05-tu-contrasena-cambio": passwordChangedTemplate({ firstName: "Lucía", whenText: "9:12", deviceText: "Chrome en Windows", url }),
  "06-completa-tu-cuenta": accountReminderTemplate({ kind: "sin_verificar", url, days: 7 }),
  "07-crea-o-acepta-tu-clinica": accountReminderTemplate({ kind: "sin_clinica", url }),
  "08-te-invitaron-a-la-clinica": invitationTemplate({ organizationName: clinic, inviterName: "María Pérez", url }),
  "09-te-invitaron-al-equipo-de-odentia": staffInvitationTemplate({ url }),
  "10-actualizamos-los-terminos": legalUpdateTemplate({
    firstName: "Lucía",
    effectiveText: "1 de marzo de 2027",
    changes: ["Quién trata tus datos y para qué.", "Cómo se cobra por acción."],
    url,
    replyTo: "soporte@odentia.localhost",
  }),
  "11-alerta-de-credito": saasAlertEmail(
    { family: "credito", level: "aviso", periodKey: "2026-10-01", title: "Aviso", message: "Tus agentes usaron 76 % del crédito del mes.", short: "Usaste 76 % del crédito", action: "ver_consumo" },
    clinic,
    billing,
  ),
  "12-tu-prueba-termino": saasTrialEndedEmail(clinic, billing),
  "13-tu-plan-empezo-hoy": saasPlanStartedEmail(clinic, billing),
  "14-tienes-un-cargo-vencido": saasOverdueEmail({ clinic, lastDay: "sábado, 25 de octubre de 2026", amounts: ["US$ 49.00"], url: billing }),
  "15-tu-acceso-quedo-restringido": saasRestrictedEmail(clinic, billing),
  "16-tu-liquidacion": saasSettlementEmail({
    sellerName: "Jorge",
    monthText: "septiembre de 2026",
    clinics: 2,
    gross: "123,45 USD",
    adjustments: "-5,00 USD",
    total: "118,45 USD",
    lines: [
      { label: "Clínica Sonrisa", amount: "100,00 USD" },
      { label: "Clínica Norte", amount: "23,45 USD" },
      { label: "Ajuste: cobro duplicado", amount: "-5,00 USD" },
    ],
  }),
  "17-soporte-caso-nuevo": supportInboxNoticeTemplate({
    kind: "caso_nuevo",
    clinic,
    caseKind: "problema",
    screen: "Automatizaciones",
    who: "Ana Torres",
    role: "Recepción",
    url: `${adminUrl}/support`,
  }),
  "18-soporte-la-clinica-respondio": supportInboxNoticeTemplate({
    kind: "clinica_respondio",
    clinic,
    caseKind: "problema",
    screen: "Automatizaciones",
    who: "Ana Torres",
    role: "Recepción",
    url: `${adminUrl}/support`,
  }),
  "19-soporte-respondio-tu-caso": supportReplyNoticeTemplate({ kind: "respuesta", caseKind: "pregunta", topic: "Agenda", url }),
  "20-soporte-necesita-algo-de-ti": supportReplyNoticeTemplate({ kind: "necesita_algo", caseKind: "cobro", topic: "Plan y pagos", url }),
  "21-copia-de-tu-hoja": received.copy,
  "22-reclamos-hoja-nueva": received.notice,
  "23-respuesta-a-tu-hoja": answered.response,
  "24-reclamos-respuesta-enviada": answered.copy,
  "25-estas-en-la-lista": waitlistReceivedEmail({ firstName: "Ana", clinicName: "Clínica Sonrisa", phone: "+51987654321", answerDays: 2 }),
  "26-invitacion-fundadores": founderInvitationEmail({
    firstName: "Ana",
    clinicName: "Clínica Sonrisa",
    email: "ana@clinicasonrisa.pe",
    url,
    expiresText: "domingo 1 de noviembre",
    offer: { currency: "USD", priceCents: 0, trialCreditCents: 10_000, discountPercent: 40, guaranteeMonths: 12 },
  }),
  "27-tu-precio-especial-termina": saasAlertEmail(
    {
      family: "precio_especial",
      level: "aviso",
      periodKey: "2026-10-24",
      title: "Aviso",
      message: "Tu precio especial (10 % menos en cada acción) termina el sábado, 24 de octubre. Desde el día siguiente pagas el precio de lista. ¿Quieres conversarlo? Escríbenos desde Soporte.",
      short: "Tu precio especial termina el sáb 24 oct",
      action: "ver_plan",
    },
    clinic,
    billing,
  ),
  "28-tu-cargo-del-mes": saasChargeIssuedEmail({ clinic, monthText: "octubre de 2026", amount: "USD 32.76", dueDay: "viernes, 30 de octubre", url: billing }),
  "29-manana-solo-lectura": saasRestrictionSoonEmail({ clinic, amounts: ["USD 32.76"], url: billing }),
  "30-resumen-del-lunes": reportDigestEmail({
    firstName: "Ana",
    clinic,
    week: "del 12 al 18 de octubre de 2026",
    // El importe con el mismo formato que el resumen real: la moneda y el formato de la clínica.
    collected: sampleCollected,
    facts: [
      { label: "Cobrado", value: `${sampleCollected} · 6 % más que la semana anterior` },
      { label: "Citas atendidas", value: "94 · 4 más que la semana anterior" },
      { label: "Pacientes nuevos", value: "9 · Igual que la semana anterior" },
      { label: "No vinieron", value: "8 % · 2 puntos más que la semana anterior" },
    ],
    changes: [
      "No vinieron subió a 8 %: 3 de las 8 citas eran de Luis Prado.",
      "El agente agendó 11 citas; la semana anterior, 8.",
      "Octubre va en el 62 % de tu meta de cobrado, con el 58 % del mes.",
    ],
    recommendation: "9 personas deben hace más de 30 días. Con «Saldo vencido» prendida: al equipo de caja le queda una tarea por cada una.",
    reportsUrl: `${webUrl}/reports?period=2026-10-12..2026-10-18`,
    stopUrl: `${webUrl}/resumen-lunes/baja/ejemplo`,
  }),
}

const htmlAt = process.argv.indexOf("--html")
if (htmlAt >= 0) {
  const dir = process.argv[htmlAt + 1] ?? "vista-previa-correos"
  await mkdir(dir, { recursive: true })
  for (const [name, mail] of Object.entries(MAILS)) {
    let html = mail.html
    for (const image of logoAttachments(html)) {
      html = html.replaceAll(`cid:${image.cid}`, `data:image/png;base64,${image.content.toString("base64")}`)
    }
    await writeFile(join(dir, `${name}.html`), html)
    await writeFile(join(dir, `${name}.txt`), `Asunto: ${mail.subject}\n\n${mail.text}`)
  }
  console.log(`Vista previa: ${Object.keys(MAILS).length} correos en ${dir}`)
} else {
  const mailer = createMailer({
    host: process.env.SMTP_HOST ?? "127.0.0.1",
    port: Number(process.env.SMTP_PORT ?? 1025),
    from: process.env.SMTP_FROM ?? "odentIA <no-reply@odentia.localhost>",
    ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : {}),
  })
  const to = process.env.MAIL_PREVIEW_TO ?? "vista-previa@odentia.localhost"
  for (const mail of Object.values(MAILS)) await mailer.send({ to, ...mail })
  console.log(`Vista previa: ${Object.keys(MAILS).length} correos enviados a ${to}`)
}
