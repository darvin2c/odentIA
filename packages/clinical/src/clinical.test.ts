import { describe, expect, it } from "vitest"
import {
  ageLabel,
  composeDisplayName,
  identityDocumentError,
  normalizePhone,
  phoneFormatError,
  whatsappNumberProblem,
  allergyConflicts,
  allergyWarnings,
  codeAllergySubstance,
  medicationGroupOfAtc,
  searchAllergens,
  bodyMassIndex,
  CORE_VITAL_KEYS,
  formatVitals,
  medicalLeaveEnd,
  medicalLeaveWords,
  parseVitals,
  MAX_TAGS,
  normalizeTags,
} from "./index.js"

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

  it("cada producto registra los suyos; el IMC sale del peso y la talla (issue 229)", () => {
    // La glucosa capilar es de latidIA: con los ocho de siempre no se acepta.
    expect(parseVitals({ glucosaCapilar: 110 }, CORE_VITAL_KEYS)).toMatchObject({ ok: false })
    expect(parseVitals({ glucosaCapilar: 110, perimetroCefalico: "48.25" })).toEqual({
      ok: true,
      value: { glucosaCapilar: 110, perimetroCefalico: 48.3 },
    })
    expect(parseVitals({ glucosaCapilar: 900 })).toMatchObject({ ok: false })
    expect(bodyMassIndex({ peso: 62, talla: 160 })).toBe(24.2)
    expect(bodyMassIndex({ peso: 62 })).toBeNull()
    expect(formatVitals({ glucosaCapilar: 110 })).toBe("Glucosa 110 mg/dL")
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

  it("avisa igual a la declarada y a la registrada, y calla la descartada de antes", () => {
    const declared = allergyWarnings("amoxicilina", [{ substance: "Penicilina", verification: "no_confirmada" }])
    expect(declared).toEqual([expect.stringMatching(/^Amoxicilina: alergia a «Penicilina» \(mismo grupo/)])
    expect(declared[0]).not.toMatch(/declarada|confirmar/)
    expect(allergyWarnings("amoxicilina", [{ substance: "Penicilina", verification: "confirmada" }])).toEqual(declared)
    expect(allergyWarnings("amoxicilina", [{ substance: "Penicilina", verification: "descartada" }])).toEqual([])
  })

  it("con la sustancia de la lista avisa por código, se haya escrito como se haya escrito", () => {
    // Escrita de varias formas: todas dan el mismo grupo ATC J01C.
    for (const written of ["Penicilina", "PENICILINAS", "penicilina ", "Penicilinas (grupo)"]) {
      const entry = codeAllergySubstance(written)
      expect(entry?.code, written).toBe("J01C")
    }
    const penicilinas = { substance: "Penicilinas (grupo)", substanceSystem: "atc", substanceCode: "J01C", severity: "severa" }
    expect(allergyWarnings("amoxicilina", [penicilinas])).toEqual([
      "Amoxicilina: alergia severa a penicilinas. Es del mismo grupo, penicilinas (ATC J01CA04).",
    ])
    // Reacción cruzada entre betalactámicos, y nada con otro grupo.
    expect(allergyWarnings("cefalexina", [penicilinas])[0]).toMatch(/reacción cruzada/)
    expect(allergyWarnings("clindamicina", [penicilinas])).toEqual([])
    // Una alergia a un medicamento avisa con el mismo y con los de su grupo.
    const amoxicilina = { substance: "amoxi", substanceSystem: "atc", substanceCode: "J01CA04" }
    expect(allergyWarnings("Amoxicilina", [amoxicilina])[0]).toMatch(/el mismo medicamento/)
    expect(allergyWarnings("ampicilina", [amoxicilina])[0]).toMatch(/mismo grupo/)
    // Lo que no es medicamento no choca con una receta.
    expect(allergyWarnings("lidocaína", [{ substance: "Látex", substanceSystem: "odentia", substanceCode: "latex" }])).toEqual([])
  })

  it("no codifica lo que no es exactamente una sustancia de la lista", () => {
    expect(codeAllergySubstance("amoxi")).toBeNull()
    expect(codeAllergySubstance("látex")?.code).toBe("latex")
    expect(codeAllergySubstance("Aspirina")?.code).toBe("N02BA01")
    const penic = searchAllergens("penic").map((entry) => entry.code)
    expect(penic[0]).toBe("J01C")
    expect(penic).toContain("J01CE08")
    expect(medicationGroupOfAtc("J01CA04")).toBe("penicilinas")
    expect(medicationGroupOfAtc("J01FF01")).toBe("lincosamidas")
  })
})

describe("identidad estándar", () => {
  it("un WhatsApp del país de la clínica es un celular completo; uno de otro país pasa como viene", () => {
    expect(whatsappNumberProblem("+51992154378", "PE")).toBeNull()
    // Un dígito de menos es un E.164 posible, pero Meta lo rechaza en cada envío.
    expect(whatsappNumberProblem("+5199215437", "PE")).toBe("Ese número no puede ser su WhatsApp: revisa que sea un celular de 9 dígitos.")
    // El fijo de Lima es un teléfono, no un WhatsApp.
    expect(whatsappNumberProblem("+5111234567", "PE")).not.toBeNull()
    expect(whatsappNumberProblem("+5491122334455", "PE")).toBeNull()
    // Sin perfil de país no se supone ningún formato.
    expect(whatsappNumberProblem("+5199215437", "CL")).toBeNull()
    expect(whatsappNumberProblem("+5199215437")).toBeNull()
  })

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

describe("descanso médico (issue 229, decisión 8)", () => {
  it("cuenta el primer día y lo dice con sus fechas", () => {
    expect(medicalLeaveEnd("2026-10-24", 3)).toBe("2026-10-26")
    expect(medicalLeaveEnd("2026-12-30", 5)).toBe("2027-01-03")
    expect(medicalLeaveWords("2026-10-24", 3)).toBe("3 días de descanso, del 24/10/2026 al 26/10/2026")
    expect(medicalLeaveWords("2026-10-24", 1)).toBe("1 día de descanso, el 24/10/2026")
  })
})
