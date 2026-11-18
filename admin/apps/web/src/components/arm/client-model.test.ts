import { describe, expect, it } from "vitest"
import { clientListItemSchema, stageWords } from "./client-model"

const item = (over: Record<string, unknown>) =>
  clientListItemSchema.parse({
    id: "c1",
    name: "Clínica Prueba (ficticia)",
    product: "dental",
    stage: "contacto",
    nextStep: null,
    owner: null,
    origin: "web",
    lastContactAt: null,
    organizationId: null,
    signals: [],
    createdAt: "2026-11-12T15:00:00.000Z",
    ...over,
  })

describe("la fase y la etapa en palabras (ADR 0196)", () => {
  it("con cuenta se dice su fase, nunca «Con cuenta» ni «Entró»; sin cuenta, la etapa de la venta", () => {
    expect(stageWords(item({ stage: "entro", phase: "en_alta", organizationId: "o1" }))).toBe(
      "En alta",
    )
    expect(stageWords(item({ stage: "entro", phase: "activo", organizationId: "o1" }))).toBe(
      "Activo",
    )
    expect(stageWords(item({ stage: "propuesta", phase: "por_vender" }))).toBe("Propuesta")
    expect(stageWords(item({ stage: "perdido", phase: "perdido" }))).toBe("Perdido")
  })

  it("una respuesta sin fase (la API de antes) la deduce; una fase que no se conoce, «Por vender»", () => {
    expect(item({ stage: "entro", organizationId: "o1" }).phase).toBe("en_alta")
    expect(item({ stage: "no_por_ahora" }).phase).toBe("no_por_ahora")
    expect(item({ stage: "contacto" }).phase).toBe("por_vender")
    expect(item({ stage: "contacto", phase: "fase_nueva" }).phase).toBe("por_vender")
  })
})
