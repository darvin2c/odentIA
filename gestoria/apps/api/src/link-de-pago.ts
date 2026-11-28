import { createHmac, timingSafeEqual } from "node:crypto"
import type { PaymentLinkProvider } from "@gestoria/db"
import { fractionDigits } from "./dinero.js"
import { StoreError } from "./tiendas.js"

/**
 * El link de pago (tablero 14: lo primero con que cobra Sofi; se confirma solo). El núcleo de
 * los pedidos conoce solo esta interfaz; cada proveedor es un adaptador intercambiable. El
 * primero es Mercado Pago (Checkout Pro).
 *
 * La tienda conecta su cuenta entrando a ella (OAuth 2.0 con PKCE, RFC 7636; lienzo «gestorIA ·
 * Configuración, de nuevo», tablero 6), y el token se renueva con su `refresh_token` antes de vencer;
 * o pega el Access Token de su propia aplicación en el proveedor (`pasarela.ts`, ADR 0232).
 *
 * Un aviso del proveedor nunca se cree por lo que trae: solo dice qué pago mirar. El estado, el
 * monto y el pedido se leen del proveedor con las credenciales de la tienda. Si el aviso viene
 * firmado y la tienda puso su clave, la firma se comprueba además.
 */

export interface LinkOrder {
  id: string
  number: string
  storeName: string
  totalCents: number
  currency: string
  /** Cuándo deja de poder pagarse (el precio negociado vence); null sin vencimiento. */
  expiresAt: Date | null
  /** Adónde avisa el proveedor. */
  notificationURL: string
  /** Lo que el link lleva para reconocerlo al volver; por omisión, el id del pedido. */
  reference?: string
  /** El nombre de lo que se paga; por omisión, «Pedido 0147 · Tienda». */
  title?: string
}

export interface LinkPayment {
  ref: string
  approved: boolean
  /** Lo que el link llevaba (el id del pedido, o «prueba:…»); null si no es de gestorIA. */
  orderId: string | null
  amountCents: number
  currency: string
}

export type LinkNotification =
  | { kind: "ignorar" }
  | { kind: "firma_invalida" }
  | { kind: "pago"; ref: string }

/** Las credenciales de la tienda que da el proveedor al conectarla o renovarla. */
export interface LinkTokens {
  accessToken: string
  refreshToken: string | null
  /** Cuánto vale el token, en segundos; null si el proveedor no lo dice. */
  expiresIn: number | null
  /** La cuenta en el proveedor. */
  userId: string | null
}

/** La aplicación de gestorIA en el proveedor (su id y su secreto) y adónde vuelve la persona. */
export interface LinkApp {
  clientId: string
  clientSecret: string
  redirectURL: string
}

export interface LinkAdapter {
  /** Adónde va la persona para dar permiso, con el `state` y el desafío de PKCE (S256). */
  authorizeURL(app: LinkApp, state: string, challenge: string): string
  /** Cambia el código que trajo la persona por las credenciales de la tienda. */
  exchange(
    app: LinkApp,
    input: { code: string; verifier: string; test: boolean },
  ): Promise<LinkTokens>
  /** Renueva las credenciales con el `refresh_token`. */
  refresh(app: LinkApp, refreshToken: string, test: boolean): Promise<LinkTokens>
  /**
   * La cuenta de esas credenciales; «sin_permiso» si el proveedor ya no las reconoce. `test` dice
   * si el proveedor la marca como cuenta de prueba.
   */
  account(
    accessToken: string,
  ): Promise<{ id: string; label: string | null; test: boolean } | "sin_permiso">
  /** Crea el link. Pedirlo otra vez para el mismo pedido no crea otro distinto. */
  create(
    accessToken: string,
    order: LinkOrder,
    options?: { test?: boolean },
  ): Promise<{ url: string; ref: string }>
  read(
    request: { query: URLSearchParams; headers: Headers; body: string },
    secret: string | null,
  ): LinkNotification
  /** El pago, leído del proveedor; null si su cuenta no lo conoce. */
  payment(accessToken: string, ref: string): Promise<LinkPayment | null>
}

export type LinkAdapters = Record<PaymentLinkProvider, LinkAdapter>

/** Lo que dura una llamada al proveedor antes de rendirse. */
const TIMEOUT_MS = 10_000

