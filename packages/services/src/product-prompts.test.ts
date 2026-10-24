/**
 * Lo que lee el modelo en odentIA no cambia al separar lo común de lo dental
 * (ADR 0079, entrega 6): las preguntas del Administrador y de Reportes para una
 * clínica dental se comparan con las de antes (`__golden__`).
 */
import { describe, expect, it } from "vitest"
import { adminQuestions } from "./admin-request.js"
import { AGENT_ROLES, agentRolesFor } from "./agent-roles.js"
import { agentTextsFor } from "./products.js"
import { reportQuestions } from "./report-questions.js"

const golden = (name: string) => `./__golden__/${name}`
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

describe("preguntas de latidIA: nada dental ni de odentIA, y sus 12 meses", () => {
  it("Administrador y Reportes", () => {
    const medical = agentTextsFor("medical")
    for (const text of [JSON.stringify(adminQuestions(medical)), JSON.stringify(reportQuestions(medical))]) {
      expect(text).not.toMatch(/\b(dental|dientes?|odont\w*|ortodon\w*|piezas?)\b/i)
      expect(text).not.toContain("odentIA")
      // Sin venir es un año en latidIA (decisión 16); «lo que deja un paciente nuevo en 6 meses» es otra cuenta.
      expect(text).not.toMatch(/\b(6|seis) meses (sin venir|sin atenderse)\b|sin venir hace más de 6 meses/i)
    }
    expect(JSON.stringify(reportQuestions(medical))).toContain("Sin venir hace más de 12 meses")
    expect(JSON.stringify(adminQuestions(medical))).toContain("Un año sin venir")
  })
})

describe("las fichas de los agentes, con las palabras del producto", () => {
  it("odentIA las ve como siempre; latidIA, con el médico, sus 12 meses y su nombre", () => {
    expect(agentRolesFor(agentTextsFor("dental"))).toEqual(AGENT_ROLES)
    const medical = agentRolesFor(agentTextsFor("medical"))
    for (const role of Object.values(medical)) expect(JSON.stringify(role)).not.toMatch(/odont\w*|odentIA|\bpiezas?\b|seis meses/i)
    expect(medical.asistente_clinico.audience).toBe("Para el médico, dentro de la atención")
    expect(medical.asistente_clinico.functions.map((fn) => fn.id)).toContain("descanso")
    expect(medical.ayuda.role).toContain("Ayuda a usar latidIA")
    expect(JSON.stringify(medical.administrador.functions)).toContain("Un año sin venir")
  })
})

describe("preguntas de odentIA, iguales a las de antes", () => {
  it("Administrador", async () => {
    await expect(json(adminQuestions(agentTextsFor("dental")))).toMatchFileSnapshot(golden("administrador.json"))
  })
  it("Reportes", async () => {
    await expect(json(reportQuestions(agentTextsFor("dental")))).toMatchFileSnapshot(golden("reportes.json"))
  })
})
