import { getConnInfo } from "@hono/node-server/conninfo"
import { type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import type { Mailer } from "@odentia/mail"
import {
  getPublicPricing,
  guideSheetsFor,
  markWebContactSent,
  moneyText,
  readFounderInvitation,
  ServiceError,
  submitWebContact,
  WEB_CONTACTS_PER_HOUR,
  webContactEmail,
  webContactInputSchema,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { errorBody } from "../lib/error.js"
import { rateKeyOf } from "../lib/rate-key.js"
import { validationError } from "./helpers.js"
import type { RegistrationRemoteAddress } from "./public-patient-registration.js"

const WINDOW_MS = 10 * 60 * 1000
const MAX_BUCKETS = 10000
/** Lo que la web vuelve a pedir: un cambio de precio en la administración se ve en menos de un minuto (decisión 14). */
const PRICING_MAX_AGE_S = 30
/** Correos que deja el aviso de las guías por dirección y ventana: de sobra para quien baja plantillas. */
const MAX_CONTACTS = 3

/**
 * Lo público de la web, terminal: nunca sigue hacia `requireSession`. La dirección
 * `/api/public/founders` queda como estaba porque la web ya publicada la usa; el
 * programa Fundadores terminó y el alta es libre (ADR 0221).
 *
 * - `GET /pricing`: los planes con «Mostrar en la web»; lo lee la web de
 *   marketing al servir cada página.
 * - `GET /invitation/:token`: lo que muestra «Crea tu cuenta» con la invitación
 *   que la administración manda desde su venta. Sin invitación vigente responde
 *   404 sin decir por qué.
 * - `POST /contact`: el correo con las plantillas de una guía.
 */
export function createPublicFoundersRoute(deps: {
  ownerDb: Db
  mailer: Mailer
  remoteAddress?: RegistrationRemoteAddress | undefined
  /** A dónde responde quien recibe el correo de una guía: hola@ de la marca. */
  replyToOf?: (product: ClinicalProduct) => string | undefined
  /** El producto del dominio de la petición (decisión 17 del issue 229). */
  productOf?: (c: Context) => ClinicalProduct
  /** La web de un producto («https://odentia32.com»): los enlaces del correo de las plantillas. */
  siteUrlOf?: (product: ClinicalProduct) => string
  /** El panel de un producto: el correo de las plantillas lleva a crear la cuenta. */
  panelUrlOf?: (product: ClinicalProduct) => string
}) {
  const app = new Hono()
  const contactBuckets = new Map<string, { expiresAt: number; posts: number }>()
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
    // Sin el error: podría llevar los datos de quien escribió.
    console.error("Web: error en la ruta pública")
    const message = c.req.path.endsWith("/contact")
      ? "No pudimos enviarte el correo. Intenta nuevamente en unos minutos."
      : "No pudimos responder. Intenta nuevamente."
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
    "/contact",
    bodyLimit({
      maxSize: 2 * 1024,
      onError: (c) => c.json(errorBody(c, "BODY_TOO_LARGE", "El envío excede el tamaño permitido"), 413),
    }),
  )

  const limited = (c: Context, buckets: Map<string, { expiresAt: number; posts: number }>, max: number): Response | null => {
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
   * El aviso de una guía (ADR 0216): quien bajó una plantilla deja su correo y le llegan
   * las plantillas adjuntas. Solo JSON, con su campo trampa y 3 por red cada 10 minutos; los
   * topes que frenan el abuso viven en la base (`submitWebContact`): uno por buzón y por guía al día y
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
    const shown = pricing.list
    const gift = shown && shown.trialCreditCents > 0 ? moneyText(shown.currency, shown.trialCreditCents) : null
    const site = deps.siteUrlOf?.(product)
    const panel = deps.panelUrlOf?.(product)
    const email = parsed.data.email
    const name = productWords(product).name
    // A quien ya es de una clínica con cuenta se le abre su entrada; a los demás, empezar gratis.
    // Sin plan publicado (vistIA todavía), el producto no abre cuentas: no se invita a crearla.
    const start = result.hasAccount
      ? panel
        ? { label: `Entrar a ${name}`, url: `${panel}/login` }
        : null
      : panel && shown
        ? { label: "Empieza gratis", url: `${panel}/register` }
        : null
    const offer =
      !result.hasAccount && shown && gift
        ? `Empieza gratis: ${shown.trialDays} días con ${gift} de regalo para tus agentes, sin tarjeta.${
            shown.priceCents > 0
              ? ` Después, ${moneyText(shown.currency, shown.priceCents)} al mes${shown.creditCents === shown.priceCents ? " que vuelven como crédito" : ""}.`
              : ""
          }`
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
          tryUrl: site ? `${site}${parsed.data.page}#pruebalo` : null,
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
