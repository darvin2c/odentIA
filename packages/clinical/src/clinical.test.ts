import { describe, expect, it } from "vitest"
import type { FindingRecord } from "./index.js"
import {
  ageLabel,
  composeDisplayName,
  identityDocumentError,
  normalizePhone,
  phoneFormatError,
  allergyConflicts,
  allergyWarnings,
  formatVitals,
  parseVitals,
  activeFindingsAsOf,
  conditionLabel,
  FINDINGS,
  findingAbbreviation,
  findingColor,
  findingDefinition,
  isValidTooth,
  MAX_TAGS,
  normalizeTags,
  surfacesForTooth,
  toothTypeOf,
  validateFinding,
} from "./index.js"

describe("catálogo", () => {
  it("corona distingue tipos sin confundir veneer con carilla de restauración", () => {
    const crown = FINDINGS.find((item) => item.code === "crown")
    const restoration = FINDINGS.find((item) => item.code === "definitive_restoration")
    expect(crown?.variants?.map((item) => item.abbreviation)).toEqual([
      "CM",
      "CF",
      "CMC",
      "CV",
      "CLM",
    ])
    expect(restoration?.variants?.map((item) => item.abbreviation)).toEqual([
      "AM",
      "R",
      "IV",
      "IM",
      "IE",
      "C",
    ])
  })

  it("caries usa MB/CE/CD/CDP y fosas profundas es FFP azul", () => {
    const caries = FINDINGS.find((item) => item.code === "caries")
    expect(caries?.color).toBe("red")
    expect(caries?.variants?.map((item) => item.abbreviation)).toEqual(["MB", "CE", "CD", "CDP"])
    expect(FINDINGS.find((item) => item.code === "deep_pits_fissures")).toMatchObject({
      color: "blue",
    })
    expect(findingAbbreviation({ condition: "deep_pits_fissures" })).toBe("FFP")
  })
})

describe("anatomía", () => {
  it("temporales 54/55 son molares y 56 es inválido", () => {
    expect(toothTypeOf(54)).toBe("molar")
    expect(toothTypeOf(85)).toBe("molar")
    expect(toothTypeOf(14)).toBe("premolar")
    expect(isValidTooth(56)).toBe(false)
    expect(isValidTooth(29)).toBe(false)
    expect(isValidTooth(11.5)).toBe(false)
  })

  it("cara externa facial en anteriores y buccal en posteriores", () => {
    expect(surfacesForTooth(11)).toEqual(["mesial", "distal", "facial", "palatal", "incisal"])
    expect(surfacesForTooth(36)).toEqual(["mesial", "distal", "buccal", "lingual", "occlusal"])
    expect(surfacesForTooth(54)).toContain("occlusal")
  })

  it("rechaza buccal en anterior y facial en posterior", () => {
    expect(
      validateFinding({ toothNumber: 11, condition: "caries", surfaces: ["buccal"] }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 16,
        condition: "caries",
        surfaces: ["facial"],
        details: { variant: "dentin", quality: undefined },
      }).length,
    ).toBeGreaterThan(0)
  })
})

