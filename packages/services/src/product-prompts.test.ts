/**
 * Lo que lee el modelo en odentIA no cambia al separar lo común de lo dental
 * (ADR 0079, entrega 6): las preguntas del Administrador y de Reportes para una
 * clínica dental se comparan con las de antes (`__golden__`).
 */
import { describe, expect, it } from "vitest"
import { adminQuestions } from "./admin-request.js"
import { agentTextsFor } from "./products.js"
import { reportQuestions } from "./report-questions.js"

const golden = (name: string) => `./__golden__/${name}`
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

describe("preguntas de odentIA, iguales a las de antes", () => {
  it("Administrador", async () => {
    await expect(json(adminQuestions(agentTextsFor("dental")))).toMatchFileSnapshot(golden("administrador.json"))
  })
  it("Reportes", async () => {
    await expect(json(reportQuestions(agentTextsFor("dental")))).toMatchFileSnapshot(golden("reportes.json"))
  })
})
