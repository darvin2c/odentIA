// «Conectar con Facebook» (Embedded Signup de Meta, versión 4): las tres
// llamadas que hace el servidor después de que la clínica termina la ventana de
// Meta. Aquí solo se habla con Meta y se dice qué respondió; qué hacer con cada
// respuesta lo decide el servicio.
//
// Documentación leída el 2026-10-13 (la URL exacta va junto a cada llamada):
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
//
// NADA DE ESTO SE HA PROBADO CONTRA META: la app de odentIA todavía no existe.
// Las formas de las respuestas son las que publica la documentación; donde esta
// no las muestra completas se aceptan las variantes razonables y se dice.
import { randomInt } from "node:crypto"
import type { ChannelAdapterDeps } from "./protocol.js"

/** La app de odentIA en Meta: la misma para todas las clínicas. */
export interface MetaPlatformApp {
  appId: string
  appSecret: string
  /** Versión del Graph API, con su «v»: `v25.0`. */
  graphVersion: string
}

export type MetaSignupStep = "canjear" | "suscribir" | "registrar"

/** Meta no aceptó un paso. Lleva lo que respondió, sin interpretarlo. */
export class MetaSignupError extends Error {
  constructor(
    public step: MetaSignupStep,
    /** Código HTTP; 0 si Meta no llegó a responder (red). */
    public httpStatus: number,
    /** `error.code` del Graph API; nulo si la respuesta no lo trae. */
    public code: number | null,
    /** Lo que Meta explica (`error.error_data.details` o `error.message`). */
    public detail: string,
  ) {
    super(`Meta (${step}): ${detail}`)
  }

  /** Meta no respondió o falló de su lado: el mismo paso puede salir bien al repetirlo. */
  get transient(): boolean {
    return this.httpStatus === 0 || this.httpStatus >= 500
  }
}

interface GraphAnswer {
  status: number
  /** La respuesta leída como JSON; nulo si no lo era. */
  json: unknown
  /** La respuesta tal como llegó. */
  raw: string
}

async function graph(
  step: MetaSignupStep,
  url: string,
  init: { method: "GET" | "POST"; token?: string; body?: unknown },
  deps: ChannelAdapterDeps,
): Promise<GraphAnswer> {
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: init.method,
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  } catch {
    // El motivo de la red no se copia: podría arrastrar la dirección con sus claves.
    throw new MetaSignupError(step, 0, null, "Meta no respondió")
  }
  const raw = await res.text().catch(() => "")
  let json: unknown = null
  try {
    json = JSON.parse(raw) as unknown
  } catch {
    json = null
  }
  return { status: res.status, json, raw }
}

/**
 * Forma del error del Graph API: `{ error: { message, type, code, error_data: { details } } }`.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
function failure(step: MetaSignupStep, answer: GraphAnswer): MetaSignupError {
  const error =
    answer.json && typeof answer.json === "object" && "error" in answer.json ? answer.json.error : null
  if (!error || typeof error !== "object") {
    return new MetaSignupError(step, answer.status, null, `HTTP ${answer.status}`)
  }
  const code = "code" in error && typeof error.code === "number" ? error.code : null
  const data = "error_data" in error && error.error_data && typeof error.error_data === "object" ? error.error_data : null
  const details = data && "details" in data && typeof data.details === "string" ? data.details : null
  const message = "message" in error && typeof error.message === "string" ? error.message : null
  return new MetaSignupError(step, answer.status, code, details ?? message ?? `HTTP ${answer.status}`)
}

/** `{ "success": true }`; la referencia del registro admite también el texto `"true"`. */
function succeeded(json: unknown): boolean {
  if (!json || typeof json !== "object" || !("success" in json)) return false
  return json.success === true || json.success === "true"
}

const base = (app: Pick<MetaPlatformApp, "graphVersion">) => `https://graph.facebook.com/${app.graphVersion}`

/** La clave de la clínica y en cuántos segundos vence, si Meta lo dijo. */
export interface SignupToken {
  token: string
  /** `expires_in` de la respuesta; nulo si no vino (la clave sola, como texto). */
  expiresInSeconds: number | null
}

/** `expires_in` del Graph API: segundos, como número o como texto. */
function expiresInOf(json: object): number | null {
  const value = "expires_in" in json ? json.expires_in : undefined
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null
}

