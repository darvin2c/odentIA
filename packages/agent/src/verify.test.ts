import { expect, it } from "vitest"
import { describeUnsupported, SOURCE_CALENDAR, SOURCE_SUM, verifyReply } from "./verify.js"

const LIMA = { timezone: "America/Lima" }
const NOW = new Date("2026-10-10T15:00:00Z")
const SERVICES = { source: "Sedes y servicios", text: "- Servicio Limpieza (id x): S/ 150.00 (45 min)\n- Servicio Blanqueamiento (id y): S/ 480.00" }
const AGENDA = {
  source: "Agenda",
  text: "- 2026-10-12T14:00:00.000Z → 2026-10-12T14:45:00.000Z (45 min, zona America/Lima) · sede s · sillón c · profesional d",
}

function check(reply: string, evidence = [SERVICES, AGENDA]) {
  return verifyReply(reply, evidence, LIMA, NOW)
}

it("un precio que figura en lo consultado pasa, con su fuente", () => {
  const verdict = check("La limpieza cuesta S/ 150.")
  expect(verdict.ok).toBe(true)
  expect(verdict.checks).toEqual([{ kind: "precio", value: "S/ 150", ok: true, source: "Sedes y servicios" }])
})

it("las cifras de un identificador interno no sustentan un precio", () => {
  const withIds = {
    source: "Sedes y servicios",
    text: "- Servicio Limpieza (id 00000061-0135-4000-8000-000000000990): S/ 150.00 (45 min)",
  }
  expect(check("La limpieza cuesta S/ 150.", [withIds]).ok).toBe(true)
  for (const invented of ["S/ 61", "S/ 135", "S/ 990", "S/ 4000"]) {
    const verdict = check(`La limpieza cuesta ${invented}.`, [withIds])
    expect(verdict.unsupported.map((item) => item.value)).toEqual([invented])
  }
})

it("un precio que no está en ninguna fuente bloquea la respuesta", () => {
  const verdict = check("La limpieza cuesta S/ 120 y el blanqueamiento 480 soles.")
  expect(verdict.ok).toBe(false)
  expect(verdict.unsupported.map((item) => item.value)).toEqual(["S/ 120"])
  expect(describeUnsupported(verdict)).toBe("precio «S/ 120»")
})

it("la suma de importes consultados cuenta como sustentada", () => {
  const verdict = check("Limpieza S/ 150 y blanqueamiento S/ 480: en total S/ 630.")
  expect(verdict.ok).toBe(true)
  expect(verdict.checks.find((item) => item.value === "S/ 630")?.source).toBe(SOURCE_SUM)
})

it("acepta los formatos habituales de un importe", () => {
  const evidence = [{ source: "Respuestas oficiales", text: "Ortodoncia desde 1,200.50 soles. Consulta: 80." }]
  expect(check("La ortodoncia va desde S/ 1.200,50.", evidence).ok).toBe(true)
  expect(check("La consulta cuesta 80 soles.", evidence).ok).toBe(true)
  expect(check("La consulta cuesta USD 80.50.", evidence).ok).toBe(false)
})

it("la hora de un hueco se reconoce en la zona de la sede", () => {
  expect(check("Tengo un espacio a las 9:00 a. m.").ok).toBe(true)
  expect(check("Tengo un espacio a las 9 de la mañana.").ok).toBe(true)
  expect(check("Tengo un espacio a las 9.").ok).toBe(true)
  const wrong = check("Tengo un espacio a las 10:30.")
  expect(wrong.unsupported).toEqual([{ kind: "hora", value: "10:30", ok: false, source: null }])
  expect(check("Te espero a las 4 pm.").ok).toBe(false)
})

it("no confunde duraciones, plazos ni horarios sin hora de reloj con una hora", () => {
  expect(check("Te respondemos en 24 horas; la sesión dura 45 minutos.").ok).toBe(true)
  expect(check("A las 2 semanas hacemos el control.").ok).toBe(true)
  expect(check("Atendemos de lunes a sábado, de 9 a 6.").checks).toEqual([])
})

it("una fecha debe estar en lo consultado y su día de la semana debe coincidir", () => {
  expect(check("Tengo un espacio el lunes 12 de octubre.").ok).toBe(true)
  expect(check("Tengo un espacio el 12/10/2026.").ok).toBe(true)
  const missing = check("Tengo un espacio el 13 de octubre.")
  expect(missing.unsupported.map((item) => item.kind)).toEqual(["fecha"])
  const weekday = check("Tengo un espacio el martes 12 de octubre.")
  expect(weekday.ok).toBe(false)
  expect(weekday.unsupported[0]?.source).toBe(SOURCE_CALENDAR)
  expect(weekday.unsupported[0]?.value).toContain("ese día es lunes")
})

it("lee fechas y horas con el formato regional de las herramientas", () => {
  const summary = { source: "Citas del paciente", text: "- Cita programada (id a, versión 1) el 5/11/2026, 3:30:00\u202fp.\u00a0m., Sede Centro con Dra. Ana." }
  expect(check("Tu cita es el 5 de noviembre a las 3:30 p. m.", [summary]).ok).toBe(true)
  expect(check("Tu cita es el jueves 5 de noviembre a las 15:30.", [summary]).ok).toBe(true)
  expect(check("Tu cita es el 6 de noviembre a las 3:30 p. m.", [summary]).ok).toBe(false)
})

it("lo que dijo el interlocutor sirve para repetirlo, y «24/7» no es una fecha", () => {
  const asked = { source: "Lo dijo el interlocutor", text: "¿Tienen cita el 20 de octubre a las 11?" }
  expect(check("El 20 de octubre a las 11 no tengo espacio.", [asked]).ok).toBe(true)
  expect(check("Nuestro chat atiende 24/7.").checks).toEqual([])
})

it("una respuesta sin precios, fechas ni horas no tiene nada que comprobar", () => {
  const verdict = check("¡Hola! Con gusto te ayudo. ¿Para qué servicio deseas tu cita?", [])
  expect(verdict).toEqual({ ok: true, checks: [], unsupported: [] })
})
