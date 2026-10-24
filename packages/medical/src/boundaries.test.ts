/**
 * Lo común no depende de lo médico (ADR 0079), como no depende de lo dental
 * (`packages/dental/src/boundaries.test.ts`). Lo médico vive en este paquete,
 * en las carpetas `medical/` de los servicios y del agente y en la app de
 * latidIA; se conecta con lo común solo por `products.ts` y, en las pantallas,
 * por `productUi()`.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..")
const IMPORTS_MEDICAL =
  /from "@odentia\/medical"|import\("@odentia\/medical"\)|from "(\.\.?\/)+medical\/|from "@odentia\/services\/medical"/

/** Carpetas comunes y la app de odentIA: ninguno de sus archivos importa lo médico. */
const OUTSIDE = [
  "packages/clinical/src",
  "packages/dental/src",
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
  "apps/api/src",
  "apps/worker/src",
  "apps/panel/src",
  "apps/admin/src",
]
/**
 * Lo médico de los servicios, y `products.ts`: el único lugar que conecta cada
 * producto con lo común. La semilla de desarrollo de odentIA también crea la
 * demo médica (`seed:dev`), solo a mano.
 */
const MEDICAL_INSIDE = [
  "packages/services/src/medical/",
  "packages/services/src/products.ts",
  // Cómo dicta Clío en latidIA, y donde el agente elige el dictado de cada producto.
  "packages/agent/src/medical/",
  "packages/agent/src/products.ts",
  // La biblioteca de latidIA en la base, y donde se une con la de odentIA.
  "packages/db/src/medical/",
  "packages/db/src/products.ts",
  "packages/services/src/dental/seed-demo.ts",
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

describe("límites entre lo común y lo médico (ADR 0079)", () => {
  it("lo común y odentIA nunca importan lo médico", () => {
    const coupled = OUTSIDE.flatMap(filesUnder)
      .filter((file) => !MEDICAL_INSIDE.some((dir) => file.startsWith(dir)))
      .filter((file) => IMPORTS_MEDICAL.test(readFileSync(join(ROOT, file), "utf8")))
      .map((file) => relative(ROOT, join(ROOT, file)).split("\\").join("/"))
    expect(coupled).toEqual([])
  })
})
