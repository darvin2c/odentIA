import { describe, expect, it } from "vitest"
import {
  absenceCauseOf,
  clinicalProfileFor,
  closingOdontogramPurpose,
  findingLeftByTreatment,
  LEAVES_BY_PROCEDURE,
  leavesFindingForProcedure,
  validateFinding,
  validateLeavesFinding,
} from "./index.js"

const PERU = { strictVariants: clinicalProfileFor("PE").odontogram?.strictVariants ?? false }
const COLOMBIA = { strictVariants: clinicalProfileFor("CO").odontogram?.strictVariants ?? false }

describe("variante del hallazgo según el país", () => {
  it("en Perú la variante sigue siendo obligatoria y fuera de Perú es opcional", () => {
    const caries = { toothNumber: 16, condition: "caries", surfaces: ["occlusal"] }
    expect(PERU.strictVariants).toBe(true)
    expect(COLOMBIA.strictVariants).toBe(false)
    expect(validateFinding(caries, PERU)).toHaveLength(1)
    expect(validateFinding(caries, COLOMBIA)).toEqual([])
    // Una variante que no existe se rechaza en cualquier país.
    expect(
      validateFinding({ ...caries, details: { variant: "profunda" } }, COLOMBIA),
    ).toHaveLength(1)
  })

  it("sin opciones valida con el criterio más estricto", () => {
    expect(validateFinding({ toothNumber: 16, condition: "caries", surfaces: ["occlusal"] })).toHaveLength(1)
  })
})

describe("lo tratado queda dibujado", () => {
  it("la resina deja una restauración de resina en buen estado en sus caras", () => {
    const leaves = leavesFindingForProcedure("CPMS", "D2391")
    expect(leaves).toEqual({ condition: "definitive_restoration", variant: "resin" })
    const finding = findingLeftByTreatment(leaves!, { toothNumber: 16, surfaces: ["occlusal"] }, PERU)
    expect(finding).toMatchObject({
      toothNumber: 16,
      condition: "definitive_restoration",
      surfaces: ["occlusal"],
      details: { variant: "resin", quality: "good" },
    })
    // Sin caras no hay dónde dibujarla.
    expect(findingLeftByTreatment(leaves!, { toothNumber: 16, surfaces: [] }, PERU)).toBeNull()
  })

  it("la exodoncia en Perú deduce la causa (DEX o DAO); fuera de Perú no la inventa", () => {
    const leaves = leavesFindingForProcedure("CPMS", "D7140")!
    const byCaries = findingLeftByTreatment(
      leaves,
      { toothNumber: 36 },
      { ...PERU, originCondition: "caries" },
    )
    expect(byCaries?.details?.variant).toBe("caries_extraction")
    const other = findingLeftByTreatment(leaves, { toothNumber: 18 }, { ...PERU, toothConditions: ["impaction"] })
    expect(other?.details?.variant).toBe("other_absence")
    expect(absenceCauseOf({ ...PERU, toothConditions: ["root_remnant"] })).toBe("caries_extraction")
    const abroad = findingLeftByTreatment(leaves, { toothNumber: 36 }, { ...COLOMBIA, originCondition: "caries" })
    expect(abroad).toMatchObject({ condition: "missing_tooth" })
    expect(abroad?.details?.variant).toBeUndefined()
  })

  it("cada procedimiento de la correspondencia deja un hallazgo válido en Perú", () => {
    for (const [key, leaves] of Object.entries(LEAVES_BY_PROCEDURE)) {
      const finding = findingLeftByTreatment(leaves, { toothNumber: 36, surfaces: ["occlusal"] }, PERU)
      expect(finding, key).not.toBeNull()
    }
  })

  it("al configurar un servicio, en Perú se pide la variante y lo que va en caras exige superficies", () => {
    const crown = { condition: "crown" }
    expect(validateLeavesFinding(crown, { scope: "tooth", ...PERU })).toHaveLength(1)
    expect(validateLeavesFinding(crown, { scope: "tooth", ...COLOMBIA })).toEqual([])
    // La ausencia no pide causa: se deduce al completar el tratamiento.
    expect(validateLeavesFinding({ condition: "missing_tooth" }, { scope: "tooth", ...PERU })).toEqual([])
    expect(
      validateLeavesFinding({ condition: "definitive_restoration", variant: "resin" }, { scope: "tooth", ...PERU }),
    ).toHaveLength(1)
    expect(validateLeavesFinding({ condition: "caries" }, { scope: "tooth", ...COLOMBIA })).toHaveLength(1)
    expect(validateLeavesFinding({ condition: "crown", variant: "resin" }, { scope: "tooth", ...COLOMBIA })).toHaveLength(1)
  })
})

describe("momento del odontograma firmado al cerrar la atención", () => {
  it("inicio la primera vez, nuevos hallazgos después y culminación al terminar el plan", () => {
    expect(closingOdontogramPurpose([], false)).toBe("initial")
    expect(closingOdontogramPurpose([], true)).toBe("initial")
    expect(closingOdontogramPurpose(["initial"], false)).toBe("new_findings")
    expect(closingOdontogramPurpose(["initial", "new_findings"], true)).toBe("completion")
    // Tras culminar, lo siguiente abre otro plan; los pedidos no cuentan.
    expect(closingOdontogramPurpose(["initial", "completion"], false)).toBe("initial")
    expect(closingOdontogramPurpose(["legal"], false)).toBe("initial")
    expect(closingOdontogramPurpose(["initial", "personal"], false)).toBe("new_findings")
  })
})
