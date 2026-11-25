import { createHash, timingSafeEqual } from "node:crypto"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { generateRandomString } from "better-auth/crypto"
import { z } from "zod"

/**
 * El pase entre dominios (ADR 0215, paso 5 del lienzo «Una cuenta, todas las apps»): quien
 * abre desde una app un lugar de otro dominio (de odentia32.com a una clínica de
 * latidia72.com, o a la administración) llega con su misma sesión, sin poner la clave.
 *
 * Tres saltos, todos en la API (`/api/auth/pase/*`, que existe en cada dominio, también en el
 * de gestorIA):
 *
 * 1. `ir`, en el dominio de destino: deja en este navegador una marca de un uso (una cookie
 *    solo del servidor de la API de destino) y manda a la API del dominio de origen.
 * 2. `emitir`, en el de origen: con la sesión de ese dominio, guarda un pase de un minuto
 *    atado a la marca y manda de vuelta al destino.
 * 3. `canjear`, en el de destino: el pase se gasta al leerlo, sirve solo si la marca del
 *    navegador es la misma y pone la cookie de la misma sesión en este dominio. Si había otra
 *    sesión aquí (otra persona en la compu del mostrador), se cierra: queda la que venía.
 *
 * La marca es la que impide que alguien mande por WhatsApp un enlace con su propio pase y deje
 * a otra persona trabajando dentro de su cuenta: quien abre ese enlace no tiene la marca.
 * Cualquier cosa que no cuadre lleva igual a `next`, sin sesión nueva: la app pide entrar.
 *
 * Se escribe aparte del `one-time-token` de Better Auth porque su canje es una ruta pública
 * que no mira nada del navegador: cualquiera con el pase lo canjea.
 */

export const PASE_TTL_SECONDS = 60
/** La marca del navegador que pidió el pase: solo de la API de destino, la lee solo el servidor. */
// `__Host-`: ningún subdominio hermano (una clínica, la web) puede plantarla.
export const PASE_COOKIE = "__Host-odentia_pase"
const PASE_PATH = "/"
const PREFIX = "pase:"
const MARK = /^[A-Za-z0-9_-]{32}$/

/** Otra instancia de la cuenta: el dominio de su cookie y la dirección de su `/api/auth`. */
export interface PaseSister {
  domain: string
  authURL: string
}

export interface PaseOptions {
  /** El dominio de la cookie de esta instancia (`odentia32.com`). */
  domain: string
  /** Todas las instancias (esta también): solo a ellas se manda y de ellas se recibe. */
  sisters: readonly PaseSister[]
  /**
   * Antes de cerrar la sesión anterior de este dominio cuando era de la misma persona: lo que
   * colgaba de ella (los avisos del equipo) pasa a la que llega.
   */
  onSessionReplaced?: (fromSessionId: string, toSessionId: string) => Promise<void>
}

type Stored = { session: string; mark: string; domain: string }

export function bareDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\./, "")
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("base64url")
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * `next` solo si es una dirección https del dominio indicado (o de un subdominio suyo): el pase
 * nunca deja a nadie en otro sitio. Puerto libre: el entorno de pruebas usa uno propio.
 */
export function arrivalOn(next: string | undefined, domain: string): string | null {
  if (!next) return null
  try {
    const url = new URL(next)
    const host = url.hostname.toLowerCase()
    const base = bareDomain(domain)
    if (url.protocol !== "https:" || url.username || url.password) return null
    if (host !== base && !host.endsWith(`.${base}`)) return null
    return url.href
  } catch {
    return null
  }
}

/** El pase guardado, si se lee entero. */
export function parseStored(value: string): Stored | null {
  try {
    const v = JSON.parse(value) as Partial<Stored>
    if (typeof v.session !== "string" || typeof v.mark !== "string" || typeof v.domain !== "string")
      return null
    return { session: v.session, mark: v.mark, domain: v.domain }
  } catch {
    return null
  }
}

/** Si el pase sirve en este dominio y en este navegador. */
export function paseFits(
  stored: Stored,
  expiresAt: Date,
  domain: string,
  mark: string | null | undefined,
  now = new Date(),
): boolean {
  if (expiresAt.getTime() <= now.getTime()) return false
  if (stored.domain !== bareDomain(domain)) return false
  if (!mark || !MARK.test(mark)) return false
  return sameHash(stored.mark, hash(mark))
}

const NO_REFERRER = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" }

