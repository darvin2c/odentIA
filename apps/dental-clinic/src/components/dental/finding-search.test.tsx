import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  FindingElsewhere,
  offeredServices,
  toothExtractionFinding,
  toothPulp,
} from "./finding-elsewhere"
import { FindingReasonNotice, findingPickerBlocks } from "./finding-picker"
import { foundBySaying, searchFindings, treatmentSearchTerm } from "./finding-search"

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

  // Mesa del 23 nov: el perno, el puente, la placa… como se dicen en la clínica.
  it("cada palabra de la clínica lleva a su hallazgo", () => {
    const said: ReadonlyArray<readonly [string, string]> = [
      ["perno", "post_and_core"],
      ["poste", "post_and_core"],
      ["perno muñón", "post_and_core"],
      ["espigo", "post_and_core"],
      ["pernos", "post_and_core"],
      ["puente", "fixed_partial_denture"],
      ["prótesis removible", "removable_partial_denture"],
      ["dentadura postiza parcial", "removable_partial_denture"],
      ["dentadura", "complete_denture"],
      ["dentadura postiza", "complete_denture"],
      ["placa total", "complete_denture"],
      ["aparato removible", "removable_orthodontic_appliance"],
      ["brackets", "fixed_orthodontic_appliance"],
      ["braquets", "fixed_orthodontic_appliance"],
      ["frenillos", "fixed_orthodontic_appliance"],
      ["retenida", "impaction"],
      ["retenido", "impaction"],
      ["incluida", "impaction"],
      ["incluido", "impaction"],
      ["raíz", "root_remnant"],
      ["solo raíz", "root_remnant"],
      ["resto radicular", "root_remnant"],
      ["tratamiento de raíz", "root_canal_treatment"],
      ["raíz fracturada", "fracture"],
      ["fracturado", "fracture"],
      ["fracturada", "fracture"],
      ["raíces", "root_remnant"],
      ["desgaste", "tooth_wear"],
      ["desgastado", "tooth_wear"],
      ["abrasión", "tooth_wear"],
      ["abfracción", "tooth_wear"],
      ["erosión", "tooth_wear"],
      ["girado", "rotation"],
      ["girada", "rotation"],
      ["rotado", "rotation"],
      ["rotada", "rotation"],
      ["extraída", "missing_tooth"],
      ["extraído", "missing_tooth"],
      ["falta", "missing_tooth"],
      ["ausente", "missing_tooth"],
      ["supernumerario", "supernumerary_tooth"],
      ["mesiodens", "supernumerary_tooth"],
      ["conoide", "peg_tooth"],
      ["hipoplasia", "enamel_development_defect"],
      ["fluorosis", "enamel_development_defect"],
      ["pulpotomía", "pulpotomy"],
    ]
    for (const [word, code] of said) expect(codes(word), word).toContain(code)
    // Lo dicho entero se queda con lo suyo: «solo raíz» no es el tratamiento de conducto.
    expect(codes("solo raíz")).not.toContain("root_canal_treatment")
    expect(codes("raíz fracturada")).toEqual(["fracture"])
  })

  it("una palabra de varios hallazgos los ofrece a todos, cada uno con su tarjeta", () => {
    expect(codes("placa")).toEqual(
      expect.arrayContaining([
        "removable_partial_denture",
        "complete_denture",
        "removable_orthodontic_appliance",
      ]),
    )
    expect(codes("raíz")).toEqual(expect.arrayContaining(["root_remnant", "root_canal_treatment"]))
    expect(codes("ortodoncia")).toEqual(
      expect.arrayContaining(["fixed_orthodontic_appliance", "removable_orthodontic_appliance"]),
    )
    expect(new Set(codes("placa")).size).toBe(codes("placa").length)
  })

  // Revisión del 23 nov: lo que se dice igual y no es el hallazgo.
  it("la placa bacteriana, la pérdida ósea y «rota» camino a «rotada» no llevan a otra cosa", () => {
    for (const code of [
      "removable_partial_denture",
      "complete_denture",
      "removable_orthodontic_appliance",
    ])
      expect(codes("placa bacteriana")).not.toContain(code)
    expect(codes("pérdida ósea")).not.toContain("missing_tooth")
    expect(codes("rota")).toContain("rotation")
    expect(codes("rota")).not.toContain("fracture")
  })

  // Mesa del 23 nov: por pedazo, «caries posterior» traía el espigo-muñón por «poste».
  it("la palabra va entera o desde su inicio, no por pedazo", () => {
    expect(codes("caries posterior")).toContain("caries")
    expect(codes("caries posterior")).not.toContain("post_and_core")
    // A medio escribir, desde el inicio de la palabra: «pern» ya es el perno.
    expect(codes("pern")).toContain("post_and_core")
    expect(codes("brack")).toContain("fixed_orthodontic_appliance")
  })

  // QA de voces del 24 nov: «perno» trae el «Espigo-muñón» y la tarjeta dice que es el perno.
  it("la tarjeta dice cómo se buscó si no fue por su nombre", () => {
    expect(foundBySaying("post_and_core", "perno")).toBe(true)
    expect(foundBySaying("post_and_core", "espigo")).toBe(false)
    expect(foundBySaying("crown", "funda")).toBe(true)
    expect(foundBySaying("caries", "caries")).toBe(false)
  })

  // QA del 23 nov: la causa de la pieza ausente («…por experiencia de caries dental») la traía.
  it("«caries» y «diente de leche» no ofrecen la pieza ausente; «falta» y «no erupcionado», sí", () => {
    for (const text of ["caries", "caries posterior", "diente de leche"])
      expect(codes(text), text).not.toContain("missing_tooth")
    for (const text of ["falta", "no erupcionado", "ausente", "pieza ausente"])
      expect(codes(text), text).toContain("missing_tooth")
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

  // Verificación del 18 nov (H4): la primera, resaltada, era la de impactada aunque nada lo dijera.
  it("ofrece hasta tres, la simple primero si la pieza no dice otra cosa, y no la que no es para la pieza", () => {
    const names = offeredServices([simple, surgical, impacted, anterior], 48, null).map(
      (row) => row.name,
    )
    expect(names).toEqual([
      "Exodoncia simple",
      "Exodoncia de pieza impactada en hueso",
      "Exodoncia quirúrgica con colgajo",
    ])
  })

  it("primero la que nombra lo que tiene la pieza: la raíz retenida o la impactada", () => {
    const remnant = exodoncia("s-5", "Exodoncia simple de resto radicular", null)
    const remnantSurgical = exodoncia("s-6", "Exodoncia quirúrgica de restos radiculares", null)
    const all = [impacted, simple, surgical, remnantSurgical, remnant]
    expect(
      offeredServices(all, 48, null, "root_remnant")
        .map((row) => row.name)
        .slice(0, 2),
    ).toEqual(["Exodoncia simple de resto radicular", "Exodoncia quirúrgica de restos radiculares"])
    expect(offeredServices(all, 48, null, "impaction")[0]?.name).toBe(
      "Exodoncia de pieza impactada en hueso",
    )
  })

  it("lo que tiene la pieza sale de sus hallazgos o de su diagnóstico (K08.3, raíz retenida)", () => {
    const dx = (code: string, toothNumber: number) => ({
      diagnosisCode: code,
      diagnosisSystem: "ICD-10",
      toothNumber,
      status: "activo",
      voidedAt: null,
    })
    expect(toothExtractionFinding(["root_remnant"], [], 48)).toBe("root_remnant")
    expect(toothExtractionFinding([], [dx("K08.3", 48)], 48)).toBe("root_remnant")
    expect(toothExtractionFinding([], [dx("K08.3", 36)], 48)).toBeNull()
    expect(toothExtractionFinding([], [dx("K01.1", 48)], 48)).toBe("impaction")
  })
})

// Mesa del 23 nov: con el tratamiento primero, dos voces casi agregaron al plan lo que la pieza ya
// tenía hecho. Con «caries dolorosa» el aviso del motivo va después de la caries (QA del 18 nov, H4).
it("el orden de «¿Qué observas?»: primero las tarjetas, después «Si falta hacerlo:»", () => {
  // «endodoncia»: la tarjeta del tratamiento de conducto hecho y después agregarla al plan.
  expect(findingPickerBlocks({ reason: false, cards: true, other: true })).toEqual([
    "cards",
    "other",
  ])
  expect(findingPickerBlocks({ reason: true, cards: true, other: true })).toEqual([
    "cards",
    "other",
    "reason",
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
