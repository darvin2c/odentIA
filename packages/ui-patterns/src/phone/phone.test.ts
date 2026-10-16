import { maskitoTransform } from "@maskito/core"
import { afterEach, describe, expect, it } from "vitest"
import { setFormatRegion } from "../locale.js"
import {
  type CountryCode,
  countryLabel,
  countryOf,
  countryOptions,
  internationalText,
  isValidE164,
  nationalText,
  normalizeCountry,
  phoneDigits,
  phoneMeta,
  readInternational,
  regionCountry,
  toE164,
} from "./phone.js"
import { maskNationalDigits, phoneMaskOptions, phonePlaceholder } from "./phone-mask.js"

/** Lo que la máscara deja en el campo tras escribir o pegar `value`. */
function masked(value: string, country: CountryCode): string {
  return maskitoTransform(
    { value, selection: [value.length, value.length] },
    phoneMaskOptions(country),
  ).value
}

describe("phoneMeta", () => {
  it("interpreta un móvil peruano tecleado como nacional", () => {
    expect(phoneMeta("987 654 321", "PE")).toEqual({
      e164: "+51987654321",
      country: "PE",
      digits: "987654321",
      national: "987 654 321",
      isPossible: true,
      isValid: true,
    })
  })

  it("quita el prefijo nacional del fijo de Lima", () => {
    expect(phoneMeta("(01) 1234567", "PE").e164).toBe("+5111234567")
  })

  it("respeta el país cuando el número trae prefijo internacional", () => {
    const meta = phoneMeta("+54 9 11 2345 6789", "PE")
    expect(meta.e164).toBe("+5491123456789")
    expect(meta.country).toBe("AR")
  })

  it("no emite E.164 mientras el número está incompleto", () => {
    expect(phoneMeta("987", "PE")).toMatchObject({
      e164: null,
      digits: "987",
      isPossible: false,
      isValid: false,
    })
    expect(phoneMeta("", "PE").e164).toBeNull()
    expect(phoneMeta("   ", "PE").e164).toBeNull()
  })
})

describe("helpers de teléfono", () => {
  it("isValidE164 solo acepta números completos", () => {
    expect(isValidE164("+51987654321")).toBe(true)
    expect(isValidE164("987654321")).toBe(false)
    expect(isValidE164("")).toBe(false)
    expect(isValidE164(null)).toBe(false)
  })

  it("normalizeCountry acepta ISO en cualquier caja y descarta lo desconocido", () => {
    expect(normalizeCountry("pe")).toBe("PE")
    expect(normalizeCountry(" PE ")).toBe("PE")
    expect(normalizeCountry("ZZ")).toBeUndefined()
    expect(normalizeCountry(undefined)).toBeUndefined()
  })

  it("countryOf lee el país del número guardado", () => {
    expect(countryOf("+5491123456789")).toBe("AR")
    expect(countryOf("sin-formato")).toBeUndefined()
  })

  it("toE164 y phoneDigits describen lo tecleado", () => {
    expect(toE164("987654321", "PE")).toBe("+51987654321")
    expect(toE164("987", "PE")).toBeNull()
    expect(phoneDigits("+51 (987) 654-321")).toBe("51987654321")
  })

  it("nationalText lee el número guardado en formato nacional", () => {
    expect(nationalText("+51987654321")).toBe("987 654 321")
    expect(nationalText("+5491123456789")).toBe("011 15-2345-6789")
    // Dato heredado que no es un número: se devuelve tal cual.
    expect(nationalText("no es un número")).toBe("no es un número")
  })

  it("internationalText lo lee con su prefijo, para mostrarlo fuera de un campo", () => {
    expect(internationalText("+51987654100")).toBe("+51 987 654 100")
    expect(internationalText("no es un número")).toBe("no es un número")
  })

  it("readInternational solo interpreta textos con prefijo", () => {
    expect(readInternational("+54 9 11 2345 6789")).toEqual({
      country: "AR",
      e164: "+5491123456789",
    })
    expect(readInternational("+51 987 654 321")?.country).toBe("PE")
    expect(readInternational("987654321")).toBeUndefined()
    expect(readInternational("hola")).toBeUndefined()
  })
})

describe("countryOptions", () => {
  it("pone el país por defecto primero y nombra en es-PE", () => {
    const options = countryOptions("PE", ["AR", "PE", "CL"])
    expect(options.map((option) => option.value)).toEqual(["PE", "AR", "CL"])
    expect(options[0]).toEqual({ value: "PE", label: "Perú", callingCode: "51" })
    expect(options[1].label).toBe("Argentina")
  })

  it("cubre todos los países con plan cuando no se acota la lista", () => {
    const options = countryOptions("PE")
    expect(options.length).toBeGreaterThan(200)
    expect(options.some((option) => option.value === "US")).toBe(true)
  })

  it("countryLabel cae al código si el runtime no nombra la región", () => {
    expect(countryLabel("PE")).toBe("Perú")
  })
})

describe("máscara de teléfono", () => {
  it("agrupa como nacional", () => {
    expect(masked("987654321", "PE")).toBe("987 654 321")
  })

  it("descarta el prefijo internacional del mismo país al pegar", () => {
    expect(masked("+51987654321", "PE")).toBe("987 654 321")
    expect(masked("987-654-321", "PE")).toBe("987 654 321")
  })

  it("formatea el fijo de Lima con el agrupamiento del estándar", () => {
    expect(masked("011234567", "PE")).toBe("(01) 1234567")
  })

  it("el agrupamiento sigue al país elegido", () => {
    expect(masked("987654321", "CL")).toBe("9 8765 4321")
  })

  it("maskNationalDigits es la forma canónica del texto del campo", () => {
    expect(maskNationalDigits("987654321", "PE")).toBe("987 654 321")
    // Argentina necesita su prefijo nacional (0 + 15): los dígitos solos no bastan.
    expect(maskNationalDigits("0111523456789", "AR")).toBe("011 15 2345 6789")
    expect(maskNationalDigits("", "PE")).toBe("")
  })

  it("la plantilla visible es el ejemplo móvil del país", () => {
    expect(phonePlaceholder("PE")).toBe("912 345 678")
    // Argentina necesita su prefijo nacional (0 + 15), que un relleno no daría.
    expect(phonePlaceholder("AR")).toContain("011 15")
    expect(phonePlaceholder("CL")).not.toBe(phonePlaceholder("PE"))
    expect(phonePlaceholder("CL")).not.toBe("")
  })
})

describe("regionCountry", () => {
  afterEach(() => setFormatRegion({ locale: "es-PE", timeZone: "America/Lima" }))

  it("parte del país de la clínica, aunque su formato sea de otro", () => {
    setFormatRegion({ locale: "es-PE", timeZone: "America/Bogota", country: "co" })
    expect(regionCountry()).toBe("CO")
  })

  it("sin país fijado, usa la región del formato de la clínica", () => {
    setFormatRegion({ locale: "es-CL", timeZone: "America/Santiago" })
    expect(regionCountry()).toBe("CL")
  })

  it("sin clínica, sale del entorno y nunca de un país escrito en el código", () => {
    setFormatRegion({})
    const fromEnvironment = regionCountry()
    expect(normalizeCountry(fromEnvironment)).toBe(fromEnvironment)
  })
})
