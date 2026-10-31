import { consentSectionsToText, SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import { afterEach, expect, it, vi } from "vitest"
import { renderConsentPreviewPdf } from "./consent-pdf.js"
import { type DocumentClinic, DocumentKit, documentFormat } from "./document-kit.js"

const clinic = {
  tradeName: "Clínica de prueba",
  legalName: "Clínica de prueba S.A.C.",
  address: "Av. Larco 345",
  country: "PE",
  locale: "es-PE",
  timezone: "America/Lima",
  sheetSize: "A4",
} as unknown as DocumentClinic

const base = SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === "exodoncia")!.sections

afterEach(() => vi.restoreAllMocks())

it("las firmas nunca quedan solas en otra hoja: la declaración pasa con ellas, sea cual sea el largo", async () => {
  const pageOf = (kit: unknown) => (kit as { page: unknown }).page
  const pages = { panel: null as unknown, signatures: null as unknown }
  const drawPanel = DocumentKit.prototype.panel
  const drawSignatures = DocumentKit.prototype.penSignatures
  vi.spyOn(DocumentKit.prototype, "panel").mockImplementation(function (this: DocumentKit, input) {
    drawPanel.call(this, input)
    pages.panel = pageOf(this)
  })
  vi.spyOn(DocumentKit.prototype, "penSignatures").mockImplementation(function (this: DocumentKit, list, options) {
    drawSignatures.call(this, list, options)
    pages.signatures = pageOf(this)
  })

  // Con cada largo la hoja se corta en otro punto: alguno cae justo antes de las firmas.
  for (let extra = 0; extra <= 30; extra++) {
    const sections = {
      ...base,
      risks: [...base.risks, ...Array.from({ length: extra }, (_, index) => `Otro riesgo de esta prueba, número ${index + 1}`)],
    }
    await renderConsentPreviewPdf(clinic, {
      title: "Exodoncia",
      sections,
      body: consentSectionsToText(sections),
    })
    expect(pages.signatures, `con ${extra} riesgos más`).toBe(pages.panel)
  }
})

it("lo que se calcula de antemano es lo que de verdad ocupa", async () => {
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), { title: "Prueba", docLabel: "Prueba", patientLabel: "Rosa" })
  const declaration = { title: "Declaración", body: "He leído y comprendido la información." }
  const beforePanel = kit.y
  kit.panel(declaration)
  expect(beforePanel - kit.y).toBeCloseTo(kit.panelHeight(declaration))
  const list = [
    { heading: "Paciente", strokes: null, lines: [{ text: "Nombre, documento y firma" }] },
    { heading: "Profesional que informa", strokes: null, lines: [{ text: "Fecha y hora" }] },
  ]
  const beforeSignatures = kit.y
  kit.penSignatures(list)
  expect(beforeSignatures - kit.y).toBeCloseTo(kit.penSignaturesHeight(list))
})