/** Un error del proveedor, dicho a la persona. */
function providerError(message: string): StoreError {
  return new StoreError(409, "LINK_PROVIDER", message)
}

/**
 * El proveedor ya no reconoce el token de la tienda al usarlo (crear un link, leer un pago): quien
 * lo llama deja la pasarela «sin permiso» (`revokeLinkIn` de `pasarela.ts`).
 */
export const LINK_REVOKED = "LINK_REVOKED"

function revokedError(): StoreError {
  return new StoreError(
    409,
    LINK_REVOKED,
    "Mercado Pago ya no reconoce la cuenta de la tienda. Vuelve a conectarla en Configuración › Cobros.",
  )
}

/**
 * Mercado Pago marca sus cuentas de prueba: la etiqueta `test_user` y el correo de
 * `@testuser.com` que da al crearlas. Si no trae ninguna, no se sabe (no se supone que sea real).
 */
export function isTestAccount(body: { tags?: unknown; email?: unknown }): boolean {
  const tags = Array.isArray(body.tags) ? body.tags : []
  return (
    tags.includes("test_user") ||
    (typeof body.email === "string" && /@testuser\.com$/i.test(body.email))
  )
}

/**
 * La cuenta, dicha a medias: el correo con su nombre y sin su dominio («rosa.quispe@…»), o el
 * apodo. Basta para reconocerla en la pantalla.
 */
export function accountLabel(email: string | null, nickname: string | null): string | null {
  const name = email?.split("@")[0]?.trim()
  if (name) return `${name.slice(0, 60)}@…`
  return nickname?.trim().slice(0, 60) || null
}

/**
 * Mercado Pago, Checkout Pro: una preferencia por pedido, con el pedido en
 * `external_reference` y el aviso en `notification_url`. `binary_mode` deja solo aprobado o
 * rechazado, sin pagos que quedan pendientes días. La conexión, por OAuth
 * (`auth.mercadopago.com/authorization`, el código vale 10 minutos y el token 180 días; cada
 * renovación trae otro `refresh_token`).
 */
