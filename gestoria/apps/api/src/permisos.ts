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
 * entradas del kardex y el aviso del mínimo), que Ventas no ve.
 */
export const STORE_PERMISSIONS = [
  "tienda.ver",
  "equipo.ver",
  "equipo.gestionar",
  "configuracion",
  "catalogo.ver",
  "costos.ver",
  "plan",
  "ventas.atender",
  "pagos.confirmar",
  "entregas",
] as const
export type StorePermission = (typeof STORE_PERMISSIONS)[number]

const SALES: readonly StorePermission[] = [
  "tienda.ver",
  "equipo.ver",
  "catalogo.ver",
  "ventas.atender",
  "pagos.confirmar",
  "entregas",
]

export const ROLE_PERMISSIONS: Record<StoreRole, readonly StorePermission[]> = {
  owner: STORE_PERMISSIONS,
  admin: STORE_PERMISSIONS.filter((permission) => permission !== "plan"),
  sales: SALES,
}

/** Los nombres de cada rol, como los ve la persona. */
export const ROLE_NAMES: Record<StoreRole, string> = {
  owner: "Dueño",
  admin: "Administrador",
  sales: "Ventas",
}

export function can(role: StoreRole, permission: StorePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission)
}

/**
 * Si quien tiene `actor` puede dar el rol `target` (al invitar o al cambiar un rol) o tocar a
 * alguien que lo tiene: solo un Dueño hace o toca a otro Dueño, porque el Dueño decide el plan.
 */
export function canAssign(actor: StoreRole, target: StoreRole): boolean {
  if (!can(actor, "equipo.gestionar")) return false
  return target !== "owner" || actor === "owner"
}
