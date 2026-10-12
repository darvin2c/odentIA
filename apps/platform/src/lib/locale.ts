import { setFormatRegion } from "@odentia/ui-patterns"
import { useSyncExternalStore } from "react"

/**
 * Formato regional de la clínica (`org_profile.locale`, BCP 47): la única
 * fuente del platform para fechas, horas y números.
 *
 * El layout `_org` lo alimenta al cargar el perfil (antes del primer render) y
 * cada vez que el perfil cambia. Sin perfil cargado —entradas públicas, clínica
 * sin configurar— vale `undefined`, que para `Intl` y `toLocale*` es el formato
 * del navegador: nunca se asume el de un país.
 *
 * - Componentes: `useOrgLocale()`, que vuelve a pintar si la clínica cambia su
 *   formato.
 * - Funciones puras de formato (no son hooks): `activeOrgLocale()` en el momento de
 *   formatear. No crear `Intl.*` a nivel de módulo: quedaría fijado antes de
 *   conocer la clínica.
 */
let current: string | undefined
let currentTimeZone: string | undefined
const listeners = new Set<() => void>()

/** Formato de la clínica o `undefined` (el del navegador) si aún no se conoce. */
export function activeOrgLocale(): string | undefined {
  return current
}

/**
 * Fija el formato (y la zona horaria, para «hoy») de la clínica. Devuelve si cambió; quien lo llama durante un
 * render avisa a los suscriptores después (`notifyOrgLocale`), no en el render.
 */
export function setOrgLocale(
  locale: string | null | undefined,
  timeZone?: string | null,
): boolean {
  const next = locale?.trim() || undefined
  const nextTimeZone = timeZone?.trim() || undefined
  if (next === current && nextTimeZone === currentTimeZone) return false
  current = next
  currentTimeZone = nextTimeZone
  // Los patrones compartidos (agenda, filtros, selectores) escriben con lo mismo.
  setFormatRegion({ locale: next, timeZone: nextTimeZone })
  return true
}

export function notifyOrgLocale(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOrgLocale(): string | undefined {
  return useSyncExternalStore(subscribe, activeOrgLocale, activeOrgLocale)
}

/**
 * Zona horaria de la clínica mientras el servidor no haya dicho la de la sede;
 * sin perfil, la del navegador. Nunca la de un país fijo.
 */
export function activeOrgTimeZone(): string {
  return currentTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
}
