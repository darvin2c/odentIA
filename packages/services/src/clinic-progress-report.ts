/**
 * El informe de avance del alta de una clínica (skill `odentia-carga`): después
 * de cada etapa, una hoja que le cuenta a la clínica lo que recibimos, lo que
 * usamos, lo que hicimos, dónde lo ve y lo que sigue. Es solo informativo: no
 * pide que responda ni que apruebe, no habla del contrato ni de la ley y no
 * promete nada. Lo que sigue lo puede hacer ella misma o escribirnos.
 *
 * Lo arma la skill en la máquina de quien acompaña el alta, sin base de datos
 * (`import:informe`), con la marca del producto y el pie del titular, como la
 * carta de bienvenida. El texto (`progressReportContent`) va aparte del dibujo
 * para probar lo que no puede decir (`REPORT_LIMITS`).
 */
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { brandPaper, type MailBrand, type MailTemplate, renderEmail } from "@odentia/mail"
import { z } from "zod"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { CONSUMER_COMPLAINT_PROVIDER } from "./consumer-complaints.js"
import { ServiceError } from "./errors.js"
import { type DocumentClinic, DocumentKit, dayWords, SIZE, sheetFormat } from "./document-kit.js"

/** Hojas del informe como máximo: si pasa, el comando falla para que se acorte. */
/** Con el detalle de lo cargado, hasta tres hojas. */
export const PROGRESS_REPORT_MAX_PAGES = 3

const PRODUCT = {
  dental: { brand: "odentia", domain: "odentia32.com" },
  medical: { brand: "latidia", domain: "latidia72.com" },
  optical: { brand: "vistia", domain: "vistia20.com" },
} as const

/** El dominio de producción del producto: quien acompaña firma con un correo de ahí. */
export function productMailDomain(product: (typeof CLINICAL_PRODUCTS)[number]): string {
  return PRODUCT[product].domain
}

const ZONE = { locale: "es-PE", timezone: "America/Lima" }

/**
 * Lo que el informe no dice, porque nos compromete: promesas, opiniones legales,
 * el contrato, pedirle que responda o apruebe, y números largos (un documento o
 * un teléfono de una persona). Se cuentan hechos, con cifras cortas.
 */
export const REPORT_LIMITS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /garantiz|asegur(amos|a que)|promet/i, reason: "no promete: cuenta lo hecho" },
  { pattern: /\bcontrato|\bley\b|\bleyes\b|\blegal|\bnorma|\bcumpl/i, reason: "no habla del contrato ni de la ley" },
  {
    // Lo que se le pide a ella; «lo que responde su asistente» no es un pedido.
    pattern: /\bresp[oó]nd(a|anos|ernos)\b|\bsu respuesta|\bconfirme|\baprueb|\baprobaci|su visto bueno|\brevise y/i,
    reason: "es informativo: no pide respuesta ni aprobación",
  },
  { pattern: /\d{7,}|\d{3}[ -]\d{3}[ -]\d{3}/, reason: "no lleva documentos ni teléfonos" },
]

/**
 * En el detalle de lo cargado, los datos de la propia clínica sí llevan sus números: su RUC
 * y sus teléfonos son de la empresa, no de una persona.
 */
const CLINIC_NUMBER_LABELS = /^(RUC|Teléfono de urgencias|Teléfono de la sede)$/i

const isoDate = z.iso.date({ error: "Fecha AAAA-MM-DD que exista en el calendario" })
const line = z.string().trim().min(2).max(200)

