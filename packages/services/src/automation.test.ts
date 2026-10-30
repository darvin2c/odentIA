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

it("la pregunta de novedades lleva el nombre de la clínica y su trato; sin nombre, «la clínica»", async () => {
  const { GENERAL_PERMISSION_QUESTION, GENERAL_PERMISSION_YES, generalPermissionWords, isGeneralPermissionQuestion } = await import("./automation-messages.js")
  expect(generalPermissionWords("Clínica  Sonríe ", "tu")).toEqual({
    question: "¿Te podemos escribir para enviarte novedades y promociones de Clínica Sonríe?",
    yes: GENERAL_PERMISSION_YES,
    no: "Entendido: no te enviaremos novedades ni promociones.",
  })
  // «Como la persona» no se sabe antes de que escriba: de tú.
  expect(generalPermissionWords("Clínica Sonríe", null).question).toBe("¿Te podemos escribir para enviarte novedades y promociones de Clínica Sonríe?")
  expect(generalPermissionWords("Clínica Sonríe", "usted")).toEqual({
    question: "¿Le podemos escribir para enviarle novedades y promociones de Clínica Sonríe?",
    yes: "¡Listo! Le enviaremos novedades y promociones. Puede darse de baja cuando quiera.",
    no: "Entendido: no le enviaremos novedades ni promociones.",
  })
  expect(generalPermissionWords(null, "tu").question).toBe(GENERAL_PERMISSION_QUESTION)
  for (const text of [GENERAL_PERMISSION_QUESTION, generalPermissionWords("Dental Smile", "usted").question]) {
    expect(isGeneralPermissionQuestion(text), text).toBe(true)
  }
  expect(isGeneralPermissionQuestion("¿Te podemos escribir mañana?")).toBe(false)
})

it("el recordatorio de una cita confirmada no pide confirmar y no termina en un dato", async () => {
  const { AUTOMATION_MESSAGES, REMINDER_CONFIRMED_KEY, renderMessage } = await import("./automation-messages.js")
  const spec = AUTOMATION_MESSAGES[REMINDER_CONFIRMED_KEY]
  expect(spec).toMatchObject({ purpose: "recordatorio", category: "utility", link: { title: "Cambiar mi cita" } })
  expect(spec.buttons.map((button) => [button.action, button.title])).toEqual([
    ["responder", "No podré ir"],
    ["baja", "No más recordatorios"],
  ])
  // Mismos datos que el recordatorio de siempre; WhatsApp rechaza un texto que empieza o termina en un dato.
  expect([...spec.variables].sort()).toEqual([...AUTOMATION_MESSAGES.recordatorio_cita.variables].sort())
  expect(spec.body).not.toMatch(/\{\{\d+\}\}[\s\p{P}]*$/u)
  expect(
    renderMessage(spec, { persona: "Lucía", citas: "mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres", lugar: "Clínica Sonríe, sede Centro" }).text,
  ).toBe("Hola, Lucía. Te esperamos mañana, martes 13 de octubre, a las 10:00, con Dra. Ana Torres en Clínica Sonríe, sede Centro. Si necesitas cambiar la cita, responde a este mensaje.")
  expect(purposeOfKind(REMINDER_CONFIRMED_KEY)).toBe("recordatorio")
})
