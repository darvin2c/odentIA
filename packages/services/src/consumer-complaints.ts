// Libro de Reclamaciones virtual de odentIA (Perú). Norma: Código de Protección
// y Defensa del Consumidor (Ley 29571) y Reglamento del Libro de Reclamaciones
// (D.S. 011-2011-PCM, modificado por D.S. 006-2014-PCM y D.S. 101-2022-PCM).
//
// Es de la plataforma, no de una clínica: la hoja se guarda en tablas globales
// que solo toca el rol owner (migraciones 0003 y 0004). La API pública es la única que
// escribe aquí y lo hace con `ownerDb.transaction`.
import { isAdminRole } from "@odentia/auth/admin-permissions"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { consumerComplaint, consumerComplaintCounter } from "@odentia/db/schema/consumer-complaints"
import { type MailTemplate, renderEmail } from "@odentia/mail"
import { and, asc, count, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { addPeruBusinessDays, limaDate, peruBusinessDaysBetween } from "./peru-business-days.js"

/**
 * Datos del proveedor que encabezan la Hoja de Reclamación (Anexo I).
 * Una sola constante para el correo; la web tiene la suya en
 * `apps/web/src/lib/complaints.ts` y deben decir lo mismo. Mientras falten los
 * datos reales, los marcadores se ven tal cual.
 */
export const CONSUMER_COMPLAINT_PROVIDER = {
  legalName: "SALLCA GROUP E.I.R.L.",
  ruc: "20603338741",
  address: "Av. Mariscal Andrés de Santa Cruz 176, Urb. Fundo Oyague, Jesús María, Lima, Perú",
} as const

/** Plazo máximo de respuesta del proveedor (art. 6 del reglamento, D.S. 101-2022-PCM). */
export const CONSUMER_COMPLAINT_RESPONSE_DAYS = 15

/** Documentos de identidad que acepta la hoja: DNI, carné de extranjería y pasaporte. */
export const CONSUMER_COMPLAINT_DOCUMENT_TYPES = ["DNI", "CE", "PASAPORTE"] as const
export type ConsumerComplaintDocumentType = (typeof CONSUMER_COMPLAINT_DOCUMENT_TYPES)[number]

export const CONSUMER_COMPLAINT_KINDS = ["reclamo", "queja"] as const
export type ConsumerComplaintKind = (typeof CONSUMER_COMPLAINT_KINDS)[number]

const DOCUMENT_LABELS: Record<ConsumerComplaintDocumentType, string> = {
  DNI: "DNI",
  CE: "Carné de extranjería",
  PASAPORTE: "Pasaporte",
}
const KIND_LABELS: Record<ConsumerComplaintKind, string> = { reclamo: "Reclamo", queja: "Queja" }
const ITEM_LABELS = { producto: "Producto", servicio: "Servicio" } as const
const CURRENCY_LABELS = { PEN: "S/", USD: "USD" } as const

/** Patrón de cada documento: DNI de 8 dígitos; CE y pasaporte alfanuméricos. */
const DOCUMENT_PATTERNS: Record<ConsumerComplaintDocumentType, RegExp> = {
  DNI: /^\d{8}$/,
  CE: /^[A-Z0-9]{8,12}$/,
  PASAPORTE: /^[A-Z0-9]{6,12}$/,
}

const text = (min: number, max: number, label: string) =>
  z
    .string({ error: `Escribe ${label}` })
    .trim()
    .min(min, `Escribe ${label}`)
    .max(max, `Usa como máximo ${max} caracteres en ${label}`)

/** Límites de longitud que la web también muestra (contador del detalle). */
export const CONSUMER_COMPLAINT_LIMITS = {
  detail: 3000,
  request: 1500,
  itemDescription: 500,
} as const

/**
 * Hoja enviada desde la web. Única declaración de la forma y sus reglas: la
 * ruta la usa para validar el cuerpo y el servicio vuelve a aplicarla.
 */
export const consumerComplaintInputSchema = z
  .strictObject({
    submissionId: z.uuid("Falta el identificador del envío"),
    kind: z.enum(CONSUMER_COMPLAINT_KINDS, "Elige si es un reclamo o una queja"),
    consumerName: text(3, 160, "tu nombre completo"),
    consumerAddress: text(5, 300, "tu domicilio"),
    documentType: z.enum(CONSUMER_COMPLAINT_DOCUMENT_TYPES, "Elige el tipo de documento"),
    documentNumber: z
      .string({ error: "Escribe el número de documento" })
      .trim()
      .toUpperCase()
      .min(1, "Escribe el número de documento")
      .max(12, "El número de documento es demasiado largo"),
    phone: z
      .string({ error: "Escribe tu teléfono" })
      .trim()
      .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, "Escribe un teléfono válido, solo con números"),
    email: z
      .string({ error: "Escribe tu correo" })
      .trim()
      .pipe(z.email("Escribe un correo válido")),
    isMinor: z.boolean().default(false),
    guardianName: z.string().trim().max(160, "Usa como máximo 160 caracteres").nullish(),
    itemType: z.enum(["producto", "servicio"], "Elige si fue un producto o un servicio"),
    itemDescription: text(
      3,
      CONSUMER_COMPLAINT_LIMITS.itemDescription,
      "qué producto o servicio contrataste",
    ),
    /** Monto reclamado como texto decimal («150.50»), para no perder céntimos. */
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,9}([.,]\d{1,2})?$/, "Escribe el monto con números, por ejemplo 150.50")
      .nullish()
      .or(z.literal("")),
    currency: z.enum(["PEN", "USD"], "Elige la moneda del monto").nullish(),
    detail: text(10, CONSUMER_COMPLAINT_LIMITS.detail, "el detalle de tu reclamación"),
    request: text(3, CONSUMER_COMPLAINT_LIMITS.request, "qué pides"),
    privacyAccepted: z.literal(
      true,
      "Acepta el tratamiento de tus datos para atender tu reclamación",
    ),
  })
  .superRefine((value, ctx) => {
    if (!DOCUMENT_PATTERNS[value.documentType].test(value.documentNumber)) {
      ctx.addIssue({
        code: "custom",
        path: ["documentNumber"],
        message:
          value.documentType === "DNI"
            ? "El DNI tiene 8 dígitos"
            : "Escribe el número de documento solo con letras y números",
      })
    }
    if (value.isMinor && !value.guardianName) {
      ctx.addIssue({
        code: "custom",
        path: ["guardianName"],
        message: "Si eres menor de edad, escribe el nombre de tu padre, madre o apoderado",
      })
    }
    if (value.amount && !value.currency) {
      ctx.addIssue({ code: "custom", path: ["currency"], message: "Elige la moneda del monto" })
    }
  })

