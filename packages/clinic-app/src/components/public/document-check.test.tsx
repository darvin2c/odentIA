import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type DocumentCheck, fetchDocumentCheck } from "../../lib/document-check"
import { DocumentCheckResult, DocumentCheckUnavailable } from "./document-check"

const base: DocumentCheck = {
  state: "vigente",
  label: "Receta N.º 12",
  issuedAt: "2026-10-30T15:00:00.000Z",
  validUntil: null,
  voidedAt: null,
  signer: { name: "Dra. Ana Torres", title: "Cirujano dentista", registration: "COP 12345" },
  patientInitials: "R. Q.",
  clinic: { name: "Dental Smile", phone: "+5115550123" },
}

afterEach(() => vi.unstubAllGlobals())

describe("Comprobar un documento", () => {
  it.each([
    ["vigente", "Documento vigente"],
    ["anulado", "Documento anulado"],
    ["revocado", "Documento revocado"],
    ["vencido", "Documento vencido"],
  ] as const)(
    "%s dice su estado con su palabra y lo mínimo para cotejar el papel",
    (state, title) => {
      const page = renderToStaticMarkup(<DocumentCheckResult check={{ ...base, state }} />)
      expect(page).toContain(title)
      expect(page).toContain("Receta N.º 12")
      expect(page).toContain("R. Q.")
      expect(page).toContain("Dra. Ana Torres")
      expect(page).toContain('href="tel:+5115550123"')
    },
  )

  it("sin teléfono no ofrece llamar", () => {
    const page = renderToStaticMarkup(
      <DocumentCheckResult check={{ ...base, clinic: { name: "Dental Smile", phone: null } }} />,
    )
    expect(page).not.toContain("Llamar a la clínica")
  })

  it("un código inválido se dice con una frase útil y sin decir por qué", () => {
    const page = renderToStaticMarkup(<DocumentCheckUnavailable />)
    expect(page).toContain("No pudimos comprobar este documento")
    expect(page).toContain("Vuelva a escanear")
    expect(page).not.toMatch(/inválido|anulado|no existe/i)
  })

  it("el 404 de la API es «no se pudo comprobar»; otro fallo se puede reintentar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    )
    await expect(fetchDocumentCheck("x")).resolves.toBeNull()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    )
    await expect(fetchDocumentCheck("x")).rejects.toThrow()
  })
})