export const progressReportSchema = z.strictObject({
  product: z.enum(CLINICAL_PRODUCTS).default("dental"),
  /** La clínica, como la conocen sus pacientes. */
  clinic: z.string().trim().min(2).max(70),
  /** A quién va: «Dra. Ana Pérez». */
  to: z.string().trim().min(2).max(55),
  /** Su correo: a donde sale el informe con `--enviar`. */
  email: z.email().max(80),
  /** El número de informe de esta clínica: 1, 2, 3… */
  number: z.number().int().min(1).max(99),
  /** La etapa, corta: «Alta de su cuenta». */
  stage: z.string().trim().min(3).max(50),
  /** El día del informe; sin decirlo, hoy. */
  date: isoDate.optional(),
  /** Quien acompaña el alta: firma y es a quien puede escribir si quiere. */
  companion: z.strictObject({
    name: z.string().trim().min(2).max(40),
    role: z.string().trim().min(2).max(50).optional(),
    email: z.email().max(40),
    phone: z.string().trim().min(6).max(20).optional(),
  }),
  /** Lo que llegó, con su fecha y por dónde. */
  received: z.array(line).max(6).default([]),
  /** Lo que usamos y dónde quedó. */
  used: z.array(z.strictObject({ data: z.string().trim().min(2).max(60), where: z.string().trim().min(2).max(90) })).max(10).default([]),
  /** Lo que llegó o se esperaba y todavía no se usó, con el motivo. */
  notYet: z.array(z.strictObject({ data: z.string().trim().min(2).max(60), why: z.string().trim().min(2).max(90) })).max(8).default([]),
  /** Lo que hicimos, ya hecho y comprobado. */
  done: z.array(line).min(1).max(8),
  /** Dónde lo ve: la pantalla o el enlace. */
  where: z.array(line).min(1).max(5),
  /** Lo que sigue: lo puede hacer ella misma o escribirnos. */
  next: z.array(line).max(5).default([]),
  /**
   * El detalle de lo que quedó cargado, por área: cada dato con su valor (cada servicio con
   * su código y su precio, cada gasto con su monto…). Lo arma la skill desde el plan cargado.
   */
  sections: z
    .array(
      z.strictObject({
        title: z.string().trim().min(2).max(60),
        rows: z.array(z.strictObject({ label: z.string().trim().min(1).max(160), value: z.string().trim().min(1).max(400) })).min(1).max(40),
      }),
    )
    .max(10)
    .default([]),
})
export type ProgressReportInput = z.input<typeof progressReportSchema>

export interface ProgressReportContent {
  brand: MailBrand
  brandName: string
  domain: string
  placeAndDate: string
  to: string
  clinic: string
  email: string
  title: string
  intro: string
  received: string[]
  used: Array<{ data: string; where: string }>
  notYet: Array<{ data: string; why: string }>
  done: string[]
  where: string[]
  next: string[]
  sections: Array<{ title: string; rows: Array<{ label: string; value: string }> }>
  /** Cierre: lo que sigue lo puede hacer ella o escribirnos, sin pedirle nada. */
  closing: string
  signature: { name: string; role: string | null; brand: string; contact: string }
  /** A quien le llega si escribe: quien acompaña, nunca un buzón que nadie lee. */
  replyTo: string
  footer: string
}

/** El día de hoy en Lima, AAAA-MM-DD. */
function todayInLima(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE.timezone }).format(new Date())
}

/** Los textos libres del informe que no pueden decir lo de `REPORT_LIMITS`, con dónde están. */
function freeTexts(report: z.output<typeof progressReportSchema>): Array<[string, string]> {
  return [
    ["stage", report.stage],
    ...report.received.map((text, i): [string, string] => [`received.${i}`, text]),
    ...report.used.flatMap((u, i): Array<[string, string]> => [[`used.${i}.data`, u.data], [`used.${i}.where`, u.where]]),
    ...report.notYet.flatMap((u, i): Array<[string, string]> => [[`notYet.${i}.data`, u.data], [`notYet.${i}.why`, u.why]]),
    ...report.done.map((text, i): [string, string] => [`done.${i}`, text]),
    ...report.where.map((text, i): [string, string] => [`where.${i}`, text]),
    ...report.next.map((text, i): [string, string] => [`next.${i}`, text]),
    ...report.sections.flatMap((section, i): Array<[string, string]> => [
      [`sections.${i}.title`, section.title],
      ...section.rows.flatMap((row, j): Array<[string, string]> => [
        [`sections.${i}.rows.${j}.label`, row.label],
        // El valor de un dato de la clínica (su RUC, su teléfono) lleva sus números.
        [`sections.${i}.rows.${j}.value`, CLINIC_NUMBER_LABELS.test(row.label) ? row.value.replace(/\d/g, "") : row.value],
      ]),
    ]),
  ]
}

