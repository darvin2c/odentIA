import { toast } from "@odentia/ui"

/**
 * Una parte de la app que no bajó: casi siempre, una versión nueva desplegada
 * con la pestaña abierta (Vite pone la huella de cada archivo en su nombre y el
 * despliegue deja solo los nuevos), a veces un corte de la conexión. Lo que
 * baja recién al abrirse (las piezas, el 3D, los lectores de imágenes) no se
 * encuentra. No se recarga sola: cortaría la subida de un CD o borraría lo que
 * alguien está escribiendo. Se avisa una vez, con la salida (ADR 0149).
 */

let warned = false

export const NEW_VERSION_TEXT =
  "No se pudo cargar una parte de la página: puede haber una versión nueva o se cortó la conexión. Recarga para seguir; lo que ya guardaste no se pierde."

export function markNewVersion(): void {
  if (warned || typeof window === "undefined") return
  warned = true
  toast(NEW_VERSION_TEXT, {
    id: "version-nueva",
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Recargar", onClick: () => window.location.reload() },
  })
}

/**
 * ¿El error es de un archivo de la app que no bajó? Cada navegador lo dice
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