export type ConsumerComplaintInput = z.input<typeof consumerComplaintInputSchema>

export type ConsumerComplaintSheet = typeof consumerComplaint.$inferSelect

/** Convierte «150.50» o «150,5» en céntimos sin pasar por coma flotante. */
function toMinor(amount: string): number {
  const [whole = "0", fraction = ""] = amount.replace(",", ".").split(".")
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
}

function parseInput(input: unknown) {
  const parsed = consumerComplaintInputSchema.safeParse(input)
  if (!parsed.success) {
    throw validation(
      parsed.error.issues[0]?.message ?? "Revisa los datos de la hoja de reclamación",
    )
  }
  return parsed.data
}

async function findBySubmission(
  tx: Db,
  submissionId: string,
): Promise<ConsumerComplaintSheet | null> {
  const [row] = await tx
    .select()
    .from(consumerComplaint)
    .where(eq(consumerComplaint.submissionId, submissionId))
    .limit(1)
  return row ?? null
}

/** ¿El error es la violación de esa restricción única? Mira el error y su causa (Drizzle envuelve el de Postgres). */
function violates(error: unknown, constraint: string): boolean {
  const chain = [error, (error as { cause?: unknown })?.cause]
  return chain.some((e) => {
    const r = e as Record<string, unknown> | null | undefined
    return [r?.constraint_name, r?.constraint, r?.message].some(
      (v) => typeof v === "string" && v.includes(constraint),
    )
  })
}

