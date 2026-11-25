/**
 * El aviso de las guías de la web (ADR 0214): quien bajó una plantilla deja su correo, si
 * quiere, y le llegan las plantillas con la puerta para pedir entrar. Entra al ARM como un
 * cliente con su contacto y la guía de la que llegó, sin abrir una venta.
 *
 * Los topes viven en la base, para todos los procesos: un correo por buzón al día (el buzón
 * sin la «+etiqueta» ni, en Gmail, los puntos: `mailboxOf`) y unos pocos por hora entre
 * todos. Así nadie usa la web para mandarle muchos correos a otro. Un correo que no se sabe
 * si salió también cuenta: no se invita a reintentarlo. La respuesta no dice si ese correo
 * ya es cliente o ya pidió entrar.
 */
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { saasWebContact } from "@odentia/db/schema/admin-arm"
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm"
import { z } from "zod"
import { clientForWebContact } from "./admin-clients.js"
import { invalidField, ServiceError } from "./errors.js"
import { guideSheetsFor } from "./products.js"
import { webPageOf } from "./saas-founders.js"

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/**
 * Correos con plantillas por hora entre todos: de sobra para quien baja plantillas, poco para
 * quien quiera abusar del aviso cambiando de dirección. Pasado el tope, el aviso pide volver luego.
 */
export const WEB_CONTACTS_PER_HOUR = 20

/** Los dominios donde los puntos de la dirección no cambian el buzón. */
const DOTLESS_DOMAINS = new Set(["gmail.com", "googlemail.com"])

/**
 * El buzón al que llega una dirección: sin la «+etiqueta» y, en Gmail, sin los puntos.
 * `ana.perez+guias@gmail.com` y `anaperez@gmail.com` son el mismo buzón.
 */
export function mailboxOf(email: string): string {
  const address = email.trim().toLowerCase()
  const at = address.lastIndexOf("@")
  if (at <= 0) return address
  let local = address.slice(0, at).split("+")[0] || address.slice(0, at)
  let domain = address.slice(at + 1)
  if (DOTLESS_DOMAINS.has(domain)) {
    local = local.replaceAll(".", "") || local
    domain = "gmail.com"
  }
  return `${local}@${domain}`
}

export const webContactInputSchema = z.strictObject({
  email: z
    .string({ error: "Escribe tu correo" })
    .trim()
    .toLowerCase()
    .max(254, "Ese correo es demasiado largo")
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
  /** Las plantillas de esa guía, que le llegan adjuntas: las de su producto (`guideSheetsFor`). */
  sheets: z
    .array(z.string().regex(/^[a-z0-9-]{1,40}$/), { error: "Faltan las plantillas" })
    .min(1)
    .max(5)
    .transform((sheets) => [...new Set(sheets)]),
  /** El campo trampa: una persona no lo ve ni lo llena. */
  website: z.string().max(200).optional(),
})
export type WebContactInput = z.input<typeof webContactInputSchema>

/** Una plantilla para adjuntar: su clave, su archivo y su nombre en el correo. */
export type WebContactSheet = { key: string; file: string; title: string }

export type WebContactResult =
  | {
      send: true
      contactId: string
      /** Nulo si el correo es de varios clientes: no se elige uno. */
      clientId: string | null
      /** Ese correo ya es de una clínica con cuenta: el correo no la invita a pedir entrar. */
      hasAccount: boolean
      sheets: WebContactSheet[]
    }
  /** «reciente»: ese buzón ya pidió las plantillas hoy; «ocupado»: se llegó al tope de la hora. */
  | { send: false; reason: "reciente" | "ocupado" }

/**
 * Deja el correo del aviso. Con el candado del correo (el mismo de su solicitud: una y otra no
 * se cruzan) y uno de todos los avisos (los topes se cuentan sin carreras). Si hay que mandarle
 * las plantillas, la fila queda sin `sent_at` hasta que el correo sale (`markWebContactSent`);
 * si nunca sale, igual cuenta para el día.
 */
export async function submitWebContact(
  tx: Db,
  input: z.output<typeof webContactInputSchema>,
  product: ClinicalProduct,
  now = new Date(),
): Promise<WebContactResult> {
  const guide = guideSheetsFor(product)
  if (!guide) throw new ServiceError("NOT_FOUND", 404, "Esta web no tiene guías")
  const sheets: WebContactSheet[] = []
  for (const key of input.sheets) {
    const sheet = Object.hasOwn(guide.sheets, key) ? guide.sheets[key] : undefined
    if (!sheet) throw invalidField("sheets", "Esa plantilla no existe")
    sheets.push({ key, file: sheet.file, title: sheet.title })
  }
  const email = input.email
  const mailbox = mailboxOf(email)
  const since = (ms: number) =>
    and(gt(saasWebContact.createdAt, new Date(now.getTime() - ms)), lte(saasWebContact.createdAt, now))
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${email}`}, 0))`)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('saas-web-contact', 0))`)
  const [recent] = await tx
    .select({ id: saasWebContact.id })
    .from(saasWebContact)
    .where(and(eq(saasWebContact.mailbox, mailbox), since(DAY_MS)))
    .limit(1)
  if (recent) return { send: false, reason: "reciente" }
  const [hour] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(saasWebContact)
    .where(since(HOUR_MS))
  if ((hour?.n ?? 0) >= WEB_CONTACTS_PER_HOUR) return { send: false, reason: "ocupado" }
  const { clientId, hasAccount } = await clientForWebContact(tx, { email, product, sourcePage: input.page }, now)
  const [row] = await tx
    .insert(saasWebContact)
    .values({ email, mailbox, product, sourcePage: input.page, sheets: input.sheets, clientId, createdAt: now })
    .returning({ id: saasWebContact.id })
  if (!row) throw new Error("No se pudo guardar el correo del aviso")
  return { send: true, contactId: row.id, clientId, hasAccount, sheets }
}

/** El correo con las plantillas salió: queda en su historial como enviado. */
export async function markWebContactSent(tx: Db, id: string, now = new Date()): Promise<void> {
  await tx
    .update(saasWebContact)
    .set({ sentAt: now })
    .where(and(eq(saasWebContact.id, id), isNull(saasWebContact.sentAt)))
}
