import { beforeEach, expect, it } from "vitest"
import { offersProposal } from "../components/patient/consent-personal-risks"
import {
  hasRisksDraft,
  resetRisksDraftsForTest,
  risksDraftOf,
  setRisksDraft,
} from "./consent-risks-draft"

const draft = (documentId: string, planItemId: string | null) => ({
  documentId,
  patientId: "p",
  planItemId,
  text: "Es hipertensa: se le toma la presión.",
  seen: [],
  latest: null,
})

beforeEach(() => resetRisksDraftsForTest())

// QA de diseño del 18 nov (H1): cada botón que firma ese consentimiento dice «Guardar y firmar».
it("lo escrito sin guardar se reconoce por el consentimiento o por su tratamiento", () => {
  setRisksDraft("c-1", draft("c-1", "item-1"))
  const all = new Map([["c-1", draft("c-1", "item-1")]])
  expect(hasRisksDraft(all, { documentIds: ["c-1"] })).toBe(true)
  expect(hasRisksDraft(all, { planItemIds: ["item-1"] })).toBe(true)
  expect(
    hasRisksDraft(all, { documentIds: ["c-2", null], planItemIds: [undefined, "item-2"] }),
  ).toBe(false)
  setRisksDraft("c-1", null)
  expect(risksDraftOf("c-1")).toBeNull()
})

// QA de diseño del 18 nov (H9): «Volver a proponer» quedaba para siempre tras guardar lo escrito a mano.
it("«Volver a proponer» solo mientras lo escrito es distinto de lo propuesto, o con el campo vacío", () => {
  const proposed = "Toma apixabán: puede sangrar más."
  // Recién generado: lo guardado es lo propuesto.
  expect(offersProposal({ written: proposed, saved: proposed, proposed })).toBe(false)
  // Lo cambia y aún no guarda.
  expect(offersProposal({ written: "Otra cosa", saved: proposed, proposed })).toBe(true)
  // Guardó a propósito lo suyo: ya no se ofrece.
  expect(offersProposal({ written: "Lo mío", saved: "Lo mío", proposed })).toBe(false)
  // Lo borró (guardado o no): se ofrece.
  expect(offersProposal({ written: "", saved: "", proposed })).toBe(true)
  // El sistema no propone nada.
  expect(offersProposal({ written: "", saved: "", proposed: "" })).toBe(false)
})
