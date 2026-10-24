/** La cita en iCalendar (issue 46, ADR 0081): lo que exigen RFC 5545 y RFC 5546. */
import { describe, expect, it } from "vitest"
import { calendarFile, type CalendarEvent, escapeCalendarText, foldCalendarLine } from "./icalendar.js"

const event: CalendarEvent = {
  uid: "0b6c1d6e-3f0a-4c55-9a52-0f1e2d3c4b5a@odentia",
  sequence: 2,
  start: new Date("2026-10-23T15:00:00Z"),
  end: new Date("2026-10-23T15:30:00Z"),
  timeZone: "America/Lima",
  summary: "Cita en Sonrisas; Miraflores, S.A.C.",
  location: "Sede Larco, Av. José Larco 345 · Miraflores",
  description: "Con la Dra. Ana Torres\nCómo llegar: https://sonrisas.odentia.test/llegar/larco",
  stamp: new Date("2026-10-22T12:00:05Z"),
}

const lines = (text: string) => text.replace(/\r\n /g, "").split("\r\n")

describe("iCalendar", () => {
  it("dice quién lo generó: la plataforma de la clínica (entrega 4b del issue 229)", () => {
    expect(lines(calendarFile(event))).toContain("PRODID:-//odentIA//Citas//ES")
    expect(lines(calendarFile(event, undefined, "latidIA"))).toContain("PRODID:-//latidIA//Citas//ES")
  })

  it("escapa barra, punto y coma, coma y salto de línea", () => {
    expect(escapeCalendarText("a\\b; c, d\ne")).toBe("a\\\\b\\; c\\, d\\ne")
  })

  it("pliega a 75 octetos sin partir un carácter de varios bytes", () => {
    const folded = foldCalendarLine(`DESCRIPTION:${"ñ".repeat(80)}`)
    const parts = folded.split("\r\n")
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    for (const part of parts.slice(1)) expect(part.startsWith(" ")).toBe(true)
    expect(folded.replace(/\r\n /g, "")).toBe(`DESCRIPTION:${"ñ".repeat(80)}`)
    expect(folded).not.toContain("�")
  })

  it("cada línea termina en CRLF y ninguna pasa de 75 octetos", () => {
    const text = calendarFile({ ...event, description: "x".repeat(300) })
    expect(text.endsWith("\r\n")).toBe(true)
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/)
    for (const line of text.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
  })

  it("la hora va en la zona de la sede con su VTIMEZONE; sin cambios de hora, una sola observancia", () => {
    const all = lines(calendarFile(event))
    expect(all).toContain("DTSTART;TZID=America/Lima:20261023T100000")
    expect(all).toContain("DTEND;TZID=America/Lima:20261023T103000")
    expect(all).toContain("DTSTAMP:20261022T120005Z")
    const zone = all.slice(all.indexOf("BEGIN:VTIMEZONE"), all.indexOf("END:VTIMEZONE") + 1)
    expect(zone).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:America/Lima",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0500",
      "END:STANDARD",
      "END:VTIMEZONE",
    ])
  })

  it("una zona con horario de verano lleva sus cambios con el minuto exacto", () => {
    const all = lines(
      calendarFile({ ...event, timeZone: "Europe/Madrid", start: new Date("2026-10-23T08:00:00Z"), end: new Date("2026-10-23T08:30:00Z") }),
    )
    expect(all).toContain("DTSTART;TZID=Europe/Madrid:20261023T100000")
    // El 25 de octubre de 2026 a las 03:00 (verano) vuelve a las 02:00.
    const change = all.indexOf("DTSTART:20261025T030000")
    expect(change).toBeGreaterThan(-1)
    expect(all[change - 1]).toBe("BEGIN:STANDARD")
    expect(all.slice(change + 1, change + 3)).toEqual(["TZOFFSETFROM:+0200", "TZOFFSETTO:+0100"])
    expect(all).toContain("BEGIN:DAYLIGHT")
  })

  it("UID y SEQUENCE; título y lugar escapados", () => {
    const all = lines(calendarFile(event))
    expect(all).toContain(`UID:${event.uid}`)
    expect(all).toContain("SEQUENCE:2")
    expect(all).toContain("SUMMARY:Cita en Sonrisas\\; Miraflores\\, S.A.C.")
    expect(all).toContain("LOCATION:Sede Larco\\, Av. José Larco 345 · Miraflores")
    expect(all).toContain("STATUS:CONFIRMED")
    expect(all.some((line) => line.startsWith("METHOD:"))).toBe(false)
  })

  it("la invitación del correo lleva método, quién invita y a quién, sin pedir respuesta", () => {
    const organizer = { email: "citas@sonrisas.pe", name: 'Clínica "Sonrisas"' }
    const attendee = { email: "rosa@example.com", name: "Rosa Pérez" }
    const all = lines(calendarFile({ ...event, organizer, attendee }, "REQUEST"))
    expect(all).toContain("METHOD:REQUEST")
    expect(all).toContain('ORGANIZER;CN="Clínica Sonrisas":mailto:citas@sonrisas.pe')
    expect(all).toContain('ATTENDEE;CN="Rosa Pérez";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:rosa@example.com')
    const cancel = lines(calendarFile({ ...event, sequence: 3, organizer, attendee }, "CANCEL"))
    expect(cancel).toContain("METHOD:CANCEL")
    expect(cancel).toContain("STATUS:CANCELLED")
    expect(cancel).toContain("SEQUENCE:3")
    expect(() => calendarFile(event, "REQUEST")).toThrow()
  })
})
