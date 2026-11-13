/**
 * A dónde va cada correo que recibe el Worker, sin red ni dependencias (se prueba con
 * `node --test`). Las reglas fijas de Email Routing mandan aquí soporte@, contacto@, hola@ y
 * fundadores@, y el atrapa todo de cada dominio, cualquier otra dirección:
 *
 * - un buzón fijo (`buzon`) se reenvía al buzón de siempre y va a la API;
 * - cualquier otra parte local es de una persona del equipo (`persona`): la API dice si es de
 *   alguien (y a dónde va su copia) o si no existe, y entonces se rechaza;
 * - lo que tiene su propia regla a Gmail (privacidad@, reclamaciones@, redes@, reply@) nunca
 *   debería llegar aquí; si llega, igual que lo del servidor (no-reply@, postmaster@, abuse@),
 *   solo se reenvía (`reenviar`).
 *
 * Aparte, lo que no tiene una persona detrás no entra al ARM (`skipReason`): lo que sale de
 * nuestros dominios desde no-reply@ o reply@, las respuestas automáticas y los rebotes. Eso
 * solo se reenvía.
 */

export type Product = "dental" | "medical" | "optical"
export type Mailbox = "soporte" | "contacto" | "hola" | "fundadores"

export type Route =
  | { kind: "buzon"; mailbox: Mailbox; product: Product }
  | { kind: "persona"; localPart: string; product: Product }
  | { kind: "reenviar"; product: Product }

/** Cada dominio con su producto (`CLINICAL_PRODUCTS`). */
export const PRODUCTS: Record<string, Product> = {
  "odentia32.com": "dental",
  "latidia72.com": "medical",
  "vistia20.com": "optical",
}

const MAILBOXES: readonly Mailbox[] = ["soporte", "contacto", "hola", "fundadores"]

/** Solo se reenvían: tienen su propia regla en Email Routing o son del servidor de correo. */
const FORWARD_ONLY = new Set([
  "privacidad",
  "reclamaciones",
  "redes",
  "reply",
  "no-reply",
  "noreply",
  "postmaster",
  "abuse",
  "mailer-daemon",
])

/** Quien escribe desde uno de nuestros dominios sin persona detrás. */
const OUR_ROBOTS = new Set(["no-reply", "noreply", "reply"])

/** Quien avisa de un rebote o de un problema de entrega. */
const DELIVERY_ROBOTS = new Set(["mailer-daemon", "postmaster"])

function split(address: string): { local: string; domain: string } | null {
  const clean = address.trim().toLowerCase()
  const at = clean.lastIndexOf("@")
  if (at < 1) return null
  return {
    local: clean.slice(0, at).split("+")[0] ?? "",
    domain: clean.slice(at + 1).replace(/\.$/, ""),
  }
}

/** «Soporte+algo@OdentIA32.com» → buzón «soporte» de «dental»; null si no es un dominio nuestro. */
export function routeOf(recipient: string): Route | null {
  const parts = split(recipient)
  if (!parts) return null
  const product = PRODUCTS[parts.domain]
  if (!product || !parts.local) return null
  const mailbox = MAILBOXES.find((name) => name === parts.local)
  if (mailbox) return { kind: "buzon", mailbox, product }
  if (FORWARD_ONLY.has(parts.local)) return { kind: "reenviar", product }
  return { kind: "persona", localPart: parts.local, product }
}

/**
 * Por qué un correo no entra al ARM, o null si entra: `propio` si lo mandamos nosotros desde
 * no-reply@ o reply@ de un dominio nuestro; `automatico` si es una respuesta automática, un
 * envío masivo o un rebote (RFC 3834 `Auto-Submitted`, `X-Autoreply`, `X-Autorespond`,
 * `Precedence`, RFC 6522 `multipart/report`, o sin remitente, mailer-daemon@ o postmaster@).
 */
export function skipReason(
  header: (name: string) => string | null,
  from: string,
): "propio" | "automatico" | null {
  const sender = split(from)
  if (!sender?.local) return "automatico"
  if (DELIVERY_ROBOTS.has(sender.local)) return "automatico"
  if (PRODUCTS[sender.domain] && OUR_ROBOTS.has(sender.local)) return "propio"
  const auto = header("auto-submitted")?.trim().toLowerCase()
  if (auto && !auto.startsWith("no")) return "automatico"
  if (header("x-autoreply") !== null || header("x-autorespond") !== null) return "automatico"
  const precedence = header("precedence")?.trim().toLowerCase()
  if (precedence && ["bulk", "junk", "auto_reply", "list"].includes(precedence)) return "automatico"
  if (/^\s*multipart\/report\b/i.test(header("content-type") ?? "")) return "automatico"
  return null
}

/** Lo que acepta la API de cada cabecera del hilo. */
export const IN_REPLY_TO_MAX = 998
export const REFERENCES_MAX = 8000

function messageIds(value: string | null | undefined): string[] {
  const out: string[] = []
  for (const id of (value ?? "").match(/<[^<>\s]+>/g) ?? []) if (!out.includes(id)) out.push(id)
  return out
}

/**
 * `In-Reply-To` y `References` solo con sus Message-ID, recortados a lo que acepta la API:
 * de References se quedan el primero (el que abrió el hilo) y los últimos.
 */
export function threadHeaders(
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): { inReplyTo: string | null; references: string | null } {
  const reply = messageIds(inReplyTo)[0] ?? null
  const ids = messageIds(references)
  while (ids.length > 2 && ids.join(" ").length > REFERENCES_MAX) ids.splice(1, 1)
  const joined = ids.join(" ")
  return {
    inReplyTo: reply && reply.length <= IN_REPLY_TO_MAX ? reply : null,
    references: joined && joined.length <= REFERENCES_MAX ? joined : null,
  }
}
