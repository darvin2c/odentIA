/**
 * Lo común no depende de lo óptico (ADR 0079), como no depende de lo dental ni de
 * lo médico (`packages/dental/src/boundaries.test.ts`,
 * `packages/medical/src/boundaries.test.ts`). Lo óptico vive en este paquete, en
 * las carpetas `optical/` de los servicios y de la base y en la app de vistIA; se
 * conecta con lo común solo por `products.ts` y, en las pantallas, por `productUi()`.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..")
const IMPORTS_OPTICAL =
  /from "@odentia\/optical"|import\("@odentia\/optical"\)|from "(\.\.?\/)+optical\/|from "@odentia\/services\/optical"/

/** Carpetas comunes y las apps de odentIA y latidIA: ninguno de sus archivos importa lo óptico. */
const OUTSIDE = [
  "packages/clinical/src",
  "packages/dental/src",
  "packages/medical/src",
  "packages/services/src",
  "packages/db/src",
  "packages/agent/src",
  "packages/auth/src",
  "packages/channels/src",
  "packages/mail/src",
  "packages/ui/src",
  "packages/ui-patterns/src",
  "packages/clinic-app/src",
  "apps/dental-clinic/src",
  "apps/medical-clinic/src",
  "apps/api/src",
  "apps/worker/src",
  "apps/panel/src",
  "apps/admin/src",
]
/**
 * Lo óptico de los servicios y de la base, y los `products.ts`: los únicos
 * lugares que conectan cada producto con lo común.
 */
const OPTICAL_INSIDE = [
  "packages/services/src/optical/",
  "packages/services/src/products.ts",
  "packages/db/src/optical/",
  "packages/db/src/products.ts",
  // Las rutas de vistIA en la API, y donde la API une las de cada producto.
  "apps/api/src/routes/optical/",
  "apps/api/src/routes/products.ts",
]

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

describe("límites entre lo común y lo óptico (ADR 0079)", () => {
  it("lo común, odentIA y latidIA nunca importan lo óptico", () => {
    const coupled = OUTSIDE.flatMap(filesUnder)
      .filter((file) => !OPTICAL_INSIDE.some((dir) => file.startsWith(dir)))
      .filter((file) => IMPORTS_OPTICAL.test(readFileSync(join(ROOT, file), "utf8")))
      .map((file) => relative(ROOT, join(ROOT, file)).split("\\").join("/"))
    expect(coupled).toEqual([])
  })
})
