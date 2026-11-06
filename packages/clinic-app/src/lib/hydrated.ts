import { useSyncExternalStore } from "react"

const never = () => () => {}

/**
 * `false` en el servidor y mientras se hidrata; `true` después. Lo que solo
 * sabe el navegador (el enlace con su clave, lo guardado en él) se pinta
 * después de hidratar: así el primer pintado es igual al del servidor y React
 * no lo rechaza (#418).
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(never, () => true, () => false)
}
