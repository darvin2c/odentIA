import { describe, expect, it } from "vitest"
import type { FindingRecord } from "./types.js"
import {
  attachmentLoss,
  comparePeriodontal,
  emptyPeriodontalTooth,
  furcationEntriesFor,
  normalizePeriodontalTooth,
  pendingProbing,
  pendingProbingWords,
  periodontalClassificationShort,
  type PeriodontalToothRecord,
  periodontalDentition,
  periodontalDiagnosisCode,
  periodontalDiagnosisLabel,
  periodontitisStatus,
  probingSequence,
  proposePeriodontalClassification,
  summarizePeriodontal,
  validatePeriodontalClassification,
  validatePeriodontalTooth,
} from "./periodontal.js"

type Row = [number, number[], number[], string, string]
const flags = (s: string) => [...s].map((c) => c === "1")
function chart(rows: Row[], extra: Record<number, Partial<PeriodontalToothRecord>> = {}): PeriodontalToothRecord[] {
  return rows.map(([toothNumber, pd, rec, bop, sup]) =>
    normalizePeriodontalTooth({ toothNumber, probingDepth: pd, recession: rec, bleeding: flags(bop), suppuration: flags(sup), ...extra[toothNumber] }),
  )
}
/** Una pieza sana: bolsas de 2 mm con la encía 2 mm sobre la corona, sin pérdida de inserción. */
const healthy = (toothNumber: number, bop = "000000"): Row => [toothNumber, [2, 2, 2, 2, 2, 2], [-2, -2, -2, -2, -2, -2], bop, "000000"]