/** Lo que dice el informe, ya con la marca y la fecha. Falla si algún texto dice lo que no debe. */
export function progressReportContent(raw: ProgressReportInput): ProgressReportContent {
  const report = progressReportSchema.parse(raw)
  const problems = freeTexts(report).flatMap(([path, text]) =>
    REPORT_LIMITS.filter((limit) => limit.pattern.test(text)).map((limit) => `${path}: ${limit.reason} («${text}»)`),
  )
  if (problems.length) throw new Error(`El informe no puede decir esto:\n- ${problems.join("\n- ")}`)

  const product = PRODUCT[report.product]
  const { name: brandName } = brandPaper(product.brand)
  const companion = report.companion
  const titular = CONSUMER_COMPLAINT_PROVIDER
  return {
    brand: product.brand,
    brandName,
    domain: product.domain,
    placeAndDate: `Lima, ${dayWords(report.date ?? todayInLima(), ZONE)}`,
    to: report.to,
    clinic: report.clinic,
    email: report.email,
    title: `Informe N.º ${report.number} · ${report.stage}`,
    intro: "Le compartimos, para su información, lo que recibimos, lo que usamos y lo que hicimos en esta etapa del alta de su clínica.",
    received: report.received,
    used: report.used,
    notYet: report.notYet,
    done: report.done,
    where: report.where,
    next: report.next,
    sections: report.sections,
    closing: `Lo que sigue puede hacerlo usted desde ${brandName} o, si lo prefiere, lo vemos juntos: puede escribirnos cuando guste.`,
    signature: {
      name: companion.name,
      role: companion.role ?? null,
      brand: brandName,
      // El celular no se parte entre dos líneas: sus espacios no cortan.
      contact: [companion.email, companion.phone?.replace(/ /g, " ")].filter(Boolean).join(" · "),
    },
    replyTo: companion.email,
    footer: `${brandName} · ${product.domain} · ${titular.legalName} · RUC ${titular.ruc}`,
  }
}