describe("validateFinding", () => {
  it("falla cerrado ante condición desconocida", () => {
    expect(validateFinding({ toothNumber: 11, condition: "sano" })).toHaveLength(1)
  })

  it("rechaza campo no reconocido en detalles", () => {
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "ectopic_tooth",
        details: { severity: "alta" } as never,
      }),
    ).toHaveLength(1)
  })

  it("corona exige variante y rechaza superficies", () => {
    expect(validateFinding({ toothNumber: 26, condition: "crown" })).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 26,
        condition: "crown",
        surfaces: ["occlusal"],
        details: { variant: "metal", quality: "good" },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 26,
        condition: "crown",
        details: { variant: "metal", quality: "good" },
      }),
    ).toHaveLength(0)
  })

  it("movilidad exige grado y no existe M0", () => {
    expect(
      validateFinding({ toothNumber: 46, condition: "pathological_mobility" }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 46,
        condition: "pathological_mobility",
        details: { grade: 0 },
      }),
    ).toEqual([expect.stringMatching(/M0/)])
    expect(
      validateFinding({
        toothNumber: 46,
        condition: "pathological_mobility",
        details: { grade: 2 },
      }),
    ).toHaveLength(0)
    expect(findingAbbreviation({ condition: "pathological_mobility", details: { grade: 2 } })).toBe(
      "M2",
    )
  })

  it("palatinizado solo superior y lingualizado solo inferior", () => {
    expect(
      validateFinding({
        toothNumber: 36,
        condition: "abnormal_position",
        details: { positions: ["palatal"] },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 26,
        condition: "abnormal_position",
        details: { positions: ["lingual"] },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 28,
        condition: "abnormal_position",
        details: { positions: ["distal", "lingual"] },
      }).length,
    ).toBeGreaterThan(0)
    expect(
      validateFinding({
        toothNumber: 26,
        condition: "abnormal_position",
        details: { positions: ["buccal", "mesial"] },
      }),
    ).toHaveLength(0)
    expect(
      findingAbbreviation({
        condition: "abnormal_position",
        details: { positions: ["lingual", "distal"] },
      }),
    ).toBe("D+L")
  })

  it("edéntulo exige la arcada completa exacta", () => {
    const upper = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "edentulous_arch",
        details: { relatedTeeth: upper },
      }),
    ).toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "edentulous_arch",
        details: { relatedTeeth: upper.slice(0, 8) },
      }),
    ).not.toHaveLength(0)
  })
  it("puente exige tramo contiguo con al menos un pilar (voladizo válido)", () => {
    expect(
      validateFinding({
        toothNumber: 14,
        condition: "fixed_partial_denture",
        details: { quality: "good", relatedTeeth: [13, 15], abutmentTeeth: [13, 15] },
      }).length,
    ).toBeGreaterThan(0)
    expect(
      validateFinding({
        toothNumber: 14,
        condition: "fixed_partial_denture",
        details: { quality: "good", relatedTeeth: [13, 14, 15], abutmentTeeth: [13, 15] },
      }),
    ).toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 14,
        condition: "fixed_partial_denture",
        details: { quality: "good", relatedTeeth: [14, 15], abutmentTeeth: [15] },
      }),
    ).toHaveLength(0)
  })

  it("removible parcial puede reemplazar una sola pieza", () => {
    expect(
      validateFinding({
        toothNumber: 44,
        condition: "removable_partial_denture",
        details: { quality: "good", relatedTeeth: [44] },
      }),
    ).toHaveLength(0)
  })

  it("fusión exige par adyacente; transposición admite no adyacente", () => {
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "fusion",
        details: { relatedTeeth: [11, 21] },
      }),
    ).toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "fusion",
        details: { relatedTeeth: [11, 31] },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "diastema",
        details: { relatedTeeth: [11, 23] },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 26,
        condition: "transposition",
        details: { relatedTeeth: [26, 28] },
      }),
    ).toHaveLength(0)
  })

  it("fractura exige trazo de dos puntos; la forma solo-dibujo exige tres", () => {
    expect(validateFinding({ toothNumber: 12, condition: "fracture" })).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 12,
        condition: "fracture",
        details: { drawing: [[[10, 10]]] },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 12,
        condition: "fracture",
        details: {
          drawing: [
            [
              [10, 10],
              [20, 25],
            ],
          ],
        },
      }),
    ).toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 16,
        condition: "caries",
        details: {
          variant: "dentin",
          drawing: [
            [
              [10, 10],
              [20, 25],
            ],
          ],
        },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 16,
        condition: "caries",
        details: {
          variant: "dentin",
          drawing: [
            [
              [10, 10],
              [20, 25],
              [15, 30],
            ],
          ],
        },
      }),
    ).toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 16,
        condition: "caries",
        surfaces: ["occlusal"],
        details: {
          variant: "dentin",
          drawing: [
            [
              [10, 10],
              [20, 25],
            ],
          ],
        },
      }),
    ).toHaveLength(0)
  })

  it("conducto y espigo exigen observación clínica; temporal exige material", () => {
    expect(
      validateFinding({
        toothNumber: 34,
        condition: "root_canal_treatment",
        details: { variant: "root_canal", quality: "good" },
      }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 34,
        condition: "root_canal_treatment",
        details: { variant: "root_canal", quality: "good", clinicallyObserved: true },
      }),
    ).toHaveLength(0)
    expect(validateFinding({ toothNumber: 37, condition: "temporary_crown" })).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 37,
        condition: "temporary_crown",
        details: { specifications: "Acrílico" },
      }),
    ).toHaveLength(0)
  })
})

