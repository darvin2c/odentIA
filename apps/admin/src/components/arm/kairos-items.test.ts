import { describe, expect, it } from "vitest"
import { approveLabel, discardLabel, kairosItemTab, possibleCargaDoneWords } from "./kairos-items"

describe("una posible carga de datos en Hoy", () => {
  const item = { kind: "posible_carga", payload: { filename: "pacientes.xlsx", dueNow: false } }

  it("«Sí, es la carga», «No» y «Ver en Documentos»; pasados los 30 días lo dice antes del sí", () => {
    expect(approveLabel(item)).toBe("Sí, es la carga")
    expect(approveLabel({ ...item, payload: { ...item.payload, dueNow: true } })).toBe(
      "Sí, es la carga: se borra al marcarlo",
    )
    expect(discardLabel("posible_carga")).toBe("No")
    expect(discardLabel("mensaje")).toBe("Ahora no")
    expect(kairosItemTab("posible_carga")).toBe("documentos")
  })

  it("el aviso dice qué pasó, con la fecha del servidor", () => {
    expect(possibleCargaDoneWords(item, "descartar", null)).toBe(
      "Listo: pacientes.xlsx no es la carga y se guarda",
    )
    expect(
      possibleCargaDoneWords(item, "aprobar", { fileId: "f", dueNow: true, deleteAfter: null }),
    ).toBe("pacientes.xlsx es la carga de datos: se borra en los próximos minutos")
    expect(
      possibleCargaDoneWords(item, "aprobar", {
        fileId: "f",
        dueNow: false,
        deleteAfter: "2026-12-10",
      }),
    ).toMatch(/^pacientes\.xlsx es la carga de datos: se borra el /)
  })
})