export const pase = (options: PaseOptions) => {
  const own = bareDomain(options.domain)
  const sisterOf = (domain: string | undefined) =>
    domain
      ? options.sisters.find((sister) => bareDomain(sister.domain) === bareDomain(domain))
      : undefined
  const markAttributes = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: PASE_PATH,
  }

  return {
    id: "pase",
    endpoints: {
      paseIr: createAuthEndpoint(
        "/pase/ir",
        {
          method: "GET",
          query: z.object({ desde: z.string().max(253), next: z.string().max(4000) }),
        },
        async (ctx) => {
          const target = arrivalOn(ctx.query.next, own)
          if (!target)
            throw APIError.from("BAD_REQUEST", {
              code: "PASE_DESTINO",
              message: "Esa dirección no es de esta app",
            })
          const from = sisterOf(ctx.query.desde)
          // Desde un dominio que no es del grupo no hay sesión que traer: la app pide entrar.
          if (!from || bareDomain(from.domain) === own) throw ctx.redirect(target)
          const mark = generateRandomString(32)
          ctx.setCookie(PASE_COOKIE, mark, { ...markAttributes, maxAge: PASE_TTL_SECONDS })
          for (const [name, value] of Object.entries(NO_REFERRER)) ctx.setHeader(name, value)
          const url = new URL(`${from.authURL.replace(/\/$/, "")}/pase/emitir`)
          url.searchParams.set("a", own)
          url.searchParams.set("n", mark)
          url.searchParams.set("next", target)
          throw ctx.redirect(url.href)
        },
      ),

      paseEmitir: createAuthEndpoint(
        "/pase/emitir",
        {
          method: "GET",
          query: z.object({
            a: z.string().max(253),
            n: z.string().max(64),
            next: z.string().max(4000),
          }),
        },
        async (ctx) => {
          const to = sisterOf(ctx.query.a)
          if (!to || bareDomain(to.domain) === own)
            throw APIError.from("BAD_REQUEST", {
              code: "PASE_DESTINO",
              message: "Esa app no es del grupo",
            })
          const target = arrivalOn(ctx.query.next, to.domain)
          if (!target || !MARK.test(ctx.query.n))
            throw APIError.from("BAD_REQUEST", {
              code: "PASE_DESTINO",
              message: "Esa dirección no es de esa app",
            })
          for (const [name, value] of Object.entries(NO_REFERRER)) ctx.setHeader(name, value)
          const current = await getSessionFromCtx(ctx).catch(() => null)
          // Sin sesión aquí, no hay nada que llevar: la app de destino pide entrar.
          if (!current) throw ctx.redirect(target)
          const token = generateRandomString(32)
          const stored: Stored = {
            session: current.session.token,
            mark: hash(ctx.query.n),
            domain: bareDomain(to.domain),
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `${PREFIX}${hash(token)}`,
            value: JSON.stringify(stored),
            expiresAt: new Date(Date.now() + PASE_TTL_SECONDS * 1000),
          })
          const url = new URL(`${to.authURL.replace(/\/$/, "")}/pase/canjear`)
          url.searchParams.set("t", token)
          url.searchParams.set("next", target)
          throw ctx.redirect(url.href)
        },
      ),

      paseCanjear: createAuthEndpoint(
        "/pase/canjear",
        {
          method: "GET",
          query: z.object({ t: z.string().max(64), next: z.string().max(4000) }),
        },
        async (ctx) => {
          const target = arrivalOn(ctx.query.next, own)
          if (!target)
            throw APIError.from("BAD_REQUEST", {
              code: "PASE_DESTINO",
              message: "Esa dirección no es de esta app",
            })
          for (const [name, value] of Object.entries(NO_REFERRER)) ctx.setHeader(name, value)
          const mark = ctx.getCookie(PASE_COOKIE)
          // La marca sirve una vez, salga bien o no.
          ctx.setCookie(PASE_COOKIE, "", { ...markAttributes, maxAge: 0 })
          const adapter = ctx.context.internalAdapter
          // Se gasta al leerlo, sirva o no: un pase no se prueba dos veces.
          const record = ctx.query.t
            ? await adapter.consumeVerificationValue(`${PREFIX}${hash(ctx.query.t)}`)
            : null
          const stored = record ? parseStored(record.value) : null
          if (!record || !stored || !paseFits(stored, new Date(record.expiresAt), own, mark))
            throw ctx.redirect(target)
          const found = await adapter.findSession(stored.session)
          if (!found || new Date(found.session.expiresAt).getTime() <= Date.now())
            throw ctx.redirect(target)
          // La sesión que había en este dominio, si era otra, se cierra: en la compu del mostrador
          // nadie sigue trabajando a nombre de quien estuvo antes.
          const previous = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          )
          if (previous && previous !== found.session.token) {
            const before = await adapter.findSession(previous).catch(() => null)
            if (before && before.session.userId === found.session.userId)
              await options.onSessionReplaced?.(before.session.id, found.session.id).catch(() => undefined)
            await adapter.deleteSession(previous).catch(() => undefined)
          }
          await setSessionCookie(ctx, found)
          throw ctx.redirect(target)
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith("/pase/"),
        window: 60,
        max: 30,
      },
    ],
  } satisfies BetterAuthPlugin
}
