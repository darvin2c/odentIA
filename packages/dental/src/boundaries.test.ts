/**
 * Lo común no depende de lo dental (ADR 0079). Lo dental vive en este paquete,
 * en las carpetas `dental/` de los servicios, el agente, la base y la API, y en
 * la app de odentIA; cada producto se conecta con lo común solo por
 * `products.ts` (servicios y API) y, en las pantallas, por `productUi()` de
 * `@odentia/clinic-app` (ADR 0085). Ningún código de lo común importa lo dental: solo las pruebas de la
 * lista de abajo, que prueban lo común con odentIA como ejemplo. Un archivo
 * nuevo que lo necesite es una señal de que falta un punto de extensión del
 * producto, no de agregarlo aquí.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..")
// Las tablas del esquema dental (ADR 0079) y lo dental de los servicios y del agente también son lo dental.
const IMPORTS_DENTAL =
  /from "@odentia\/dental"|from "(\.\.?\/)+dental\/|import\("@odentia\/dental"\)|from "@odentia\/(db\/schema|db|services|agent)\/dental"|from "\.\/dental\.js"/

/**
 * Las pruebas y mediciones de lo común que usan lo dental como ejemplo (el
 * odontograma en el cierre de la atención, la biblioteca de odentIA al
 * sembrar, Clío): solo pruebas, nunca código que corre (entrega 8).
 */
const STILL_COUPLED = [
  "packages/agent/src/agent.test.ts",
  "packages/agent/src/consumo.eval.ts",
  "packages/agent/src/product-prompts.test.ts",
  "apps/api/src/routes/services.test.ts",
  "apps/api/src/routes/timeline.test.ts",
  "packages/db/src/procedure-seeds.test.ts",
  "packages/services/src/agenda-especialidades.test.ts",
  "packages/services/src/clinica-otro-pais.test.ts",
  "packages/services/src/composite-keys.test.ts",
  "packages/services/src/diagnosis-codes.test.ts",
  "packages/services/src/encounter-lifecycle.test.ts",
  "packages/services/src/patient-history.test.ts",
  "packages/services/src/patients.test.ts",
  "packages/services/src/procedure-codings.test.ts",
  "packages/services/src/saas-actions.test.ts",
  "packages/services/src/service-interest.test.ts",
  "packages/services/src/treatment-journey.test.ts",
  // El visor de tomografías se prueba con el fantasma de odentIA (`generateCbctPhantom`).
  "packages/clinic-app/src/lib/cbct-arch.test.ts",
  "packages/clinic-app/src/lib/cbct-volume.test.ts",
]

/** Carpetas comunes: ninguno de sus archivos importa lo dental salvo la lista. */
const COMMON = [
  "packages/clinical/src",
  "packages/services/src",
  "packages/db/src",
  "packages/agent/src",
  "packages/auth/src",
  "packages/channels/src",
  "packages/mail/src",
  "packages/ui/src",
  "packages/ui-patterns/src",
  "packages/clinic-app/src",
  "apps/api/src",
  "apps/worker/src",
  "apps/panel/src",
  "apps/admin/src",
]
/**
 * Dentro de lo común, lo que ya es del producto dental, y `products.ts`: el
 * único lugar que conecta cada producto con los momentos de lo común.
 */
const DENTAL_INSIDE = [
  "packages/services/src/dental/",
  "packages/agent/src/dental/",
  "packages/db/src/dental/",
  "apps/api/src/routes/dental/",
  "apps/api/src/routes/products.ts",
  "packages/services/src/products.ts",
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

describe("límites entre lo común y lo dental (ADR 0079)", () => {
  const coupled = COMMON.flatMap(filesUnder)
    .filter((file) => !DENTAL_INSIDE.some((dir) => file.startsWith(dir)))
    .filter((file) => IMPORTS_DENTAL.test(readFileSync(join(ROOT, file), "utf8")))
    .map((file) => relative(ROOT, join(ROOT, file)).split("\\").join("/"))
    .sort()

  it("clinical nunca importa lo dental", () => {
    expect(coupled.filter((file) => file.startsWith("packages/clinical/"))).toEqual([])
  })

  it("lo común solo importa lo dental donde aún falta separarlo", () => {
    const fresh = coupled.filter((file) => !STILL_COUPLED.includes(file))
    expect(fresh, "archivos comunes nuevos que importan lo dental").toEqual([])
  })

  it("en la lista solo hay pruebas y mediciones, nunca código que corre", () => {
    expect(STILL_COUPLED.filter((file) => !/.(test|eval).ts$/.test(file))).toEqual([])
  })

  it("la lista se achica: lo que ya no importa lo dental sale de ella", () => {
    const done = STILL_COUPLED.filter((file) => !coupled.includes(file))
    expect(done, "quitar de STILL_COUPLED").toEqual([])
  })
})
