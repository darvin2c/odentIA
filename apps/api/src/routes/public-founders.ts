import { getConnInfo } from "@hono/node-server/conninfo"
import { type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  getPublicPricing,
  guideSheetsFor,
  markWaitlistConfirmationSent,
  markWebContactSent,
  moneyText,
  readFounderInvitation,
  ServiceError,
  submitWaitlistRequest,
  submitWebContact,
  waitlistInputSchemaFor,
  waitlistReceivedEmail,
  newClientNoticeEmail,
  WEB_CONTACTS_PER_HOUR,
  webContactEmail,
  webContactInputSchema,
  webPageOf,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { errorBody } from "../lib/error.js"
import { rateKeyOf } from "../lib/rate-key.js"
import { validationError } from "./helpers.js"
import type { RegistrationRemoteAddress } from "./public-patient-registration.js"

const WINDOW_MS = 10 * 60 * 1000
/** Solicitudes por dirección y ventana: de sobra para una clínica, poco para quien abusa. */
const MAX_POSTS = 5
const MAX_BUCKETS = 10000
/** Lo que la web vuelve a pedir: un cambio de precio en la administración se ve en menos de un minuto (decisión 14). */
const PRICING_MAX_AGE_S = 30
/**
 * Avisos al equipo por hora en este proceso: de sobra para la lista de espera,
 * poco para llenar el buzón si alguien abusa del formulario. Pasado el tope la
 * solicitud se guarda igual y sale en Inicio de la administración.
 */
const TEAM_NOTICES_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000
/** Correos que deja el aviso de las guías por dirección y ventana: de sobra para quien baja plantillas. */
const MAX_CONTACTS = 3

/**
 * Lo público de Fundadores (issue 165), terminal: nunca sigue hacia
 * `requireSession`.
 *
 * - `GET /pricing`: los planes con «Mostrar en la web»; lo lee la web de
 *   marketing al servir cada página. Nunca los lugares que quedan.
 * - `POST /waitlist`: la solicitud de la web. Guarda con `ownerDb` y después
 *   envía la copia a quien pidió y el aviso al buzón del equipo, cada uno por
 *   su lado: si un correo falla, el otro sale y la solicitud queda igual.
 * - `GET /invitation/:token`: lo que muestra «Crea tu cuenta» con una
 *   invitación. Sin invitación vigente responde 404 sin decir por qué.
 */
export function createPublicFoundersRoute(deps: {
  ownerDb: Db
  mailer: Mailer
  remoteAddress?: RegistrationRemoteAddress | undefined
  /** A dónde responde la clínica su confirmación: hola@ de la marca de su solicitud. */
  replyToOf?: (product: ClinicalProduct) => string | undefined
  /** El producto del dominio de la petición: la solicitud lo guarda (decisión 17 del issue 229). */
  productOf?: (c: Context) => ClinicalProduct
  /** La administración (ADMIN_URL): el aviso al equipo abre la ficha del cliente. */
  adminURL?: string | undefined
  /** Quién recibe el aviso de cada cliente nuevo: hola@ de la marca de la solicitud; sin él, no sale. */
  teamEmailOf?: (product: ClinicalProduct) => string | undefined
  /** La web de un producto («https://odentia32.com»): los enlaces del correo de las plantillas. */
  siteUrlOf?: (product: ClinicalProduct) => string
  /** El panel de un producto: con el alta abierta, el correo de las plantillas lleva a crear la cuenta. */
  panelUrlOf?: (product: ClinicalProduct) => string
}) {
  const app = new Hono()
  const defaultBuckets = new Map<string, { expiresAt: number; posts: number }>()
  const contactBuckets = new Map<string, { expiresAt: number; posts: number }>()
  /** Cuándo salió cada aviso al equipo de la última hora, del más viejo al más nuevo. */
  const noticesSent: number[] = []
  const address: RegistrationRemoteAddress =
    deps.remoteAddress ??
    ((c) => {
      try {
        return getConnInfo(c).remote.address
      } catch {
        return undefined
      }
    })

  app.onError((error, c) => {
    if (error instanceof ServiceError) return c.json(errorBody(c, error.code, error.message, error.fields), error.status)
    // Sin el error: podría llevar los datos de quien pidió.
    console.error("Fundadores: error en la ruta pública")
    const message = c.req.path.endsWith("/contact")
      ? "No pudimos enviarte el correo. Intenta nuevamente en unos minutos."
      : "No pudimos guardar tu solicitud. Intenta nuevamente."
    return c.json(errorBody(c, "INTERNAL", message), 500)
  })

  app.get("/pricing", async (c) => {
    c.header("Cache-Control", `public, max-age=${PRICING_MAX_AGE_S}`)
    // La lista de cada producto (ADR 0093): la web la pide con `?product=`, porque llama a la
    // API por la red interna; sin decirlo, la del dominio de la petición.
    const asked = c.req.query("product")
    const product = isClinicalProduct(asked) ? asked : (deps.productOf?.(c) ?? "dental")
    return c.json(await deps.ownerDb.transaction((tx) => getPublicPricing(tx, product)))
  })

  app.get("/invitation/:token", async (c) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    const found = await deps.ownerDb.transaction((tx) => readFounderInvitation(tx, c.req.param("token")))
    if (!found) return c.json(errorBody(c, "INVITATION_INVALID", "Esa invitación ya no sirve"), 404)
    return c.json(found)
  })

  app.use(
    "/waitlist",
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "La solicitud excede el tamaño permitido"), 413),
    }),
  )

  app.use(
    "/contact",
    bodyLimit({
      maxSize: 2 * 1024,
      onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "El envío excede el tamaño permitido"), 413),
    }),
  )

  const limited = (c: Context, buckets: Map<string, { expiresAt: number; posts: number }> = defaultBuckets, max = MAX_POSTS): Response | null => {
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key)
    const key = rateKeyOf(address(c))
    let bucket = buckets.get(key)
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        c.header("Retry-After", "60")
        return c.json(errorBody(c, "RATE_LIMITED", "Recibimos demasiadas solicitudes. Intenta nuevamente en unos minutos."), 429)
      }
      bucket = { expiresAt: now + WINDOW_MS, posts: 0 }
      buckets.set(key, bucket)
    }
    if (bucket.posts >= max) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))))
      return c.json(errorBody(c, "RATE_LIMITED", "Recibimos demasiadas solicitudes. Intenta nuevamente en unos minutos."), 429)
    }
    bucket.posts++
    return null
  }

  /**
   * Una sola vez por solicitud nueva y sin reintentos: si no sale, solo su id
   * va al registro (nunca los datos de quien pidió) y la solicitud sigue en
   * Inicio de la administración.
   */
  const noticeTeam = async (to: string, id: string, clientId: string | null, product: ClinicalProduct, data: { clinicName: string; city: string; countryCode: string }) => {
    const now = Date.now()
    while ((noticesSent[0] ?? now) <= now - HOUR_MS) noticesSent.shift()
    if (noticesSent.length >= TEAM_NOTICES_PER_HOUR) {
      console.error(`Fundadores: pasó el tope de ${TEAM_NOTICES_PER_HOUR} avisos por hora; la solicitud ${id} queda sin aviso y sale en Inicio`)
      return
    }
    noticesSent.push(now)
    try {
      await deps.mailer.send({
        to,
        ...newClientNoticeEmail({
          clinicName: data.clinicName,
          product,
          city: data.city,
          countryCode: data.countryCode,
          clientUrl: deps.adminURL && clientId ? `${deps.adminURL.replace(/\/+$/, "")}/clients/${clientId}` : null,
        }),
      })
    } catch {
      console.error(`Fundadores: no salió el aviso al equipo de la solicitud ${id}`)
    }
  }

  app.post("/waitlist", async (c) => {
    c.header("Cache-Control", "no-store")
    const blocked = limited(c)
    if (blocked) return blocked
    const product = deps.productOf?.(c) ?? "dental"
    const parsed = waitlistInputSchemaFor(product).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // La página desde la que se envió va en la dirección (`?desde=`), no en el cuerpo: así la
    // API de antes la ignora mientras la web nueva ya se publicó (ADR 0215).
    const sourcePage = webPageOf(c.req.query("desde"))
    const result = await deps.ownerDb.transaction((tx) => submitWaitlistRequest(tx, parsed.data, product, { sourcePage }))
    // La copia sale una sola vez: si ya estaba en la lista, no se repite.
    if (!result.existing) {
      try {
        await deps.mailer.send({
          to: parsed.data.email,
          ...waitlistReceivedEmail({
            firstName: parsed.data.firstName,
            clinicName: parsed.data.clinicName,
            phone: parsed.data.phone,
            answerDays: result.answerDays,
            replyTo: deps.replyToOf?.(product),
            brand: productWords(product).brand,
          }),
        })
        await deps.ownerDb.transaction((tx) => markWaitlistConfirmationSent(tx, result.id)).catch(() => undefined)
      } catch {
        console.error(`Fundadores: no salió la copia de la solicitud ${result.id}`)
      }
      // Aparte de la copia: que la de quien pidió rebote no deja al equipo sin saberlo.
      const team = deps.teamEmailOf?.(product)
      if (team) await noticeTeam(team, result.id, result.clientId, product, parsed.data)
    }
    // La misma respuesta si ya estaba en la lista: la web no dice si un correo ya pidió entrar,
    // ni promete la copia (ADR 0215).
    return c.json({ ok: true, answerDays: result.answerDays }, 201)
  })

  /**
   * El aviso de una guía (ADR 0215): quien bajó una plantilla deja su correo y le llegan
   * las plantillas adjuntas. Solo JSON, con su campo trampa y 3 por red cada 10 minutos; los
   * topes que frenan el abuso viven en la base (`submitWebContact`): uno por buzón al día y
   * unos pocos por hora entre todos. No dice si ese correo ya es cliente o ya pidió entrar, y
   * un correo que no se sabe si salió no se reintenta. No avisa al equipo: el contacto queda
   * en Clientes con su guía.
   */
  app.post("/contact", async (c) => {
    c.header("Cache-Control", "no-store")
    const product = deps.productOf?.(c) ?? "dental"
    const guide = guideSheetsFor(product)
    if (!guide) return c.json(errorBody(c, "NOT_FOUND", "Esta web no tiene guías"), 404)
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json"))
      return c.json(errorBody(c, "UNSUPPORTED_MEDIA_TYPE", "Envía el correo desde la guía"), 415)
    const blocked = limited(c, contactBuckets, MAX_CONTACTS)
    if (blocked) return blocked
    const parsed = webContactInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // Quien llena el campo que nadie ve no es una persona: no se guarda ni se envía nada.
    if (parsed.data.website?.trim()) return c.json({ ok: true, sent: true }, 201)
    // Lo que lleva el correo se arma antes de guardar el aviso: si algo de esto falla, no queda
    // un aviso que cuente para el día sin que haya salido nada.
    const pricing = await deps.ownerDb.transaction((tx) => getPublicPricing(tx, product))
    const pdfs = new Map<string, Uint8Array>()
    for (const key of parsed.data.sheets) if (Object.hasOwn(guide.sheets, key)) pdfs.set(key, await guide.bytes(key))
    const result = await deps.ownerDb.transaction((tx) => submitWebContact(tx, parsed.data, product))
    if (!result.send && result.reason === "ocupado") {
      console.error(`Guías: pasó el tope de ${WEB_CONTACTS_PER_HOUR} correos con plantillas por hora`)
      c.header("Retry-After", "900")
      return c.json(errorBody(c, "RATE_LIMITED", "Ahora no pudimos enviarte el correo. Intenta nuevamente en un rato."), 429)
    }
    if (!result.send) return c.json({ ok: true, sent: false, reason: result.reason }, 200)
    const shown = (pricing.signupMode === "invitacion" ? pricing.founders : null) ?? pricing.list ?? pricing.founders
    const gift = shown && shown.trialCreditCents > 0 ? moneyText(shown.currency, shown.trialCreditCents) : null
    const site = deps.siteUrlOf?.(product)
    const panel = deps.panelUrlOf?.(product)
    const email = parsed.data.email
    const name = productWords(product).name
    // A quien ya es de una clínica con cuenta no se lo invita a pedir entrar: se le abre su entrada.
    const start = result.hasAccount
      ? panel
        ? { label: `Entrar a ${name}`, url: `${panel}/login` }
        : null
      : pricing.signupMode === "invitacion"
        ? site
          ? { label: gift ? `Pide tus ${gift}` : "Solicita tu invitación", url: `${site}/solicitar-invitacion#correo=${encodeURIComponent(email)}` }
          : null
        : panel
          ? { label: gift ? `Obtén ${gift} de crédito` : "Crear mi cuenta", url: `${panel}/register` }
          : null
    const offer =
      !result.hasAccount && pricing.signupMode === "invitacion" && gift
        ? `Mientras dure el programa Fundadores, los primeros ${gift} de tus agentes los pagamos nosotros.`
        : null
    const attachments = await Promise.all(
      result.sheets.map(async (sheet) => ({
        filename: sheet.file,
        content: pdfs.get(sheet.key) ?? (await guide.bytes(sheet.key)),
        contentType: "application/pdf",
      })),
    )
    try {
      await deps.mailer.send({
        to: email,
        attachments,
        ...webContactEmail({
          sheets: result.sheets.map((sheet) => sheet.title),
          guideUrl: `${site ?? ""}${parsed.data.page}`,
          pitch: guide.pitch(result.sheets.map((sheet) => sheet.key)),
          start,
          offer,
          replyTo: deps.replyToOf?.(product),
          brand: productWords(product).brand,
        }),
      })
    } catch {
      // Sin los datos de la persona en el registro. No se sabe si el proveedor lo entregó: el
      // aviso cuenta para el día y la web no invita a reintentarlo, para no mandarlo dos veces.
      console.error(`Guías: no se confirmó el correo con plantillas del aviso ${result.contactId}`)
      return c.json(errorBody(c, "MAIL_UNCONFIRMED", "No pudimos confirmar que salió el correo."), 502)
    }
    await deps.ownerDb
      .transaction((tx) => markWebContactSent(tx, result.contactId))
      .catch(() => console.error(`Guías: salió el correo del aviso ${result.contactId}, pero no quedó anotado`))
    return c.json({ ok: true, sent: true }, 201)
  })

  return app
}