/** El informe en PDF (A4), con el logotipo y el color de la marca y el titular en el membrete. */
export async function progressReportPdf(raw: ProgressReportInput): Promise<{
  bytes: Uint8Array
  pages: number
  content: ProgressReportContent
}> {
  const content = progressReportContent(raw)
  const paper = brandPaper(content.brand)
  // El papel es de la marca, no de la clínica: su logotipo, su color y el titular.
  const sender: DocumentClinic = {
    tradeName: content.brandName,
    legalName: CONSUMER_COMPLAINT_PROVIDER.legalName,
    fiscalDocType: "RUC",
    fiscalDocNumber: CONSUMER_COMPLAINT_PROVIDER.ruc,
    address: CONSUMER_COMPLAINT_PROVIDER.address,
    phone: content.domain,
    branchName: null,
    logo: { bytes: paper.logoPng, kind: "png" },
    wordmark: true,
    brandInk: paper.color,
    locale: ZONE.locale,
    timezone: ZONE.timezone,
    sheetSize: "A4",
    receiptWidth: "80",
  }
  const kit = await DocumentKit.open(sender, sheetFormat("A4"), {
    title: content.title,
    docLabel: "",
    legalNote: content.footer,
  })
  const body = { size: SIZE.dense, leading: 1.45 }
  const section = { before: 7, after: 1 }

  kit.gap(6)
  kit.text(content.placeAndDate, { ...body, align: "right" })
  kit.gap(6)
  kit.text({ text: content.to, face: "sansSemi" }, { ...body, leading: 1.35 })
  // La clínica que lleva el nombre de la persona («Dra. Ana Pérez») no se repite debajo de ella.
  if (!sameName(content.to, content.clinic)) kit.text(content.clinic, { ...body, leading: 1.35 })
  kit.gap(8)
  kit.heading(content.title, { size: SIZE.h2small, before: 0, after: 4 })
  kit.text(content.intro, body)

  if (content.received.length) {
    kit.subheading("Lo que recibimos", section)
    kit.bullets(content.received, body)
  }
  if (content.used.length) {
    kit.subheading("Lo que usamos", section)
    kit.table({
      columns: [{ label: "Dato", width: 160 }, { label: "Dónde quedó" }],
      rows: content.used.map((u) => [u.data, u.where]),
      size: SIZE.dense,
      rowPad: 2,
    })
  }
  if (content.sections.length) {
    kit.subheading("Lo que quedó cargado", section)
    for (const part of content.sections) {
      kit.gap(2)
      // El título no queda solo al pie de una hoja: va con sus primeras filas.
      kit.ensure(SIZE.dense * 1.45 * 4)
      kit.text({ text: part.title, face: "sansSemi" }, body)
      kit.table({
        columns: [{ label: "Dato", width: 190 }, { label: "Valor" }],
        rows: part.rows.map((row) => [row.label, row.value]),
        size: SIZE.dense,
        rowPad: 2,
      })
    }
  }
  if (content.notYet.length) {
    kit.subheading("Aún no usamos", section)
    kit.bullets(
      content.notYet.map((u) => `${u.data}: ${u.why}`),
      body,
    )
  }
  kit.subheading("Lo que hicimos", section)
  kit.bullets(content.done, body)
  kit.subheading("Dónde lo ve", section)
  kit.bullets(content.where, body)
  if (content.next.length) {
    kit.subheading("Lo que sigue", section)
    kit.bullets(content.next, body)
  }

  // Cierre y firma juntos: la firma nunca queda sola en otra hoja.
  const signature = { ...body, leading: 1.35 }
  kit.gap(6)
  kit.ensure(SIGNATURE_HEIGHT)
  kit.text(content.closing, body)
  kit.gap(4)
  kit.text("Atentamente,", body)
  kit.gap(12)
  kit.text({ text: content.signature.name, face: "sansSemi" }, signature)
  kit.text(content.signature.role ? `${content.signature.role} · ${content.signature.brand}` : content.signature.brand, {
    ...signature,
    tone: "gray",
  })
  kit.text(content.signature.contact, { ...signature, tone: "gray" })

  const bytes = await kit.finish()
  return { bytes, pages: kit.pageCount, content }
}

/**
 * Lo que necesita el correo del informe para salir otra vez igual. Viaja con la reserva en
 * el registro: un informe que no se sabe si salió se reenvía con su mismo correo y su mismo
 * PDF, sin volver a armarlo.
 */
export interface ProgressReportMail {
  brand: MailBrand
  brandName: string
  title: string
  clinic: string
  to: string
  closing: string
  replyTo: string
  signature: { name: string }
}

/** Lo del contenido que lleva el correo, y nada más. */
export function progressReportMailOf(content: ProgressReportContent): ProgressReportMail {
  return {
    brand: content.brand,
    brandName: content.brandName,
    title: content.title,
    clinic: content.clinic,
    to: content.to,
    closing: content.closing,
    replyTo: content.replyTo,
    signature: { name: content.signature.name },
  }
}

/** Lo guardado en el registro, si está completo (un informe de antes de guardarlo no lo tiene). */
function mailFromMetadata(value: unknown): ProgressReportMail | null {
  if (!value || typeof value !== "object") return null
  const mail = value as Record<string, unknown>
  const signature = mail.signature as Record<string, unknown> | undefined
  const texts = ["brand", "brandName", "title", "clinic", "to", "closing", "replyTo"] as const
  if (texts.some((key) => typeof mail[key] !== "string") || typeof signature?.name !== "string")
    return null
  return {
    brand: mail.brand as MailBrand,
    brandName: mail.brandName as string,
    title: mail.title as string,
    clinic: mail.clinic as string,
    to: mail.to as string,
    closing: mail.closing as string,
    replyTo: mail.replyTo as string,
    signature: { name: signature.name },
  }
}

