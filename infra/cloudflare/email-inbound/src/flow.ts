/**
 * Qué hace el Worker con un correo, según a dónde llegó (`routeOf`), sin red: el reenvío, la
 * API y el rechazo los da quien llama (en `index.ts`, los de Cloudflare). Así se prueba con
 * `node --test`.
 *
 * - Un buzón fijo: primero se reenvía a `FORWARD_TO` (así nada se pierde) y después va a la
 *   API, una sola vez. Solo si fallan las dos cosas se rechaza.
 * - La dirección de una persona: primero la API, que dice si es de alguien y a dónde va su
 *   copia. Con 2xx se reenvía a esa copia, si la tiene; con 404 (`MAILBOX_UNKNOWN`) se rechaza
 *   («Esta dirección no existe») sin reenviar; con otro error o sin red, se reenvía a
 *   `FORWARD_TO`.
 * - Lo que no entra al ARM (`skipReason`), lo que solo se reenvía y lo de otro dominio: solo se
 *   reenvía a `FORWARD_TO`.
 */
import { type Route, routeOf } from "./route.ts"

export interface FlowEnv {
  /** El buzón de siempre (o varios, separados por comas), verificado en Email Routing. */
  FORWARD_TO?: string
}

/** Lo que respondió la API: `ok` (con la copia de la persona), `unknown` (404) o `error`. */
export type ApiOutcome =
  | { status: "ok"; copyTo: string | null }
  | { status: "unknown" }
  | { status: "error" }

export interface FlowDeps {
  forward(to: string): Promise<void>
  reject(reason: string): void
  /** Manda el correo a la API, una sola vez. */
  post(route: Exclude<Route, { kind: "reenviar" }>): Promise<ApiOutcome>
  /** Por qué no entra al ARM, o null (`skipReason` sobre el correo). */
  skipReason(): "propio" | "automatico" | null
  warn(message: string): void
}

export const REJECT_UNKNOWN = "Esta dirección no existe"
export const REJECT_LATER = "No pudimos recibir su correo en este momento. Inténtelo más tarde."

function destinations(env: FlowEnv): string[] {
  return (env.FORWARD_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean)
}

/** Reenvía al buzón de siempre; devuelve si llegó a alguno. */
async function forwardHome(env: FlowEnv, deps: FlowDeps): Promise<boolean> {
  const to = destinations(env)
  if (!to.length) deps.warn("correo entrante: falta FORWARD_TO; no se reenvió")
  let forwarded = false
  for (const destination of to) {
    try {
      await deps.forward(destination)
      forwarded = true
    } catch (error) {
      deps.warn(`correo entrante: no se pudo reenviar a un destino: ${String(error)}`)
    }
  }
  return forwarded
}

async function postOnce(route: Exclude<Route, { kind: "reenviar" }>, deps: FlowDeps) {
  try {
    return await deps.post(route)
  } catch (error) {
    deps.warn(`correo entrante: no se pudo mandar a la API; no se reintenta: ${String(error)}`)
    return { status: "error" } as const
  }
}

export async function deliver(recipient: string, env: FlowEnv, deps: FlowDeps): Promise<void> {
  const route = routeOf(recipient)
  const skip = route && route.kind !== "reenviar" ? deps.skipReason() : null
  if (!route || route.kind === "reenviar" || skip) {
    if (skip) deps.warn(`correo entrante: no entra al ARM (${skip}); solo se reenvía`)
    if (!(await forwardHome(env, deps))) deps.reject(REJECT_LATER)
    return
  }
  if (route.kind === "buzon") {
    const forwarded = await forwardHome(env, deps)
    const answer = await postOnce(route, deps)
    if (!forwarded && answer.status !== "ok") deps.reject(REJECT_LATER)
    return
  }
  const answer = await postOnce(route, deps)
  if (answer.status === "unknown") {
    deps.reject(REJECT_UNKNOWN)
    return
  }
  if (answer.status === "ok") {
    if (!answer.copyTo) return
    try {
      await deps.forward(answer.copyTo)
    } catch (error) {
      // Ya está en el ARM: la copia que no llegó (sin verificar en Email Routing) solo se anota.
      deps.warn(`correo entrante: no se pudo dejar la copia de una persona: ${String(error)}`)
    }
    return
  }
  if (!(await forwardHome(env, deps))) deps.reject(REJECT_LATER)
}
