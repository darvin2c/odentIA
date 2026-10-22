import { describe, expect, it } from "vitest"
import {
  countWords,
  fileFilter,
  filesShownElsewhere,
  groupByMonth,
  matchesSearch,
  teethWords,
  visibleDocumentFilters,
} from "./document-list"
import { DOCUMENT_FILTERS, type DocumentFilter } from "./patient-areas"

const ORDER = DOCUMENT_FILTERS.map((option) => option.id)

describe("la lista de Documentos (issue 149)", () => {
  it("cada archivo va con su filtro: imágenes, consentimientos u otros archivos", () => {
    expect(fileFilter("radiografia")).toBe("imagenes")
    expect(fileFilter("foto_clinica")).toBe("imagenes")
    expect(fileFilter("consentimiento")).toBe("consentimientos")
    expect(fileFilter("informe")).toBe("otros")
    expect(fileFilter("otro")).toBe("otros")
  })

  it("cada papel sale una vez: lo que vive en un consentimiento o es el informe de una orden", () => {
    const files = [
      { id: "pdf", category: "consentimiento" },
      { id: "revocacion", category: "consentimiento" },
      { id: "hoja", category: "consentimiento" },
      { id: "informe", category: "informe" },
      { id: "panoramica", category: "radiografia" },
      { id: "suelta", category: "radiografia" },
    ]
    const hidden = filesShownElsewhere(
      [{ pdfDocumentId: "pdf", revokePdfDocumentId: "revocacion", paperDocumentId: "hoja" }],
      [{ resultDocumentId: "informe" }, { resultDocumentId: "panoramica" }, { resultDocumentId: null }],
      files,
    )
    expect([...hidden].sort()).toEqual(["hoja", "informe", "pdf", "revocacion"])
    // La radiografía que llegó como resultado sigue en Imágenes: se compara con las demás.
    expect(hidden.has("panoramica")).toBe(false)
  })

  it("el buscador no distingue tildes ni mayúsculas y pide cada palabra", () => {
    const panoramica = "Panorámica inicial Radiografía panorámica · Tomada 30/09/2026"
    expect(matchesSearch(panoramica, "panoramica")).toBe(true)
    expect(matchesSearch(panoramica, "PANOR 2026")).toBe(true)
    expect(matchesSearch(panoramica, "panor 36")).toBe(false)
    expect(matchesSearch(panoramica, "   ")).toBe(true)
  })

  it("los filtros solo aparecen si filtran algo", () => {
    const present = (...ids: DocumentFilter[]) => new Set(ids)
    // Lucía: una tomografía y nada más.
    expect(visibleDocumentFilters(ORDER, present("imagenes"), 0, 1)).toEqual([])
    // Rosa: de todo, con cuatro pendientes de 29.
    expect(
      visibleDocumentFilters(
        ORDER,
        present("recetas", "ordenes", "consentimientos", "formularios", "imagenes", "odontogramas"),
        4,
        29,
      ),
    ).toEqual([
      "requieren",
      "recetas",
      "ordenes",
      "consentimientos",
      "formularios",
      "imagenes",
      "odontogramas",
    ])
    // Si todo lo que tiene está pendiente, «Requieren acción» no cambia nada.
    expect(visibleDocumentFilters(ORDER, present("consentimientos"), 1, 1)).toEqual([])
    // El filtro puesto se ve siempre, para poder quitarlo.
    expect(visibleDocumentFilters(ORDER, present("imagenes"), 0, 1, "recetas")).toEqual([
      "recetas",
    ])
  })

  it("la lista se separa por mes en el orden recibido", () => {
    const groups = groupByMonth(
      ["2026-10-18", "2026-10-04", "2026-09-30", "2025-09-13"],
      (iso) => iso,
      (iso) => iso.slice(0, 7),
    )
    expect(groups.map((group) => [group.heading, group.items.length])).toEqual([
      ["2026-10", 2],
      ["2026-09", 1],
      ["2025-09", 1],
    ])
  })

  it("dice cuántos hay con el nombre del filtro y la pieza", () => {
    expect(countWords(29)).toBe("29 papeles")
    expect(countWords(1, "imagenes")).toBe("1 imagen")
    expect(countWords(16, "imagenes", 36)).toBe("16 imágenes de la pieza 36")
    expect(countWords(2, "ordenes")).toBe("2 órdenes")
    expect(teethWords([36])).toBe("Pieza 36")
    expect(teethWords([36, 46])).toBe("Piezas 36, 46")
    expect(teethWords([])).toBeNull()
  })
})
