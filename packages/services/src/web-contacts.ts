/**
 * El aviso de las guías de la web (ADR 0214): quien bajó una plantilla deja su correo, si
 * quiere, y le llegan las plantillas con la puerta para pedir entrar. Entra al ARM como un
 * cliente con su contacto y la guía de la que llegó, sin abrir una venta.
 *
 * Una vez por dirección al día: ni el aviso repetido ni alguien que use la web para
 * escribirle a otro manda más de un correo. Con una solicitud viva no se hace nada: ya
 * está en la lista.
 */
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasWebContact } from "@odentia/db/schema/admin-arm"
import { saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import { clientForWebContact } from "./admin-clients.js"
import { BLANK_SHEET_KEYS, type BlankSheet } from "./blank-sheets.js"
import { webPageOf } from "./saas-founders.js"

const DAY_MS = 24 * 60 * 60 * 1000
/** Un correo que está saliendo cuenta como enviado: dos pestañas a la vez no mandan dos. */
const IN_FLIGHT_MS = 2 * 60 * 1000

export const webContactInputSchema = z.strictObject({
  email: z
    .string({ error: "Escribe tu correo" })
    .trim()
    .toLowerCase()
    .pipe(z.email("Escribe un correo válido, como nombre@clinica.com")),
  /** La guía donde lo dejó: solo una página de las guías. */
  page: z.string({ error: "Falta la guía" }).transform((value, ctx) => {
    const page = webPageOf(value)
    if (!page || !page.startsWith("/guias/")) {
      ctx.addIssue({ code: "custom", message: "Esa página no es una guía" })
      return z.NEVER
    }
    return page
  }),
  /** Las plantillas de esa guía, que le llegan adjuntas. */
  sheets: z
    .array(z.enum(BLANK_SHEET_KEYS as [BlankSheet, ...BlankSheet[]]), {
      error: "Faltan las plantillas",
    })
    .min(1)
    .max(BLANK_SHEET_KEYS.length)
    .transform((sheets) => [...new Set(sheets)]),
  /** El campo trampa: una persona no lo ve ni lo llena. */
  website: z.string().max(200).optional(),
})
export type WebContactInput = z.input<typeof webContactInputSchema>

export type WebContactResult =
  | { send: true; contactId: string; clientId: string; sheets: BlankSheet[] }
  /** «solicitud»: ya tiene una solicitud viva; «reciente»: ya se le mandó hoy (o está saliendo). */
  | { send: false; reason: "solicitud" | "reciente" }

/**
 * Deja el correo del aviso: con el mismo candado que la solicitud de ese correo, así una y
 * otra no se cruzan. Si hay que mandarle las plantillas, la fila queda sin `sent_at` hasta
 * que el correo sale (`markWebContactSent`).
 */
export async function submitWebContact(
  tx: Db,
  input: z.output<typeof webContactInputSchema>,
  product: ClinicalProduct,
  now = new Date(),
): Promise<WebContactResult> {
  const email = input.email
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${email}`}, 0))`)
  const [alive] = await tx
    .select({ id: saasWaitlistRequest.id })
    .from(saasWaitlistRequest)
    .where(
      and(
        eq(saasWaitlistRequest.email, email),
        inArray(saasWaitlistRequest.status, ["por_revisar", "invitada"]),
      ),
    )
    .limit(1)
  if (alive) return { send: false, reason: "solicitud" }
  const [recent] = await tx
    .select({ id: saasWebContact.id })
    .from(saasWebContact)
    .where(
      and(
        eq(saasWebContact.email, email),
        or(
          gt(saasWebContact.sentAt, new Date(now.getTime() - DAY_MS)),
          and(
            isNull(saasWebContact.sentAt),
            gt(saasWebContact.createdAt, new Date(now.getTime() - IN_FLIGHT_MS)),
          ),
        ),
      ),
    )
    .limit(1)
  if (recent) return { send: false, reason: "reciente" }
  const { clientId } = await clientForWebContact(
    tx,
    { email, product, sourcePage: input.page },
    now,
  )
  const [row] = await tx
    .insert(saasWebContact)
    .values({
      email,
      product,
      sourcePage: input.page,
      sheets: input.sheets,
      clientId,
      createdAt: now,
    })
    .returning({ id: saasWebContact.id })
  if (!row) throw new Error("No se pudo guardar el correo del aviso")
  return { send: true, contactId: row.id, clientId, sheets: input.sheets }
}

/** El correo con las plantillas salió: desde ahora cuenta para el tope del día. */
export async function markWebContactSent(tx: Db, id: string, now = new Date()): Promise<void> {
  await tx
    .update(saasWebContact)
    .set({ sentAt: now })
    .where(and(eq(saasWebContact.id, id), isNull(saasWebContact.sentAt)))
}
