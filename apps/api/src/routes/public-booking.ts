import { getConnInfo } from "@hono/node-server/conninfo"
import { registrationAnswersSchema } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import {
  type AddressProvider,
  cancelBookingLinkAppointment,
  changeBookingLinkAppointment,
  confirmBookingLinkAppointment,
  decidePersonalLinkBudget,
  decideSaasPublicAccess,
  getBookingLinkCalendar,
  getBookingLinkRegistrationForm,
  getBranchDirections,
  getPersonalLinkConsent,
  getPersonalLinkDataForm,
  getPersonalLinkPaper,
  getPersonalLinkQuestionnaire,
  getPersonalLinkView,
  issueFields,
  listBookingLinkProfessionals,
  listBookingLinkSlots,
  registerFromBookingLink,
  reservePersonalLink,
  ServiceError,
  setPersonalLinkMessages,
  signPersonalLinkConsent,
  submitPersonalLinkData,
  submitPersonalLinkQuestionnaire,
  suggestAddresses,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { calendarResponse } from "../lib/calendar-response.js"
import { errorBody } from "../lib/error.js"
import { keepRegistrationHold } from "../lib/registration-hold.js"

const WINDOW_MS = 10 * 60 * 1000
const MAX_BUCKETS = 10000
// Por clínica y dirección cada 10 minutos. Las sugerencias de dirección llegan
// mientras se escribe: tienen su cupo y no gastan el de enviar (issue 36).
const LIMITS = { get: 240, post: 30, address: 60 } as const
const token = z.string().regex(/^[0-9a-f]{64}$/)
// `cambiar`: las horas para cambiar su cita, con las reglas de su cita.
const linkMode = z.enum(["cambiar"]).optional()
const slotsQuery = z.strictObject({ token, branchId: z.uuid(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), mode: linkMode })
const professionalsQuery = z.strictObject({ token, branchId: z.uuid(), mode: linkMode })
const registrationBody = z.strictObject({
  token,
  submissionId: z.uuid(),
  formVersion: z.number().int().nonnegative(),
  answers: registrationAnswersSchema,
})
const shortText = (max: number) => z.string().trim().max(max)
const linkData = z.strictObject({
    givenNames: shortText(100).optional(),
    familyName: shortText(200).optional(),
    birthDate: shortText(10).optional(),
    docType: shortText(20).optional(),
    docNumber: shortText(20).optional(),
    docCountry: shortText(2).optional(),
    sex: shortText(10).optional(),
    nationality: shortText(2).optional(),
    birthPlace: shortText(200).optional(),
    phone: shortText(30).optional(),
    email: shortText(200).optional(),
    address: shortText(500).optional(),
    addressCity: shortText(100).optional(),
    addressReference: shortText(300).optional(),
    emergencyContactName: shortText(200).optional(),
    emergencyContactPhone: shortText(30).optional(),
    emergencyContactRelationship: shortText(10).optional(),
    insuranceType: shortText(30).optional(),
    insuranceScheme: shortText(30).optional(),
    insurerName: shortText(200).optional(),
    affiliationNumber: shortText(50).optional(),
})
const dataBody = z.strictObject({
  token,
  data: linkData,
  // Su salud, con las mismas reglas del registro de pacientes.
  health: registrationAnswersSchema.shape.health.nullable().optional(),
  // El aviso que aún no aceptó y su respuesta a novedades y promociones, si nunca la dio.
  privacyAccepted: z.boolean().optional(),
  acceptsPromotions: z.boolean().optional(),
  // Dejó su celular y se le dijo que le escribiremos por WhatsApp sobre sus citas.
  acceptsReminders: z.literal(true).optional(),
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
const reserveBody = z.strictObject({
  token,
  branchId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  professionalUserId: z.string().min(1).max(200),
  roomId: z.uuid().optional(),
  // «Elegir horario» de lo que aceptó en su presupuesto.
  planItemIds: z.array(z.uuid()).min(1).max(52).optional(),
  // Quien ya es paciente: lo que faltaba de sus datos y lo que acepta, en el mismo paso.
  you: z
    .strictObject({
      data: linkData,
      privacyAccepted: z.boolean().optional(),
      acceptsPromotions: z.boolean().optional(),
      // Su nombre, si el de su ficha no es el suyo; con documento guardado, el documento entero.
      name: z
        .strictObject({
          givenNames: shortText(100).min(1),
          familyName: shortText(200).min(1),
          docNumber: shortText(20).optional(),
        })
        .optional(),
    })
    .optional(),
})
const decisionBody = z.strictObject({
  token,
  optionId: z.uuid().nullish(),
  decisions: z.array(z.strictObject({ planItemId: z.uuid(), decision: z.enum(["aceptado", "rechazado", "pospuesto"]) })).min(1).max(200),
})
const signBody = z.strictObject({
  token,
  docNumber: shortText(40).min(1, "Escribe tu documento."),
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
// Lo escrito en «Calle y número» del registro o de «Tus datos» (issue 36): va en el cuerpo.
const addressBody = z.strictObject({ q: z.string().max(200), session: z.uuid() })
// «Tus papeles»: el token va en el cuerpo, nunca en la dirección (registros de acceso, proxies, Referer).
const paperBody = z.strictObject({ token, kind: z.enum(["receta", "comprobante"]) })
export type BookingRemoteAddress = (c: Context) => string | undefined

/**
 * «Su enlace» (ADR 0037, que amplía el 0014): la página personal de cada
 * persona. Sin sesión; todo lo que puede hacer lo decide el enlace, y nunca
 * entrega lo guardado. Límites locales de una instancia, sin confiar en
 * cabeceras del cliente.
 */
export function createPublicBookingRoute(deps: {
  db: Db
  secretsKey: Buffer
  remoteAddress?: BookingRemoteAddress
  /** Quién sugiere la dirección de la persona (Geoapify, issue 36); null: los campos de siempre. */
  addressProvider?: AddressProvider | null
}) {
  const app = new Hono<{ Variables: { bookingOrganization: { id: string } } }>()
  const buckets = new Map<string, { expiresAt: number } & Record<keyof typeof LIMITS, number>>()
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
      bucket = { expiresAt: now + WINDOW_MS, get: 0, post: 0, address: 0 }
      buckets.set(key, bucket)
    }
    const method = c.req.method === "GET" ? "get" : c.req.path.endsWith("/address") ? "address" : "post"
    if (bucket[method] >= LIMITS[method]) {
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
        return c.json(errorBody(c, error.code, error.message, error.fields), error.status)
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

  // El enlace corto para llegar a una sede (issue 36): sin sesión ni token, solo
  // a dónde llevar en el mapa; una sede desactivada o sin dirección no existe.
  app.get("/:slug/directions/:branch", (c) =>
    answer(c, 200, () => inOrg(c, (tx, orgId) => getBranchDirections(tx, orgId, c.req.param("branch") ?? ""))),
  )

  // Sugerencias para la dirección que escribe la persona (issue 36): sin token,
  // con su propio cupo por clínica y dirección (`LIMITS.address`) y el tope diario de la clínica.
  app.post("/:slug/address", async (c) => {
    const body = addressBody.safeParse(await bodyOf(c))
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa lo escrito"), 400)
    const org = c.get("bookingOrganization") as { id: string }
    // El proveedor responde fuera de la transacción: la que se abre solo cuenta la búsqueda.
    const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(deps.db, org.id, fn)
    return answer(c, 200, () => suggestAddresses(run, org.id, deps.addressProvider, "paciente", { text: body.data.q, session: body.data.session }))
  })

  app.get("/:slug/slots", async (c) => {
    const query = slotsQuery.safeParse(c.req.query())
    if (!query.success) return c.json(errorBody(c, "VALIDATION", "Revisa las fechas pedidas"), 400)
    const { token: linkToken, mode, ...range } = query.data
    return answer(c, 200, () => inOrg(c, (tx, orgId) => listBookingLinkSlots(tx, orgId, linkToken, { ...range, changing: mode === "cambiar" })))
  })

  // Con quién: quienes atienden en la sede y el próximo horario libre de cada uno, aunque no sea esta semana.
  app.get("/:slug/professionals", async (c) => {
    const query = professionalsQuery.safeParse(c.req.query())
    if (!query.success) return c.json(errorBody(c, "VALIDATION", "Revisa la sede pedida"), 400)
    const { token: linkToken, branchId, mode } = query.data
    return answer(c, 200, () => inOrg(c, (tx, orgId) => listBookingLinkProfessionals(tx, orgId, linkToken, { branchId, changing: mode === "cambiar" })))
  })

  // Quien aún no es paciente deja aquí sus datos esenciales: la ficha la crea el registro de pacientes.
  app.get("/:slug/registration", async (c) => {
    const query = z.strictObject({ token }).safeParse(c.req.query())
    if (!query.success) return unavailable(c)
    return answer(c, 200, () => inOrg(c, (tx, orgId) => getBookingLinkRegistrationForm(tx, orgId, query.data.token)))
  })

  app.post("/:slug/registration", async (c) => {
    const body = registrationBody.safeParse(await bodyOf(c))
    // Lo escrito por la persona se señala en su campo (`answers.…`); el enlace y el envío no son de ningún campo.
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tus datos", issueFields(body.error.issues.filter((issue) => issue.path[0] === "answers"))), 400)
    const { token: linkToken, ...input } = body.data
    return answer(c, 201, () =>
      inOrg(c, (tx, orgId) => registerFromBookingLink(tx, orgId, linkToken, input)).catch(async (error: unknown) => {
        // El documento ya era de alguien: queda para recepción y se responde el texto neutro.
        await keepRegistrationHold(deps.db, (c.get("bookingOrganization") as { id: string }).id, error)
        throw error
      }),
    )
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
        return reservePersonalLink(tx, orgId, linkToken, choice, { secretsKey: deps.secretsKey })
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
    // Lo escrito se señala en su campo (`data.…`, `representative.…`); el enlace no es de ningún campo.
    if (!body.success) return c.json(errorBody(c, "VALIDATION", "Revisa tus datos", issueFields(body.error.issues.filter((issue) => issue.path[0] !== "token"))), 400)
    const { token: linkToken, ...input } = body.data
    return answer(c, 201, () =>
      inOrg(c, (tx, orgId) => submitPersonalLinkData(tx, orgId, linkToken, input)).catch((error: unknown) => {
        // Un documento que resultó ser de otra persona no se le dice a quien escribe (ni de quién es): texto neutro.
        if (error instanceof ServiceError && error.code === "DUPLICATE_DOCUMENT") {
          throw new ServiceError("DATA_NOT_SAVED", 409, "No pudimos guardar tus datos. Escríbenos por el chat y te ayudamos.")
        }
        throw error
      }),
    )
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
    // El documento escrito va a su campo; el enlace y la firma no se escriben aquí.
    if (!params.success || !body.success)
      return c.json(errorBody(c, "VALIDATION", "Revisa tu firma", body.success ? undefined : issueFields(body.error.issues.filter((issue) => issue.path[0] === "docNumber"))), 400)
    const { token: linkToken, ...input } = body.data
    // Desde dónde firma: la evidencia de una firma a distancia (#47).
    const evidence = { ip: address(c) ?? null, userAgent: c.req.header("user-agent") ?? null }
    return answer(c, 200, () =>
      inOrg(c, (tx, orgId) => signPersonalLinkConsent(tx, orgId, linkToken, params.data.consentId, input, evidence)),
    )
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
  // Es un POST, como el resto de lo que hace el enlace: el token viaja en el cuerpo.
  app.post("/:slug/papers/:paperId", async (c) => {
    const body = paperBody.safeParse(await bodyOf(c))
    const params = z.object({ paperId: z.uuid() }).safeParse({ paperId: c.req.param("paperId") })
    if (!body.success || !params.success) return unavailable(c)
    try {
      const paper = await inOrg(c, (tx, orgId) =>
        getPersonalLinkPaper(tx, orgId, body.data.token, { kind: body.data.kind, id: params.data.paperId }),
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
      if (error instanceof ServiceError) return c.json(errorBody(c, error.code, error.message, error.fields), error.status)
      throw error
    }
  })

  // «Añadir al calendario» de su cita (issue 46). Es un POST por lo mismo que «Tus papeles».
  app.post("/:slug/calendar", async (c) => {
    const body = z.strictObject({ token }).safeParse(await bodyOf(c))
    if (!body.success) return unavailable(c)
    try {
      return calendarResponse(await inOrg(c, (tx, orgId) => getBookingLinkCalendar(tx, orgId, body.data.token)))
    } catch (error) {
      if (error instanceof ServiceError) {
        if (error.status === 404) return unavailable(c)
        return c.json(errorBody(c, error.code, error.message, error.fields), error.status)
      }
      throw error
    }
  })

  // Terminal: nunca continuar hacia requireSession ni ampliar excepciones a otros /api/*.
  app.all("*", unavailable)
  return app
}
