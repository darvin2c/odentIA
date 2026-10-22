import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/** El archivo de una ruta del árbol generado (`./routes/_org` es `_org.tsx` o `_org/route.tsx`). */
function routeFile(path: string): string | null {
  for (const candidate of [`../${path}.tsx`, `../${path}/route.tsx`]) {
    if (existsSync(fileURLToPath(new URL(candidate, import.meta.url)))) return candidate
  }
  return null
}

it("toda ruta anidada tiene un padre que la dibuja con <Outlet />", () => {
  const tree = read("../routeTree.gen.ts")
  const files = new Map([...tree.matchAll(/import \{ Route as (\w+)Import \} from '\.\/(routes\/[^']+)'/g)].map((m) => [m[1], m[2]]))
  const nested = [...tree.matchAll(/const (\w+) =\s+\w+Import\.update\(\{[^}]*?getParentRoute: \(\) => (\w+),?\s*\}/g)]
    .map((m) => ({ route: m[1] ?? "", parent: m[2] ?? "" }))
    .filter((item) => item.parent !== "rootRouteImport")
  // Si el árbol generado cambia de forma, la prueba no debe pasar en vacío.
  expect(nested.length).toBeGreaterThan(30)
  // Sin <Outlet /> el padre se dibuja en lugar de la hija: así la página de un
  // producto mostraba la lista del inventario.
  const silent = [...new Set(nested.map((item) => item.parent))].filter((parent) => {
    const path = files.get(parent)
    const file = path ? routeFile(path) : null
    return !file || !read(file).includes("<Outlet")
  })
  expect(silent).toEqual([])
  expect(nested.find((item) => item.route === "OrgInventoryProductIdRoute")?.parent).toBe("OrgRoute")
})
