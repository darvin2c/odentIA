import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  brokenMoves,
  clinicScreens,
  parentsWithoutOutlet,
  routesOf,
  screensWithoutRule,
} from "@odentia/clinic-app/lib/route-tree-checks"
import { expect, it } from "vitest"

/** El árbol que arma latidIA: las páginas comunes del paquete (ADR 0086). */
const here = dirname(fileURLToPath(import.meta.url))
const routes = routesOf(readFileSync(resolve(here, "routeTree.gen.ts"), "utf8"))
const read = (file: string): string | null => {
  for (const candidate of [`${file}.tsx`, `${file}/route.tsx`]) {
    const path = resolve(here, candidate)
    if (existsSync(path)) return readFileSync(path, "utf8")
  }
  return null
}

it("toda ruta anidada tiene un padre que la dibuja con <Outlet />", () => {
  const nested = routes.filter((route) => route.parentId !== null)
  // Si el árbol generado cambia de forma, la prueba no debe pasar en vacío.
  expect(nested.length).toBeGreaterThan(30)
  expect(parentsWithoutOutlet(routes, read)).toEqual([])
  // La página de un producto no va dentro de la lista del inventario.
  expect(routes.find((route) => route.id === "/_org/inventory_/$productId")?.parentId).toBe("/_org")
})

it("toda pantalla de la clínica tiene su regla de entrada", () => {
  expect(clinicScreens(routes).length).toBeGreaterThan(30)
  expect(screensWithoutRule(routes)).toEqual([])
})

it("una dirección que cambió de sitio sigue existiendo, igual que su destino", () => {
  expect(brokenMoves(routes)).toEqual([])
})

it("latidIA no trae las páginas del odontograma", () => {
  expect(routes.some((route) => route.id.includes("odontogram"))).toBe(false)
})
