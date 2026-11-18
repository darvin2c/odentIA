import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FindingElsewhere } from "./finding-elsewhere"
import { FindingReasonNotice } from "./finding-picker"
import { searchFindings } from "./finding-search"

// Reglas clínicas del 18 nov: «¿Qué observas?» encuentra los hallazgos por cómo se dicen y, lo que
// no es un hallazgo, lo dice y ofrece anotarlo como diagnóstico, agregarlo al plan o ir al motivo.
describe("el buscador de hallazgos de la pieza", () => {
  const codes = (text: string) => searchFindings(text).findings.map((finding) => finding.code)

  it("encuentra los hallazgos por cómo se dicen en la clínica", () => {
    for (const word of ["resina", "obturación", "curación"])
      expect(codes(word)).toContain("definitive_restoration")
    expect(codes("resto radicular")).toContain("root_remnant")
    expect(codes("funda")).toContain("crown")
    // «Endodoncia» es el tratamiento de conducto que ya tiene y, además, se busca para el plan.
    expect(codes("endodoncia")).toContain("root_canal_treatment")
    expect(searchFindings("endodoncia").elsewhere).toBe(true)
    // Lo que se llama así no busca en otro lado.
    expect(searchFindings("caries")).toMatchObject({ elsewhere: false, reason: null })
  })

  // Revisión de las reglas clínicas del 18 nov: «curación temporal» traía la restauración definitiva.
  it("lo temporal se encuentra como temporal, no como la variante definitiva", () => {
    expect(codes("curación temporal")).toEqual(["temporary_restoration"])
    expect(codes("obturación temporal")).toEqual(["temporary_restoration"])
    expect(codes("funda temporal")).toEqual(["temporary_crown"])
    expect(codes("curación")).toEqual(["definitive_restoration"])
    expect(codes("funda")).toContain("crown")
    expect(codes("funda")).not.toContain("temporary_crown")
    // A medio escribir, las dos.
    expect(codes("cura")).toEqual(
      expect.arrayContaining(["definitive_restoration", "temporary_restoration"]),
    )
  })

  it("«pulpitis» no es un hallazgo: se busca en diagnósticos y tratamientos", () => {
    expect(searchFindings("pulpitis")).toMatchObject({
      findings: [],
      elsewhere: true,
      reason: null,
    })
  })

  it("«dolor», «sensibilidad», «hinchazón» o «sangrado de encías» son el motivo de consulta", () => {
    expect(searchFindings("dolor")).toMatchObject({ reason: "El dolor", elsewhere: false })
    expect(searchFindings("sensibilidad").reason).toBe("La sensibilidad")
    expect(searchFindings("hinchazón").reason).toBe("La hinchazón")
    expect(searchFindings("sangrado de encías").reason).toBe("El sangrado de encías")
  })

  // Revisión de las reglas clínicas del 18 nov: aparece mientras se escribe, y se anuncia.
  it("«El dolor es el motivo de consulta» se anuncia a quien usa un lector de pantalla", () => {
    const html = renderToStaticMarkup(<FindingReasonNotice reason="El dolor" onReason={() => {}} />)
    expect(html).toMatch(/^<div role="status"/)
    expect(html).toContain("El dolor es el motivo de consulta.")
    expect(html).toContain("Ir al motivo")
  })

  it("buscar «pulpitis» en la 36 ofrece «Anotar Pulpitis en la 36», no «Sin resultados»", () => {
    const client = new QueryClient()
    client.setQueryData(["diagnosis-codes", "pulpitis"], {
      data: [{ system: "ICD-10", code: "K04.0", description: "Pulpitis", isCategory: false }],
    })
    client.setQueryData(["services", "picker", "pulpitis", "todas"], { data: [], total: 0 })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FindingElsewhere
          patientId="p"
          encounterId="e"
          toothNumber={36}
          query="pulpitis"
          diagnoses
          onChanged={() => {}}
        />
      </QueryClientProvider>,
    ).replace(/<[^>]+>/g, "|")
    expect(html).toContain("Pulpitis| es un diagnóstico: no se dibuja en el diente.")
    expect(html).toContain("Anotar Pulpitis en la 36")
    expect(html).not.toContain("Sin resultados")
  })
})
