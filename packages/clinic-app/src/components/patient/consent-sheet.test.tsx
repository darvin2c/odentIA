// @vitest-environment jsdom

/**
 * La hoja del consentimiento (tablet y enlace) dice los riesgos propios de su caso donde los dice
 * el PDF: después de «Riesgos y molestias», una viñeta por frase (reglas clínicas del 18 nov).
 */
import { SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ConsentSheet } from "./consent-sheet"

afterEach(cleanup)

const base = SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === "exodoncia")!.sections
const sheet = (sections: typeof base & { personalRisks?: string[] | null }) =>
  render(
    <ConsentSheet
      clinic={null}
      title="Exodoncia"
      facts={[]}
      sections={sections}
      declaration="Declaro."
    />,
  )

it("los riesgos propios salen después de «Riesgos y molestias»; sin ellos, la hoja es la de siempre", () => {
  const risk =
    "Toma un anticoagulante (apixabán): puede sangrar más tiempo después de la extracción."
  sheet({ ...base, personalRisks: [risk] })
  const headings = screen
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent)
  expect(headings[headings.indexOf("Riesgos y molestias") + 1]).toBe("Riesgos propios de su caso")
  expect(screen.getByText(risk).tagName).toBe("LI")
  cleanup()

  sheet(base)
  expect(screen.queryByRole("heading", { name: "Riesgos propios de su caso" })).toBeNull()
})
