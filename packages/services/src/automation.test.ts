import { expect, it } from "vitest"
import { inQuietHours, purposeOfKind } from "./automation.js"

// America/Lima es UTC-5 fijo (sin horario de verano): instantes estables.

it("detecta la ventana de silencio por defecto 21:00–08:00 en Lima", () => {
  // 02:00Z = 21:00 Lima → dentro; 14:00Z = 09:00 Lima → fuera.
  expect(inQuietHours(new Date("2026-03-10T02:00:00Z"), "America/Lima")).toBe(true)
  expect(inQuietHours(new Date("2026-03-10T14:00:00Z"), "America/Lima")).toBe(false)
  // Borde: 08:00 Lima exacto ya permite enviar.
  expect(inQuietHours(new Date("2026-03-10T13:00:00Z"), "America/Lima")).toBe(false)
})

it("respeta ventanas diurnas personalizadas", () => {
  // 18:30Z = 13:30 Lima.
  expect(inQuietHours(new Date("2026-03-10T18:30:00Z"), "America/Lima", "13:00", "14:00")).toBe(true)
  expect(inQuietHours(new Date("2026-03-10T18:30:00Z"), "America/Lima", "15:00", "16:00")).toBe(false)
})

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