describe("color y vigencia", () => {
  it("color deriva del código, nunca del estado, y revisión pendiente anula", () => {
    expect(findingColor({ condition: "caries", details: { variant: "dentin" } })).toBe("red")
    expect(findingColor({ condition: "missing_tooth", details: { variant: "unerupted" } })).toBe(
      "blue",
    )
    expect(
      findingColor({ condition: "crown", details: { variant: "metal", quality: "good" } }),
    ).toBe("blue")
    expect(
      findingColor({ condition: "crown", details: { variant: "metal", quality: "poor" } }),
    ).toBe("red")
    expect(findingColor({ condition: "crown", details: { variant: "metal" } })).toBeNull()
    expect(
      findingColor({ condition: "caries", details: { variant: "dentin" }, needsReview: true }),
    ).toBeNull()
    expect(findingColor({ condition: "clinical_observation" })).toBeNull()
  })

  it("vigencia conserva coexistencia y excluye revisión y anuladas", () => {
    const history: FindingRecord[] = [
      {
        id: "a",
        toothNumber: 16,
        condition: "caries",
        status: "recorded",
        createdAt: "2024-01-01",
      },
      {
        id: "b",
        toothNumber: 16,
        condition: "definitive_restoration",
        status: "recorded",
        createdAt: "2024-02-01",
      },
      {
        id: "c",
        toothNumber: 16,
        condition: "fracture",
        status: "recorded",
        needsReview: true,
        createdAt: "2024-03-01",
      },
      {
        id: "d",
        toothNumber: 17,
        condition: "caries",
        status: "recorded",
        voidedAt: "2024-04-01",
        createdAt: "2024-01-15",
      },
    ]
    expect(activeFindingsAsOf(history, "2024-12-31").map((item) => item.id)).toEqual(["a", "b"])
    expect(activeFindingsAsOf(history, "2024-01-10").map((item) => item.id)).toEqual(["a"])
  })

  it("un hallazgo tratado estuvo vigente hasta su tratamiento y deja de estarlo después", () => {
    const history = [
      {
        id: "caries",
        toothNumber: 36,
        condition: "caries",
        status: "recorded",
        createdAt: "2026-01-10",
        resolvedAt: "2026-02-01",
      },
    ]
    expect(activeFindingsAsOf(history, "2026-01-20").map((item) => item.id)).toEqual(["caries"])
    expect(activeFindingsAsOf(history, "2026-02-02")).toEqual([])
  })
})

describe("correcciones y registros no válidos", () => {
  it("anulado con estado voided sigue vigente antes de su voidedAt", () => {
    const history: FindingRecord[] = [
      {
        id: "v",
        toothNumber: 16,
        condition: "caries",
        status: "voided",
        voidedAt: "2024-04-01",
        createdAt: "2024-01-01",
      },
      {
        id: "w",
        toothNumber: 17,
        condition: "caries",
        status: "voided",
        createdAt: "2024-01-01",
      },
    ]
    expect(activeFindingsAsOf(history, "2024-02-01").map((item) => item.id)).toEqual(["v"])
    expect(activeFindingsAsOf(history, "2024-12-31")).toHaveLength(0)
  })

  it("observación clínica exige observaciones o nota", () => {
    expect(
      validateFinding({ toothNumber: 11, condition: "clinical_observation" }),
    ).not.toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "clinical_observation",
        note: "Control en 6 meses.",
      }),
    ).toHaveLength(0)
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "clinical_observation",
        details: { observations: "Placa blanda generalizada." },
      }),
    ).toHaveLength(0)
  })

  it("claves prototipo no se confunden con códigos ni campos conocidos", () => {
    expect(findingDefinition("__proto__")).toBeUndefined()
    expect(findingDefinition("toString")).toBeUndefined()
    expect(conditionLabel("toString")).toBe("toString")
    expect(findingAbbreviation({ condition: "healthy" })).toBe("")
    expect(findingColor({ condition: "healthy" })).toBeNull()
    expect(validateFinding({ toothNumber: 11, condition: "toString" })).toHaveLength(1)
    expect(
      validateFinding({
        toothNumber: 11,
        condition: "ectopic_tooth",
        details: JSON.parse('{"__proto__":1}'),
      }),
    ).toEqual([expect.stringMatching(/no reconocido/)])
    expect(
      validateFinding({
        toothNumber: 26,
        condition: "abnormal_position",
        details: { positions: ["__proto__"] },
      }),
    ).toEqual([expect.stringMatching(/desconocida/)])
  })

  it("textos libres superan el máximo de 2000 caracteres", () => {
    const long = "x".repeat(2001)
    expect(validateFinding({ toothNumber: 11, condition: "ectopic_tooth", note: long })).toEqual([
      expect.stringMatching(/2000/),
    ])
  })
})

