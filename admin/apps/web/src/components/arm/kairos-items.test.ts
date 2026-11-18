import { describe, expect, it } from "vitest"
import {
  approveLabel,
  chatSendWords,
  discardLabel,
  kairosItemTab,
  possibleCargaDoneWords,
} from "./kairos-items"

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

describe("un mensaje de Kairós por WhatsApp", () => {
  const item = { kind: "mensaje", payload: { channel: "whatsapp", to: "+51987654321" } }

  it("con el número de Sallca se envía; sin él, se abre wa.me", () => {
    expect(approveLabel(item, true)).toBe("Enviar")
    expect(approveLabel(item)).toBe("Abrir WhatsApp")
  })

  it("dice si salió, si salió la plantilla, si no salió o si no se sabe", () => {
    const base = { to: "+51987654321", template: null, why: null }
    expect(chatSendWords({ ...base, status: "enviado" })).toEqual({
      tone: "success",
      text: "Salió por WhatsApp a +51987654321. Queda en su historial.",
    })
    const template = chatSendWords({ ...base, status: "enviado", template: "retomar_conversacion" })
    expect(template.tone).toBe("success")
    expect(template.text).toMatch(/plantilla para retomar: pasaron 24 horas.*el texto no va/)
    expect(chatSendWords({ ...base, status: "no_salio", why: "Invalid parameter" })).toEqual({
      tone: "error",
      text: "No salió por WhatsApp: Invalid parameter",
    })
    expect(chatSendWords({ ...base, status: "incierto" }).tone).toBe("warning")
    expect(chatSendWords({ ...base, status: "pendiente" }).text).toMatch(/^No se sabe si salió/)
  })
})
