import { expect, it } from "vitest"
import { inQuietHours, isTerminalFailureCode, purposeOfKind } from "./automation.js"

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

it("cada línea que escribe pide el permiso de su tipo de mensaje", () => {
  expect(purposeOfKind("recordatorio_cita")).toBe("recordatorio")
  expect(purposeOfKind("recordatorio_control")).toBe("recordatorio")
  expect(purposeOfKind("seguimiento_presupuesto")).toBe("seguimiento")
  expect(purposeOfKind("seguimiento_no_asistencia")).toBe("seguimiento")
  expect(purposeOfKind("seguimiento_comercial")).toBe("seguimiento")
})

it("cierra sin reintentos ventana, inbound requerido y validación", () => {
  expect(isTerminalFailureCode("WINDOW_CLOSED")).toBe(true)
  expect(isTerminalFailureCode("CHANNEL_REQUIRES_INBOUND")).toBe(true)
  expect(isTerminalFailureCode("VALIDATION")).toBe(true)
  expect(isTerminalFailureCode("CONNECTION_DISABLED")).toBe(false)
  expect(isTerminalFailureCode(undefined)).toBe(false)
})
