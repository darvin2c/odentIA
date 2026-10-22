import { describe, expect, it } from "vitest"
import { attentionOf } from "./people.js"

const none = new Set<string>()
const on = (...lines: string[]) => new Set(lines)

describe("quién lleva lo que sigue de cada paciente", () => {
  it("el agente lleva el seguimiento de un presupuesto solo si su línea está prendida; si no, una persona", () => {
    expect(attentionOf("respuesta", on("seguimiento_presupuesto"))).toBe("agente")
    expect(attentionOf("respuesta", none)).toBe("persona")
  })

  it("un control lo lleva el agente si está prendido; si no, nadie todavía", () => {
    expect(attentionOf("control", on("recordatorio_control"))).toBe("agente")
    expect(attentionOf("control", none)).toBe("nadie")
  })

  it("lo que pide una persona (enviar, agendar, la siguiente sesión) lo lleva una persona; sin paso, nadie", () => {
    expect(attentionOf("enviar", none)).toBe("persona")
    expect(attentionOf("agendar", none)).toBe("persona")
    expect(attentionOf("continuar", on("presupuestos_sin_cita"))).toBe("persona")
    expect(attentionOf("ninguno", none)).toBe("nadie")
  })
})
