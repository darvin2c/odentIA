// Solo para pruebas: deja una solicitud como las que llegaban de la web antes del alta libre
// (ADR 0221). La ruta pública ya no existe, pero el ARM sigue atendiendo las solicitudes que
// quedaron en la base, y sus pruebas las arman con esto.
import { type ClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { SAAS_WAITLIST_PROFESSIONALS, SAAS_WAITLIST_TOOLS, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { clientForWaitlistRequest } from "./admin-clients.js"
import { ServiceError, validation } from "./errors.js"
import { guideSheetsFor } from "./products.js"
import { saasTermsAt } from "./saas-commercial-terms.js"
import { webPageOf } from "./saas-founders.js"

const text = (min: number, max: number, what: string) =>
  z
    .string({ error: `Escribe ${what}` })
    .trim()
    .min(min, `Escribe ${what}`)
    .max(max, `Usa como máximo ${max} caracteres`)

export const waitlistInputSchema = z.strictObject({
  firstName: text(1, 80, "tu nombre"),
  lastName: text(1, 80, "tus apellidos"),
  email: z
    .string({ error: "Escribe tu correo" })
    .trim()
    .toLowerCase()
    .pipe(z.email("Escribe un correo válido, como nombre@clinica.com")),
  /** Con el código del país, como lo muestra el formulario: «+51 987 654 321». */
  phone: z
    .string({ error: "Escribe tu celular" })
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, "Escribe un celular válido, solo con números")
    .transform((value) => value.replace(/[ ()-]/g, "")),
  clinicName: text(1, 120, "el nombre de la clínica"),
  countryCode: z
    .string({ error: "Elige el país" })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Elige el país"),
  city: text(1, 80, "la ciudad"),
  professionals: z.enum(SAAS_WAITLIST_PROFESSIONALS, "Elige cuántos odontólogos atienden"),
  currentTool: z.enum(SAAS_WAITLIST_TOOLS, "Elige qué usan hoy"),
})
export type WaitlistInput = z.input<typeof waitlistInputSchema>

/**
 * La solicitud de un producto: pregunta por quien atiende con su palabra
 * («cuántos médicos» en latidIA; decisión 17 del issue 229).
 */
export function waitlistInputSchemaFor(product: ClinicalProduct) {
  return waitlistInputSchema.extend({
    professionals: z.enum(SAAS_WAITLIST_PROFESSIONALS, `Elige cuántos ${productWords(product).clinician.many} atienden`),
  })
}

export interface WaitlistSubmitResult {
  id: string
  /** El cliente del ARM de la solicitud: el aviso al buzón comercial abre su ficha. */
  clientId: string | null
  /** Ya había una solicitud viva con ese correo: no se duplica ni se vuelve a escribir. */
  existing: boolean
  /** Días hábiles que se prometen para responderla: los que regían cuando llegó. */
  answerDays: number
}

/**
 * Deja la solicitud en la lista, con el producto del dominio donde se pidió.
 * Un mismo correo con una solicitud viva (por revisar o invitada) no crea
 * otra: se devuelve la que hay. En la misma transacción la solicitud queda
 * con su cliente del ARM (`clientForWaitlistRequest`: el que ya tiene a esa
 * persona, o uno nuevo que llegó por la web) y su persona como contacto.
 */
export async function submitWaitlistRequest(
  tx: Db,
  input: WaitlistInput,
  product: ClinicalProduct = "dental",
  options: { sourcePage?: string | null } = {},
): Promise<WaitlistSubmitResult> {
  const parsed = waitlistInputSchemaFor(product).safeParse(input)
  if (!parsed.success) throw validation(parsed.error.issues[0]?.message ?? "Revisa los datos de la solicitud")
  const data = parsed.data
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${data.email}`}, 0))`)
  const [alive] = await tx
    .select({ id: saasWaitlistRequest.id, clientId: saasWaitlistRequest.clientId, createdAt: saasWaitlistRequest.createdAt })
    .from(saasWaitlistRequest)
    .where(and(eq(saasWaitlistRequest.email, data.email), inArray(saasWaitlistRequest.status, ["por_revisar", "invitada"])))
    .limit(1)
  if (alive) return { id: alive.id, clientId: alive.clientId, existing: true, answerDays: (await saasTermsAt(tx, alive.createdAt)).waitlistAnswerDays }
  // Solo una guía que existe: la administración la muestra como enlace (ADR 0216).
  const page = webPageOf(options.sourcePage)
  const sourcePage = page && guideSheetsFor(product)?.pages.includes(page) ? page : null
  const clientId = await clientForWaitlistRequest(tx, { ...data, product, sourcePage })
  const [row] = await tx
    .insert(saasWaitlistRequest)
    .values({ ...data, product, clientId, source: "web", sourcePage })
    .returning({ id: saasWaitlistRequest.id, createdAt: saasWaitlistRequest.createdAt })
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo guardar la solicitud")
  return { id: row.id, clientId, existing: false, answerDays: (await saasTermsAt(tx, row.createdAt)).waitlistAnswerDays }
}

