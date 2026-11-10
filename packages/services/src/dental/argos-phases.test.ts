/**
 * La vista de Argos (`argos.lineas_presupuesto`, migración 0083) escribe a mano el orden de las
 * fases del plan dental para «va después» (`espera_a_otro_con_cita`): si las fases cambian, Argos
 * contaría distinto que Inicio y «Por agendar» sin que nada lo dijera (QA antes de entregar).
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { TREATMENT_PHASES } from "@odentia/dental"
import { expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

it("la vista de Argos ordena las fases igual que el plan dental", () => {
  const view = readFileSync(join(here, "../../../db/drizzle/0083_argos_espera_a_otro.sql"), "utf8")
  const arrays = [...view.matchAll(/array_position\(ARRAY\[([^\]]+)\]/g)].map((match) =>
    [...match[1]!.matchAll(/'([a-z_]+)'::text/g)].map((phase) => phase[1]),
  )
  expect(arrays.length).toBe(2)
  for (const phases of arrays) expect(phases).toEqual([...TREATMENT_PHASES])
})
