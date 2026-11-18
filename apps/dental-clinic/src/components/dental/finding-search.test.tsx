import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FindingElsewhere, offeredServices, toothPulp } from "./finding-elsewhere"
import { FindingReasonNotice, findingPickerBlocks } from "./finding-picker"
import { searchFindings, treatmentSearchTerm } from "./finding-search"

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

  // QA del 18 nov (H8): «funda» mostraba primero «Fosas y fisuras profundas».
  it("«funda» muestra primero la corona", () => {
    expect(codes("funda")[0]).toBe("crown")
    expect(codes("funda")).toContain("deep_pits_fissures")
    // Lo que se llama así desde el inicio de una palabra sigue primero.
    expect(codes("fosas")[0]).toBe("deep_pits_fissures")
  })

  it("«caries dolorosa» muestra la caries y dice que el dolor es el motivo", () => {
    const found = searchFindings("caries dolorosa")
    expect(found.findings.map((finding) => finding.code)).toContain("caries")
    expect(found.reason).toBe("El dolor")
    expect(found.elsewhere).toBe(false)
  })

  it("«sacar muela», «extraer» y «extracción» buscan la exodoncia en los tratamientos", () => {
    for (const said of ["sacar muela", "extraer", "extracción", "Sacar la muela"])
      expect(treatmentSearchTerm(said)).toBe("exodoncia")
    expect(treatmentSearchTerm("endodoncia")).toBe("endodoncia")
    for (const said of ["sacar muela", "extraer", "extracción"])
      expect(searchFindings(said).elsewhere).toBe(true)
  })
})

describe("los tratamientos que se ofrecen desde la pieza", () => {
  const service = (id: string, name: string, family: string | null) =>
    ({
      id,
      name,
      scope: "tooth",
      toothAnatomy: family
        ? { groups: ["molar", "premolar"], dentition: "permanent", family, siblings: [] }
        : null,
    }) as unknown as Parameters<typeof offeredServices>[0][number]
  const vital = service("s-v", "Endodoncia posterior vital", "endodoncia-vital")
  const nonVital = service("s-nv", "Endodoncia posterior no vital", "endodoncia-no-vital")
  const diagnosis = (code: string, toothNumber = 36) => ({
    diagnosisCode: code,
    toothNumber,
    status: "activo",
    voidedAt: null,
  })

  // QA del 18 nov (H5): para una pulpitis ofrecía la no vital, y una sola.
  it("con pulpitis, la vital; con necrosis, la no vital; sin saberlo, las dos", () => {
    const names = (pulp: ReturnType<typeof toothPulp>) =>
      offeredServices([nonVital, vital], 36, pulp).map((row) => row.name)
    expect(toothPulp([diagnosis("K04.0")], 36)).toBe("vital")
    expect(names(toothPulp([diagnosis("K04.0")], 36))).toEqual(["Endodoncia posterior vital"])
    expect(toothPulp([diagnosis("K04.1")], 36)).toBe("necrotic")
    expect(toothPulp([diagnosis("K04.5")], 36)).toBe("necrotic")
    expect(names(toothPulp([diagnosis("K04.1")], 36))).toEqual(["Endodoncia posterior no vital"])
    // La pulpitis de otra pieza no cuenta.
    expect(toothPulp([diagnosis("K04.0", 46)], 36)).toBeNull()
    expect(names(null)).toEqual(["Endodoncia posterior vital", "Endodoncia posterior no vital"])
  })

  // QA del 18 nov (H4): tras agregarla, volver a buscar ofrecía otra endodoncia en la 36.
  it("si la pieza ya tiene la endodoncia en el plan, lo dice en vez del botón", () => {
    const client = new QueryClient()
    client.setQueryData(["services", "picker", "endodoncia", "todas"], {
      data: [vital, nonVital],
      total: 2,
    })
    client.setQueryData(["plan-items", "p"], {
      data: [
        {
          id: "it-1",
          serviceId: "s-nv",
          toothNumber: 36,
          status: "pendiente",
          title: "Endodoncia posterior no vital",
        },
      ],
    })
    client.setQueryData(["patient-diagnoses", "p"], { data: [diagnosis("K04.0")] })
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <FindingElsewhere
          patientId="p"
          encounterId="e"
          toothNumber={36}
          query="endodoncia"
          diagnoses={false}
          onChanged={() => {}}
        />
      </QueryClientProvider>,
    ).replace(/<[^>]+>/g, "|")
    expect(html).toContain("Endodoncia posterior no vital ya está en el plan de la 36.")
    expect(html).not.toContain("Agregar")
  })
})

// QA de diseño del 18 nov (H3): «sacar muela» en una 48 con raíz retenida ofrecía solo la de impactada.
describe("las exodoncias que encajan en la pieza", () => {
  const exodoncia = (id: string, name: string, groups: string[] | null) =>
    ({
      id,
      name,
      scope: "tooth",
      toothAnatomy: groups ? { groups, dentition: "permanent", family: null, siblings: [] } : null,
    }) as unknown as Parameters<typeof offeredServices>[0][number]
  const simple = exodoncia("s-1", "Exodoncia simple", null)
  const surgical = exodoncia("s-2", "Exodoncia quirúrgica con colgajo", null)
  const impacted = exodoncia("s-3", "Exodoncia de pieza impactada en hueso", ["molar"])
  const anterior = exodoncia("s-4", "Exodoncia de diente anterior", ["anterior"])

  it("ofrece hasta tres, la más específica primero, y no la que no es para la pieza", () => {
    const names = offeredServices([simple, surgical, impacted, anterior], 48, null).map(
      (row) => row.name,
    )
    expect(names).toEqual([
      "Exodoncia de pieza impactada en hueso",
      "Exodoncia simple",
      "Exodoncia quirúrgica con colgajo",
    ])
  })
})

// QA de diseño del 18 nov (H4): lo primero era la tarjeta de un hallazgo ya hecho, y con «caries
// dolorosa» el aviso del motivo iba antes que la caries.
it("el orden de «¿Qué observas?»: primero lo que responde a lo escrito", () => {
  // «endodoncia»: agregarla al plan y después la tarjeta del tratamiento de conducto hecho.
  expect(findingPickerBlocks({ reason: false, cards: true, other: true })).toEqual([
    "other",
    "cards",
  ])
  // «caries dolorosa»: la caries y después el motivo.
  expect(findingPickerBlocks({ reason: true, cards: true, other: false })).toEqual([
    "cards",
    "reason",
  ])
  // «dolor»: el motivo solo.
  expect(findingPickerBlocks({ reason: true, cards: false, other: false })).toEqual(["reason"])
  // «pulpitis»: el diagnóstico; sin nada, «Sin resultados».
  expect(findingPickerBlocks({ reason: false, cards: false, other: true })).toEqual(["other"])
  expect(findingPickerBlocks({ reason: false, cards: false, other: false })).toEqual(["empty"])
})
