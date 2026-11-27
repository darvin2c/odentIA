import {
  createDevicePush,
  listenForInstall,
  registerAppWorker as registerWorker,
} from "@odentia/ui-patterns"
import { apiFetch } from "./api"

/**
 * La app instalada de la clínica y sus avisos en este equipo (ADR 0177).
 *
 * Cada clínica es su propio origen (`<slug>.<dominio>`): el permiso del
 * navegador y la suscripción son de esta clínica en este equipo, no de la
 * persona. Por eso el interruptor vive en «Avisos» de la clínica y dice «en
 * este equipo». El service worker (`public/sw.js`) no guarda nada en caché.
 *
 * Lo del navegador es de uso general (`device-push` de `@odentia/ui-patterns`,
 * que también usa gestorIA); aquí queda lo de la clínica: su API y el mensaje
 * de su service worker.
 */
export {
  applicationServerKey,
  canOfferInstall,
  isAppleMobile,
  isInstalled,
  isInternalPath,
  notificationPermission,
  offerInstall,
  PushBlockedError,
  type PushSupport,
  pushSupport,
  subscribeInstall,
  subscribePermission,
} from "@odentia/ui-patterns"

const browser = typeof window !== "undefined"

// Sin la ventana del navegador al entrar: se ofrece solo en «Avisos».
listenForInstall()

/**
 * Registra el service worker y escucha cuando un aviso pide abrir una pantalla
 * con la app ya abierta: navega el router, que respeta lo que se está escribiendo.
 */
export function registerAppWorker(open: (href: string) => void): () => void {
  return registerWorker(open, "odentia:abrir")
}

const device = createDevicePush({
  request: (path, init) =>
    apiFetch(path, {
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
    }),
  paths: { key: "/api/push/key", subscriptions: "/api/push/subscriptions", state: "/api/push/subscriptions/state" },
  readKey: (response) => (response as { data: { publicKey: string | null } }).data.publicKey,
  readActive: (response) => (response as { data: { active: boolean } }).data.active,
})

/** Si este equipo recibe hoy los avisos de quien mira (otra persona pudo activarlos después). */
export const devicePushActive = (): Promise<boolean> => device.active()

/** Si el servidor ofrece los avisos en el equipo (tiene sus claves). */
export const devicePushAvailable = (): Promise<boolean> => device.available()

/**
 * Activar los avisos en este equipo. El navegador pregunta solo aquí, después
 * del toque de la persona. Devuelve lo que decidió el navegador.
 */
export const enableDevicePush = (): Promise<NotificationPermission | "no-disponible"> => device.enable()

/** Apagar los avisos en este equipo: el servidor deja de enviar y el navegador olvida la suscripción. */
export const disableDevicePush = (): Promise<void> => device.disable()

/**
 * Al cerrar sesión: este equipo deja de recibir los avisos de quien sale (la
 * compu del mostrador la usa otra persona después). Nunca frena el cierre.
 */
export const forgetDevicePushOnSignOut = (): Promise<void> => device.forgetOnSignOut()

/** En línea según el navegador (`navigator.onLine`): con wifi pero sin internet no se entera. */
export function isOnline(): boolean {
  return !browser || navigator.onLine !== false
}

export function subscribeOnline(listener: () => void): () => void {
  if (!browser) return () => undefined
  window.addEventListener("online", listener)
  window.addEventListener("offline", listener)
  return () => {
    window.removeEventListener("online", listener)
    window.removeEventListener("offline", listener)
  }
}

/**
 * Las barras del teléfono (arriba la hora, abajo los botones) del color del fondo de
 * la app, también cuando la persona eligió claro u oscuro distinto al del teléfono:
 * lee `--canvas` ya calculado y lo vuelve a leer al cambiar el tema.
 */
export function syncThemeColor(): () => void {
  if (!browser) return () => undefined
  const root = document.documentElement
  const apply = () => {
    const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim()
    if (!canvas) return
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = canvas
      meta.removeAttribute("media")
    }
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(root, { attributes: true, attributeFilter: ["class", "style", "data-theme"] })
  const scheme = window.matchMedia?.("(prefers-color-scheme: dark)")
  scheme?.addEventListener("change", apply)
  return () => {
    observer.disconnect()
    scheme?.removeEventListener("change", apply)
  }
}
