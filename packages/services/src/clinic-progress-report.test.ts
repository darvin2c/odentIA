/** El informe de avance: cuenta hechos, no dice lo que nos compromete y cabe en sus hojas. */
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import {
  PROGRESS_REPORT_MAX_PAGES,
  type ProgressReportInput,
  progressReportContent,
  progressReportEmail,
  progressReportPdf,
} from "./clinic-progress-report.js"

const base: ProgressReportInput = {
  clinic: "Clínica Dental Sonrisa",
  to: "Dra. Ana Pérez",
  email: "ana@example.com",
  number: 1,
  stage: "Alta de su cuenta",
  date: "2026-11-12",
  companion: { name: "Carlos Ruiz", role: "Implementación", email: "carlos@odentia32.com", phone: "987 654 321" },
  received: ["Su correo del 11 de noviembre con los datos de la clínica y 3 adjuntos."],
  used: [
    { data: "Nombre de la clínica", where: "Su cuenta" },
    { data: "Su correo", where: "La invitación de propietaria" },
  ],
  notYet: [{ data: "Lista de pacientes", why: "todavía no llegó" }],
  done: ["Creamos su cuenta: sonrisa.odentia32.com", "Le enviamos la invitación a ana@example.com."],
  where: ["Con el enlace de la invitación entra a su clínica."],
  next: ["Entrar con la invitación antes del 19 de noviembre."],
}

describe("informe de avance", () => {
  it("cuenta lo recibido, lo usado y lo hecho, con la marca y sin pedir nada", () => {
    const content = progressReportContent(base)
    expect(content.title).toBe("Informe N.º 1 · Alta de su cuenta")
    expect(content.placeAndDate).toBe("Lima, 12 de noviembre de 2026")
    expect(content.brandName).toBe("odentIA")
    expect(content.footer).toContain("SALLCA GROUP E.I.R.L.")
    // Lo que sigue lo puede hacer ella o escribirnos: no se le pide respuesta.
    expect(content.closing).not.toMatch(/respond|confirm|aprueb/i)
    expect(content.replyTo).toBe("carlos@odentia32.com")
  })

  it.each([
    ["una promesa", "Le garantizamos que todo quedó bien."],
    ["el contrato", "Según el contrato, sus datos están protegidos."],
    ["la ley", "Su clínica cumple con la ley de datos."],
    ["pedir respuesta", "Revise y respóndanos si algo no coincide."],
    ["un documento", "El paciente con DNI 45678901 entró."],
    ["un teléfono", "Llamamos al 987 654 321."],
  ])("no dice %s", (_, text) => {
    expect(() => progressReportContent({ ...base, done: [text] })).toThrow(/El informe no puede decir esto/)
  })

  it("sale en PDF de una hoja, con su título", async () => {
    const { bytes, pages } = await progressReportPdf(base)
    expect(pages).toBe(1)
    expect(pages).toBeLessThanOrEqual(PROGRESS_REPORT_MAX_PAGES)
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getTitle()).toBe("Informe N.º 1 · Alta de su cuenta")
  })

  it("no repite la clínica cuando lleva el nombre de la persona", async () => {
    const own = await progressReportPdf({ ...base, clinic: "Dra. Ana Pérez", to: "Dra. Ana Pérez Soto" })
    const other = await progressReportPdf(base)
    // Una línea menos en el encabezado: el PDF es más corto que el de una clínica con otro nombre.
    expect(own.bytes.length).toBeLessThan(other.bytes.length)
  })

  it("el correo lo lleva con la marca y la respuesta va a quien acompaña", () => {
    const mail = progressReportEmail(progressReportContent(base))
    expect(mail.subject).toBe("Informe N.º 1 · Alta de su cuenta — Clínica Dental Sonrisa")
    expect(mail.replyTo).toBe("carlos@odentia32.com")
    expect(mail.text).toContain("para su información")
    expect(mail.text).not.toMatch(/contrato|garantiz/i)
  })
})
