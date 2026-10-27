// WhatsApp con la app propia de la clínica: lo que odentIA le pregunta a Meta
// con los datos que la clínica pegó, antes y después de guardar la conexión.
// Aquí solo se habla con Meta y se dice qué respondió; qué decirle a la
// clínica lo decide el servicio. Registrar el número y suscribir la app usan
// las mismas llamadas que «Conectar con Facebook» (`registerPhoneNumber`,
// `subscribeAppToAccount`), con la clave de la clínica.
//
// Documentación leída el 2026-10-26:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration
// https://developers.facebook.com/docs/graph-api/reference/debug_token/
//
// SIN PROBAR CONTRA UNA CUENTA REAL: las formas de las respuestas son las que
// publica Meta; lo que no publica se dice junto a cada llamada.
import type { ChannelAdapterDeps } from "./protocol.js"
import { base, failure, graph, type MetaPlatformApp, MetaSignupError } from "./whatsapp-embedded-signup.js"

type Graph = Pick<MetaPlatformApp, "graphVersion">

/** Lo que Meta dice de la clave de acceso de una app propia. */
export interface OwnAppToken {
  /** La app a la que pertenece la clave. */
  appId: string
  /** `SYSTEM_USER`, `USER`, …; nulo si Meta no lo dijo. */
  type: string | null
  /** Cuándo vence; nulo: no vence. */
  expiresAt: Date | null
  /** Permisos que tiene la clave. */
  scopes: string[]
}

/** Qué no salió al revisar la clave de una app propia. */
export type OwnAppTokenProblem = "clave" | "clave-secreta"

/** La clave o la clave secreta no son lo que deberían; `MetaSignupError` cuando Meta no respondió. */
export class OwnAppTokenError extends Error {
  constructor(
    public problem: OwnAppTokenProblem,
    /** Lo que Meta explicó, sin interpretar. */
    public detail: string,
  ) {
    super(`Meta (comprobar): ${detail}`)
  }
}

/**
 * Revisa la clave de acceso y la clave secreta de la app propia de una clínica:
 * - `GET /app` con la clave dice de qué app es (Meta no publica que esto valga
 *   para una clave de usuario del sistema: por confirmar con una cuenta real);
 * - `GET /debug_token` con la clave de esa app (`<id>|<clave secreta>`) dice
 *   su tipo, cuándo vence y sus permisos. Si la clave secreta no es de esa app,
 *   Meta no acepta la clave de la app y la llamada falla: así se sabe que la
 *   clave secreta no corresponde, sin esperar a que un aviso llegue mal firmado.
 */
export async function inspectOwnAppToken(
  app: Graph,
  token: string,
  appSecret: string,
  deps: ChannelAdapterDeps,
): Promise<OwnAppToken> {
  const owner = await graph("comprobar", `${base(app)}/app?fields=id`, { method: "GET", token }, deps)
  if (owner.status >= 500 || owner.status === 0) throw failure("comprobar", owner)
  const appId =
    owner.status < 400 && owner.json && typeof owner.json === "object" && "id" in owner.json && typeof owner.json.id === "string"
      ? owner.json.id
      : null
  if (!appId) throw new OwnAppTokenError("clave", failure("comprobar", owner).detail)

  const query = new URLSearchParams({ input_token: token, access_token: `${appId}|${appSecret}` })
  const answer = await graph("comprobar", `${base(app)}/debug_token?${query.toString()}`, { method: "GET" }, deps)
  if (answer.status >= 500 || answer.status === 0) throw failure("comprobar", answer)
  if (answer.status >= 400) throw new OwnAppTokenError("clave-secreta", failure("comprobar", answer).detail)
  const data = answer.json && typeof answer.json === "object" && "data" in answer.json ? answer.json.data : null
  if (!data || typeof data !== "object") {
    throw new MetaSignupError("comprobar", answer.status, null, "Meta respondió sin los datos de la clave")
  }
  if (!("is_valid" in data) || data.is_valid !== true) throw new OwnAppTokenError("clave", "debug_token: la clave no es válida")
  const at = "expires_at" in data && typeof data.expires_at === "number" ? data.expires_at : 0
  const scopes =
    "scopes" in data && Array.isArray(data.scopes) ? data.scopes.filter((scope): scope is string => typeof scope === "string") : []
  return {
    appId,
    type: "type" in data && typeof data.type === "string" ? data.type : null,
    // Meta pone 0 en una clave que no vence.
    expiresAt: at > 0 ? new Date(at * 1000) : null,
    scopes,
  }
}

/** Si el número ya está registrado para la API de la nube. */
export interface OwnAppNumber {
  /** `CLOUD_API` cuando ya está registrado; nulo si Meta no lo dijo. */
  platformType: string | null
}

/**
 * Lee si el número ya está registrado, para no registrarlo de nuevo con un PIN
 * que no es el suyo. Meta muestra `platform_type: "CLOUD_API"` en un número
 * registrado; no publica los demás valores.
 */
export async function readOwnAppNumber(
  app: Graph,
  phoneNumberId: string,
  token: string,
  deps: ChannelAdapterDeps,
): Promise<OwnAppNumber> {
  const answer = await graph(
    "leer",
    `${base(app)}/${encodeURIComponent(phoneNumberId)}?fields=platform_type`,
    { method: "GET", token },
    deps,
  )
  if (answer.status >= 400 || answer.status === 0) throw failure("leer", answer)
  const json = answer.json
  const platformType =
    json && typeof json === "object" && "platform_type" in json && typeof json.platform_type === "string" ? json.platform_type : null
  return { platformType }
}
