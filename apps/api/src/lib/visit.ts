import { AsyncLocalStorage } from "node:async_hooks"

/**
 * El país de la visita mientras la cuenta de una app que es otro sistema atiende su petición
 * (ADR 0219). Better Auth arma el token firmado sin ver la petición (`definePayload` recibe solo
 * la sesión), y la marca del código del personal vale solo desde el país donde se puso: por eso
 * el país viaja aquí, de la ruta al token, solo durante esa petición.
 */
const visit = new AsyncLocalStorage<{ country: string | null }>()

export function withVisitCountry<T>(country: string | null, fn: () => Promise<T>): Promise<T> {
  return visit.run({ country }, fn)
}

/**
 * El país de la petición en curso. `undefined` fuera de una petición que lo dejó anotado: quien
 * lo usa para decidir un permiso lo niega (lado seguro).
 */
export function visitCountryNow(): { country: string | null } | undefined {
  return visit.getStore()
}
