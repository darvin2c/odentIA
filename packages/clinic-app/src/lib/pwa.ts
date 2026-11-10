import { apiFetch } from "./api"

/**
 * La app instalada de la clínica y sus avisos en este equipo (ADR 0177).
 *
 * Cada clínica es su propio origen (`<slug>.<dominio>`): el permiso del
 * navegador y la suscripción son de esta clínica en este equipo, no de la
 * persona. Por eso el interruptor vive en «Avisos» de la clínica y dice «en
 * este equipo». El service worker (`public/sw.js`) no guarda nada en caché.
 */

/** Lo que este equipo puede hacer con los avisos. */
export type PushSupport =
  | "listo"
  /** iPhone o iPad en Safari, sin instalar: los avisos llegan solo a la app en el inicio. */
  | "instalar-en-iphone"
  | "no-compatible"

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

const browser = typeof window !== "undefined"

/** El ofrecimiento de instalar del navegador (Chrome, Edge, Android). Llega una vez, a veces antes de pintar. */
let installPrompt: InstallPromptEvent | null = null
const installListeners = new Set<() => void>()
const tellInstall = () => {
  for (const listener of installListeners) listener()
}
if (browser) {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Sin la ventana del navegador al entrar: se ofrece solo en «Avisos».
    event.preventDefault()
    installPrompt = event as InstallPromptEvent
    tellInstall()
  })
  window.addEventListener("appinstalled", () => {
    installPrompt = null
    tellInstall()
  })
}

export function subscribeInstall(listener: () => void): () => void {
  installListeners.add(listener)
  return () => installListeners.delete(listener)
}

export const canOfferInstall = (): boolean => installPrompt !== null

/** Abre la ventana del navegador para instalar. Devuelve si la persona aceptó. */
export async function offerInstall(): Promise<boolean> {
  const prompt = installPrompt
  if (!prompt) return false
  await prompt.prompt()
  const { outcome } = await prompt.userChoice
  installPrompt = null
  tellInstall()
  return outcome === "accepted"
}

/** Abierta como app (desde el ícono), no en una pestaña. */
export function isInstalled(): boolean {
  if (!browser) return false
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true
}

export function isAppleMobile(): boolean {
  if (!browser) return false
  // El iPad de hoy se presenta como Mac: se reconoce por la pantalla táctil.
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

export function pushSupport(): PushSupport {
  if (!browser) return "no-compatible"
  if (isAppleMobile() && !isInstalled()) return "instalar-en-iphone"
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "no-compatible"
  return "listo"
}

/** Lo que decidió la persona en el navegador: `denied` ya no se puede volver a pedir desde la página. */
export function notificationPermission(): NotificationPermission {
  return browser && "Notification" in window ? Notification.permission : "default"
}

/**
 * Registra el service worker y escucha cuando un aviso pide abrir una pantalla
 * con la app ya abierta: navega el router, que respeta lo que se está escribiendo.
 */
export function registerAppWorker(open: (href: string) => void): () => void {
  if (!browser || !("serviceWorker" in navigator)) return () => undefined
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
    console.warn("No se pudo registrar la app en este equipo", error)
  })
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; href?: unknown } | null
    if (data?.type !== "odentia:abrir" || typeof data.href !== "string" || !isInternalPath(data.href)) return
    // Le dice al service worker que esta ventana se encarga; si nadie responde, abre otra.
    event.ports[0]?.postMessage("ok")
    open(data.href)
  }
  navigator.serviceWorker.addEventListener("message", onMessage)
  return () => navigator.serviceWorker.removeEventListener("message", onMessage)
}

/** La misma regla que `sw.js` y la campana: una ruta de esta clínica. */
export function isInternalPath(href: string): boolean {
  return /^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/.test(href)
}

/** El service worker listo, o un error si no se registró: `ready` sola esperaría para siempre. */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Sin la app en este equipo")), 8000))
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

async function readySubscription(): Promise<PushSubscription | null> {
  return (await readyRegistration()).pushManager.getSubscription()
}

/** Si la suscripción se hizo con la misma clave pública: si se cambiaron las claves, hay que suscribirse otra vez. */
function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index])
}

/** Si este equipo recibe hoy los avisos de quien mira (otra persona pudo activarlos después). */
export async function devicePushActive(): Promise<boolean> {
  if (pushSupport() !== "listo" || notificationPermission() !== "granted") return false
  const subscription = await readySubscription()
  if (!subscription) return false
  const { data } = await apiFetch<{ data: { active: boolean } }>("/api/push/subscriptions/state", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })
  return data.active
}

/** La clave pública VAPID como la pide `PushManager.subscribe`. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** El navegador no deja suscribirse aquí (ventana privada o de invitado, o push apagado): no es la red. */
export class PushBlockedError extends Error {}

let availableKey: Promise<string | null> | null = null
/** La clave pública del servidor, una vez por pestaña: sin ella los avisos no están disponibles. */
function publicKey(): Promise<string | null> {
  availableKey ??= apiFetch<{ data: { publicKey: string | null } }>("/api/push/key")
    .then(({ data }) => data.publicKey)
    .catch((error: unknown) => {
      availableKey = null
      throw error
    })
  return availableKey
}

/** Si el servidor ofrece los avisos en el equipo (tiene sus claves). */
export async function devicePushAvailable(): Promise<boolean> {
  return (await publicKey()) !== null
}

/** Cuando la persona cambia el permiso en el navegador con la página abierta. */
export function subscribePermission(listener: () => void): () => void {
  if (!browser || !navigator.permissions) return () => undefined
  let status: PermissionStatus | null = null
  let stopped = false
  navigator.permissions
    .query({ name: "notifications" })
    .then((found) => {
      if (stopped) return
      status = found
      status.addEventListener("change", listener)
    })
    .catch(() => undefined)
  return () => {
    stopped = true
    status?.removeEventListener("change", listener)
  }
}

/**
 * Activar los avisos en este equipo. El navegador pregunta solo aquí, después
 * del toque de la persona. Devuelve lo que decidió el navegador.
 */
export async function enableDevicePush(): Promise<NotificationPermission | "no-disponible"> {
  const serverKey = await publicKey()
  if (!serverKey) return "no-disponible"
  const permission = await Notification.requestPermission()
  if (permission !== "granted") return permission
  const registration = await readyRegistration()
  const key = applicationServerKey(serverKey)
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager
    .subscribe({ userVisibleOnly: true, applicationServerKey: key })
    .catch((error: unknown) => {
      // Chrome en una ventana privada responde así aunque el permiso esté dado.
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError"))
        throw new PushBlockedError(error.message)
      throw error
    })
  const json = subscription.toJSON()
  await apiFetch("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } }),
  })
  return "granted"
}

/** Apagar los avisos en este equipo: el servidor deja de enviar y el navegador olvida la suscripción. */
export async function disableDevicePush(): Promise<void> {
  const subscription = await readySubscription()
  if (!subscription) return
  await apiFetch("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) })
  await subscription.unsubscribe()
}

/**
 * Al cerrar sesión: este equipo deja de recibir los avisos de quien sale (la
 * compu del mostrador la usa otra persona después). Nunca frena el cierre.
 */
export async function forgetDevicePushOnSignOut(): Promise<void> {
  if (pushSupport() !== "listo") return
  try {
    const subscription = await Promise.race([
      readySubscription(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ])
    if (!subscription) return
    await apiFetch("/api/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined)
    await subscription.unsubscribe()
  } catch {
    // Sin suscripción en el navegador, el servicio de push responde que ya no existe y el worker la olvida.
  }
}

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
