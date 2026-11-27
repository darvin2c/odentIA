import { createDevicePush, listenForInstall, registerAppWorker } from "@odentia/ui-patterns"
import { api } from "./api"

/**
 * Los avisos al celular de gestorIA (tablero 15). Lo del navegador es lo común de las clínicas
 * (`device-push` de @odentia/ui-patterns, ADR 0177); aquí, su servidor y su service worker
 * (`public/sw.js`). La app es un solo origen: cada celular se activa una vez y le llega lo de
 * todas las tiendas de la persona; qué le llega lo elige en cada tienda.
 */

/** Lo que elige cada persona, como lo manda el servidor (`apps/api/src/avisos.ts`). */
export interface PushChoices {
  kinds: { kind: string; label: string; hint: string; on: boolean }[]
  /** En cuántos celulares los recibe: lo que elige vale en todos. */
  devices: number
}

export const device = createDevicePush({
  request: (path, init) => {
    const call = api<unknown>(path, {
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body === undefined ? {} : { body: init.body }),
    })
    const signal = init?.signal
    if (!signal) return call
    // Al cerrar sesión no se espera de más: el servicio de push olvida solo lo que no se apagó.
    return Promise.race([
      call,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ])
  },
  paths: {
    key: "/api/avisos/clave",
    subscriptions: "/api/avisos/celular",
    state: "/api/avisos/celular/estado",
  },
  readKey: (response) => (response as { publicKey: string | null }).publicKey,
  readActive: (response) => (response as { active: boolean }).active,
})

/**
 * Al arrancar: guarda el ofrecimiento de instalar del navegador (se ofrece desde la tarjeta, sin
 * su ventana al entrar) y registra el service worker, que con la app abierta le pasa al router la
 * pantalla que abre un aviso.
 */
export function startInstalledApp(open: (href: string) => void): () => void {
  listenForInstall()
  return registerAppWorker(open, "gestoria:abrir")
}

/** «Ahora no» en la tarjeta de instalar: se recuerda en este celular, sin pasar al servidor. */
const LATER_KEY = "gestoria:avisos-ahora-no"
/** Una semana: después se vuelve a ofrecer, una vez. */
const LATER_MS = 7 * 24 * 3600_000

export function installCardDismissed(now = Date.now()): boolean {
  try {
    const at = Number(window.localStorage.getItem(LATER_KEY))
    return Number.isFinite(at) && at > 0 && now - at < LATER_MS
  } catch {
    return false
  }
}

export function dismissInstallCard(now = Date.now()): void {
  try {
    window.localStorage.setItem(LATER_KEY, String(now))
  } catch {
    // Sin almacenamiento (ventana privada): vuelve a salir la próxima vez.
  }
}
