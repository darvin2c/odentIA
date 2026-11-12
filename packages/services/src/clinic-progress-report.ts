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
import { and, desc, eq } from "drizzle-orm"
import { brandPaper, type MailBrand, type MailTemplate, renderEmail } from "@odentia/mail"
import { z } from "zod"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { CONSUMER_COMPLAINT_PROVIDER } from "./consumer-complaints.js"
import { type DocumentClinic, DocumentKit, dayWords, SIZE, sheetFormat } from "./document-kit.js"

/** Hojas del informe como máximo: si pasa, el comando falla para que se acorte. */
export const PROGRESS_REPORT_MAX_PAGES = 2

const PRODUCT = {
  dental: { brand: "odentia", domain: "odentia32.com" },
  medical: { brand: "latidia", domain: "latidia72.com" },
  optical: { brand: "vistia", domain: "vistia20.com" },
} as const

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
    pattern: /respond|respuesta|confirm|aprueb|aprobaci|su visto bueno|revise y/i,
    reason: "es informativo: no pide respuesta ni aprobación",
  },
  { pattern: /\d{7,}|\d{3}[ -]\d{3}[ -]\d{3}/, reason: "no lleva documentos ni teléfonos" },
]

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
  if (content.used.length || content.notYet.length) {
    kit.subheading("Lo que usamos", section)
    if (content.used.length)
      kit.table({
        columns: [{ label: "Dato", width: 160 }, { label: "Dónde quedó" }],
        rows: content.used.map((u) => [u.data, u.where]),
        size: SIZE.dense,
        rowPad: 2,
      })
    if (content.notYet.length) {
      kit.gap(4)
      kit.text({ text: "Aún no usamos", face: "sansSemi" }, body)
      kit.bullets(
        content.notYet.map((u) => `${u.data}: ${u.why}`),
        body,
      )
    }
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

/** El correo que lleva el informe: corto, informativo y con respuesta a quien acompaña. */
export function progressReportEmail(content: ProgressReportContent): MailTemplate {
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

/** Lo que deja en la auditoría de la administración cada informe enviado: no se envía dos veces. */
export const PROGRESS_REPORT_SENT_ACTION = "org.progress_report_sent"

/** Si ese informe (por su número) ya se envió a esa clínica, cuándo y a quién. */
export async function progressReportSent(
  tx: Db,
  orgId: string,
  number: number,
): Promise<{ at: string; to: string | null } | null> {
  const [row] = await tx
    .select({ at: adminAudit.createdAt, metadata: adminAudit.metadata })
    .from(adminAudit)
    .where(
      and(
        eq(adminAudit.action, PROGRESS_REPORT_SENT_ACTION),
        eq(adminAudit.organizationId, orgId),
        eq(adminAudit.entityId, `informe-${number}`),
      ),
    )
    .orderBy(desc(adminAudit.createdAt))
    .limit(1)
  return row ? { at: row.at.toISOString(), to: (row.metadata?.to as string | undefined) ?? null } : null
}

/** Deja constancia de un informe enviado, después de que el servidor de correo lo aceptó. */
export async function recordProgressReportSent(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  input: { number: number; to: string; subject: string },
): Promise<void> {
  await writeAdminAudit(tx, actor, {
    action: PROGRESS_REPORT_SENT_ACTION,
    organizationId: orgId,
    entityId: `informe-${input.number}`,
    metadata: { to: input.to, subject: input.subject },
  })
}