/**
 * Guarda una Hoja de Reclamación y le asigna el correlativo del año.
 *
 * - El año es el de Lima en el reloj de la base (el mismo `now()` de
 *   `created_at`), así la hoja y su número nunca caen en años distintos.
 * - El contador se incrementa con un upsert atómico en esta transacción: la
 *   fila queda bloqueada hasta el commit y, si algo falla, vuelve atrás.
 *   Por eso no quedan huecos ni números repetidos.
 * - Idempotente por `submissionId`: reenviar devuelve la misma hoja
 *   (`created: false`). Dos envíos simultáneos con el mismo id se resuelven
 *   con un savepoint: el segundo deshace su número y lee la hoja del primero.
 *
 * `tx` debe ser una transacción abierta con el rol owner.
 */
export async function submitConsumerComplaint(
  tx: Db,
  input: unknown,
): Promise<{ sheet: ConsumerComplaintSheet; created: boolean }> {
  const data = parseInput(input)
  const existing = await findBySubmission(tx, data.submissionId)
  if (existing) return { sheet: existing, created: false }

  const amount = data.amount ? toMinor(data.amount) : null
  try {
    // Transacción anidada = savepoint de postgres.js: si la hoja choca con otra
    // del mismo envío, se deshacen juntas la hoja y su número.
    const sheet = await tx.transaction(async (sp) => {
      const [counter] = await sp
        .insert(consumerComplaintCounter)
        .values({ year: sql`extract(year from now() at time zone 'America/Lima')::int`, value: 1 })
        .onConflictDoUpdate({
          target: consumerComplaintCounter.year,
          set: { value: sql`"consumer_complaint_counter"."value" + 1` },
        })
        .returning({ year: consumerComplaintCounter.year, value: consumerComplaintCounter.value })
      if (!counter) throw new Error("No se pudo asignar el número de la hoja de reclamación")
      const [row] = await sp
        .insert(consumerComplaint)
        .values({
          number: `${counter.year}-${String(counter.value).padStart(6, "0")}`,
          year: counter.year,
          submissionId: data.submissionId,
          kind: data.kind,
          consumerName: data.consumerName,
          consumerAddress: data.consumerAddress,
          documentType: data.documentType,
          documentNumber: data.documentNumber,
          phone: data.phone,
          email: data.email.toLowerCase(),
          isMinor: data.isMinor,
          guardianName: data.isMinor ? (data.guardianName ?? null) : null,
          itemType: data.itemType,
          itemDescription: data.itemDescription,
          amountMinor: amount,
          amountCurrency: amount === null ? null : (data.currency ?? null),
          detail: data.detail,
          request: data.request,
          privacyAcceptedAt: sql`now()`,
        })
        .returning()
      if (!row) throw new Error("No se pudo guardar la hoja de reclamación")
      return row
    })
    return { sheet, created: true }
  } catch (error) {
    if (violates(error, "consumer_complaint_submission_unique")) {
      const again = await findBySubmission(tx, data.submissionId)
      if (again) return { sheet: again, created: false }
    }
    throw error
  }
}

/** Marca que la copia de la hoja llegó al servidor de correo del consumidor. */
export async function markComplaintEmailSent(tx: Db, id: string): Promise<void> {
  const rows = await tx
    .update(consumerComplaint)
    .set({ emailSent: true, updatedAt: sql`now()` })
    .where(eq(consumerComplaint.id, id))
    .returning({ id: consumerComplaint.id })
  if (rows.length === 0) throw notFound("Hoja de reclamación")
}

// --- Correos -----------------------------------------------------------------

/** Fecha y hora de la hoja como la ve el consumidor en Perú. */
export function formatComplaintDate(date: Date): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    dateStyle: "long",
    timeStyle: "short",
  }).format(date)
}