// El caso del lienzo (tablero 4): Carlos Paredes, 48 años, 10 de agosto.
const CARLOS: Row[] = [
  [11, [4, 2, 4, 4, 2, 4], [1, 0, 0, 0, 1, 0], "001001", "000000"],
  [12, [3, 2, 3, 4, 2, 2], [-1, 0, -1, -1, 0, -1], "000100", "000000"],
  [13, [3, 2, 4, 3, 3, 3], [0, 2, 0, 0, 0, 0], "000000", "000000"],
  [14, [3, 3, 3, 3, 3, 3], [-1, 0, 0, 0, -1, 0], "000000", "000000"],
  [15, [2, 3, 3, 2, 2, 3], [-1, 0, 0, 0, 0, -1], "010000", "000000"],
  [16, [6, 3, 5, 6, 3, 6], [0, 0, 1, 0, 0, 0], "001101", "000000"],
  [17, [6, 4, 5, 5, 3, 5], [0, 0, 1, 1, 0, 1], "110100", "100000"],
  [21, [4, 2, 3, 4, 2, 4], [1, 1, 0, 0, 0, 0], "000001", "000000"],
  [22, [3, 2, 3, 2, 2, 3], [0, -1, -1, 0, 0, -1], "000001", "000000"],
  [23, [3, 2, 3, 2, 2, 2], [0, 2, 0, 0, 0, 0], "100010", "000000"],
  [24, [3, 2, 3, 3, 2, 3], [-1, -1, -1, -1, 0, -1], "000000", "000000"],
  [25, [4, 2, 4, 4, 3, 4], [0, 0, 0, 1, 0, 1], "101001", "000000"],
  [26, [5, 3, 6, 6, 3, 6], [0, 0, 0, 0, 1, 0], "001101", "000101"],
  [27, [5, 2, 4, 4, 2, 4], [0, 0, 0, 1, 1, 1], "101011", "000000"],
  [31, [4, 2, 4, 3, 2, 4], [1, 2, 1, 1, 0, 1], "001000", "000000"],
  [32, [4, 2, 5, 4, 3, 4], [1, 2, 1, 1, 0, 1], "011110", "000000"],
  [33, [2, 2, 4, 3, 2, 3], [0, 0, -1, 0, -1, -1], "010000", "000000"],
  [34, [2, 2, 3, 3, 2, 3], [0, 0, 0, -1, 0, 0], "010010", "000000"],
  [35, [3, 3, 2, 3, 2, 2], [0, 0, 0, -1, 0, 0], "001000", "000000"],
  [36, [5, 3, 6, 5, 3, 6], [0, 0, 1, 1, 0, 0], "101101", "001000"],
  [37, [4, 3, 4, 4, 2, 5], [0, 1, 0, 0, 1, 0], "100001", "000000"],
  [41, [5, 2, 4, 4, 2, 4], [1, 2, 1, 0, 1, 0], "000100", "000000"],
  [42, [4, 2, 3, 4, 2, 4], [1, 2, 1, 1, 0, 1], "100100", "000000"],
  [43, [3, 2, 3, 2, 2, 2], [0, 0, 0, -1, 0, -1], "100000", "000000"],
  [44, [3, 3, 3, 3, 2, 4], [-1, 0, -1, -1, 0, 0], "001101", "000000"],
  [45, [3, 2, 2, 2, 2, 2], [0, -1, 0, 0, 0, -1], "100000", "000000"],
  [46, [4, 3, 4, 4, 3, 3], [0, 0, 0, 0, 0, 0], "101000", "000000"],
  [47, [6, 4, 5, 5, 3, 6], [0, 0, 1, 1, 0, 0], "100101", "100000"],
]
// La reevaluación de Carlos, el 12 de octubre (tablero 11).
const CARLOS_REEVALUATION: Row[] = [
  [17, [3, 3, 3, 4, 3, 3], [1, 0, 2, 2, 0, 2], "110000", "000000"],
  [16, [4, 3, 3, 3, 3, 4], [1, 0, 1, 1, 0, 1], "000100", "000000"],
  [15, [2, 3, 3, 2, 2, 3], [-1, 0, 0, 0, 0, -1], "010000", "000000"],
  [14, [3, 3, 3, 3, 3, 3], [-1, 0, 0, 0, -1, 0], "000000", "000000"],
  [13, [3, 2, 3, 3, 3, 3], [0, 2, 0, 0, 0, 0], "000000", "000000"],
  [12, [3, 2, 3, 4, 2, 2], [-1, 0, -1, -1, 0, -1], "000000", "000000"],
  [11, [3, 2, 3, 3, 2, 3], [1, 0, 0, 0, 1, 0], "000000", "000000"],
  [21, [3, 2, 3, 3, 2, 3], [1, 1, 0, 0, 0, 0], "000000", "000000"],
  [22, [3, 2, 3, 2, 2, 3], [0, -1, -1, 0, 0, -1], "000000", "000000"],
  [23, [3, 2, 3, 2, 2, 2], [0, 2, 0, 0, 0, 0], "000000", "000000"],
  [24, [3, 2, 3, 3, 2, 3], [-1, -1, -1, -1, 0, -1], "000000", "000000"],
  [25, [3, 2, 3, 3, 3, 4], [0, 0, 0, 1, 0, 1], "100001", "000000"],
  [26, [4, 3, 4, 3, 3, 4], [1, 0, 1, 0, 1, 1], "000000", "000000"],
  [27, [3, 2, 3, 3, 2, 3], [0, 0, 0, 1, 1, 1], "000000", "000000"],
  [47, [3, 3, 4, 4, 3, 4], [1, 0, 1, 2, 0, 1], "100100", "000000"],
  [46, [3, 3, 3, 3, 3, 3], [0, 0, 0, 0, 0, 0], "000000", "000000"],
  [45, [3, 2, 2, 2, 2, 2], [0, -1, 0, 0, 0, -1], "100000", "000000"],
  [44, [3, 3, 3, 3, 2, 4], [-1, 0, -1, -1, 0, 0], "000000", "000000"],
  [43, [3, 2, 3, 2, 2, 2], [0, 0, 0, -1, 0, -1], "000000", "000000"],
  [42, [3, 2, 3, 4, 2, 3], [1, 2, 1, 1, 0, 1], "000100", "000000"],
  [41, [3, 2, 3, 3, 2, 3], [1, 2, 1, 0, 1, 0], "000100", "000000"],
  [31, [3, 2, 3, 3, 2, 3], [1, 2, 1, 1, 0, 1], "000000", "000000"],
  [32, [3, 2, 3, 3, 3, 3], [1, 2, 2, 1, 0, 1], "000110", "000000"],
  [33, [2, 2, 3, 3, 2, 3], [0, 0, -1, 0, -1, -1], "000000", "000000"],
  [34, [2, 2, 3, 3, 2, 3], [0, 0, 0, -1, 0, 0], "010000", "000000"],
  [35, [3, 3, 2, 3, 2, 2], [0, 0, 0, -1, 0, 0], "000000", "000000"],
  [36, [3, 3, 4, 3, 3, 4], [1, 0, 2, 1, 0, 1], "000001", "000000"],
  [37, [4, 3, 3, 3, 2, 7], [0, 1, 0, 0, 1, 0], "100001", "000000"],
]
const CARLOS_EXTRA: Record<number, Partial<PeriodontalToothRecord>> = {
  16: { furcation: { buccal: 1 } },
  26: { furcation: { buccal: 1, distopalatal: 1 } },
  36: { furcation: { buccal: 2, lingual: 1 } },
  31: { mobility: 1 },
  41: { mobility: 1 },
}

