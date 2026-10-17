// Libro de Reclamaciones virtual de odentIA (Perú). Norma: Código de Protección
// y Defensa del Consumidor (Ley 29571) y Reglamento del Libro de Reclamaciones
// (D.S. 011-2011-PCM, modificado por D.S. 006-2014-PCM y D.S. 101-2022-PCM).
//
// Es de la plataforma, no de una clínica: la hoja se guarda en tablas globales
// que solo toca el rol owner (migración 0099). La API pública es la única que
// escribe aquí y lo hace con `ownerDb.transaction`.
import type { Db } from "@odentia/db"
import { consumerComplaint, consumerComplaintCounter } from "@odentia/db/schema/consumer-complaints"
import { escapeHtml, type MailTemplate } from "@odentia/mail"
import { eq, sql } from "drizzle-orm"
import { z } from "zod"
import { notFound, validation } from "./errors.js"

/**
 * Datos del proveedor que encabezan la Hoja de Reclamación (Anexo I).
 * Una sola constante para el correo; la web tiene la suya en
 * `apps/web/src/lib/complaints.ts` y deben decir lo mismo. Mientras falten los
 * datos reales, los marcadores se ven tal cual.
 */
export const CONSUMER_COMPLAINT_PROVIDER = {
  legalName: "[Por completar: razón social]",
  ruc: "[Por completar: RUC]",
  address: "[Por completar: domicilio]",
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
      rows: [["Estado", sheet.providerResponse ?? "Pendiente: te responderemos por correo."]],
    },
  ]
}

const NOTICES = [
  `El proveedor debe responder en un plazo no mayor a quince (${CONSUMER_COMPLAINT_RESPONSE_DAYS}) días hábiles improrrogables.`,
  "La formulación del reclamo no impide acudir a otras vías de solución de controversias ni es requisito previo para interponer una denuncia ante el INDECOPI.",
]

function sheetText(sheet: ConsumerComplaintSheet): string {
  const lines = [
    `Hoja de Reclamación N.º ${sheet.number}`,
    `Fecha: ${formatComplaintDate(sheet.createdAt)}`,
    "",
  ]
  for (const section of sheetSections(sheet)) {
    lines.push(section.title.toUpperCase())
    for (const [label, value] of section.rows) lines.push(`${label}: ${value}`)
    lines.push("")
  }
  lines.push(...NOTICES)
  return lines.join("\n")
}

function sheetHtml(sheet: ConsumerComplaintSheet, intro: string): string {
  const sections = sheetSections(sheet)
    .map(
      (section) =>
        `<h2 style="margin:24px 0 8px;font-size:15px">${escapeHtml(section.title)}</h2>` +
        `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.5">${section.rows
          .map(
            ([label, value]) =>
              `<tr><th style="text-align:left;vertical-align:top;padding:4px 12px 4px 0;width:38%;color:#475569;font-weight:600">${escapeHtml(label)}</th>` +
              `<td style="padding:4px 0;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`,
          )
          .join("")}</table>`,
    )
    .join("")
  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;color:#18181b">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
      <h1 style="margin:0 0 4px;font-size:20px">Hoja de Reclamación N.º ${escapeHtml(sheet.number)}</h1>
      <p style="margin:0 0 16px;font-size:14px;color:#475569">Fecha: ${escapeHtml(formatComplaintDate(sheet.createdAt))}</p>
      <p style="margin:0;font-size:14px;line-height:1.6">${escapeHtml(intro)}</p>
      ${sections}
      ${NOTICES.map((n) => `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#475569">${escapeHtml(n)}</p>`).join("")}
    </div>
  </body>
</html>`
}

/**
 * Copia para el consumidor (obligatoria) y aviso para odentIA. Todo lo escrito
 * por el consumidor va escapado en el HTML.
 */
export function consumerComplaintEmails(sheet: ConsumerComplaintSheet): {
  copy: MailTemplate
  notice: MailTemplate
} {
  const kind = KIND_LABELS[sheet.kind as ConsumerComplaintKind] ?? sheet.kind
  const copyIntro = `Recibimos tu ${kind.toLowerCase()}. Esta es la copia de tu Hoja de Reclamación del Libro de Reclamaciones virtual de odentIA. Guárdala: te responderemos a este correo.`
  const noticeIntro = `Llegó un ${kind.toLowerCase()} al Libro de Reclamaciones. Hay que responder en un plazo no mayor a ${CONSUMER_COMPLAINT_RESPONSE_DAYS} días hábiles.`
  return {
    copy: {
      subject: `Copia de tu Hoja de Reclamación N.º ${sheet.number} — odentIA`,
      text: `${copyIntro}\n\n${sheetText(sheet)}`,
      html: sheetHtml(sheet, copyIntro),
    },
    notice: {
      subject: `Libro de Reclamaciones: ${kind} N.º ${sheet.number}`,
      text: `${noticeIntro}\n\n${sheetText(sheet)}`,
      html: sheetHtml(sheet, noticeIntro),
    },
  }
}