/** Monto con su moneda («S/ 150.50»), o null si no se reclamó un monto. */
export function formatComplaintAmount(
  sheet: Pick<ConsumerComplaintSheet, "amountMinor" | "amountCurrency">,
): string | null {
  if (sheet.amountMinor === null || !sheet.amountCurrency) return null
  const symbol =
    CURRENCY_LABELS[sheet.amountCurrency as keyof typeof CURRENCY_LABELS] ?? sheet.amountCurrency
  const whole = Math.floor(sheet.amountMinor / 100)
  const cents = String(sheet.amountMinor % 100).padStart(2, "0")
  return `${symbol} ${whole}.${cents}`
}

/** Filas de la hoja en el orden del Anexo I, con sus etiquetas. */
function sheetSections(
  sheet: ConsumerComplaintSheet,
): { title: string; rows: [string, string][] }[] {
  const consumer: [string, string][] = [
    ["Nombre completo", sheet.consumerName],
    ["Domicilio", sheet.consumerAddress],
    [
      "Documento",
      `${DOCUMENT_LABELS[sheet.documentType as ConsumerComplaintDocumentType] ?? sheet.documentType} ${sheet.documentNumber}`,
    ],
    ["Teléfono", sheet.phone],
    ["Correo electrónico", sheet.email],
  ]
  if (sheet.isMinor) {
    consumer.push(["Menor de edad", "Sí"], ["Padre, madre o apoderado", sheet.guardianName ?? ""])
  }
  return [
    {
      title: "Datos del proveedor",
      rows: [
        ["Razón social", CONSUMER_COMPLAINT_PROVIDER.legalName],
        ["RUC", CONSUMER_COMPLAINT_PROVIDER.ruc],
        ["Domicilio", CONSUMER_COMPLAINT_PROVIDER.address],
      ],
    },
    { title: "1. Identificación del consumidor reclamante", rows: consumer },
    {
      title: "2. Identificación del bien contratado",
      rows: [
        ["Tipo", ITEM_LABELS[sheet.itemType as keyof typeof ITEM_LABELS] ?? sheet.itemType],
        ["Monto reclamado", formatComplaintAmount(sheet) ?? "No indicado"],
        ["Descripción", sheet.itemDescription],
      ],
    },
    {
      title: "3. Detalle de la reclamación y pedido del consumidor",
      rows: [
        ["Tipo", KIND_LABELS[sheet.kind as ConsumerComplaintKind] ?? sheet.kind],
        ["Detalle", sheet.detail],
        ["Pedido", sheet.request],
      ],
    },
    {
      title: "4. Observaciones y acciones adoptadas por el proveedor",
      rows: [
        sheet.providerResponse === null
          ? ["Estado", "Pendiente: te responderemos por correo."]
          : ["Respuesta", sheet.providerResponse],
      ],
    },
  ]
}

const NOTICES = [
  `El proveedor debe responder en un plazo no mayor a quince (${CONSUMER_COMPLAINT_RESPONSE_DAYS}) días hábiles improrrogables.`,
  "La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante el INDECOPI.",
]

/** Lo que acompaña a todo correo del libro: el buzón que recibe respuestas y dónde se atiende. */
export interface ConsumerComplaintMailOptions {
  /** Buzón de reclamos: quien reclama responde a él. Sin él, el correo dice que no se responde. */
  replyTo?: string | undefined
  /** Reclamaciones en la administración: el botón de los avisos internos. */
  reviewUrl?: string | undefined
}

type SheetQuote = { title: string; text: string; caption: string }

/** La copia para quien reclama: la hoja completa, sin botón, con su fecha y los textos de la norma. */
function sheetEmail(
  sheet: ConsumerComplaintSheet,
  input: { subject: string; preview: string; intro: string; quote?: SheetQuote },
  options: ConsumerComplaintMailOptions,
): MailTemplate {
  return renderEmail({
    subject: input.subject,
    preview: input.preview,
    eyebrow: "Libro de Reclamaciones virtual",
    title: `Hoja de Reclamación N.º ${sheet.number}`,
    paragraphs: [`Fecha: ${formatComplaintDate(sheet.createdAt)}`, input.intro],
    ...(input.quote ? { quote: input.quote } : {}),
    sections: sheetSections(sheet),
    notices: NOTICES,
    reason: "Te escribimos porque registraste esta hoja en el Libro de Reclamaciones de odentIA.",
    ...(options.replyTo
      ? { replyTo: options.replyTo, replies: "Si respondes este correo, llega a quien atiende los reclamos." }
      : {}),
  })
}

