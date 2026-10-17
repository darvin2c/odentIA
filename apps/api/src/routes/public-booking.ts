import { getConnInfo } from "@hono/node-server/conninfo"
import { registrationAnswersSchema } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import {
  cancelBookingLinkAppointment,
  changeBookingLinkAppointment,
  confirmBookingLinkAppointment,
  decidePersonalLinkBudget,
  decideSaasPublicAccess,
  getBookingLinkRegistrationForm,
  getPersonalLinkConsent,
  getPersonalLinkDataForm,
  getPersonalLinkPaper,
  getPersonalLinkQuestionnaire,
  getPersonalLinkView,
  listBookingLinkSlots,
  registerFromBookingLink,
  reserveBookingLink,
  ServiceError,
  setPersonalLinkMessages,
  signPersonalLinkConsent,
  submitPersonalLinkData,
  submitPersonalLinkQuestionnaire,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { errorBody } from "../lib/error.js"

const WINDOW_MS = 10 * 60 * 1000
const MAX_BUCKETS = 10000
const token = z.string().regex(/^[0-9a-f]{64}$/)
const slotsQuery = z.strictObject({ token, branchId: z.uuid(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
const reserveBody = z.strictObject({
  token,
  branchId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  dentistUserId: z.string().min(1).max(200),
  chairId: z.uuid().optional(),
  // «Elegir horario» de lo que aceptó en su presupuesto.
  planItemIds: z.array(z.uuid()).min(1).max(52).optional(),
})
const registrationBody = z.strictObject({
  token,
  submissionId: z.uuid(),
  formVersion: z.number().int().nonnegative(),
  answers: registrationAnswersSchema,
})
const shortText = (max: number) => z.string().trim().max(max)
const dataBody = z.strictObject({
  token,
  data: z.strictObject({
    givenNames: shortText(100).optional(),
    paternalSurname: shortText(100).optional(),
    maternalSurname: shortText(100).optional(),
    birthDate: shortText(10).optional(),
    docType: shortText(20).optional(),
    docNumber: shortText(20).optional(),
    docCountry: shortText(2).optional(),
    sex: shortText(10).optional(),
    phone: shortText(30).optional(),
    email: shortText(200).optional(),
    address: shortText(300).optional(),
    emergencyContactName: shortText(200).optional(),
    emergencyContactPhone: shortText(30).optional(),
    insuranceType: shortText(30).optional(),
  }),
  representative: z
    .strictObject({
      displayName: shortText(200).min(1),
      docType: shortText(20).optional(),
      docNumber: shortText(20).optional(),
      docCountry: shortText(2).optional(),
      phone: shortText(30).optional(),
      relationshipDetail: shortText(100).optional(),
    })
    .nullish(),
})
const decisionBody = z.strictObject({
  token,
  optionId: z.uuid().nullish(),
  decisions: z.array(z.strictObject({ planItemId: z.uuid(), decision: z.enum(["aceptado", "rechazado", "pospuesto"]) })).min(1).max(200),
})
const signBody = z.strictObject({
  token,
  docNumber: shortText(40).min(1),
  comprehensionConfirmed: z.boolean(),
  signatureData: z.unknown(),
})
const questionnaireBody = z.strictObject({ token, answers: z.record(z.string(), z.unknown()) })
// «Tus mensajes»: un interruptor o «ningún mensaje» (ADR 0040).
const messagesBody = z.strictObject({
  token,
  tipo: z.enum(["recordatorio", "seguimiento", "novedades", "ninguno"]),
  recibir: z.boolean(),
})
const paperQuery = z.strictObject({ token, kind: z.enum(["receta", "comprobante"]) })
export type BookingRemoteAddress = (c: Context) => string | undefined

/**
 * «Su enlace» (ADR 0037, que amplía el 0014): la página personal de cada
 * persona. Sin sesión; todo lo que puede hacer lo decide el enlace, y nunca
 * entrega lo guardado. Límites locales de una instancia, sin confiar en
 * cabeceras del cliente.
 */
export function createPublicBookingRoute(deps: { db: Db; secretsKey: Buffer; remoteAddress?: BookingRemoteAddress }) {
  const app = new Hono<{ Variables: { bookingOrganization: { id: string } } }>()
  const buckets = new Map<string, { expiresAt: number; get: number; post: number }>()
  const unavailable = (c: Context) => c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
  const address: BookingRemoteAddress =
    deps.remoteAddress ??
    ((c) => {
      try {
        return getConnInfo(c).remote.address
      } catch {
        return undefined
      }
    })
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  const tooLarge = (c: Context) => c.json(errorBody(c, "BODY_TOO_LARGE", "La solicitud excede el tamaño permitido"), 413)
  // La firma con el dedo pesa más que el resto: solo esa ruta admite más.
  const small = bodyLimit({ maxSize: 8 * 1024, onError: tooLarge })
  const signature = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge })
  app.use("*", (c, next) => (c.req.path.endsWith("/sign") ? signature(c, next) : small(c, next)))
  // Los errores inesperados no pasan al registro global: podrían llevar el enlace.
  app.onError((error, c) => {
    // Solo el tipo de error: el mensaje puede llevar la consulta y sus parámetros.
    console.error(`public-booking: ${error instanceof Error ? error.name : "error desconocido"}`)
    return c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500)
  })
  app.use("/:slug/*", limit)
  app.use("/:slug", limit)

  async function limit(c: Context, next: () => Promise<void>) {
    if (c.req.method !== "GET" && c.req.method !== "POST") return unavailable(c)
    const [org] = await deps.db.select({ id: organization.id }).from(organization).where(eq(organization.slug, c.req.param("slug") ?? "")).limit(1)
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key)
    const key = `${org?.id ?? "unknown"}:${address(c) ?? "shared"}`
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
      bucket = { expiresAt: now + WINDOW_MS, get: 0, post: 0 }
      buckets.set(key, bucket)
    }
    const method = c.req.method === "POST" ? "post" : "get"
    if (bucket[method] >= (method === "post" ? 30 : 240)) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return c.json(errorBody(c, "RATE_LIMITED", "Intenta nuevamente más tarde"), 429)
    }
    bucket[method]++
    if (!org) return unavailable(c)
    c.set("bookingOrganization", org)
    await next()
  }

  const answer = async (c: Context, status: 200 | 201, run: () => Promise<unknown>) => {
    try {
      return c.json({ data: await run() }, status)
    } catch (error) {
      if (error instanceof ServiceError) {
        if (error.status === 404) return unavailable(c)
        console.error(`public-booking: rechazo ${error.code}: ${error.message.slice(0, 200)}`)
        return c.json(errorBody(c, error.code, error.message), error.status)
      }
      throw error
    }
  }
  const bodyOf = (c: Context) => c.req.json().catch(() => null)
  const inOrg = <T>(c: Context, fn: (tx: Db, orgId: string) => Promise<T>) => {
    const org = c.get("bookingOrganization") as { id: string }
    return withOrgContext(deps.db, org.id, (tx) => fn(tx, org.id))
  }

  app.get("/:slug", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => getPersonalLinkView(tx, orgId, query.data.token)))
  })

  app.get("/:slug/slots", async (c) => {
    const query = slotsQuery.safeParse(c.req.query())
    if (!query.success) return c.json(errorBody(c, "VALIDATION", "Revisa las fechas pedidas"), 400)
    const { token: linkToken, ...range } = query.data
    return answer(c, 200, () => inOrg(c, (tx, orgId) => listBookingLinkSlots(tx, orgId, linkToken, range)))
  })

  // Quien aún no es paciente deja aquí sus datos esenciales: la ficha la crea el registro de pacientes.
  app.get("/:slug/registration", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => getBookingLinkRegistrationForm(tx, orgId, query.data.token)))
  })

  app.post("/:slug/registration", async (c) => {
    const body = registrationBody.safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tus datos"), 400)
    const { token: linkToken, ...input } = body.data
    return answer(c, 201, () => inOrg(c, (tx, orgId) => registerFromBookingLink(tx, orgId, linkToken, input)))
  })

  app.post("/:slug/reserve", async (c) => {
    const body = reserveBody.safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa el horario elegido"), 400)
    const { token: linkToken, ...choice } = body.data
    return answer(c, 201, () =>
      inOrg(c, async (tx, orgId) => {
        // Reservar nuevo se deniega en restricción/pausa (el paciente conserva
        // cambiar o cancelar lo ya reservado). Sin fila comercial: pasa.
        const access = await decideSaasPublicAccess(tx, orgId, "reservar")
        if (!access.allowed) {
          throw new ServiceError("SAAS_RESTRICTED", 403, "La clínica pausó las reservas en línea: escríbenos por otro canal")
        }
        return reserveBookingLink(tx, orgId, linkToken, choice, { secretsKey: deps.secretsKey })
      }),
    )
  })

  // Su cita: la cambia de horario, la cancela o la confirma mientras no haya empezado.
  app.post("/:slug/change", async (c) => {
    const body = reserveBody.omit({ branchId: true, planItemIds: true }).safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa el horario elegido"), 400)
    const { token: linkToken, ...choice } = body.data
    return answer(c, 200, () =>
      inOrg(c, (tx, orgId) => changeBookingLinkAppointment(tx, orgId, linkToken, choice, { secretsKey: deps.secretsKey })),
    )
  })

  app.post("/:slug/cancel", async (c) => {
    const body = z.strictObject({ token }).safeParse(await bodyOf(c))
    if (!body.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => cancelBookingLinkAppointment(tx, orgId, body.data.token, { secretsKey: deps.secretsKey })))
  })

  app.post("/:slug/confirm", async (c) => {
    const body = z.strictObject({ token }).safeParse(await bodyOf(c))
    if (!body.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => confirmBookingLinkAppointment(tx, orgId, body.data.token)))
  })

  // Tus datos: solo lo que falta, una sola vez.
  app.get("/:slug/data", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => getPersonalLinkDataForm(tx, orgId, query.data.token)))
  })

  app.post("/:slug/data", async (c) => {
    const body = dataBody.safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tus datos"), 400)
    const { token: linkToken, ...input } = body.data
    return answer(c, 201, () => inOrg(c, (tx, orgId) => submitPersonalLinkData(tx, orgId, linkToken, input)))
  })

  // Tu presupuesto: «Ver y responder».
  app.post("/:slug/budgets/:budgetId/decision", async (c) => {
    const params = z.object({ budgetId: z.uuid() }).safeParse({ budgetId: c.req.param("budgetId") })
    const body = decisionBody.safeParse(await bodyOf(c))
    if (!params.success || !body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tu respuesta"), 400)
    const { token: linkToken, ...decision } = body.data
    return answer(c, 200, () => inOrg(c, (tx, orgId) => decidePersonalLinkBudget(tx, orgId, linkToken, params.data.budgetId, decision)))
  })

  // Tu consentimiento: leer, escribir su documento y firmar.
  app.get("/:slug/consents/:consentId", async (c) => {
    const params = z.object({ consentId: z.uuid() }).safeParse({ consentId: c.req.param("consentId") })
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!params.success || !query.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => getPersonalLinkConsent(tx, orgId, query.data.token, params.data.consentId)))
  })

  app.post("/:slug/consents/:consentId/sign", async (c) => {
    const params = z.object({ consentId: z.uuid() }).safeParse({ consentId: c.req.param("consentId") })
    const body = signBody.safeParse(await bodyOf(c))
    if (!params.success || !body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tu firma"), 400)
    const { token: linkToken, ...input } = body.data
    return answer(c, 200, () => inOrg(c, (tx, orgId) => signPersonalLinkConsent(tx, orgId, linkToken, params.data.consentId, input)))
  })

  // Antes de tu cita: el cuestionario se envía una vez, completo.
  app.get("/:slug/questionnaire", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => getPersonalLinkQuestionnaire(tx, orgId, query.data.token)))
  })

  app.post("/:slug/questionnaire", async (c) => {
    const body = questionnaireBody.safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tus respuestas"), 400)
    return answer(c, 201, () => inOrg(c, (tx, orgId) => submitPersonalLinkQuestionnaire(tx, orgId, body.data.token, body.data.answers)))
  })

  // «Tus mensajes»: los tres interruptores de quien recibe sus mensajes.
  app.post("/:slug/messages", async (c) => {
    const body = messagesBody.safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa lo que elegiste"), 400)
    const { token: linkToken, ...input } = body.data
    return answer(c, 200, () => inOrg(c, (tx, orgId) => setPersonalLinkMessages(tx, orgId, linkToken, input)))
  })

  // «Tus papeles»: la receta o el comprobante de los últimos 30 días, como PDF.
  app.get("/:slug/papers/:paperId", async (c) => {
    const query = paperQuery.safeParse(c.req.query())
    const params = z.object({ paperId: z.uuid() }).safeParse({ paperId: c.req.param("paperId") })
    if (!query.success || !params.success) return unavailable(c)
    try {
      const paper = await inOrg(c, (tx, orgId) =>
        getPersonalLinkPaper(tx, orgId, query.data.token, { kind: query.data.kind, id: params.data.paperId }),
      )
      return new Response(Buffer.from(paper.bytes), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${paper.filename.replace(/[^A-Za-z0-9._-]+/g, "-")}"`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      })
    } catch (error) {
      if (error instanceof ServiceError) return c.json(errorBody(c, error.code, error.message), error.status)
      throw error
    }
  })

  // Terminal: nunca continuar hacia requireSession ni ampliar excepciones a otros /api/*.
  app.all("*", unavailable)
  return app
}
