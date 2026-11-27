import type { StoreRole } from "@gestoria/db"

/**
 * Qué puede cada rol de una tienda (decisión 7 del lienzo B). Es la matriz única: la API la
 * aplica en cada pedido y la pantalla solo la usa para no ofrecer lo que no se puede.
 *
 * - Dueño: todo, también el plan.
 * - Administrador: todo menos el plan.
 * - Ventas: atiende, confirma pagos y entrega; no toca la configuración ni el equipo.
 *
 * Los permisos de atender, confirmar pagos y entregar ya están aquí aunque sus pantallas lleguen
 * en B2 y B4: así la matriz se decide una vez. «configuracion» es cambiar los medios de pago, las
 * formas de entrega, el catálogo, sus precios y el stock (entradas y ajustes); «catalogo.ver» es
 * verlos, sin cambiarlos (B3); «costos.ver» es ver lo que costó cada producto (el costo de las
 * entradas del kardex y el aviso del mínimo), que Ventas no ve. «reportes.ver» es Reportes y lo
 * que hizo y le toca a Argos (B5, tablero 13): solo Dueño y Administrador. «ayuda.pedir» es
 * escribirle al equipo de gestorIA desde la Ayuda: todo el equipo (decisión 6 del lienzo
 * «gestorIA como odentIA»); lo del cobro, solo con «plan». «avisos.recibir» es recibir en el
 * celular los avisos de lo que su rol resuelve y elegir cuáles (tablero 15): todo el equipo;
 * qué avisos le llegan sale de los demás permisos (`avisos.ts`). Soporte no es del equipo: no.
 */
export const STORE_PERMISSIONS = [
  "tienda.ver",
  "equipo.ver",
  "equipo.gestionar",
  "configuracion",
  "catalogo.ver",
  "costos.ver",
  "reportes.ver",
  "plan",
  "ventas.atender",
  "pagos.confirmar",
  "entregas",
  "ayuda.pedir",
  "avisos.recibir",
] as const
export type StorePermission = (typeof STORE_PERMISSIONS)[number]

const SALES: readonly StorePermission[] = [
  "tienda.ver",
  "equipo.ver",
  "catalogo.ver",
  "ventas.atender",
  "pagos.confirmar",
  "entregas",
  "ayuda.pedir",
  "avisos.recibir",
]

/**
 * Soporte de gestorIA, mientras su entrada esté aceptada (ADR 0214): no es del equipo ni un rol que
 * se da, y solo mira lo que no se toca al mirarlo (la tienda, su equipo y su catálogo, sin costos).
 * Lo que se lee con permisos que también escriben (atender, pagos, entregas) queda fuera, y no le
 * pide ayuda a su propio equipo (`ayuda.pedir`).
 */
export type StoreSeat = StoreRole | "support"

export const ROLE_PERMISSIONS: Record<StoreSeat, readonly StorePermission[]> = {
  owner: STORE_PERMISSIONS,
  admin: STORE_PERMISSIONS.filter((permission) => permission !== "plan"),
  sales: SALES,
  support: ["tienda.ver", "equipo.ver", "catalogo.ver"],
}

/** Los nombres de cada rol, como los ve la persona. */
export const ROLE_NAMES: Record<StoreSeat, string> = {
  owner: "Dueño",
  admin: "Administrador",
  sales: "Ventas",
  support: "Soporte de gestorIA",
}

export function can(role: StoreSeat, permission: StorePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * Si quien tiene `actor` puede dar el rol `target` (al invitar o al cambiar un rol) o tocar a
 * alguien que lo tiene: solo un Dueño hace o toca a otro Dueño, porque el Dueño decide el plan.
 */
export function canAssign(actor: StoreSeat, target: StoreRole): boolean {
  if (!can(actor, "equipo.gestionar")) return false
  return target !== "owner" || actor === "owner"
}