/** El aviso al buzón de reclamos de odentIA: interno, con la hoja debajo y el botón a Reclamaciones. */
function internalSheetEmail(
  sheet: ConsumerComplaintSheet,
  input: { subject: string; title: string; intro: string; quote?: SheetQuote },
  options: ConsumerComplaintMailOptions,
): MailTemplate {
  return renderEmail({
    subject: input.subject,
    preview: input.intro,
    internal: "Reclamos",
    title: input.title,
    paragraphs: [input.intro, `Fecha de la hoja: ${formatComplaintDate(sheet.createdAt)}`],
    ...(input.quote ? { quote: input.quote } : {}),
    sections: sheetSections(sheet),
    ...(options.reviewUrl ? { action: { label: "Abrir en Reclamaciones", url: options.reviewUrl } } : {}),
    reason: "Aviso interno del equipo de odentIA: cada hoja del Libro de Reclamaciones llega a este buzón.",
  })
}

/**
 * Copia para el consumidor (obligatoria) y aviso para odentIA. Todo lo escrito
 * por el consumidor va escapado en el HTML.
 */
export function consumerComplaintEmails(
  sheet: ConsumerComplaintSheet,
  options: ConsumerComplaintMailOptions = {},
): {
  copy: MailTemplate
  notice: MailTemplate
} {
  const kind = KIND_LABELS[sheet.kind as ConsumerComplaintKind] ?? sheet.kind
  return {
    copy: sheetEmail(
      sheet,
      {
        subject: `Copia de tu Hoja de Reclamación N.º ${sheet.number}`,
        preview: `Guárdala: te responderemos en un plazo no mayor a ${CONSUMER_COMPLAINT_RESPONSE_DAYS} días hábiles.`,
        intro: `Recibimos tu ${kind.toLowerCase()}. Esta es la copia de tu Hoja de Reclamación del Libro de Reclamaciones virtual de odentIA. Guárdala: te responderemos a este correo.`,
      },
      options,
    ),
    notice: internalSheetEmail(
      sheet,
      {
        subject: `Libro de Reclamaciones: ${kind} N.º ${sheet.number}`,
        title: `${kind} N.º ${sheet.number}`,
        intro: `Llegó un ${kind.toLowerCase()} al Libro de Reclamaciones. Hay que responder en un plazo no mayor a ${CONSUMER_COMPLAINT_RESPONSE_DAYS} días hábiles.`,
      },
      options,
    ),
  }
}

// --- Respuesta desde la administración --------------------------------------
//
// El personal de odentIA (Administración y Soporte) lee las hojas y las
// responde dentro del plazo, con `ownerDb` y auditado en `admin_audit`. Lo
// enviado no cambia: la base lo impide (migración 0006).

/** Quedan estos días hábiles o menos: la hoja se marca «por vencer». */
export const CONSUMER_COMPLAINT_DUE_SOON_DAYS = 5
export const CONSUMER_COMPLAINT_RESPONSE_LIMIT = 3000

/** Plazo de una hoja según los días hábiles de Perú. */
export interface ConsumerComplaintTimeline {
  /** Último día para responder (día civil de Lima, ISO 8601). */
  dueDate: string
  /** Días hábiles después de hoy y hasta el último día; 0 si vence hoy o ya venció. */
  daysLeft: number
  /** Sin responder y el último día ya pasó. */
  overdue: boolean
  /** Respondida a tiempo; null mientras no se responda. */
  respondedOnTime: boolean | null
}

