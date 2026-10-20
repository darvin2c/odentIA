/**
 * El resumen del lunes (ADR 0071): el enlace para dejar de recibirlo no se
 * puede falsificar y el correo dice las cifras con el molde común.
 */
import { describe, expect, it } from "vitest"
import { readReportDigestToken, reportDigestEmail, reportDigestToken } from "./report-digest.js"

const KEY = Buffer.alloc(32, 7)

describe("dejar de recibirlo", () => {
  it("el enlace lleva a la persona firmada y no sirve para otra", () => {
    const token = reportDigestToken(KEY, "org_a", "user_1")
    expect(readReportDigestToken(KEY, token)).toEqual({ orgId: "org_a", userId: "user_1" })
    const [payload] = token.split(".")
    const other = reportDigestToken(KEY, "org_a", "user_2").split(".")[1]
    expect(readReportDigestToken(KEY, `${payload}.${other}`)).toBeNull()
    expect(readReportDigestToken(Buffer.alloc(32, 8), token)).toBeNull()
    expect(readReportDigestToken(KEY, "basura")).toBeNull()
  })
})

describe("el correo", () => {
  it("las cuatro cifras, lo que cambió, la recomendación, el botón y la baja", () => {
    const mail = reportDigestEmail({
      firstName: "Ana",
      clinic: "Clínica Sonríe",
      week: "del 12 al 18 de octubre de 2026",
      collected: "S/ 11,600.00",
      facts: [{ label: "Cobrado", value: "S/ 11,600.00 · 6 % más que la semana anterior" }],
      changes: ["El agente agendó 11 citas; la semana anterior, 8."],
      recommendation: "9 personas deben hace más de 30 días.",
      reportsUrl: "https://dental-smile.odentia.localhost/reports",
      stopUrl: "https://dental-smile.odentia.localhost/resumen-lunes/baja/abc",
    })
    expect(mail.subject).toBe("Tu semana: S/ 11,600.00 cobrados y 2 cosas que mirar")
    expect(mail.text).toContain("Hola, Ana. Así fue la semana del 12 al 18 de octubre de 2026 en Clínica Sonríe.")
    expect(mail.text).toContain("LO QUE CAMBIÓ\n- El agente agendó 11 citas; la semana anterior, 8.")
    expect(mail.text).toContain("ARGOS TE RECOMIENDA\n9 personas deben hace más de 30 días.")
    expect(mail.text).toContain("Dejar de recibirlo: https://dental-smile.odentia.localhost/resumen-lunes/baja/abc")
    expect(mail.html).toContain('href="https://dental-smile.odentia.localhost/reports"')
    expect(mail.html).toContain("Dejar de recibirlo</a>")
  })

  it("sin nada que mirar, el asunto solo dice lo cobrado", () => {
    const mail = reportDigestEmail({ firstName: "Ana", clinic: "C", week: "w", collected: "S/ 0.00", facts: [], changes: [], recommendation: null, reportsUrl: null, stopUrl: null })
    expect(mail.subject).toBe("Tu semana: S/ 0.00 cobrados")
    expect(mail.text).not.toContain("Dejar de recibirlo")
  })
})
