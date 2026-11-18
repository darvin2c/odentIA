import { expect, it } from "vitest"
import type { ConsentDocument } from "../../lib/clinical-forms"
import { personalRisksHelp } from "./consent-personal-risks"

const doc = (personalRisks: string[] | undefined, updatedAt = "2026-11-18T10:00:00.000Z") =>
  ({
    sectionsSnapshot: { purpose: "", procedure: "", benefits: [], risks: [], alternatives: [], consequences: "", personalRisks },
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt,
  }) as unknown as ConsentDocument

// Revisión de las reglas clínicas del 18 nov: «Lo propone el sistema» solo cuando hubo propuesta.
it("la ayuda de «Riesgos propios» dice que los propuso el sistema solo si los propuso", () => {
  expect(personalRisksHelp(doc(["Toma apixabán: puede sangrar más."]))).toBe(
    "Lo propone el sistema según sus antecedentes. Cámbialo o bórralo. Una frase por línea.",
  )
  expect(personalRisksHelp(doc(undefined))).toBe("Escribe los riesgos propios de su caso, una frase por línea.")
  // Ya cambiados por el equipo: no se dice que los propuso el sistema.
  expect(personalRisksHelp(doc(["Usa prótesis superior."], "2026-11-18T10:05:00.000Z"))).toBe(
    "Cámbialo o bórralo. Una frase por línea.",
  )
})