/**
 * El plazo cuenta desde el día hábil siguiente a la hoja: la del viernes
 * empieza a contar el lunes. El día 15 es el último para responder.
 */
export function consumerComplaintTimeline(
  sheet: Pick<ConsumerComplaintSheet, "createdAt" | "respondedAt">,
  now: Date,
): ConsumerComplaintTimeline {
  const dueDate = addPeruBusinessDays(limaDate(sheet.createdAt), CONSUMER_COMPLAINT_RESPONSE_DAYS)
  const today = limaDate(now)
  const responded = sheet.respondedAt ? limaDate(sheet.respondedAt) : null
  return {
    dueDate,
    daysLeft: peruBusinessDaysBetween(today, dueDate),
    overdue: responded === null && today > dueDate,
    respondedOnTime: responded === null ? null : responded <= dueDate,
  }
}

function assertStaff(actor: AdminActor): void {
  if (!isAdminRole(actor.role)) {
    throw new ServiceError("FORBIDDEN", 403, "Solo el equipo de odentIA")
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CONSUMER_COMPLAINT_STATUS_FILTERS = ["recibido", "respondido", "todas"] as const
export type ConsumerComplaintStatusFilter = (typeof CONSUMER_COMPLAINT_STATUS_FILTERS)[number]

export interface ConsumerComplaintListFilters {
  status?: ConsumerComplaintStatusFilter
  /** Número de hoja, nombre o documento de quien reclamó. */
  search?: string
  limit?: number
  offset?: number
}

export interface ConsumerComplaintListItem {
  id: string
  number: string
  createdAt: Date
  kind: string
  consumerName: string
  status: string
  respondedAt: Date | null
  responseEmailSent: boolean
  timeline: ConsumerComplaintTimeline
}

export interface ConsumerComplaintSummary {
  pending: number
  dueSoon: number
  overdue: number
}

/**
 * Hojas sin responder: cuántas, cuántas vencen pronto y cuántas vencieron.
 * Solo cuenta, sin datos de nadie: no se audita (la usan el menú e Inicio).
 */
export async function consumerComplaintSummary(
  tx: Db,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<ConsumerComplaintSummary> {
  assertStaff(actor)
  const rows = await tx
    .select({ createdAt: consumerComplaint.createdAt })
    .from(consumerComplaint)
    .where(eq(consumerComplaint.status, "recibido"))
  const summary: ConsumerComplaintSummary = { pending: rows.length, dueSoon: 0, overdue: 0 }
  for (const row of rows) {
    const timeline = consumerComplaintTimeline({ createdAt: row.createdAt, respondedAt: null }, now)
    if (timeline.overdue) summary.overdue++
    else if (timeline.daysLeft <= CONSUMER_COMPLAINT_DUE_SOON_DAYS) summary.dueSoon++
  }
  return summary
}

/**
 * Lista del libro. Sin responder, primero la que vence antes (el plazo sigue
 * el orden de llegada); respondidas, la más reciente primero; en «todas», las
 * pendientes arriba.
 */
export async function listConsumerComplaints(
  tx: Db,
  actor: AdminActor,
  filters: ConsumerComplaintListFilters = {},
  now: Date = new Date(),
): Promise<{
  items: ConsumerComplaintListItem[]
  total: number
  summary: ConsumerComplaintSummary
}> {
  assertStaff(actor)
  const status = filters.status ?? "recibido"
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)
  const conditions: (SQL | undefined)[] = [
    status === "todas" ? undefined : eq(consumerComplaint.status, status),
  ]
  const search = filters.search?.trim()
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    conditions.push(
      or(
        ilike(consumerComplaint.number, pattern),
        ilike(consumerComplaint.consumerName, pattern),
        ilike(consumerComplaint.documentNumber, pattern),
      ),
    )
  }
  const pendingFirst = sql`case when ${consumerComplaint.status} = 'recibido' then 0 else 1 end`
  const order =
    status === "recibido"
      ? [asc(consumerComplaint.createdAt)]
      : status === "respondido"
        ? [desc(consumerComplaint.respondedAt)]
        : [
            pendingFirst,
            sql`case when ${consumerComplaint.status} = 'recibido' then ${consumerComplaint.createdAt} end asc`,
            desc(consumerComplaint.createdAt),
          ]
  const where = and(...conditions)
  const rows = await tx
    .select()
    .from(consumerComplaint)
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset)
  const [totalRow] = await tx.select({ total: count() }).from(consumerComplaint).where(where)
  await writeAdminAudit(tx, actor, {
    action: "consumer_complaint.list",
    metadata: { status, searched: Boolean(search), results: rows.length },
  })
  return {
    items: rows.map((row) => ({
      id: row.id,
      number: row.number,
      createdAt: row.createdAt,
      kind: row.kind,
      consumerName: row.consumerName,
      status: row.status,
      respondedAt: row.respondedAt,
      responseEmailSent: row.responseEmailSent,
      timeline: consumerComplaintTimeline(row, now),
    })),
    total: totalRow?.total ?? 0,
    summary: await consumerComplaintSummary(tx, actor, now),
  }
}

