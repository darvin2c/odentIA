import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { platformPathPermission } from "@odentia/auth/permissions"
import { expect, it } from "vitest"

/** Pantallas de la clínica que cualquier miembro abre: no llevan regla a propósito. */
const OPEN_TO_EVERY_MEMBER = new Set(["/home"])

/** Direcciones que cambiaron de sitio: siguen existiendo solo para redirigir a la nueva. */
const MOVED: Record<string, string> = {
  "/branches": "/settings/branches",
  "/members": "/settings/team",
  "/settings/channels": "/settings/integrations",
  "/settings/mail": "/settings/integrations",
  "/settings/webchat": "/settings/integrations/webchat",
  "/settings/agent": "/settings/integrations/model",
}

/** Las pantallas bajo el layout de la clínica, tal como las declara el árbol generado. */
function clinicScreens(): string[] {
  const tree = readFileSync(fileURLToPath(new URL("../routeTree.gen.ts", import.meta.url)), "utf8")
  return [...tree.matchAll(/'\/_org\/[^']*': \{\s+id: '[^']+'\s+path: '[^']*'\s+fullPath: '([^']+)'/g)].map((match) =>
    (match[1] ?? "").replace(/\/$/, ""),
  )
}

it("toda pantalla de la clínica tiene su regla de entrada", () => {
  const screens = clinicScreens()
  // Si el árbol generado cambia de forma, la prueba no debe pasar en vacío.
  expect(screens.length).toBeGreaterThan(30)
  // Sin regla, el guard deja entrar a cualquier rol y el servidor le niega los datos después.
  const withoutRule = screens.filter((path) => !OPEN_TO_EVERY_MEMBER.has(path) && platformPathPermission(path) === null)
  expect(withoutRule).toEqual([])
})

it("una dirección que cambió de sitio sigue existiendo, igual que su destino", () => {
  const screens = new Set(clinicScreens())
  for (const [from, to] of Object.entries(MOVED)) {
    expect(screens.has(from), `${from} dejó de existir: los enlaces y avisos guardados quedarían rotos`).toBe(true)
    expect(screens.has(to), `${from} redirige a ${to}, que no es una pantalla`).toBe(true)
  }
})
