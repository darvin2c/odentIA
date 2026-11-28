/**
 * Un Mercado Pago de mentira para el recorrido de Cobros: un proveedor controlado (ADR 0214), sin
 * la red. Hace lo que el recorrido necesita de Mercado Pago y nada más: la página donde se da el
 * permiso (vuelve a gestorIA con un código), cambiar el código por las credenciales, crear el link
 * y la página donde se paga con la tarjeta de prueba, que avisa al servidor como lo haría él. El
 * pago, como siempre, el servidor lo lee después de este adaptador: nunca del aviso.
 *
 * No prueba que Mercado Pago responda así: eso lo cubre `pedidos.test.ts` con el adaptador real
 * contra respuestas controladas, y lo que falta probar con una cuenta real lo dice el PR.
 */
import { createServer } from "node:http"
import type { LinkAdapter, LinkPayment } from "../apps/api/src/link-de-pago.js"

/**
 * Donde se paga el link: con https, como lo da Mercado Pago y lo exige la base. El navegador del
 * recorrido lo desvía a este servidor (`page.context().route`).
 */
export const PAY_ORIGIN = "https://mercadopago.e2e"

/**
 * Las claves de Rosa en su propia aplicación de Mercado Pago: el Access Token de «Prueba» (de su
 * cuenta de prueba, que Mercado Pago marca así) y el de «Producción».
 */
export const KEYS_TEST = "APP_USR-1111111111-222222-pruebadelatiendarosa-4512"
export const KEYS_REAL = "APP_USR-3333333333-444444-produccionderosa-0077"

export function fakeMercadoPago(options: {
  port: number
  /** Adónde avisa el pago (la dirección de avisos del servidor de la tienda). */
  notify: (paymentId: string, notificationURL: string) => Promise<void>
}) {
  const base = `http://127.0.0.1:${options.port}`
  const links = new Map<string, { reference: string; cents: number; notificationURL: string }>()
  const payments = new Map<string, LinkPayment>()
  let nextPayment = 5000

  const adapter: LinkAdapter = {
    authorizeURL(app, state) {
      const url = new URL("/autorizar", base)
      url.searchParams.set("state", state)
      url.searchParams.set("redirect_uri", app.redirectURL)
      return url.toString()
    },
    async exchange(_app, { code, test }) {
      if (code !== "codigo-e2e") throw new Error("código desconocido")
      return {
        accessToken: test ? "TEST-e2e-rosa" : "APP_USR-e2e-rosa",
        refreshToken: "TG-e2e-rosa",
        expiresIn: 15_552_000,
        userId: "77",
      }
    },
    async refresh() {
      return {
        accessToken: "APP_USR-e2e-rosa",
        refreshToken: "TG-e2e-rosa",
        expiresIn: 15_552_000,
        userId: "77",
      }
    },
    async account(token) {
      if (token === KEYS_TEST) return { id: "4512", label: "test_user_4512@…", test: true }
      if (token === KEYS_REAL || token.endsWith("-e2e-rosa"))
        return { id: "77", label: "rosa.quispe@…", test: false }
      return "sin_permiso"
    },
    async create(_token, order) {
      const ref = `pref-${order.reference ?? order.id}`
      links.set(ref, {
        reference: order.reference ?? order.id,
        cents: order.totalCents,
        notificationURL: order.notificationURL,
      })
      // Con https, como lo exige la base: el recorrido lo lleva a esta página (`PAY_ORIGIN`).
      return { url: `${PAY_ORIGIN}/pagar/${encodeURIComponent(ref)}`, ref }
    },
    read({ query }) {
      const id = query.get("data.id") ?? ""
      return /^\d+$/.test(id) ? { kind: "pago", ref: id } : { kind: "ignorar" }
    },
    async payment(_token, ref) {
      return payments.get(ref) ?? null
    },
  }

  const page = (title: string, body: string) =>
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#18181b}b.mp{color:#00b1ea;font-size:20px}a,button{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:999px;background:#00b1ea;color:#fff;border:0;font-size:16px;text-decoration:none}</style></head><body><b class="mp">mercado pago</b>${body}</body></html>`

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base)
    const html = (status: number, text: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" })
      response.end(text)
    }
    if (url.pathname === "/autorizar") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "")
      back.searchParams.set("code", "codigo-e2e")
      back.searchParams.set("state", url.searchParams.get("state") ?? "")
      return html(
        200,
        page(
          "Mercado Pago",
          `<h1>gestorIA quiere cobrar en tu nombre</h1><p>Crear links de pago y consultar si se pagaron. No puede mover tu dinero.</p><a href="${back.toString()}">Permitir</a>`,
        ),
      )
    }
    const paying = /^\/pagar\/(.+)$/.exec(url.pathname)
    if (paying) {
      const ref = decodeURIComponent(paying[1]!)
      const link = links.get(ref)
      if (!link) return html(404, page("Mercado Pago", "<p>Ese link no existe.</p>"))
      if (request.method === "POST") {
        const id = String(nextPayment++)
        payments.set(id, {
          ref: id,
          approved: true,
          orderId: link.reference,
          amountCents: link.cents,
          currency: "PEN",
        })
        await options.notify(id, link.notificationURL)
        return html(200, page("Pagado", "<h1>¡Listo! Pagaste con la tarjeta de prueba.</h1>"))
      }
      return html(
        200,
        page(
          "Pagar",
          `<h1>Pagar S/ ${(link.cents / 100).toFixed(2)}</h1><form method="post"><button>Pagar con la tarjeta de prueba</button></form>`,
        ),
      )
    }
    return html(404, page("Mercado Pago", "<p>No existe.</p>"))
  })
  server.listen(options.port, "127.0.0.1")
  return { adapter, server }
}
