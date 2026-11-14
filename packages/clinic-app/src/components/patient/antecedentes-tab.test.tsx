import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { asaLabel, type PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { buildDrafts, ClinicalGroupCard } from "./antecedentes-tab"

declareProduct(bareProduct("dental"))

// QA del 6 nov (B4): la ASA guardada no salía en ningún resumen.
describe("la clasificación ASA en el resumen de antecedentes", () => {
  it("se dice con su nombre", () => {
    expect(asaLabel("II")).toBe("ASA II · enfermedad sistémica leve")
  })
  it("sin clasificar, nada", () => {
    expect(asaLabel("")).toBeNull()
    expect(asaLabel(null)).toBeNull()
  })
})

// QA del 14 nov (H4a de clínica): «Revisar antecedentes» llegaba con «Niega… · Ausencia confirmada»
// puesto desde el «No» que marcó la paciente; con un solo «Revisar y guardar» quedaba un «niega» que
// nadie preguntó.
describe("«Revisar antecedentes» con un «No» que dijo la persona", () => {
  const said = {
    revision: 1,
    reviewStatus: { allergies: "unknown", conditions: "none", medications: "none" },
    allergies: [],
    conditions: [],
    medications: [],
    bloodGroup: null,
    reviewedAt: null,
    reviewedBy: null,
    latestAnamnesis: null,
    reviewPending: true,
    declared: [
      {
        by: { kind: "patient", name: null, relation: null },
        at: "2026-11-13T19:27:00.000Z",
        allergies: [],
        conditions: [],
        medications: [],
        pregnancy: false,
        saidNo: { allergies: false, conditions: true, medications: false },
      },
    ],
  } as unknown as PatientHealth

  it("no llega elegido como «Niega»: queda sin marcar para que el profesional decida", () => {
    const drafts = buildDrafts(said)
    expect(drafts.reviewStatus.conditions).toBe("unknown")
    // El «niega» que anotó el equipo sí se conserva.
    expect(drafts.reviewStatus.medications).toBe("none")
  })

  it("junto al grupo dice «Dijo que no» con su día", () => {
    const page = renderToStaticMarkup(
      <ClinicalGroupCard title="Condiciones" review="unknown" saidNo="Dijo que no · 13 nov · sin revisar" reviewField={null}>
        {null}
      </ClinicalGroupCard>,
    )
    expect(page).toContain("Dijo que no · 13 nov · sin revisar")
    expect(page).toContain("No se le preguntó")
    expect(page).not.toContain("Niega")
  })
})