/** El correo que lleva el informe: corto, informativo y con respuesta a quien acompaña. */
export function progressReportEmail(content: ProgressReportMail): MailTemplate {
  return {
    ...renderEmail({
      brand: content.brand,
      subject: `${content.title} — ${content.clinic}`,
      preview: `Lo que recibimos, lo que usamos y lo que hicimos en el alta de ${content.clinic}.`,
      title: content.title,
      paragraphs: [
        `${content.to}:`,
        `Le enviamos adjunto el informe de esta etapa del alta de ${content.clinic}, para su información.`,
        content.closing,
      ],
      reason: `Le escribimos porque acompañamos el alta de ${content.clinic} en ${content.brandName}.`,
      replies: `Si nos escribe, la respuesta le llega a ${content.signature.name}.`,
      replyTo: content.replyTo,
    }),
    replyTo: content.replyTo,
    brand: content.brand,
  }
}

/** Si el nombre de la clínica ya está en el de la persona, sin tildes ni mayúsculas. */
function sameName(person: string, clinic: string): boolean {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()
  return fold(person).includes(fold(clinic))
}

/** Lo que mide el cierre con la firma: el cierre en dos líneas, «Atentamente», tres de firma y sus espacios, para no partirla. */
const SIGNATURE_HEIGHT = 3 * SIZE.dense * 1.45 + 3 * SIZE.dense * 1.35 + 6 + 4 + 12 + 6

/**
 * Cada informe deja su rastro en la auditoría de la administración: `enviando` antes de
 * enviarlo, y después `enviado` o `desconocido` (el correo se cortó y no se sabe si
 * salió). Con cualquiera de los tres, ese número no se vuelve a enviar solo: lo dudoso se
 * revisa en Zoho y una persona lo cierra como salido o, si no salió, lo reenvía igual
 * (`reserveProgressReportResend`), una vez por pulsación y nunca en un reintento.
 */
export const PROGRESS_REPORT_ACTIONS = {
  enviando: "org.progress_report_sending",
  enviado: "org.progress_report_sent",
  desconocido: "org.progress_report_unknown",
} as const
export type ProgressReportState = keyof typeof PROGRESS_REPORT_ACTIONS

/**
 * Lo último de un informe: el más nuevo y, a la misma hora (reservar y cerrar
 * en una misma transacción comparten `now()`), el cierre antes que el «enviándose».
 * Sin el desempate, un informe que no se sabe si salió podía leerse «enviándose»
 * y perder «Revisé en Zoho: salió» (QA del ARM, 12 nov).
 */
const latestReportFirst = [
  desc(adminAudit.createdAt),
  sql`case when ${adminAudit.action} = ${PROGRESS_REPORT_ACTIONS.enviando} then 1 else 0 end`,
] as const

/** Lo último que pasó con ese informe (por su número) en esa clínica, o null si nunca se envió. */
export async function progressReportSent(
  tx: Db,
  orgId: string,
  number: number,
): Promise<{ at: string; to: string | null; state: ProgressReportState } | null> {
  const [row] = await tx
    .select({ at: adminAudit.createdAt, action: adminAudit.action, metadata: adminAudit.metadata })
    .from(adminAudit)
    .where(
      and(
        inArray(adminAudit.action, Object.values(PROGRESS_REPORT_ACTIONS)),
        eq(adminAudit.organizationId, orgId),
        eq(adminAudit.entityId, `informe-${number}`),
      ),
    )
    .orderBy(...latestReportFirst)
    .limit(1)
  if (!row) return null
  const state = (Object.entries(PROGRESS_REPORT_ACTIONS).find(([, action]) => action === row.action)?.[0] ?? "enviado") as ProgressReportState
  return { at: row.at.toISOString(), to: (row.metadata?.to as string | undefined) ?? null, state }
}

/**
 * Reserva el envío de ese informe: con la clínica y el número bloqueados, si ya hay
 * rastro no se reserva (dos pestañas o un doble clic no envían dos correos).
 */
