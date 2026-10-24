import { platformPathPermission } from "@odentia/auth/permissions"

/**
 * Comprobaciones del árbol de rutas que arma cada app con las páginas comunes
 * (ADR 0086): la prueba de cada app las corre contra su `routeTree.gen.ts`.
 */

export interface TreeRoute {
  /** «/_org/agenda». */
  id: string
  /** «/agenda». */
  fullPath: string
  /** El archivo de la ruta como lo importa el árbol, sin extensión. */
  file: string
  /** La ruta que la contiene; null si cuelga de la raíz. */
  parentId: string | null
}

/** Las rutas del árbol generado, con su archivo y su padre. */
export function routesOf(tree: string): TreeRoute[] {
  const files = new Map(
    [...tree.matchAll(/import \{ Route as (\w+) \} from '([^']+)'/g)].map((m) => [
      m[1] ?? "",
      m[2] ?? "",
    ]),
  )
  const entries = [
    ...tree.matchAll(
      /'[^']+': \{\s+id: '([^']+)'\s+path: '[^']*'\s+fullPath: '([^']*)'\s+preLoaderRoute: typeof (\w+)\s+parentRoute: typeof (\w+)/g,
    ),
  ].map((m) => ({
    id: m[1] ?? "",
    fullPath: m[2] ?? "",
    importName: m[3] ?? "",
    parent: m[4] ?? "",
  }))
  // Cada ruta del árbol es `const X = XImport.update(…)`: su padre se nombra por X.
  const idOfVar = new Map(
    entries.map((entry) => [entry.importName.replace(/Import$/, ""), entry.id]),
  )
  return entries.map((entry) => ({
    id: entry.id,
    fullPath: entry.fullPath,
    file: files.get(entry.importName) ?? "",
    parentId:
      entry.parent === "rootRouteImport" ? null : (idOfVar.get(entry.parent) ?? entry.parent),
  }))
}

/**
 * Los padres que no dibujan a sus hijas con `<Outlet />`: sin él, el padre se
 * dibuja en lugar de la hija (así la página de un producto mostraba la lista
 * del inventario). `read` devuelve el texto del archivo de una ruta, o null.
 */
export function parentsWithoutOutlet(
  routes: readonly TreeRoute[],
  read: (file: string) => string | null,
): string[] {
  const parents = new Set(routes.flatMap((route) => (route.parentId ? [route.parentId] : [])))
  return [...parents].filter((id) => {
    const file = routes.find((route) => route.id === id)?.file
    const text = file ? read(file) : null
    return !text?.includes("<Outlet")
  })
}

/** Las pantallas bajo el layout de la clínica, por su dirección. */
export function clinicScreens(routes: readonly TreeRoute[]): string[] {
  return routes
    .filter((route) => route.id.startsWith("/_org/"))
    .map((route) => route.fullPath.replace(/\/$/, ""))
}

/** Pantallas de la clínica que cualquier miembro abre: no llevan regla a propósito. */
const OPEN_TO_EVERY_MEMBER = new Set(["/home"])

/** Las pantallas de la clínica sin regla de entrada: el guard dejaría entrar a cualquier rol. */
export function screensWithoutRule(routes: readonly TreeRoute[]): string[] {
  return clinicScreens(routes).filter(
    (path) => !OPEN_TO_EVERY_MEMBER.has(path) && platformPathPermission(path) === null,
  )
}

/** Direcciones que cambiaron de sitio: siguen existiendo solo para redirigir a la nueva. */
export const MOVED_SCREENS: Readonly<Record<string, string>> = {
  "/branches": "/settings/branches",
  "/members": "/settings/team",
  "/settings/channels": "/settings/integrations",
  "/settings/mail": "/settings/integrations",
  "/settings/webchat": "/settings/integrations/webchat",
  "/settings/agent": "/settings/integrations",
  "/agent/approvals": "/agent/pendientes",
  // Una persona, una página (ADR 0029): Contactos y la ficha redirigen a la persona.
  "/contacts": "/people",
  "/contacts/$contactId": "/people/$personId",
  "/patients": "/people",
  "/patients/$patientId": "/people/$personId",
}

/** Lo que dejó de existir de una dirección que cambió de sitio, o de su destino. */
export function brokenMoves(routes: readonly TreeRoute[]): string[] {
  const screens = new Set(clinicScreens(routes))
  return Object.entries(MOVED_SCREENS).flatMap(([from, to]) => [
    ...(screens.has(from)
      ? []
      : [`${from} dejó de existir: los enlaces y avisos guardados quedarían rotos`]),
    ...(screens.has(to) ? [] : [`${from} redirige a ${to}, que no es una pantalla`]),
  ])
}
