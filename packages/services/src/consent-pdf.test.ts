import { consentSectionsToText, SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import { afterEach, expect, it, vi } from "vitest"
import { renderConsentPaperPdf, renderConsentPdf, renderConsentPreviewPdf } from "./consent-pdf.js"
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

it("firmado en su enlace y sin confirmar: lleva su firma y dice que falta confirmar, sin darlo por firmado", async () => {
  const stateBox = vi.spyOn(DocumentKit.prototype, "stateBox")
  const penSignatures = vi.spyOn(DocumentKit.prototype, "penSignatures")
  const text = vi.spyOn(DocumentKit.prototype, "text")
  const strokes = [[[10, 10], [200, 120]]]
  const personSignedAt = new Date("2026-10-30T15:00:00Z")
  const bytes = await renderConsentPdf(
    {
      document: {
        status: "pendiente",
        titleSnapshot: "Exodoncia",
        procedureRef: null,
        sectionsSnapshot: base,
        bodySnapshot: "",
        diagnosisCode: null,
        declarationSnapshot: "He leído y comprendido la información.",
        signatureMethod: "enlace",
        signerKind: "paciente",
        signerName: "Rosa Rojas",
        signerDoc: "DNI 40000004",
        signatureData: { strokes },
        personSignedAt,
        personSignedIp: "203.0.113.7",
        personSignedUserAgent: "Mozilla/5.0 (Android)",
        signedAt: null,
        informerName: null,
        informerTitle: null,
        informerRegistration: null,
        informedAt: null,
      },
      patient: { displayName: "Rosa Rojas", docType: "DNI", docNumber: "40000004", patientNumber: 7 },
      diagnosisDescription: null,
      establishment: null,
    } as never,
    clinic,
  )
  expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-")
  expect(stateBox).toHaveBeenCalledWith(expect.objectContaining({ title: "FALTA CONFIRMAR" }))
  const [signer] = penSignatures.mock.calls[0]?.[0] ?? []
  expect(signer).toMatchObject({ heading: "Paciente", strokes })
  // La fecha en que firmó la persona, y el profesional aún sin nombre ni «firmado».
  expect(signer?.lines.at(-1)?.text).toMatch(/^Firmó el .*30/)
  const [, informer] = penSignatures.mock.calls[0]?.[0] ?? []
  expect(informer?.lines).toEqual([{ text: "Falta su confirmación" }])
  const written = text.mock.calls.map(([line]) => line)
  expect(written).not.toContain("Firmado electrónicamente")
  expect(written.join(" ")).toContain("IP 203.0.113.7")
})

it("firmado de nuevo en la clínica después del enlace: el PDF dice la fecha de la firma en la clínica", async () => {
  const penSignatures = vi.spyOn(DocumentKit.prototype, "penSignatures")
  const text = vi.spyOn(DocumentKit.prototype, "text")
  await renderConsentPdf(
    {
      document: {
        status: "firmado",
        titleSnapshot: "Exodoncia",
        procedureRef: null,
        sectionsSnapshot: base,
        bodySnapshot: "",
        diagnosisCode: null,
        declarationSnapshot: "He leído y comprendido la información.",
        // Firmó en su enlace el 30 y, en la cita del 5, prefirió firmarlo de nuevo en la tablet.
        signatureMethod: "clinica",
        signerKind: "paciente",
        signerName: "Rosa Rojas",
        signerDoc: "DNI 40000004",
        signatureData: { strokes: [[[10, 10], [200, 120]]] },
        personSignedAt: new Date("2026-10-30T15:00:00Z"),
        personSignedIp: "203.0.113.7",
        personSignedUserAgent: "Mozilla/5.0 (Android)",
        signedAt: new Date("2026-11-05T16:00:00Z"),
        informerName: "Ana Torres",
        informerTitle: "Cirujano dentista",
        informerRegistration: "COP 12345",
        informedAt: new Date("2026-11-05T16:00:00Z"),
      },
      patient: { displayName: "Rosa Rojas", docType: "DNI", docNumber: "40000004", patientNumber: 7 },
      diagnosisDescription: null,
      establishment: null,
    } as never,
    clinic,
  )
  const [signer] = penSignatures.mock.lastCall?.[0] ?? []
  expect(signer?.lines.at(-1)?.text).toMatch(/^Firmó el 5 de noviembre de 2026/)
  // La evidencia del enlace no se presenta como la firma que vale.
  expect(text.mock.calls.map(([line]) => line).join(" ")).not.toContain("Firmó en su enlace")
})

it("firmado: la firma guardada del profesional sale dibujada y el papel sigue diciendo cómo se firmó", async () => {
  const penSignatures = vi.spyOn(DocumentKit.prototype, "penSignatures")
  const strokes = [[[10, 10], [200, 120]]]
  const consent = (professionalSignature: unknown) =>
    ({
      document: {
        status: "firmado",
        titleSnapshot: "Exodoncia",
        procedureRef: null,
        sectionsSnapshot: base,
        bodySnapshot: "",
        diagnosisCode: null,
        declarationSnapshot: "He leído y comprendido la información.",
        signatureMethod: "clinica",
        signerKind: "paciente",
        signerName: "Rosa Rojas",
        signerDoc: "DNI 40000004",
        signatureData: { strokes },
        signedAt: new Date("2026-10-30T15:00:00Z"),
        informerName: "Ana Torres",
        informerTitle: "Cirujano dentista",
        informerRegistration: "COP 12345",
        informedAt: new Date("2026-10-30T15:00:00Z"),
        professionalSignature,
      },
      patient: { displayName: "Rosa Rojas", docType: "DNI", docNumber: "40000004", patientNumber: 7 },
      diagnosisDescription: null,
      establishment: null,
    }) as never

  await renderConsentPdf(consent({ strokes }), clinic)
  const [, withSignature] = penSignatures.mock.lastCall?.[0] ?? []
  expect(withSignature).toMatchObject({ heading: "Profesional que informa", strokes })
  expect(withSignature?.lines.at(-1)?.text).toBe("Firmado electrónicamente")

  // Sin firma guardada: la línea para firmar a mano, no un papel a medias.
  await renderConsentPdf(consent(null), clinic)
  const [, withoutSignature] = penSignatures.mock.lastCall?.[0] ?? []
  expect(withoutSignature).toMatchObject({ strokes: null, handLine: true })
  expect(withoutSignature?.lines.at(-1)?.text).toBe("Firmado electrónicamente")
})

it("el pie dice el nivel de la firma en letra discreta, y en papel no la llama electrónica (entrega 11)", async () => {
  const text = vi.spyOn(DocumentKit.prototype, "text")
  const consent = (signatureMethod: string, country: string | null) =>
    ({
      document: {
        status: "firmado",
        titleSnapshot: "Exodoncia",
        procedureRef: null,
        sectionsSnapshot: base,
        bodySnapshot: "",
        diagnosisCode: null,
        declarationSnapshot: "He leído y comprendido la información.",
        signatureMethod,
        signerKind: "paciente",
        signerName: "Rosa Rojas",
        signerDoc: null,
        signatureData: null,
        signedAt: new Date("2026-10-30T15:00:00Z"),
        informerName: "Ana Torres",
        informedAt: new Date("2026-10-30T15:00:00Z"),
      },
      patient: { displayName: "Rosa Rojas", docType: null, docNumber: null, patientNumber: 7 },
      diagnosisDescription: null,
      establishment: country ? { country } : null,
    }) as never
  const written = () => text.mock.calls.map(([words]) => String(words))
  await renderConsentPdf(consent("clinica", "PE"), clinic, { checkUrl: "https://example.com/comprobar/x" })
  expect(written()).toContain("Firma electrónica simple (Ley 27269) · en la clínica")
  expect(written()).toContain("Escanee el código para comprobar que sigue vigente y que este documento no cambió.")
  expect(written().join(" ")).not.toMatch(/no constituye|firma digital/)
  text.mockClear()
  await renderConsentPdf(consent("enlace", null), clinic)
  expect(written()).toContain("Firma electrónica simple · por enlace")
  text.mockClear()
  await renderConsentPdf(consent("papel", "PE"), clinic)
  expect(written()).toContain("El paciente firmó a mano en papel")
  // Ni «electrónica» al lado de lo firmado en papel (pendiente de la entrega 11).
  expect(written().join(" ")).not.toMatch(/electrónica simple|Firmado electrónicamente/)
  expect(written()).toContain("Lo confirmó con su perfil profesional")
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

it("la hoja para firmar en papel trae el recuadro de la huella de quien no sabe firmar donde la norma lo pide", async () => {
  const penSignatures = vi.spyOn(DocumentKit.prototype, "penSignatures")
  const paper = (country: string | null) =>
    ({
      document: {
        status: "pendiente",
        titleSnapshot: "Exodoncia",
        procedureRef: null,
        sectionsSnapshot: base,
        bodySnapshot: "",
        diagnosisCode: null,
        declarationSnapshot: null,
        informerName: null,
        informerTitle: null,
        informerRegistration: null,
      },
      patient: { displayName: "Rosa Rojas", docType: "DNI", docNumber: "40000004", patientNumber: 7, minor: false },
      diagnosisDescription: null,
      establishment: country ? { country } : null,
    }) as never
  await renderConsentPaperPdf(paper("PE"), clinic)
  expect(penSignatures.mock.lastCall?.[0]?.map((signature) => signature.heading)).toEqual([
    "Paciente",
    "Huella digital",
    "Profesional que informa",
  ])
  // La vista previa de la plantilla es la misma hoja que se imprime.
  await renderConsentPreviewPdf(clinic, { title: "Exodoncia", sections: base, body: "" }, "PE")
  expect(penSignatures.mock.lastCall?.[0]?.map((signature) => signature.heading)).toContain("Huella digital")
  await renderConsentPaperPdf(paper(null), clinic)
  expect(penSignatures.mock.lastCall?.[0]?.map((signature) => signature.heading)).toEqual([
    "Paciente",
    "Profesional que informa",
  ])
})
