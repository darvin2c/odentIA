import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { platformPathPermission } from "@odentia/auth/permissions"
import { expect, it } from "vitest"

/** Pantallas de la clínica que cualquier miembro abre: no llevan regla a propósito. */
const OPEN_TO_EVERY_MEMBER = new Set(["/home"])

it("toda pantalla de la clínica tiene su regla de entrada", () => {
  const tree = readFileSync(fileURLToPath(new URL("../routeTree.gen.ts", import.meta.url)), "utf8")
  const screens = [...tree.matchAll(/'\/_org\/[^']*': \{\s+id: '[^']+'\s+path: '[^']*'\s+fullPath: '([^']+)'/g)].map(
    (match) => (match[1] ?? "").replace(/\/$/, ""),
  )
  // Si el árbol generado cambia de forma, la prueba no debe pasar en vacío.
  expect(screens.length).toBeGreaterThan(30)
  // Sin regla, el guard deja entrar a cualquier rol y el servidor le niega los datos después.
  const withoutRule = screens.filter((path) => !OPEN_TO_EVERY_MEMBER.has(path) && platformPathPermission(path) === null)
  expect(withoutRule).toEqual([])
})
