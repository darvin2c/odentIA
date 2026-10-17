import { expect, it } from "vitest"
import { purposeOfKind } from "./automation.js"

it("cada mensaje es de su tipo: avisos, recordatorios, seguimiento o novedades (ADR 0040)", () => {
  expect(purposeOfKind("recordatorio_cita")).toBe("recordatorio")
  expect(purposeOfKind("recordatorio_control")).toBe("seguimiento")
  expect(purposeOfKind("seguimiento_no_asistencia")).toBe("seguimiento")
  expect(purposeOfKind("cita_cancelada")).toBe("seguimiento")
  // Lo que WhatsApp cuenta como promoción pide el sí de novedades.
  expect(purposeOfKind("seguimiento_presupuesto")).toBe("novedades")
  expect(purposeOfKind("seguimiento_comercial")).toBe("novedades")
  // Los avisos de lo que pasó con la cita no son recordatorios: «No más recordatorios» no los apaga.
  expect(purposeOfKind("aviso_cita_reservada")).toBe("avisos")
  expect(purposeOfKind("aviso_cita_movida")).toBe("avisos")
  expect(purposeOfKind("aviso_cita_cancelada")).toBe("avisos")
})

it("«BAJA» y «STOP» son bajas; «cancelar» nunca lo es", async () => {
  const { isStopWord } = await import("./automation-messages.js")
  for (const word of ["BAJA", "baja", " Stop ", "STOP!", "dar de baja"]) expect(isStopWord(word), word).toBe(true)
  for (const word of ["cancelar", "Cancelar mi cita", "quiero cancelar", "no", "baja de peso", ""]) expect(isStopWord(word), word).toBe(false)
})
