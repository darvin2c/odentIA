import type { LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { hostnameOf, isPrivateAddress, parseLlmBaseUrl, ServiceError } from "@odentia/services"
import { Agent, type Dispatcher } from "undici"

export { isPrivateAddress, parseLlmBaseUrl } from "@odentia/services"

/** Códigos de problema del proveedor; `DAILY_LIMIT` lo emite la corrida, no la configuración. */
export type LlmProblemCode =
  | "MODEL_REQUIRED"
  | "API_KEY_REQUIRED"
  | "API_KEY_UNREADABLE"
  | "PROTOCOL_UNSUPPORTED"
  | "BASE_URL_INVALID"
  | "BASE_URL_UNSAFE"
  | "PROVIDER_REJECTED"
  | "PROVIDER_QUOTA"
  | "DAILY_LIMIT"

export class LlmConfigError extends Error {
  constructor(
    public readonly code:
      | "MODEL_REQUIRED"
      | "API_KEY_REQUIRED"
      | "API_KEY_UNREADABLE"
      | "PROTOCOL_UNSUPPORTED"
      | "BASE_URL_INVALID"
      | "BASE_URL_UNSAFE"
      | "PROVIDER_REJECTED"
      | "PROVIDER_QUOTA",
    message: string,
  ) {
    super(message)
    this.name = "LlmConfigError"
  }
}

function toConfigError(error: unknown): LlmConfigError {
  if (error instanceof LlmConfigError) return error
  if (error instanceof ServiceError) {
    const unsafe = /privada|https/.test(error.message)
    return new LlmConfigError(unsafe ? "BASE_URL_UNSAFE" : "BASE_URL_INVALID", error.message)
  }
  throw error
}

/** Validación sintáctica que lanza LlmConfigError (misma regla que services). */
export function parseSafeBaseUrl(raw: string, opts: { allowInsecure?: boolean } = {}): URL {
  try {
    return parseLlmBaseUrl(raw, opts)
  } catch (error) {
    throw toConfigError(error)
  }
}

async function resolvePublic(host: string): Promise<LookupAddress[]> {
  if (isIP(host) !== 0) return [{ address: host, family: isIP(host) }]
  let addresses: LookupAddress[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new LlmConfigError("BASE_URL_INVALID", `No se pudo resolver el host ${host}`)
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new LlmConfigError("BASE_URL_UNSAFE", "La URL base resuelve a una dirección privada")
  }
  return addresses
}

/**
 * Comprobación completa al guardar o probar: sintaxis y resolución DNS de
 * todas las direcciones del host. La garantía en cada llamada la da el
 * dispatcher, que valida la dirección en el momento de conectar.
 */
export async function assertSafeBaseUrl(raw: string, opts: { allowInsecure?: boolean } = {}): Promise<URL> {
  const url = parseSafeBaseUrl(raw, opts)
  if (!opts.allowInsecure) await resolvePublic(hostnameOf(url))
  return url
}

/**
 * Dispatcher que resuelve el nombre al conectar y rechaza cualquier
 * dirección privada: la petición solo sale hacia la dirección validada, sin
 * ventana entre comprobar y conectar (DNS rebinding).
 */
export function createPinnedDispatcher(opts: { allowInsecure?: boolean } = {}): Dispatcher {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        resolvePublic(hostname)
          .then((addresses) => {
            if (options.all) {
              callback(null, addresses.map((a) => ({ address: a.address, family: a.family })))
            } else {
              const first = addresses[0]!
              callback(null, first.address, first.family)
            }
          })
          .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), [], 0))
      },
    },
  })
}

/** En dev/e2e no se fija la dirección: los servidores de prueba son locales. */
export function dispatcherFor(opts: { allowInsecure?: boolean }): Dispatcher | undefined {
  return opts.allowInsecure ? undefined : createPinnedDispatcher()
}