describe("periodontograma", () => {
  it("la pérdida de inserción es bolsa más recesión, con signo", () => {
    expect(attachmentLoss(6, 1)).toBe(7)
    expect(attachmentLoss(3, -1)).toBe(2)
    expect(attachmentLoss(3, null)).toBeNull()
  })

  it("las furcas que existen dependen de la pieza", () => {
    expect(furcationEntriesFor(16)).toEqual(["buccal", "mesiopalatal", "distopalatal"])
    expect(furcationEntriesFor(36)).toEqual(["buccal", "lingual"])
    expect(furcationEntriesFor(14)).toEqual(["mesial", "distal"])
    expect(furcationEntriesFor(44)).toEqual([])
    expect(furcationEntriesFor(11)).toEqual([])
  })

  it("valida cada pieza en palabras de quien la registra", () => {
    expect(validatePeriodontalTooth({ toothNumber: 16, probingDepth: [3, 2, 3, 3, 2, 3] }, { implant: false })).toEqual([])
    expect(validatePeriodontalTooth({ toothNumber: 55 }, { implant: false })[0]).toMatch(/permanentes/)
    expect(validatePeriodontalTooth({ toothNumber: 16, probingDepth: [3, 2, 3] }, { implant: false })[0]).toMatch(/6 sitios/)
    expect(validatePeriodontalTooth({ toothNumber: 16, probingDepth: [3, 2, 30, 3, 2, 3] }, { implant: false })[0]).toMatch(/de 0 a 15/)
    expect(validatePeriodontalTooth({ toothNumber: 16, recession: [0, 0, -11, 0, 0, 0] }, { implant: false })[0]).toMatch(/Recesión/)
    expect(validatePeriodontalTooth({ toothNumber: 16, mobility: 4 }, { implant: false })[0]).toMatch(/Miller/)
    expect(validatePeriodontalTooth({ toothNumber: 44, furcation: { buccal: 1 } }, { implant: false })[0]).toMatch(/no tiene furca/)
    expect(validatePeriodontalTooth({ toothNumber: 36, furcation: { buccal: 4 as 1 } }, { implant: false })[0]).toMatch(/Hamp/)
    expect(validatePeriodontalTooth({ toothNumber: 46, plaque: [true, false, false, false] }, { implant: true })[0]).toMatch(/implantes/)
    expect(validatePeriodontalTooth({ toothNumber: 16, periImplant: "mucositis" }, { implant: false })[0]).toMatch(/solo de implantes/)
    expect(validatePeriodontalTooth({ toothNumber: 16, skipped: true, probingDepth: [3, 2, 3, 3, 2, 3] }, { implant: false })[0]).toMatch(/saltada/)
  })

  it("toma del odontograma qué piezas se sondean y cuáles son implantes", () => {
    const finding = (toothNumber: number, condition: string): FindingRecord => ({ id: `${toothNumber}`, toothNumber, condition, status: "recorded" })
    const { teeth, implants } = periodontalDentition([
      finding(18, "missing_tooth"),
      finding(28, "missing_tooth"),
      finding(38, "missing_tooth"),
      finding(48, "missing_tooth"),
      finding(46, "implant"),
      finding(16, "caries"),
    ])
    expect(teeth).toHaveLength(28)
    expect(teeth).not.toContain(18)
    expect(implants).toEqual([46])
    const edentulous = periodontalDentition([finding(11, "edentulous_arch"), finding(14, "implant"), finding(24, "implant")])
    expect(edentulous.teeth.filter((t) => t < 30)).toEqual([14, 24])
  })

  it("sigue la sonda sin saltos: arriba por fuera, arriba por dentro, abajo por dentro, abajo por fuera", () => {
    const sequence = probingSequence([17, 16, 26, 46, 36])
    expect(sequence.map((s) => `${s.toothNumber}${s.face[0]}`)).toEqual(["17b", "16b", "26b", "26l", "16l", "17l", "46l", "36l", "36b", "46b"])
  })

  it("calcula los índices del lienzo con las medidas de Carlos", () => {
    const summary = summarizePeriodontal(chart(CARLOS, CARLOS_EXTRA), [46], [...CARLOS.map((r) => r[0])])
    expect(summary).toMatchObject({
      teethMeasured: 27,
      sitesMeasured: 162,
      bleedingSites: 50,
      bleedingPercent: 31,
      sitesFrom4mm: 59,
      sitesFrom6mm: 11,
      maxProbingDepth: 6,
      worstInterdentalLoss: { toothNumber: 36, site: "distobuccal", value: 7 },
      maxMobility: 1,
      maxFurcation: 2,
      pendingTeeth: [],
    })
    // Las que llegan a la pérdida de su estadio III (5 mm o más entre dientes).
    expect(Object.values(summary.interdentalLossByTooth).filter((loss) => loss >= 5)).toHaveLength(14)
    expect(summary.implants).toEqual([{ toothNumber: 46, bleedingSites: 2, suppurationSites: 0, maxProbingDepth: 4 }])
  })

  it("la placa de O'Leary cuenta caras marcadas; el implante no cuenta", () => {
    const teeth = [
      normalizePeriodontalTooth({ toothNumber: 11, plaque: [true, true, false, false] }),
      normalizePeriodontalTooth({ toothNumber: 21, plaque: [false, false, false, true] }),
      emptyPeriodontalTooth(46),
    ]
    expect(summarizePeriodontal(teeth, [46]).plaque).toEqual({ faces: 8, withPlaque: 3, percent: 38 })
    expect(summarizePeriodontal([emptyPeriodontalTooth(11)], []).plaque).toBeNull()
  })

  it("propone estadio III, grado B y generalizada para Carlos, con sus razones", () => {
    const proposal = proposePeriodontalClassification(
      chart(CARLOS, CARLOS_EXTRA),
      [46],
      { boneLossPercent: 40, teethLostToPeriodontitis: 1, cigarettesPerDay: 6, diabetes: false },
      48,
    )
    expect(proposal).toMatchObject({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized", missing: [] })
    expect(proposal.reasons[0]).toMatch(/Estadio III porque pierde 7 mm de inserción entre dientes/)
    expect(proposal.reasons[1]).toMatch(/0,83/)
    expect(proposal.reasons[2]).toMatch(/14 de 27 piezas \(52 %\) llegan a la pérdida de su estadio, 5 mm o más/)
    expect(proposal.implants).toEqual([{ toothNumber: 46, condition: "mucositis" }])
  })

  it("dice lo que falta y parte del grado B sin la radiografía", () => {
    const proposal = proposePeriodontalClassification(chart(CARLOS, CARLOS_EXTRA), [46], {}, 48)
    expect(proposal.stage).toBe(3)
    expect(proposal.grade).toBe("B")
    expect(proposal.missing).toEqual(["teethLostToPeriodontitis", "boneLossPercent", "smoking", "diabetes"])
  })

  it("los factores de riesgo suben el grado y las piezas perdidas el estadio", () => {
    const rows = chart(CARLOS, CARLOS_EXTRA)
    expect(proposePeriodontalClassification(rows, [46], { cigarettesPerDay: 15 }, 48).grade).toBe("C")
    expect(proposePeriodontalClassification(rows, [46], { diabetes: true, hba1c: 7.4 }, 48).grade).toBe("C")
    expect(proposePeriodontalClassification(rows, [46], { boneLossPercent: 10, cigarettesPerDay: 0, diabetes: false }, 60).grade).toBe("A")
    expect(proposePeriodontalClassification(rows, [46], { teethLostToPeriodontitis: 5 }, 48).stage).toBe(4)
    // Movilidad grado 2 con pérdida de 5 mm o más: rehabilitación compleja, estadio IV.
    const mobile = chart(CARLOS, { ...CARLOS_EXTRA, 31: { mobility: 2 } })
    expect(proposePeriodontalClassification(mobile, [46], {}, 48).stage).toBe(4)
  })

  it("sin pérdida de inserción propone salud o gingivitis con el sangrado", () => {
    const teeth = [11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26]
    const health = proposePeriodontalClassification(chart(teeth.map((t) => healthy(t))), [], {}, 30)
    expect(health).toMatchObject({ diagnosis: "health", stage: null, extent: null })
    const local = proposePeriodontalClassification(chart(teeth.map((t, i) => healthy(t, i < 4 ? "110000" : "000000"))), [], {}, 30)
    expect(local).toMatchObject({ diagnosis: "gingivitis", extent: "localized" })
    const general = proposePeriodontalClassification(chart(teeth.map((t) => healthy(t, "110100"))), [], {}, 30)
    expect(general).toMatchObject({ diagnosis: "gingivitis", extent: "generalized" })
  })

  it("una sola pieza con pérdida entre dientes no es periodontitis: hacen falta dos no vecinas", () => {
    const rows: Row[] = [[11, [4, 2, 2, 2, 2, 2], [0, -2, -2, -2, -2, -2], "000000", "000000"], healthy(12), healthy(21), healthy(22)]
    expect(proposePeriodontalClassification(chart(rows), [], {}, 30).diagnosis).not.toBe("periodontitis")
    rows[3] = [22, [4, 2, 2, 2, 2, 2], [0, -2, -2, -2, -2, -2], "000000", "000000"]
    expect(proposePeriodontalClassification(chart(rows), [], {}, 30)).toMatchObject({ diagnosis: "periodontitis", stage: 2 })
  })

  it("la extensión cuenta las piezas con la pérdida de su estadio, no cualquier pérdida", () => {
    // Jorge (decisión 7): seis molares con 5 mm y doce piezas con 1 a 2 mm.
    const serious = [17, 16, 26, 27, 47, 37].map((t): Row => [t, [5, 3, 5, 5, 3, 5], [0, 0, 0, 0, 0, 0], "000000", "000000"])
    const mild = [15, 14, 13, 12, 22, 23, 24, 25, 45, 44, 34, 35].map((t): Row => [t, [3, 2, 3, 3, 2, 3], [-1, -2, -1, -1, -2, -1], "000000", "000000"])
    const sound = [11, 21, 31, 32, 33, 41, 42, 43, 36, 46].map((t) => healthy(t))
    const proposal = proposePeriodontalClassification(chart([...serious, ...mild, ...sound]), [], {}, 52)
    expect(proposal).toMatchObject({ diagnosis: "periodontitis", stage: 3, extent: "localized" })
    expect(proposal.reasons[2]).toMatch(/6 de 28 piezas \(21 %\)/)
  })

  it("el patrón molar-incisivo se reconoce cuando solo esos están afectados", () => {
    const rows: Row[] = [
      [16, [5, 2, 5, 5, 2, 5], [0, 0, 0, 0, 0, 0], "000000", "000000"],
      [11, [4, 2, 4, 4, 2, 4], [0, 0, 0, 0, 0, 0], "000000", "000000"],
      [36, [5, 2, 5, 5, 2, 5], [0, 0, 0, 0, 0, 0], "000000", "000000"],
      healthy(14),
      healthy(24),
      healthy(34),
    ]
    expect(proposePeriodontalClassification(chart(rows), [], {}, 20).extent).toBe("molar_incisor")
  })

  it("la encía en su lugar anotada como 0 no basta para proponer periodontitis (decisión 8)", () => {
    // Sofía, 25 años: bolsas de 2 a 3 mm y todas las recesiones en 0.
    const teeth = [17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37]
    const sofia = chart(teeth.map((t, i): Row => [t, [3, 2, 3, 3, 2, 3], [0, 0, 0, 0, 0, 0], i < 3 ? "100000" : "000000", "000000"]))
    const proposal = proposePeriodontalClassification(sofia, [], {}, 25)
    expect(proposal.diagnosis).toBe("health")
    expect(proposal.reasons[1]).toMatch(/no alcanza para proponer periodontitis/)
    expect(proposal.warnings[0]).toMatch(/Ninguna recesión está anotada en negativo/)
    // Con la recesión anotada en negativo ya no hay aviso.
    const measured = chart(teeth.map((t): Row => [t, [3, 2, 3, 3, 2, 3], [-2, -2, -2, -2, -2, -2], "000000", "000000"]))
    expect(proposePeriodontalClassification(measured, [], {}, 25).warnings).toEqual([])
  })

  it("una pérdida leve con bolsa de 4 mm sí es periodontitis estadio I", () => {
    const rows: Row[] = [
      [16, [4, 2, 3, 3, 2, 3], [-2, -2, -2, -2, -2, -2], "100000", "000000"],
      healthy(15),
      healthy(14),
      [26, [4, 2, 3, 3, 2, 3], [-2, -2, -2, -2, -2, -2], "100000", "000000"],
    ]
    expect(proposePeriodontalClassification(chart(rows), [], {}, 40)).toMatchObject({ diagnosis: "periodontitis", stage: 1 })
  })

  it("en la reevaluación el estadio no baja y propone cómo está hoy", () => {
    const previous = { stage: 3 as const, grade: "B" as const, extent: "generalized" as const, date: "10 ago 2026" }
    const proposal = proposePeriodontalClassification(chart(CARLOS_REEVALUATION, CARLOS_EXTRA), [46], {}, 48, null, previous)
    expect(proposal).toMatchObject({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized", status: "unstable", missing: [] })
    expect(proposal.reasons[0]).toBe("Estadio III, grado B y generalizada vienen del 10 ago 2026: el diagnóstico no baja con el tratamiento.")
    expect(proposal.reasons.at(-1)).toBe("Inestable: la 37, distal por dentro, tiene una bolsa de 7 mm (5 mm o más).")
  })

  it("en la reevaluación el estadio sube si el sondaje de hoy es peor", () => {
    const previous = { stage: 2 as const, grade: "A" as const, extent: "localized" as const }
    const proposal = proposePeriodontalClassification(chart(CARLOS, CARLOS_EXTRA), [46], {}, 48, null, previous)
    expect(proposal).toMatchObject({ stage: 3, grade: "A", extent: "generalized" })
    expect(proposal.reasons[1]).toMatch(/^Sube: estadio III porque/)
    expect(proposal.reasons[2]).toMatch(/^Se extiende: generalizada porque/)
  })

  it("estable, en remisión o inestable según bolsas y sangrado", () => {
    const teeth = [16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26]
    const status = (rows: Row[]) => periodontitisStatus(chart(rows), []).status
    expect(status(teeth.map((t) => [t, [3, 2, 3, 3, 2, 3], [1, 0, 1, 1, 0, 1], "000000", "000000"]))).toBe("stable")
    expect(status(teeth.map((t) => [t, [3, 2, 3, 3, 2, 3], [1, 0, 1, 1, 0, 1], "110000", "000000"]))).toBe("remission")
    expect(status(teeth.map((t, i) => [t, [i ? 3 : 4, 2, 3, 3, 2, 3], [1, 0, 1, 1, 0, 1], i ? "000000" : "100000", "000000"]))).toBe("unstable")
    // Sin diagnóstico previo de periodontitis no se propone un estado.
    expect(proposePeriodontalClassification(chart(CARLOS, CARLOS_EXTRA), [46], {}, 48).status).toBeNull()
  })

  it("el código de la lista de la clínica y el diagnóstico en palabras", () => {
    expect(periodontalDiagnosisCode("ICD-10", "periodontitis")).toBe("K05.3")
    expect(periodontalDiagnosisCode("ICD-10-PE", "gingivitis")).toBe("K05.1")
    expect(periodontalDiagnosisCode("ICD-11", "periodontitis")).toBe("DA0C.Y")
    expect(periodontalDiagnosisCode("ICD-11", "gingivitis")).toBe("DA0B.Y")
    expect(periodontalDiagnosisCode("ICD-10", "health")).toBeNull()
    expect(periodontalDiagnosisLabel({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized", status: "unstable" })).toBe(
      "Periodontitis estadio III, grado B, generalizada, inestable (AAP/EFP 2017)",
    )
    expect(periodontalDiagnosisLabel({ diagnosis: "gingivitis", extent: "localized" })).toBe("Gingivitis inducida por biopelícula, localizada (AAP/EFP 2017)")
    expect(validatePeriodontalClassification({ diagnosis: "gingivitis", extent: "localized", status: "stable" })[0]).toMatch(/solo de la periodontitis/)
  })

  it("valida la clasificación que confirma el odontólogo", () => {
    expect(validatePeriodontalClassification({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized" })).toEqual([])
    expect(validatePeriodontalClassification({ diagnosis: "periodontitis", stage: 3 })).toHaveLength(2)
    expect(validatePeriodontalClassification({ diagnosis: "gingivitis", extent: "molar_incisor" })[0]).toMatch(/localizada o generalizada/)
    expect(validatePeriodontalClassification({ diagnosis: "health", stage: 1 })[0]).toMatch(/solo de la periodontitis/)
    expect(validatePeriodontalClassification({ diagnosis: "health", hba1c: 8 })[0]).toMatch(/diabetes/)
  })

  it("compara dos visitas: cambia un sitio cuando la bolsa se mueve 2 mm o más", () => {
    const before = chart([[37, [4, 3, 4, 4, 2, 5], [0, 1, 0, 0, 1, 0], "100001", "000000"], [36, [5, 3, 6, 5, 3, 6], [0, 0, 1, 1, 0, 0], "101101", "001000"]])
    const after = chart([[37, [4, 3, 3, 3, 2, 7], [0, 1, 0, 0, 1, 0], "100001", "000000"], [36, [3, 3, 4, 3, 3, 4], [1, 0, 2, 1, 0, 1], "000001", "000000"]])
    const result = comparePeriodontal(before, after)
    expect(result.compared).toBe(12)
    expect(result.worsened).toEqual([{ toothNumber: 37, site: "distolingual", before: 5, after: 7, delta: 2 }])
    expect(result.improved.map((c) => `${c.toothNumber}:${c.site}`)).toEqual([
      "36:mesiobuccal",
      "36:distobuccal",
      "36:mesiolingual",
      "36:distolingual",
    ])
  })
  it("dice lo que falta sondear por tramos de la secuencia; la pieza saltada no falta", () => {
    const expected = [17, 16, 15, 46, 45, 44, 43, 42]
    const teeth = expected.map((toothNumber) => {
      const tooth = emptyPeriodontalTooth(toothNumber)
      if (toothNumber >= 40) return tooth
      return { ...tooth, probingDepth: [3, 2, 3, 3, 2, 3] }
    })
    // Abajo por dentro ya está medido de la 46 a la 44; la 43 se saltó.
    for (const tooth of teeth) {
      if ([46, 45, 44].includes(tooth.toothNumber)) tooth.probingDepth = [null, null, null, 3, 2, 3]
      if (tooth.toothNumber === 43) tooth.skipped = true
    }
    expect(pendingProbing(teeth, expected).map((step) => `${step.toothNumber}${step.face[0]}`)).toEqual(["42l", "42b", "44b", "45b", "46b"])
    expect(pendingProbingWords(teeth, expected)).toBe("abajo por dentro, la 42; abajo por fuera, la 42 y de la 44 a la 46")
    expect(pendingProbingWords(expected.map(emptyPeriodontalTooth), expected)).toBe("todo")
    expect(pendingProbingWords(teeth.map((tooth) => ({ ...tooth, skipped: true })), expected)).toBeNull()
  })

  it("la clasificación en corto, para una ficha o un chip", () => {
    expect(periodontalClassificationShort({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized", status: "unstable" })).toBe(
      "Estadio III · Grado B · Generalizada · Inestable",
    )
    expect(periodontalClassificationShort({ diagnosis: "gingivitis", extent: "localized" })).toBe("Gingivitis · Localizada")
    expect(periodontalClassificationShort({ diagnosis: "health" })).toBe("Salud periodontal")
  })
})