export async function reserveProgressReport(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  input: {
    number: number
    to: string
    subject: string
    stage: string
    pdfKey: string
    /** El correo tal como sale, para poder reenviarlo igual si no se sabe si salió. */
    mail?: ProgressReportMail
  },
): Promise<void> {
  await lockProgressReport(tx, orgId, input.number)
  const before = await progressReportSent(tx, orgId, input.number)
  if (before)
    throw new ServiceError(
      "CONFLICT",
      409,
      before.state === "enviado"
        ? `El informe N.º ${input.number} ya se envió: no se envía dos veces`
        : `El informe N.º ${input.number} ya se intentó enviar: revisa en Zoho si salió antes de hacer otro`,
    )
  await writeAdminAudit(tx, actor, {
    action: PROGRESS_REPORT_ACTIONS.enviando,
    organizationId: orgId,
    entityId: `informe-${input.number}`,
    metadata: {
      to: input.to,
      subject: input.subject,
      stage: input.stage,
      pdfKey: input.pdfKey,
      ...(input.mail ? { mail: input.mail } : {}),
    },
  })
}

/** El número de ese informe en esa clínica, bloqueado hasta el fin de la transacción. */
async function lockProgressReport(tx: Db, orgId: string, number: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('informe:' || ${orgId} || ':' || ${number}))`)
}

/** Lo que hace falta para reenviar un informe: el mismo número, destinatario, PDF y correo. */
export interface ProgressReportResend {
  number: number
  to: string
  subject: string
  stage: string
  pdfKey: string
  mail: ProgressReportMail
}

/**
 * Por qué no se puede reenviar ese informe, o null si se puede: solo uno que quedó «no se
 * sabe si salió», con su PDF y su correo guardados. Lo usa la ruta para decirlo antes de
 * leer el PDF y la reserva para volver a mirarlo con el número bloqueado.
 */
export function progressReportResendProblem(
  number: number,
  found: ProgressReportRecord | undefined,
): ServiceError | null {
  if (!found)
    return new ServiceError("NOT_FOUND", 404, `El informe N.º ${number} no está en el registro`)
  if (found.state === "enviado")
    return new ServiceError(
      "CONFLICT",
      409,
      `El informe N.º ${number} ya figura como enviado: no se envía dos veces`,
    )
  if (found.state === "enviando")
    return new ServiceError(
      "CONFLICT",
      409,
      `El informe N.º ${number} se está enviando o quedó a medias: revisa en Zoho si salió antes de reenviarlo`,
    )
  if (!found.pdfKey || !found.mail || !found.to)
    return new ServiceError(
      "CONFLICT",
      409,
      `El informe N.º ${number} no guardó su PDF o su correo: no se puede reenviar igual desde aquí`,
    )
  return null
}

/**
 * Reserva el reenvío de un informe que no se sabe si salió: con el número bloqueado, vuelve
 * a mirar que siga así y deja otra vez `enviando` con lo mismo que llevaba (destinatario,
 * asunto, PDF y correo) y la marca de reenvío. Dos pulsaciones no envían dos correos.
 */
export async function reserveProgressReportResend(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  number: number,
): Promise<ProgressReportResend> {
  await lockProgressReport(tx, orgId, number)
  const found = (await listProgressReports(tx, orgId)).find((report) => report.number === number)
  const problem = progressReportResendProblem(number, found)
  if (problem) throw problem
  if (!found?.pdfKey || !found.mail || !found.to)
    throw new ServiceError("CONFLICT", 409, `El informe N.º ${number} no se puede reenviar`)
  const sending: ProgressReportResend = {
    number,
    to: found.to,
    subject: found.subject ?? "",
    stage: found.stage ?? "",
    pdfKey: found.pdfKey,
    mail: found.mail,
  }
  await writeAdminAudit(tx, actor, {
    action: PROGRESS_REPORT_ACTIONS.enviando,
    organizationId: orgId,
    entityId: `informe-${number}`,
    metadata: {
      to: sending.to,
      subject: sending.subject,
      stage: sending.stage,
      pdfKey: sending.pdfKey,
      mail: sending.mail,
      resent: true,
    },
  })
  return sending
}

/** Cómo terminó el envío reservado: salió, o no se sabe. */
export async function finishProgressReport(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  input: {
    number: number
    to: string
    subject: string
    stage: string
    pdfKey: string
    state: "enviado" | "desconocido"
    /** Cuándo salió, si fue por otra vía antes de registrarlo (ISO 8601). */
    sentAt?: string
    /** Salió por otra vía y se registra después: el sistema no lo envió. */
    registered?: boolean
    /** El correo tal como salió (o se intentó), para reenviarlo igual si no se sabe si salió. */
    mail?: ProgressReportMail
    /** Es un reenvío de ese mismo número. */
    resent?: boolean
  },
): Promise<void> {
  await writeAdminAudit(tx, actor, {
    action: PROGRESS_REPORT_ACTIONS[input.state],
    organizationId: orgId,
    entityId: `informe-${input.number}`,
    metadata: {
      to: input.to,
      subject: input.subject,
      stage: input.stage,
      pdfKey: input.pdfKey,
      ...(input.sentAt ? { sentAt: input.sentAt } : {}),
      ...(input.registered ? { registered: true } : {}),
      ...(input.mail ? { mail: input.mail } : {}),
      ...(input.resent ? { resent: true } : {}),
    },
  })
}

/** Dónde queda el PDF de un informe enviado: en el almacenamiento privado, en la carpeta de la clínica. */
export function progressReportPdfKey(orgId: string, number: number): string {
  return `clinics/${orgId}/informes/informe-${number}-${crypto.randomUUID()}.pdf`
}

export interface ProgressReportRecord {
  number: number
  state: ProgressReportState
  at: string
  to: string | null
  subject: string | null
  stage: string | null
  /** Quién lo envió o lo registró. */
  by: string | null
  /** Salió por otra vía y se registró después: el sistema no lo envió. */
  registeredLater: boolean
  /** La clave del PDF tal como salió; sin ella, el informe se envió antes de guardarlos. */
  pdfKey: string | null
  /** El correo tal como salió; sin él, el informe es de antes de guardarlo y no se reenvía. */
  mail: ProgressReportMail | null
  /** Lo último fue un reenvío de ese número. */
  resent: boolean
}

/** Los informes de esa clínica, el último estado de cada número, del más nuevo al más viejo. */
export async function listProgressReports(tx: Db, orgId: string): Promise<ProgressReportRecord[]> {
  return (await progressReportsOf(tx, [orgId])).get(orgId) ?? []
}

/** Los informes de varias clínicas en una sola lectura (lo de `listProgressReports`, por clínica). */
export async function progressReportsOf(tx: Db, orgIds: string[]): Promise<Map<string, ProgressReportRecord[]>> {
  const out = new Map<string, ProgressReportRecord[]>()
  if (!orgIds.length) return out
  const rows = await tx
    .select({
      orgId: adminAudit.organizationId,
      at: adminAudit.createdAt,
      action: adminAudit.action,
      entityId: adminAudit.entityId,
      metadata: adminAudit.metadata,
      by: user.name,
    })
    .from(adminAudit)
    .leftJoin(user, eq(user.id, adminAudit.actorUserId))
    .where(and(inArray(adminAudit.action, Object.values(PROGRESS_REPORT_ACTIONS)), inArray(adminAudit.organizationId, [...new Set(orgIds)])))
    .orderBy(...latestReportFirst)
  const seenOf = new Map<string, Map<number, ProgressReportRecord>>()
  for (const row of rows) {
    if (!row.orgId) continue
    const seen = seenOf.get(row.orgId) ?? new Map<number, ProgressReportRecord>()
    seenOf.set(row.orgId, seen)
    const number = Number(row.entityId?.replace("informe-", ""))
    if (!Number.isInteger(number) || seen.has(number)) continue
    const state = (Object.entries(PROGRESS_REPORT_ACTIONS).find(([, action]) => action === row.action)?.[0] ?? "enviado") as ProgressReportState
    const meta = row.metadata ?? {}
    const sentAt = meta.sentAt as string | undefined
    seen.set(number, {
      number,
      state,
      at: sentAt ?? row.at.toISOString(),
      to: (meta.to as string | undefined) ?? null,
      subject: (meta.subject as string | undefined) ?? null,
      stage: (meta.stage as string | undefined) ?? null,
      by: row.by ?? null,
      registeredLater: meta.registered === true,
      pdfKey: (meta.pdfKey as string | undefined) ?? null,
      mail: mailFromMetadata(meta.mail),
      resent: meta.resent === true,
    })
  }
  for (const [orgId, seen] of seenOf) out.set(orgId, [...seen.values()].sort((a, b) => b.number - a.number))
  return out
}

/** Una carga en el registro de la clínica: la configuración o los pacientes de un plan. */
export interface ClinicLoadRecord {
  /** La primera fila de la auditoría de esa carga (la tanda 0 de los pacientes): no cambia al seguir. */
  id: string
  kind: "configuracion" | "pacientes"
  at: string
  by: string | null
  /** Lo que quedó, en una frase: «20 nuevos · 2 cambiaron · 7 ya estaban». */
  summary: string
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Las cifras de una carga en palabras; lo que es cero no se dice. */
function loadSummary(kind: ClinicLoadRecord["kind"], totals: Record<string, number>): string {
  const n = (key: string) => totals[key] ?? 0
  const parts =
    kind === "configuracion"
      ? [
          n("nueva") && plural(n("nueva"), "nuevo", "nuevos"),
          n("cambia") && plural(n("cambia"), "cambió", "cambiaron"),
          n("igual") && `${n("igual")} ya estaba${n("igual") === 1 ? "" : "n"}`,
          n("espera") && `${n("espera")} espera${n("espera") === 1 ? "" : "n"} a que acepten su invitación`,
          n("error") && `${n("error")} no ${n("error") === 1 ? "entró" : "entraron"}`,
        ]
      : [
          n("creadas") && plural(n("creadas"), "persona creada", "personas creadas"),
          n("existentes") && `${n("existentes")} ya estaba${n("existentes") === 1 ? "" : "n"}`,
          n("yaCargadas") && `${n("yaCargadas")} ya ${n("yaCargadas") === 1 ? "se había" : "se habían"} cargado`,
          n("errores") && `${n("errores")} no ${n("errores") === 1 ? "entró" : "entraron"}`,
        ]
  return parts.filter(Boolean).join(" · ") || "Nada que cargar"
}

/**
 * Las cargas de esa clínica, de la más nueva a la más vieja, con quién las hizo. Los
 * pacientes se cargan por tandas: las tandas seguidas del mismo plan son una sola carga.
 */
export async function listClinicLoads(tx: Db, orgId: string): Promise<ClinicLoadRecord[]> {
  const rows = await tx.execute<{ id: string; action: string; created_at: Date | string; metadata: Record<string, unknown> | null; name: string | null }>(sql`
    select a.id, a.action, a.created_at, a.metadata, u.name
    from admin_audit a left join "user" u on u.id = a.actor_user_id
    where a.organization_id = ${orgId} and a.action in ('org.setup_import', 'org.data_import')
    order by a.created_at desc
    limit 500`)
  // `open`: las tandas llegan de la más nueva a la más vieja, y la tanda 0 es el comienzo de
  // esa pasada; la anterior a ella (otra pasada del mismo plan) va en su propia fila.
  const loads: Array<{ id: string; kind: ClinicLoadRecord["kind"]; at: string; by: string | null; plan: unknown; open: boolean; totals: Record<string, number> }> = []
  for (const row of rows) {
    const meta = row.metadata ?? {}
    const kind = row.action === "org.setup_import" ? "configuracion" : "pacientes"
    const numbers = Object.fromEntries(Object.entries(meta).filter(([, value]) => typeof value === "number")) as Record<string, number>
    const { from, to: _to, total: _total, invitations: _invitations, ...totals } = numbers
    const first = kind === "pacientes" && from === 0
    const last = loads.at(-1)
    if (kind === "pacientes" && last?.kind === "pacientes" && last.open && last.plan === meta.planSha256) {
      for (const [key, value] of Object.entries(totals)) last.totals[key] = (last.totals[key] ?? 0) + value
      last.id = row.id
      if (first) last.open = false
      continue
    }
    loads.push({ id: row.id, kind, at: new Date(row.created_at).toISOString(), by: row.name, plan: meta.planSha256, open: kind === "pacientes" && !first, totals })
  }
  return loads.slice(0, 100).map(({ id, kind, at, by, totals }) => ({ id, kind, at, by, summary: loadSummary(kind, totals) }))
}