export function mercadoPago(fetcher: typeof fetch = fetch): LinkAdapter {
  const API = "https://api.mercadopago.com"
  async function call(accessToken: string, path: string, init: RequestInit = {}) {
    try {
      return await fetcher(`${API}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw providerError("Mercado Pago no respondió. Inténtalo de nuevo en un momento.")
    }
  }
  async function post(path: string, body: Record<string, string>) {
    try {
      return await fetcher(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw providerError("Mercado Pago no respondió. Inténtalo de nuevo en un momento.")
    }
  }
  async function tokens(response: Response, refused: string): Promise<LinkTokens> {
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      user_id?: number | string
    }
    if (response.status >= 400 && response.status < 500) throw providerError(refused)
    if (!response.ok || !body.access_token)
      throw providerError("Mercado Pago no respondió. Inténtalo de nuevo en un momento.")
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
      userId: body.user_id === undefined ? null : String(body.user_id),
    }
  }
  return {
    authorizeURL(app, state, challenge) {
      const url = new URL("https://auth.mercadopago.com/authorization")
      url.search = new URLSearchParams({
        client_id: app.clientId,
        response_type: "code",
        platform_id: "mp",
        state,
        redirect_uri: app.redirectURL,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString()
      return url.toString()
    },
    async exchange(app, { code, verifier, test }) {
      return tokens(
        await post("/oauth/token", {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: app.redirectURL,
          code_verifier: verifier,
          // Las credenciales de prueba: el link de S/ 1 se paga con la tarjeta de prueba.
          test_token: test ? "true" : "false",
        }),
        "Mercado Pago no aceptó el permiso: pudo vencer (dura 10 minutos). Vuelve a conectar.",
      )
    },
    async refresh(app, refreshToken, test) {
      return tokens(
        await post("/oauth/token", {
          client_id: app.clientId,
          client_secret: app.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          // En modo prueba se renueva como prueba: nunca pasa a credenciales reales sin pedirlo.
          test_token: test ? "true" : "false",
        }),
        "Mercado Pago no renovó el permiso de la tienda.",
      )
    },
    async account(accessToken) {
      const response = await call(accessToken, "/users/me")
      if (response.status === 401 || response.status === 403) return "sin_permiso"
      if (!response.ok) throw providerError("Mercado Pago no respondió. Inténtalo de nuevo.")
      const body = (await response.json().catch(() => ({}))) as {
        id?: number | string
        email?: string
        nickname?: string
        tags?: unknown
      }
      if (body.id === undefined) throw providerError("Mercado Pago no dijo de qué cuenta es.")
      return {
        id: String(body.id),
        label: accountLabel(body.email ?? null, body.nickname ?? null),
        test: isTestAccount(body),
      }
    },
    async create(accessToken, order, options = {}) {
      const digits = fractionDigits(order.currency)
      const reference = order.reference ?? order.id
      const response = await call(accessToken, "/checkout/preferences", {
        method: "POST",
        // Repetir con el mismo pedido no crea otro link (un reintento tras un corte).
        headers: { "x-idempotency-key": `gestoria-${reference}` },
        body: JSON.stringify({
          items: [
            {
              id: order.id,
              title: order.title ?? `Pedido ${order.number} · ${order.storeName}`,
              quantity: 1,
              unit_price: order.totalCents / 10 ** digits,
              currency_id: order.currency,
            },
          ],
          external_reference: reference,
          notification_url: order.notificationURL,
          binary_mode: true,
          ...(order.expiresAt
            ? { expires: true, expiration_date_to: order.expiresAt.toISOString() }
            : {}),
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        id?: string
        init_point?: string
        sandbox_init_point?: string
      }
      if (response.status === 401) throw revokedError()
      if (response.status === 403)
        throw providerError(
          "Mercado Pago no deja crear links con esa cuenta. Revisa en tu panel de Mercado Pago que la aplicación esté activa.",
        )
      // Con las credenciales de prueba, solo el link que se paga con la tarjeta de prueba: si no
      // viene, no se cae al link real (cobraría dinero de verdad en una prueba).
      const url = options.test ? body.sandbox_init_point : body.init_point
      if (!response.ok || !body.id || !url?.startsWith("https://"))
        throw providerError("Mercado Pago no creó el link. Inténtalo de nuevo.")
      return { url, ref: body.id }
    },
    read({ query, headers, body }, secret) {
      let parsed: { type?: string; data?: { id?: unknown } } = {}
      try {
        parsed = body ? (JSON.parse(body) as typeof parsed) : {}
      } catch {
        // Un aviso sin cuerpo JSON (el IPN viejo) trae todo en la dirección.
      }
      const type = query.get("type") ?? query.get("topic") ?? parsed.type
      if (type !== "payment") return { kind: "ignorar" }
      const raw = query.get("data.id") ?? query.get("id") ?? String(parsed.data?.id ?? "")
      if (!/^\d{1,20}$/.test(raw)) return { kind: "ignorar" }
      if (secret) {
        // x-signature: «ts=…,v1=…», sobre «id:<data.id>;request-id:<x-request-id>;ts:<ts>;».
        const parts = Object.fromEntries(
          (headers.get("x-signature") ?? "").split(",").map((part) => {
            const [key, ...value] = part.trim().split("=")
            return [key, value.join("=")]
          }),
        )
        const requestId = headers.get("x-request-id") ?? ""
        if (!parts.ts || !parts.v1) return { kind: "firma_invalida" }
        const expected = createHmac("sha256", secret)
          .update(`id:${raw};request-id:${requestId};ts:${parts.ts};`)
          .digest()
        const given = Buffer.from(parts.v1, "hex")
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
          return { kind: "firma_invalida" }
      }
      return { kind: "pago", ref: raw }
    },
    async payment(accessToken, ref) {
      const response = await call(accessToken, `/v1/payments/${encodeURIComponent(ref)}`)
      if (response.status === 404) return null
      if (response.status === 401) throw revokedError()
      if (!response.ok) throw new Error(`mercadopago: el pago respondió ${response.status}`)
      const body = (await response.json()) as {
        id?: number | string
        status?: string
        external_reference?: string | null
        transaction_amount?: number
        currency_id?: string
      }
      const currency = body.currency_id ?? ""
      const digits = /^[A-Z]{3}$/.test(currency) ? fractionDigits(currency) : 2
      return {
        ref: String(body.id ?? ref),
        approved: body.status === "approved",
        orderId: body.external_reference || null,
        amountCents: Math.round((body.transaction_amount ?? 0) * 10 ** digits),
        currency,
      }
    },
  }
}

export function defaultLinkAdapters(): LinkAdapters {
  return { mercadopago: mercadoPago() }
}
