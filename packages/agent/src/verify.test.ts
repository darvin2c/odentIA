import { expect, it } from "vitest"
import { describeUnsupported, refusedPaymentMentions, SOURCE_CALENDAR, SOURCE_SUM, verifyReply } from "./verify.js"

// Lo que recibe la comprobación en una corrida: la zona, la moneda y el formato de la clínica.
const LIMA = { timezone: "America/Lima", currency: "PEN", locale: "es-PE" }
const NOW = new Date("2026-10-10T15:00:00Z")
const SERVICES = { source: "Sedes y servicios", text: "- Servicio Limpieza (id x): S/ 150.00 (45 min)\n- Servicio Blanqueamiento (id y): S/ 480.00" }
const AGENDA = {
  source: "Agenda",
  text: "- 2026-10-12T14:00:00.000Z → 2026-10-12T14:45:00.000Z (45 min, zona America/Lima) · sede s · unidad dental c · profesional d",
}

function check(reply: string, evidence = [SERVICES, AGENDA]) {
  return verifyReply(reply, evidence, LIMA, NOW)
}

function unsupportedOf(reply: string, evidence: { source: string; text: string }[]) {
  return check(reply, evidence).unsupported.map((item) => item.value)
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

it("las cifras de la referencia de un profesional no sustentan un precio", () => {
  // `professionalRef` llega en los datos de la clínica y en cada hueco de la agenda.
  const clinic = (ref: string) => ({
    source: "Conocimiento publicado de la clínica",
    text: `- Dentista Agente. Sede Norte. [profesional ${ref}: solo para pedir sus horas; no lo escribas]`,
  })
  const slot = { ...AGENDA, text: AGENDA.text.replace("profesional d", "profesional pro-3a99f0c1d2") }
  for (const evidence of [[clinic("pro-99d040905f")], [clinic("pro-e099abcdef")], [slot]]) {
    expect(check("La limpieza cuesta S/ 99.", evidence).unsupported.map((item) => item.value)).toEqual(["S/ 99"])
  }
  // Lo que no tiene la forma exacta de una referencia se sigue leyendo.
  expect(check("La limpieza cuesta S/ 99.", [clinic("pro-99")]).ok).toBe(true)
})

it("las cifras de una dirección web no sustentan un precio; el importe junto a ella, sí", () => {
  // «Su enlace» vuelve en las respuestas anteriores del agente con su token de 64 cifras hexadecimales.
  const token = "3fe99b0c4a7d250f1e8b6c39a4d0f7e2b5c18d6a9e3f0b47c2d5e8a1f6b9c304"
  const sent = { source: "Respuestas anteriores del agente", text: `Su enlace para elegir tu cita: https://sonrisa.odentia32.com/reserva?token=${token}` }
  const registration = { source: "Lo escribió el equipo en este hilo", text: "Completa tus datos: https://sonrisa.odentia32.com/registro?token=kP3vX85_qLm-ZtRwYcNaBdEfGhJs4uVwXyZaBcDeFgH" }
  const branch = {
    source: "Conocimiento publicado de la clínica",
    text: "- Sede Centro (id 0f6b2a10-5c3d-4e8f-9a1b-2c3d4e5f6a7b) · mapa: https://www.google.com/maps/@-12.0931,-77.0465,17z",
  }
  for (const [invented, evidence] of [
    ["S/ 99", sent], ["S/ 250", sent], ["S/ 304", sent], ["S/ 32", sent],
    ["S/ 85", registration], ["S/ 17", branch], ["S/ 77", branch],
  ] as const) {
    expect(unsupportedOf(`La limpieza cuesta ${invented}.`, [evidence])).toEqual([invented])
  }
  // Una respuesta oficial con un enlace sigue sustentando su importe, también en el JSON de una herramienta.
  const official = { source: "Respuestas oficiales", text: "Limpieza en promoción: S/ 120. Reserva en https://sonrisa.example/promo-99." }
  const contact = { source: "Ficha del contacto", text: JSON.stringify({ datos: { web: "https://sonrisa.example/promo-99", convenio: 120 } }) }
  for (const evidence of [official, contact]) {
    expect(check("La limpieza cuesta S/ 120.", [evidence]).ok).toBe(true)
    expect(unsupportedOf("La limpieza cuesta S/ 99.", [evidence])).toEqual(["S/ 99"])
  }
})

it("el enlace que envía el agente no se lee como importe en la respuesta", () => {
  // Con dólares canadienses, «9cad42» de un token se leía como CAD 42.
  const link = "https://sonrisa.odentia32.com/reserva?token=0b7e19cad42f8a3c6d5e0b1f2a9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c"
  const tool = { source: "Su enlace", text: `Su enlace, para que Ana elija su cita: ${link}` }
  const ca = { timezone: "America/Toronto", currency: "CAD", locale: "es" }
  expect(verifyReply(`Aquí tienes tu enlace: ${link}`, [tool], ca, NOW).checks).toEqual([
    { kind: "enlace", value: link, ok: true, source: "Su enlace" },
  ])
  expect(verifyReply(`La limpieza cuesta CAD 42: ${link}`, [tool], ca, NOW).unsupported.map((item) => item.value)).toEqual(["CAD 42"])
})

it("un enlace que no trajo ninguna fuente no sale", () => {
  // Auditoría del 27-oct: el modelo armó «…/cita», una página que no existe.
  const tool = { source: "Datos de la clínica", text: "Sede San Martín: Av. Perú 1820. Cómo llegar: https://sanmartin.latidia72.com/llegar/san-martin" }
  const pe = { timezone: "America/Lima", currency: "PEN", locale: "es-PE" }
  expect(verifyReply("Elige tu cita aquí: https://sanmartin.latidia72.com/cita.", [tool], pe, NOW).unsupported).toEqual([
    { kind: "enlace", value: "https://sanmartin.latidia72.com/cita", ok: false, source: null },
  ])
  expect(verifyReply("Así llegas: https://sanmartin.latidia72.com/llegar/san-martin.", [tool], pe, NOW).ok).toBe(true)
})

it("la versión de una cita no sustenta un precio", () => {
  const summary = {
    source: "Resumen del paciente",
    text: "- Cita programada (id 0f6b2a10-5c3d-4e8f-9a1b-2c3d4e5f6a7b, versión 14) el 5/11/2026, 3:30 p. m., Sede Centro con Dra. Ana.\n- Saldo pendiente: S/ 150.00.",
  }
  expect(unsupportedOf("Tu cita cuesta S/ 14.", [summary])).toEqual(["S/ 14"])
  expect(check("Tienes un saldo de S/ 150.", [summary]).ok).toBe(true)
})

it("las cifras del cursor de una lista no sustentan un precio", () => {
  // Como lo arman los servicios: base64url de un objeto JSON. Este trae las cifras 0, 2, 5 y 6.
  const cursor = Buffer.from(
    JSON.stringify({ ts: "2026-10-09T21:14:05.000Z", id: "7c1e9d02-4b6a-4f3e-8d21-5a9c0e7b3f64" }),
  ).toString("base64url")
  const opportunities = { source: "Oportunidades del contacto", text: `- Ortodoncia: S/ 2,500.00\nHay más oportunidades: vuelve a llamar con cursor "${cursor}".` }
  const contact = { source: "Ficha del contacto", text: JSON.stringify({ name: "Ana", datos: { convenio: 120 }, nextNotesCursor: cursor }) }
  for (const evidence of [opportunities, contact]) {
    for (const invented of ["S/ 2", "S/ 5", "S/ 6"]) {
      expect(unsupportedOf(`La consulta cuesta ${invented}.`, [evidence])).toEqual([invented])
    }
  }
  expect(check("La ortodoncia cuesta S/ 2,500.", [opportunities]).ok).toBe(true)
  expect(check("Con tu convenio pagas S/ 120.", [contact]).ok).toBe(true)
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

it("reconoce la moneda de la clínica por lo que dice ICU, no por una lista de países", () => {
  const price = (text: string) => [{ source: "Sedes y servicios", text }]
  const prices = (reply: string, text: string, zone: { timezone: string; currency: string; locale: string }) =>
    verifyReply(reply, price(text), zone, NOW)
  // Quetzales: símbolo «Q» y nombre, sin que ningún país figure en el código.
  const gt = { timezone: "America/Guatemala", currency: "GTQ", locale: "es-GT" }
  expect(prices("La limpieza cuesta Q150.", "- Servicio Limpieza: Q 150.00", gt).ok).toBe(true)
  expect(prices("La limpieza cuesta Q200.", "- Servicio Limpieza: Q 150.00", gt).unsupported.map((item) => item.value)).toEqual(["Q200"])
  expect(prices("Son 200 quetzales.", "- Servicio Limpieza: Q 150.00", gt).ok).toBe(false)
  // Euros: el símbolo va detrás del número.
  const es = { timezone: "Europe/Madrid", currency: "EUR", locale: "es-ES" }
  expect(prices("La limpieza cuesta 60 €.", "- Servicio Limpieza: 60,00 €", es).ok).toBe(true)
  expect(prices("La limpieza cuesta 65 €.", "- Servicio Limpieza: 60,00 €", es).ok).toBe(false)
  // Sin moneda de la clínica quedan los códigos ISO, los signos y los nombres compartidos.
  const bare = { timezone: "UTC" }
  expect(verifyReply("Cuesta 90 dólares, o MXN 1,500.", price("Tarifa: 80"), bare, NOW).unsupported.map((item) => item.value)).toEqual(["90 dólares", "MXN 1,500"])
})

it("no asume dos decimales: pesos sin decimales y dinares con tres", () => {
  const cl = { timezone: "America/Santiago", currency: "CLP", locale: "es-CL" }
  const pesos = [{ source: "Sedes y servicios", text: "- Servicio Limpieza: $50.000" }]
  expect(verifyReply("La limpieza cuesta $50.000.", pesos, cl, NOW).ok).toBe(true)
  expect(verifyReply("La limpieza cuesta 50.000 pesos.", pesos, cl, NOW).ok).toBe(true)
  expect(verifyReply("La limpieza cuesta $55.000.", pesos, cl, NOW).ok).toBe(false)
  const kw = { timezone: "Asia/Kuwait", currency: "KWD", locale: "es" }
  const dinars = [{ source: "Sedes y servicios", text: "- Servicio Limpieza: 12,500 KWD\n- Servicio Corona: 1234,500 KWD" }]
  expect(verifyReply("La limpieza cuesta 12,500 KWD.", dinars, kw, NOW).ok).toBe(true)
  expect(verifyReply("La corona cuesta 1234,500 dinares.", dinars, kw, NOW).ok).toBe(true)
  // Con dos decimales, 12,505 y 12,500 se leían igual.
  expect(verifyReply("La limpieza cuesta 12,505 KWD.", dinars, kw, NOW).ok).toBe(false)
})

it("una palabra corriente no es un código de moneda", () => {
  expect(check("Si ves 2 manchas, aplica el gel 2 veces al día.").checks).toEqual([])
  expect(check("Estamos en el top 3 de la ciudad.").checks).toEqual([])
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

it("un mínimo («desde») solo sale dicho como mínimo", () => {
  const desde = {
    source: "Sedes y servicios",
    text: "- Ortodoncia (id x): desde S/ 2,500.00 (es un mínimo: el precio final se define en la evaluación).",
  }
  expect(check("La ortodoncia es desde S/ 2,500; el final se define en la evaluación.", [desde]).ok).toBe(true)
  expect(check("La ortodoncia es a partir de S/ 2,500.", [desde]).ok).toBe(true)
  // En WhatsApp va en negrita junto al precio: la marca no esconde el «desde».
  expect(check("La ortodoncia es *desde S/ 2,500*; el final se define en la evaluación.", [desde]).ok).toBe(true)
  expect(check("La ortodoncia en promoción: *S/ 2,500*.", [desde]).ok).toBe(false)
  const asFinal = check("La ortodoncia cuesta S/ 2,500.", [desde])
  expect(asFinal.ok).toBe(false)
  expect(describeUnsupported(asFinal)).toContain("es un mínimo")
  // Que el mismo número aparezca suelto en otra fuente (lo escribió la persona) no lo vuelve precio final.
  const said = { source: "Lo dijo el interlocutor", text: "¿la ortodoncia cuesta 2,500, no?" }
  expect(check("Sí, la ortodoncia cuesta S/ 2,500.", [desde, said]).ok).toBe(false)
})

it("un medio de pago desactivado no se ofrece; decir que no se acepta sí pasa", () => {
  const refused = ["Transferencia", "Cheque"]
  expect(refusedPaymentMentions("Aceptamos efectivo, tarjeta, transferencia, Yape y Plin.", refused)).toEqual(["Transferencia"])
  expect(refusedPaymentMentions("Sí, aceptamos tarjeta. La transferencia no está entre nuestros medios de pago.", refused)).toEqual([])
  expect(refusedPaymentMentions("No aceptamos cheque ni transferencia; sí efectivo y tarjeta.", refused)).toEqual([])
  expect(refusedPaymentMentions("We take cash and bank TRANSFERENCIA.", refused)).toEqual(["Transferencia"])
  // Una palabra que solo contiene el nombre no cuenta.
  expect(refusedPaymentMentions("Chequeamos tu cita.", refused)).toEqual([])
  expect(refusedPaymentMentions("Aceptamos tarjeta.", [])).toEqual([])
})