/**
 * Paso 1: canjea el código que devuelve la ventana de Meta por la clave de la
 * clínica («business token»). El código vive 30 segundos y sirve una vez: se
 * canjea antes que cualquier otra cosa.
 *
 * Paso 1 de la guía: `GET /oauth/access_token?client_id&client_secret&code`
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 *
 * La documentación muestra la respuesta solo como `<BUSINESS_TOKEN>`, sin decir
 * su envoltura. Se acepta la habitual de este punto del Graph API
 * (`{ "access_token": "…", "expires_in": … }`) y también la clave sola, como
 * texto. Por confirmar en la primera prueba real, igual que el plazo: la
 * configuración de «Conectar con Facebook» dice 60 días (darvin2c/odentIA#121).
 */
export async function exchangeSignupCode(
  app: MetaPlatformApp,
  code: string,
  deps: ChannelAdapterDeps,
): Promise<SignupToken> {
  const query = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, code })
  const answer = await graph("canjear", `${base(app)}/oauth/access_token?${query.toString()}`, { method: "GET" }, deps)
  if (answer.status >= 400) throw failure("canjear", answer)
  const { json } = answer
  if (json && typeof json === "object") {
    if ("error" in json) throw failure("canjear", answer)
    if ("access_token" in json && typeof json.access_token === "string" && json.access_token) {
      return { token: json.access_token, expiresInSeconds: expiresInOf(json) }
    }
  }
  if (typeof json === "string" && json) return { token: json, expiresInSeconds: null }
  const plain = answer.raw.trim()
  // Una clave es una cadena opaca sin espacios; cualquier otra cosa no se toma por clave.
  if (json === null && /^[A-Za-z0-9_\-|.]{20,}$/.test(plain)) return { token: plain, expiresInSeconds: null }
  throw new MetaSignupError("canjear", answer.status, null, "Meta respondió sin la clave de la cuenta")
}

/**
 * Paso 2: suscribe la app de odentIA a los avisos de la cuenta de WhatsApp
 * Business de la clínica. Sin esto Meta no entrega nada de esa cuenta. Los
 * avisos llegan a la dirección de la app, la misma para todas las clínicas; no
 * se usa una dirección alterna por cuenta ni por número. Repetirla no cambia nada.
 *
 * Paso 2 de la guía: `POST /<WABA_ID>/subscribed_apps` → `{ "success": true }`
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks
 */
export async function subscribeAppToAccount(
  app: Pick<MetaPlatformApp, "graphVersion">,
  wabaId: string,
  token: string,
  deps: ChannelAdapterDeps,
): Promise<void> {
  const answer = await graph(
    "suscribir",
    `${base(app)}/${encodeURIComponent(wabaId)}/subscribed_apps`,
    { method: "POST", token },
    deps,
  )
  if (answer.status >= 400 || !succeeded(answer.json)) throw failure("suscribir", answer)
}

/**
 * Paso 3: registra el número para usarlo con la Cloud API. El PIN pasa a ser el
 * de la verificación en dos pasos del número: si el número ya tenía uno, Meta
 * exige ese mismo. Por eso el PIN se guarda antes de llamar y no se inventa otro
 * para un número ya registrado. Meta admite 10 intentos por número cada 72 horas
 * y exige registrar dentro de los 14 días siguientes a la ventana de Meta.
 *
 * Paso 3 de la guía: `POST /<PHONE_NUMBER_ID>/register` `{ messaging_product: "whatsapp", pin }` → `{ "success": true }`
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration
 */
export async function registerPhoneNumber(
  app: Pick<MetaPlatformApp, "graphVersion">,
  phoneNumberId: string,
  token: string,
  pin: string,
  deps: ChannelAdapterDeps,
): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new Error("El PIN de registro debe tener 6 dígitos")
  const answer = await graph(
    "registrar",
    `${base(app)}/${encodeURIComponent(phoneNumberId)}/register`,
    { method: "POST", token, body: { messaging_product: "whatsapp", pin } },
    deps,
  )
  if (answer.status >= 400 || !succeeded(answer.json)) throw failure("registrar", answer)
}

/** PIN de 6 dígitos para el registro, del generador criptográfico. */
export function newRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0")
}
