import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { asaLabel, type PatientHealth } from "../../lib/patients"
import { bareProduct, declareProduct } from "../../product/product-ui"
import {
  buildDrafts,
  ClinicalGroupCard,
  DeclaredHealthSnapshot,
  hasOriginalDeclaration,
  healthReviewedWords,
} from "./antecedentes-tab"

// Las fechas en el formato de la clínica, no en el de la máquina que corre la prueba (el CI está en inglés).
beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
})
afterAll(() => {
  setOrgLocale(undefined, undefined)
})

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

// QA del 14 nov (H2 y H6 de desarrollo, 5 del auditor).
describe("«Ver declaración original»", () => {
  it("muestra el embarazo que dijo al registrarse, con sus semanas", () => {
    const page = renderToStaticMarkup(
      <DeclaredHealthSnapshot
        health={{ allergies: { state: "recorded", items: [{ substance: "Ibuprofeno" }] }, personal: { embarazo: true, semanasEmbarazo: 22 } }}
      />,
    ).replace(/<[^>]+>/g, "")
    expect(page).toContain("Ibuprofeno")
    expect(page).toContain("Embarazo · Sí · 22 semanas")
  })

  it("no se ofrece si el equipo la registró sin nada de su salud", () => {
    expect(hasOriginalDeclaration({ respondent: "staff", answers: {} }, [])).toBe(false)
    expect(hasOriginalDeclaration({ respondent: "staff", answers: { health: { bloodGroup: "O+" } } }, [])).toBe(true)
    expect(hasOriginalDeclaration({ respondent: "patient", answers: {} }, [])).toBe(true)
    expect(hasOriginalDeclaration(null, [{}])).toBe(true)
    expect(hasOriginalDeclaration(null, [])).toBe(false)
  })
})

// Auditor, 14 nov: «Revisado por personal autorizado», sin nadie, al lado de una alergia sin revisar.
describe("la revisión de los antecedentes", () => {
  it("nombra a quien la hizo y el día, y dice que es de los antecedentes", () => {
    expect(healthReviewedWords("2026-11-14T15:00:00.000Z", "u1", () => "Dra. Ana Torres")).toBe(
      "Antecedentes revisados por Dra. Ana Torres · 14 nov",
    )
    expect(healthReviewedWords("2026-11-14T15:00:00.000Z", null, () => "")).toBe("Antecedentes revisados · 14 nov")
  })
})