export interface ConsumerComplaintDetail extends ConsumerComplaintSheet {
  respondedByName: string | null
  timeline: ConsumerComplaintTimeline
}

async function findDetail(tx: Db, id: string, now: Date): Promise<ConsumerComplaintDetail | null> {
  if (!UUID.test(id)) return null
  const [row] = await tx
    .select({ sheet: consumerComplaint, respondedByName: user.name })
    .from(consumerComplaint)
    .leftJoin(user, eq(user.id, consumerComplaint.respondedByUserId))
    .where(eq(consumerComplaint.id, id))
    .limit(1)
  if (!row) return null
  return {
    ...row.sheet,
    respondedByName: row.respondedByName ?? null,
    timeline: consumerComplaintTimeline(row.sheet, now),
  }
}

/** Hoja completa para el personal. Ver los datos de quien reclamó queda auditado. */
export async function getConsumerComplaint(
  tx: Db,
  actor: AdminActor,
  id: string,
  now: Date = new Date(),
): Promise<ConsumerComplaintDetail> {
  assertStaff(actor)
  const detail = await findDetail(tx, id, now)
  if (!detail) throw notFound("Hoja de reclamación")
  await writeAdminAudit(tx, actor, {
    action: "consumer_complaint.view",
    entityId: detail.id,
    metadata: { number: detail.number },
  })
  return detail
}

/** Cuerpo de la respuesta. La ruta lo usa para validar y el servicio vuelve a aplicarlo. */
export const consumerComplaintResponseSchema = z.strictObject({
  response: z
    .string({ error: "Escribe la respuesta" })
    .trim()
    .min(10, "Escribe la respuesta: qué hicieron y qué le responden")
    .max(
      CONSUMER_COMPLAINT_RESPONSE_LIMIT,
      `Usa como máximo ${CONSUMER_COMPLAINT_RESPONSE_LIMIT} caracteres en la respuesta`,
    ),
})

/**
 * Responde una hoja: llena el bloque 4, la pasa a «respondido» y anota quién
 * respondió. El cambio es condicional, así dos personas que envían a la vez no
 * se pisan: la segunda recibe un conflicto con el nombre de quien respondió.
 * El correo lo envía quien llama, después de confirmar la transacción.
 */
export async function respondConsumerComplaint(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: unknown,
  now: Date = new Date(),
): Promise<ConsumerComplaintDetail> {
  assertStaff(actor)
  const parsed = consumerComplaintResponseSchema.safeParse(input)
  if (!parsed.success) {
    throw validation(parsed.error.issues[0]?.message ?? "Revisa la respuesta")
  }
  if (!UUID.test(id)) throw notFound("Hoja de reclamación")
  const updated = await tx
    .update(consumerComplaint)
    .set({
      status: "respondido",
      providerResponse: parsed.data.response,
      respondedAt: sql`now()`,
      respondedByUserId: actor.userId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(consumerComplaint.id, id), eq(consumerComplaint.status, "recibido")))
    .returning({ id: consumerComplaint.id })
  const detail = await findDetail(tx, id, now)
  if (!detail) throw notFound("Hoja de reclamación")
  if (updated.length === 0) {
    throw new ServiceError(
      "ALREADY_RESPONDED",
      409,
      `${detail.respondedByName ?? "Otra persona del equipo"} ya respondió esta hoja`,
    )
  }
  await writeAdminAudit(tx, actor, {
    action: "consumer_complaint.respond",
    entityId: detail.id,
    // Sin el texto: la auditoría no copia lo que se le respondió a la persona.
    metadata: { number: detail.number, onTime: detail.timeline.respondedOnTime },
  })
  return detail
}

