import { readFileSync } from "node:fs"
import { SAAS_MILESTONE_STEPS } from "@odentia/db/schema/admin-arm"
import { describe, expect, it } from "vitest"
import { ONBOARDING_STEP_KEYS } from "./admin-onboarding.js"
import { PROGRESS_REPORT_ACTIONS } from "./clinic-progress-report.js"

// La base no importa los servicios: sus listas del alta son copias, y el relleno de los hitos
// (0119) escribe las acciones tal cual. Si cambian aquí, cambian allá (sin base de datos).
describe("los hitos del alta y la ficha hablan de lo mismo", () => {
  it("los pasos que guardan su primera vez son los de la ficha, en el mismo orden", () => {
    expect([...SAAS_MILESTONE_STEPS]).toEqual([...ONBOARDING_STEP_KEYS])
  })

  it("el relleno lee los informes enviados y las cargas con las acciones de los servicios", () => {
    const backfill = readFileSync(
      new URL("../../db/drizzle/0119_kairos_vigila_el_alta_reglas.sql", import.meta.url),
      "utf8",
    )
    const actions = new Set(
      [...backfill.matchAll(/a\.action = '([a-z_.]+)'/g)].map((match) => match[1]),
    )
    expect(actions).toEqual(
      new Set(["org.setup_import", "org.data_import", PROGRESS_REPORT_ACTIONS.enviado]),
    )
  })
})
