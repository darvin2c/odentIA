import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type DocumentCheck,
  fetchDocumentCheck,
  matchesFingerprint,
} from "../../lib/document-check"
import {
  DocumentCheckResult,
  DocumentCheckUnavailable,
  DocumentFileCompare,
} from "./document-check"

const base: DocumentCheck = {
  state: "vigente",
  label: "Receta N.º 12",
  issuedAt: "2026-10-30T15:00:00.000Z",
  validUntil: null,
  voidedAt: null,
  signer: { name: "Dra. Ana Torres", title: "Cirujano dentista", registration: "COP 12345" },
  patientInitials: "R. Q.",
  fingerprints: [],
  clinic: { name: "Dental Smile", phone: "+5115550123" },
}

/** SHA-256 de «abc». */
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

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

  it("sin archivo guardado no ofrece comparar un PDF; con él, sí, y dice que no se sube", () => {
    expect(renderToStaticMarkup(<DocumentCheckResult check={base} />)).not.toContain("Elegir el PDF")
    const page = renderToStaticMarkup(
      <DocumentCheckResult check={{ ...base, fingerprints: [ABC] }} />,
    )
    expect(page).toContain("Elegir el PDF")
    expect(page).toContain("no se envía a ningún lado")
  })

  it("compara por la huella exacta del archivo", async () => {
    const file = new Blob(["abc"])
    await expect(matchesFingerprint(file, [ABC])).resolves.toBe(true)
    await expect(matchesFingerprint(new Blob(["abd"]), [ABC])).resolves.toBe(false)
    // Un archivo enorme no se lee: no es uno de estos papeles.
    const huge = { size: 31 * 1024 * 1024, arrayBuffer: () => Promise.reject(new Error("no")) }
    await expect(matchesFingerprint(huge, [ABC])).resolves.toBe(false)
  })

  it("lo que no coincide avisa que una foto o un escaneo tampoco coinciden", () => {
    const same = renderToStaticMarkup(
      <DocumentFileCompare fingerprints={[ABC]} initial="same" />,
    )
    expect(same).toContain("Es el original.")
    const different = renderToStaticMarkup(
      <DocumentFileCompare fingerprints={[ABC]} initial="different" />,
    )
    expect(different).toContain("No coincide con el original.")
    expect(different).toContain("Una foto, un escaneo")
    expect(different).toContain("Llame a la clínica")
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
