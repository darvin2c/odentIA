import { createHmac, timingSafeEqual } from "node:crypto"
import type { PaymentLinkProvider } from "@gestoria/db"
import { fractionDigits } from "./dinero.js"
import { StoreError } from "./tiendas.js"

/**
 * El link de pago (tablero 14: lo primero con que cobra Sofi; se confirma solo). El núcleo de
 * los pedidos conoce solo esta interfaz; cada proveedor es un adaptador intercambiable. El
 * primero es Mercado Pago (Checkout Pro). La tienda pone sus propias credenciales.
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
}

export interface LinkPayment {
  ref: string
  approved: boolean
  /** El pedido que el link llevaba (su id); null si no es de gestorIA. */
  orderId: string | null
  amountCents: number
  currency: string
}

export type LinkNotification =
  | { kind: "ignorar" }
  | { kind: "firma_invalida" }
  | { kind: "pago"; ref: string }

export interface LinkAdapter {
  /** Comprueba las credenciales antes de guardarlas. */
  verify(accessToken: string): Promise<void>
  /** Crea el link. Pedirlo otra vez para el mismo pedido no crea otro distinto. */
  create(accessToken: string, order: LinkOrder): Promise<{ url: string; ref: string }>
  read(
    request: { query: URLSearchParams; headers: Headers; body: string },
    secret: string | null,
  ): LinkNotification
  payment(accessToken: string, ref: string): Promise<LinkPayment>
}

export type LinkAdapters = Record<PaymentLinkProvider, LinkAdapter>

/** Lo que dura una llamada al proveedor antes de rendirse. */
const TIMEOUT_MS = 10_000

/** Un error del proveedor, dicho a la persona. */
function providerError(message: string): StoreError {
  return new StoreError(409, "LINK_PROVIDER", message)
}

/**
 * Mercado Pago, Checkout Pro: una preferencia por pedido, con el pedido en
 * `external_reference` y el aviso en `notification_url`. `binary_mode` deja solo aprobado o
 * rechazado, sin pagos que quedan pendientes días.
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
  return {
    async verify(accessToken) {
      const response = await call(accessToken, "/users/me")
      if (response.status === 401 || response.status === 403)
        throw new StoreError(400, "VALIDATION_ERROR", "Mercado Pago no reconoce ese token", {
          accessToken: "Mercado Pago no reconoce ese token. Copia el «Access token» de producción.",
        })
      if (!response.ok) throw providerError("Mercado Pago no respondió. Inténtalo de nuevo.")
    },
    async create(accessToken, order) {
      const digits = fractionDigits(order.currency)
      const response = await call(accessToken, "/checkout/preferences", {
        method: "POST",
        // Repetir con el mismo pedido no crea otro link (un reintento tras un corte).
        headers: { "x-idempotency-key": `gestoria-${order.id}` },
        body: JSON.stringify({
          items: [
            {
              id: order.id,
              title: `Pedido ${order.number} · ${order.storeName}`,
              quantity: 1,
              unit_price: order.totalCents / 10 ** digits,
              currency_id: order.currency,
            },
          ],
          external_reference: order.id,
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
      }
      if (response.status === 401 || response.status === 403)
        throw providerError(
          "Mercado Pago rechazó las credenciales de la tienda. Revísalas en Pagos y entregas.",
        )
      if (!response.ok || !body.id || !body.init_point?.startsWith("https://"))
        throw providerError("Mercado Pago no creó el link. Inténtalo de nuevo.")
      return { url: body.init_point, ref: body.id }
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
      if (!response.ok) throw new Error(`mercadopago: el pago ${ref} respondió ${response.status}`)
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
