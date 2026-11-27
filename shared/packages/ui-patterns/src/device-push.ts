/**
 * La app instalable y los avisos en este equipo (push web, ADR 0177), de uso general: lo del
 * navegador, sin la API de ninguna app. Cada app le pasa cómo llama a su servidor
 * (`createDevicePush`) y escucha el ofrecimiento de instalar al arrancar (`listenForInstall`).
 *
 * El permiso del navegador y la suscripción son de este origen en este equipo, no de la persona:
 * por eso todo dice «en este equipo». El service worker de cada app no guarda nada en caché.
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
let listening = false
const installListeners = new Set<() => void>()
const tellInstall = () => {
  for (const listener of installListeners) listener()
}

/**
 * Guarda el ofrecimiento de instalar para ofrecerlo desde la app, sin la ventana del navegador
 * al entrar. Lo llama cada app que se instala al arrancar (no al importar este paquete: las apps
 * que no se instalan conservan lo que hace el navegador). Llamarlo dos veces no repite nada.
 */
export function listenForInstall(): void {
  if (!browser || listening) return
  listening = true
  window.addEventListener("beforeinstallprompt", (event) => {
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
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

export function isAppleMobile(): boolean {
  if (!browser) return false
  // El iPad de hoy se presenta como Mac: se reconoce por la pantalla táctil.
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  )
}

export function pushSupport(): PushSupport {
  if (!browser) return "no-compatible"
  if (isAppleMobile() && !isInstalled()) return "instalar-en-iphone"
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "no-compatible"
  return "listo"
}

/** Lo que decidió la persona en el navegador: `denied` ya no se puede volver a pedir desde la página. */
export function notificationPermission(): NotificationPermission {
  return browser && "Notification" in window ? Notification.permission : "default"
}

/** Una ruta de esta app (la misma regla que el service worker): nunca otra dirección. */
export function isInternalPath(href: string): boolean {
  return /^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/.test(href)
}

/**
 * Registra el service worker (`/sw.js`) y escucha cuando un aviso pide abrir una pantalla con la
 * app ya abierta: navega con el router, que respeta lo que se está escribiendo. `message` es el
 * tipo del mensaje que manda el service worker de esa app.
 */
export function registerAppWorker(
  open: (href: string) => void,
  message: string,
  onFail: (error: unknown) => void = (error) =>
    console.warn("No se pudo registrar la app en este equipo", error),
): () => void {
  if (!browser || !("serviceWorker" in navigator)) return () => undefined
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(onFail)
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; href?: unknown } | null
    if (data?.type !== message || typeof data.href !== "string" || !isInternalPath(data.href))
      return
    // Le dice al service worker que esta ventana se encarga; si nadie responde, abre otra.
    event.ports[0]?.postMessage("ok")
    open(data.href)
  }
  navigator.serviceWorker.addEventListener("message", onMessage)
  return () => navigator.serviceWorker.removeEventListener("message", onMessage)
}

/** La clave pública VAPID (RFC 8292) como la pide `PushManager.subscribe`. */
export function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/")
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** El navegador no deja suscribirse aquí (ventana privada o de invitado, o push apagado): no es la red. */
export class PushBlockedError extends Error {}

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

/** El service worker listo, o un error si no se registró: `ready` sola esperaría para siempre. */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Sin la app en este equipo")), 8000),
  )
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

/** Cómo la app llama a su servidor: lo que responde ya leído como JSON. */
export type DevicePushRequest = (
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<unknown>

/** Las direcciones del servidor de la app. */
export interface DevicePushPaths {
  /** GET: `{ publicKey: string | null }`, o lo que entregue `readKey`. */
  key: string
  /** POST `{ endpoint, keys }` para activar; DELETE `{ endpoint }` para apagar. */
  subscriptions: string
  /** POST `{ endpoint }`: `{ active: boolean }`, o lo que entregue `readActive`. */
  state: string
}

export interface DevicePushOptions {
  request: DevicePushRequest
  paths: DevicePushPaths
  /** Saca la clave pública de lo que responde el servidor. */
  readKey: (response: unknown) => string | null
  /** Saca si este equipo recibe los avisos de quien mira. */
  readActive: (response: unknown) => boolean
}

/** Los avisos en este equipo, hablando con el servidor de una app. */
export interface DevicePush {
  /** Si el servidor ofrece los avisos (tiene sus claves). */
  available(): Promise<boolean>
  /** Si este equipo recibe hoy los avisos de quien mira (otra persona pudo activarlos después). */
  active(): Promise<boolean>
  /** Activa: el navegador pregunta solo aquí, después del toque. Devuelve lo que decidió. */
  enable(): Promise<NotificationPermission | "no-disponible">
  /** Apaga: el servidor deja de enviar y el navegador olvida la suscripción. */
  disable(): Promise<void>
  /** Al cerrar sesión, este equipo deja de recibir los avisos de quien sale. Nunca frena el cierre. */
  forgetOnSignOut(): Promise<void>
}

export function createDevicePush(options: DevicePushOptions): DevicePush {
  const { request, paths } = options
  let availableKey: Promise<string | null> | null = null
  /** La clave pública del servidor, una vez por pestaña: sin ella los avisos no están disponibles. */
  const publicKey = (): Promise<string | null> => {
    availableKey ??= request(paths.key)
      .then(options.readKey)
      .catch((error: unknown) => {
        availableKey = null
        throw error
      })
    return availableKey
  }
  return {
    async available() {
      return (await publicKey()) !== null
    },
    async active() {
      if (pushSupport() !== "listo" || notificationPermission() !== "granted") return false
      const subscription = await readySubscription()
      if (!subscription) return false
      return options.readActive(
        await request(paths.state, { method: "POST", body: { endpoint: subscription.endpoint } }),
      )
    },
    async enable() {
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
          if (
            error instanceof DOMException &&
            (error.name === "NotAllowedError" || error.name === "AbortError")
          )
            throw new PushBlockedError(error.message)
          throw error
        })
      const json = subscription.toJSON()
      await request(paths.subscriptions, {
        method: "POST",
        body: {
          endpoint: subscription.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
        },
      })
      return "granted"
    },
    async disable() {
      const subscription = await readySubscription()
      if (!subscription) return
      await request(paths.subscriptions, {
        method: "DELETE",
        body: { endpoint: subscription.endpoint },
      })
      await subscription.unsubscribe()
    },
    async forgetOnSignOut() {
      if (pushSupport() !== "listo") return
      try {
        const subscription = await Promise.race([
          readySubscription(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ])
        if (!subscription) return
        await request(paths.subscriptions, {
          method: "DELETE",
          body: { endpoint: subscription.endpoint },
          signal: AbortSignal.timeout(3000),
        }).catch(() => undefined)
        await subscription.unsubscribe()
      } catch {
        // Sin suscripción en el navegador, el servicio de push responde que ya no existe y el
        // servidor la olvida.
      }
    },
  }
}