describe("normalizeTags", () => {
  it("deduplica mayúsculas y espacios: TAG/tag/' tag ' -> una sola", () => {
    expect(normalizeTags(["TAG", "tag", " tag "])).toEqual(["tag"])
  })

  it("unifica separadores: 'tag 1', 'tag-1' y 'tag_1' -> 'tag-1'", () => {
    expect(normalizeTags(["tag 1", "tag-1", "tag_1"])).toEqual(["tag-1"])
  })

  it("quita tildes y recorta guiones extremos", () => {
    expect(normalizeTags(["  Ortodoncia  ", "niño", "--vip--"])).toEqual([
      "ortodoncia",
      "nino",
      "vip",
    ])
  })

  it("rechaza etiquetas vacías y puntuación no admitida", () => {
    expect(() => normalizeTags(["   "])).toThrow(Error)
    expect(() => normalizeTags(["hola!"])).toThrow(Error)
  })

  it("impone máximo canónico de longitud y de cantidad", () => {
    const maxLengthTag = "a".repeat(40)
    expect(normalizeTags([maxLengthTag])).toEqual([maxLengthTag])
    expect(() => normalizeTags([`${maxLengthTag}a`])).toThrow(Error)
    const veintiuna = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag-${i}`)
    expect(() => normalizeTags(veintiuna)).toThrow(Error)
  })

  it("el límite cuenta únicas canónicas, no crudas", () => {
    const twenty = Array.from({ length: MAX_TAGS }, (_, i) => `tag-${i}`)
    expect(normalizeTags([...twenty, " TAG_0 "])).toEqual(twenty)
  })
})

describe("signos vitales", () => {
  it("normaliza decimales y exige presión completa y plausible", () => {
    expect(parseVitals({ temperatura: "36.54", frecuenciaCardiaca: 72 })).toEqual({
      ok: true,
      value: { temperatura: 36.5, frecuenciaCardiaca: 72 },
    })
    expect(parseVitals({ presionSistolica: 120 })).toMatchObject({ ok: false })
    expect(parseVitals({ presionSistolica: 80, presionDiastolica: 120 })).toMatchObject({
      ok: false,
    })
    expect(parseVitals({ temperatura: 50 })).toMatchObject({ ok: false })
    expect(parseVitals({ glucosa: 90 })).toMatchObject({ ok: false })
    expect(parseVitals({ temperatura: "" })).toEqual({ ok: true, value: null })
    expect(formatVitals({ presionSistolica: 120, presionDiastolica: 80, temperatura: 36.5 })).toBe(
      "PA 120/80 mmHg · T 36.5 °C",
    )
  })
})

describe("alergias al prescribir", () => {
  it("advierte la misma sustancia, el mismo grupo y la reactividad cruzada", () => {
    expect(allergyConflicts("Amoxicilina", ["Amoxicilina"])[0]?.reason).toBe("misma sustancia")
    expect(allergyConflicts("amoxicilina", ["Penicilina"])[0]?.reason).toMatch(/mismo grupo/)
    expect(allergyConflicts("cefalexina", ["penicilina G"])[0]?.reason).toMatch(/cruzada/)
    expect(allergyConflicts("ibuprofeno", ["Aspirina"])[0]?.reason).toMatch(/cruzada/)
    expect(allergyConflicts("clindamicina", ["Penicilina"])).toEqual([])
    expect(allergyConflicts("paracetamol", ["Látex"])).toEqual([])
  })

  it("dice declarada la alergia sin confirmar y calla la descartada", () => {
    expect(
      allergyWarnings("amoxicilina", [{ substance: "Penicilina", verification: "no_confirmada" }]),
    ).toEqual([
      expect.stringMatching(/^amoxicilina: alergia a Penicilina, declarada y por confirmar \(mismo grupo/),
    ])
    expect(
      allergyWarnings("amoxicilina", [{ substance: "Penicilina", verification: "confirmada" }])[0],
    ).not.toMatch(/declarada/)
    expect(
      allergyWarnings("amoxicilina", [{ substance: "Penicilina", verification: "descartada" }]),
    ).toEqual([])
  })
})

describe("identidad estándar", () => {
  it("normaliza teléfonos, valida documentos y compone el nombre", () => {
    // Un número nacional solo se completa con el perfil del país de la clínica.
    expect(normalizePhone("987 654 321", "PE")).toBe("+51987654321")
    expect(normalizePhone("51 987-654-321", "pe")).toBe("+51987654321")
    expect(normalizePhone("987 654 321")).toBeNull()
    expect(normalizePhone("987 654 321", "CL")).toBeNull()
    expect(phoneFormatError("PE")).toBe("Ingresa el teléfono con código de país (+51…) o un celular de 9 dígitos")
    expect(phoneFormatError("CL")).not.toMatch(/\+\d|dígitos/)
    expect(phoneFormatError()).toBe(phoneFormatError("CL"))
    expect(normalizePhone("+58 412 1234567")).toBe("+584121234567")
    expect(normalizePhone("4567890")).toBeNull()
    expect(normalizePhone("5491122334455")).toBe("+5491122334455")
    expect(identityDocumentError("DNI", "123")).toBe("El DNI tiene 8 números; faltan 5")
    expect(identityDocumentError("CE", "001234567")).toBeNull()
    expect(
      composeDisplayName({
        givenNames: " Rosa  María",
        familyName: "Quispe  Huamán",
      }),
    ).toBe("Rosa María Quispe Huamán")
    expect(ageLabel("2025-12-15", new Date("2026-10-08T12:00:00Z"))).toBe("9 meses")
    expect(ageLabel("1990-01-01", new Date("2026-10-08T12:00:00Z"))).toBe("36 años")
  })
})