/**
 * Antes de reenviar a mano la respuesta: solo si la hoja está respondida y su
 * correo no salió. Deja en la auditoría quién lo reenvía.
 */
export async function prepareComplaintResponseResend(
  tx: Db,
  actor: AdminActor,
  id: string,
  now: Date = new Date(),
): Promise<ConsumerComplaintDetail> {
  assertStaff(actor)
  const detail = await findDetail(tx, id, now)
  if (!detail) throw notFound("Hoja de reclamación")
  if (detail.status !== "respondido") {
    throw new ServiceError("NOT_RESPONDED", 409, "Esta hoja aún no tiene respuesta")
  }
  if (detail.responseEmailSent) {
    throw new ServiceError("RESPONSE_EMAIL_SENT", 409, "La respuesta ya salió por correo")
  }
  await writeAdminAudit(tx, actor, {
    action: "consumer_complaint.response_email.resend",
    entityId: detail.id,
    metadata: { number: detail.number },
  })
  return detail
}

/** Marca que la respuesta llegó al servidor de correo de quien reclamó. */
export async function markComplaintResponseEmailSent(tx: Db, id: string): Promise<void> {
  const rows = await tx
    .update(consumerComplaint)
    .set({ responseEmailSent: true, updatedAt: sql`now()` })
    .where(and(eq(consumerComplaint.id, id), eq(consumerComplaint.status, "respondido")))
    .returning({ id: consumerComplaint.id })
  if (rows.length === 0) throw notFound("Hoja de reclamación respondida")
}

/**
 * Respuesta para quien reclamó (arriba la respuesta, debajo su hoja completa
 * con el bloque 4 lleno) y su copia para el buzón de reclamos de odentIA. Lo
 * escrito por personas va escapado.
 */
export function consumerComplaintResponseEmails(
  sheet: ConsumerComplaintSheet,
  options: ConsumerComplaintMailOptions = {},
): {
  response: MailTemplate
  copy: MailTemplate
} {
  if (sheet.providerResponse === null || sheet.respondedAt === null) {
    throw new Error("La hoja aún no tiene respuesta")
  }
  const kind = (KIND_LABELS[sheet.kind as ConsumerComplaintKind] ?? sheet.kind).toLowerCase()
  const quote: SheetQuote = {
    title: "Nuestra respuesta",
    text: sheet.providerResponse,
    // «10:00 a. m.» ya termina en punto: no se dobla.
    caption: `Respondida el ${formatComplaintDate(sheet.respondedAt)}`.replace(/\.?$/, "."),
  }
  return {
    response: sheetEmail(
      sheet,
      {
        subject: `Respuesta a tu Hoja de Reclamación N.º ${sheet.number}`,
        preview: `Respondemos tu ${kind}: la respuesta y tu hoja completa.`,
        intro: `Respondemos tu ${kind}. Abajo está nuestra respuesta y, debajo, tu hoja completa como la enviaste.`,
        quote,
      },
      options,
    ),
    copy: internalSheetEmail(
      sheet,
      {
        subject: `Libro de Reclamaciones: respuesta a la hoja N.º ${sheet.number}`,
        title: `Respuesta a la hoja N.º ${sheet.number}`,
        intro: `Copia de la respuesta enviada a ${sheet.email}.`,
        quote,
      },
      options,
    ),
  }
}
