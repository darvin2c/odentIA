import { useSyncExternalStore } from "react"

/**
 * Una versión nueva desplegada mientras la pestaña seguía abierta. Vite pone la
 * huella de cada archivo en su nombre y el despliegue deja solo los nuevos: lo
 * que baja recién al abrirse (las piezas, el 3D, los lectores de imágenes) ya no
 * existe para la versión vieja. No se recarga sola: cortaría la subida de un CD
 * o borraría lo que alguien está escribiendo. Se avisa una sola vez, con la salida.
 */

const listeners = new Set<() => void>()
let stale = false

export function markNewVersion(): void {
  if (stale) return
  stale = true
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** true desde que alguna parte no bajó por una versión nueva. */
export function useNewVersion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => stale,
    () => false,
  )
}

/**
 * ¿El error es de un archivo de la app que ya no está? Cada navegador lo dice
 * distinto (Chrome, Safari, Firefox) y Vite agrega el suyo al precargar.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i.test(
    message,
  )
}

/** Escucha el aviso de Vite al precargar; lo instala la raíz de cada app. Devuelve cómo quitarlo. */
export function watchNewVersion(): () => void {
  const onError = () => markNewVersion()
  window.addEventListener("vite:preloadError", onError)
  return () => window.removeEventListener("vite:preloadError", onError)
}
