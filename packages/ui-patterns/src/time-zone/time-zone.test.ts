import { describe, expect, it } from "vitest"
import { normalizeSearchText } from "../text.js"
import {
  canonicalTimeZone,
  detectedTimeZone,
  localTimeIn,
  timeZoneInfo,
  timeZoneMeta,
  timeZoneOption,
  timeZoneOptions,
  zonesForCountry,
} from "./time-zone.js"

/** Enero y julio de 2026: cubren los dos lados del horario de verano. */
const ENERO = new Date("2026-01-15T12:00:00Z")
const JULIO = new Date("2026-07-15T12:00:00Z")

describe("canonicalTimeZone", () => {
  it("acepta el identificador IANA y normaliza alias y mayúsculas", () => {
    expect(canonicalTimeZone("America/Lima")).toBe("America/Lima")
    expect(canonicalTimeZone("US/Pacific")).toBe("America/Los_Angeles")
    expect(canonicalTimeZone("america/lima")).toBe("America/Lima")
    expect(canonicalTimeZone("  America/Lima  ")).toBe("America/Lima")
  })

  it("descarta lo que no es una zona", () => {
    expect(canonicalTimeZone("Lima")).toBeUndefined()
    expect(canonicalTimeZone("GMT-5")).toBeUndefined()
    expect(canonicalTimeZone("")).toBeUndefined()
    expect(canonicalTimeZone(null)).toBeUndefined()
    expect(canonicalTimeZone(undefined)).toBeUndefined()
  })
})

describe("timeZoneInfo", () => {
  it("describe ciudad, región y desfase de una zona", () => {
    expect(timeZoneInfo("America/Lima", ENERO)).toEqual({
      timeZone: "America/Lima",
      city: "Lima",
      region: "America",
      offsetMinutes: -300,
      offsetLabel: "GMT-5",
    })
  })

  it("usa el último segmento como ciudad", () => {
    expect(timeZoneInfo("America/Argentina/Buenos_Aires", ENERO)?.city).toBe("Buenos Aires")
  })

  it("lee desfases de media hora y de tres cuartos", () => {
    expect(timeZoneInfo("Asia/Kolkata", ENERO)).toMatchObject({
      offsetMinutes: 330,
      offsetLabel: "GMT+5:30",
    })
    expect(timeZoneInfo("Asia/Kathmandu", ENERO)).toMatchObject({
      offsetMinutes: 345,
      offsetLabel: "GMT+5:45",
    })
    expect(timeZoneInfo("Pacific/Chatham", ENERO)?.offsetMinutes).toBe(825)
  })

  it("sigue el horario de verano del hemisferio norte y del sur", () => {
    expect(timeZoneInfo("America/New_York", ENERO)?.offsetMinutes).toBe(-300)
    expect(timeZoneInfo("America/New_York", JULIO)?.offsetMinutes).toBe(-240)
    expect(timeZoneInfo("Australia/Adelaide", ENERO)?.offsetMinutes).toBe(630)
    expect(timeZoneInfo("Australia/Adelaide", JULIO)?.offsetMinutes).toBe(570)
  })

  it("devuelve undefined para un dato que no es una zona", () => {
    expect(timeZoneInfo("Lima", ENERO)).toBeUndefined()
  })
})

describe("hora local y lectura", () => {
  it("da la hora local en formato HH:mm", () => {
    expect(localTimeIn("America/Lima", ENERO)).toBe("07:00")
    expect(localTimeIn("Asia/Tokyo", ENERO)).toBe("21:00")
    expect(localTimeIn("Lima", ENERO)).toBe("")
  })

  it("timeZoneMeta reúne la zona con su hora local", () => {
    expect(timeZoneMeta("America/Lima", ENERO)).toMatchObject({
      city: "Lima",
      offsetLabel: "GMT-5",
      localTime: "07:00",
    })
    expect(timeZoneMeta("Lima", ENERO)).toBeUndefined()
  })
})

describe("timeZoneOptions", () => {
  it("cubre el catálogo del runtime ordenado de oeste a este", () => {
    const options = timeZoneOptions(ENERO)
    expect(options.length).toBeGreaterThan(300)
    expect(options.some((option) => option.timeZone === "America/Lima")).toBe(true)
    for (let i = 1; i < options.length; i += 1) {
      expect(options[i].offsetMinutes).toBeGreaterThanOrEqual(options[i - 1].offsetMinutes)
    }
  })

  it("precalcula el texto de búsqueda sin diacríticos", () => {
    const bogota = timeZoneOptions(ENERO).find((option) => option.timeZone === "America/Bogota")
    expect(bogota?.search).toContain("bogota")
    expect(bogota?.search).toContain("gmt-5")
  })

  it("timeZoneOption describe una zona suelta, incluidas las que no lista el catálogo", () => {
    // `UTC` es válido pero no aparece en `Intl.supportedValuesOf`.
    expect(timeZoneOptions(ENERO).some((option) => option.timeZone === "UTC")).toBe(false)
    expect(timeZoneOption("UTC", ENERO)).toMatchObject({ offsetMinutes: 0, offsetLabel: "GMT" })
    expect(timeZoneOption("Lima", ENERO)).toBeUndefined()
  })
})

describe("zonesForCountry", () => {
  it("da las zonas del país según el runtime", () => {
    expect(zonesForCountry("PE")).toEqual(["America/Lima"])
    expect(zonesForCountry("pe")).toEqual(["America/Lima"])
    expect(zonesForCountry("ES")).toContain("Europe/Madrid")
  })

  it("devuelve zonas canónicas y sin repetir", () => {
    const argentina = zonesForCountry("AR")
    expect(argentina.length).toBeGreaterThan(5)
    expect(argentina.every((zone) => canonicalTimeZone(zone) === zone)).toBe(true)
    expect(new Set(argentina).size).toBe(argentina.length)
  })

  it("no falla con una región desconocida", () => {
    expect(zonesForCountry("XX")).toEqual([])
    expect(zonesForCountry("")).toEqual([])
    expect(zonesForCountry(null)).toEqual([])
  })
})

describe("detectedTimeZone", () => {
  it("devuelve la zona del entorno, canonicalizada", () => {
    const zone = detectedTimeZone()
    expect(zone).toBe(canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone))
    expect(timeZoneInfo(zone, ENERO)).toBeDefined()
  })
})

describe("normalizeSearchText", () => {
  it("quita diacríticos y baja a minúsculas para buscar", () => {
    expect(normalizeSearchText("Bogotá")).toBe("bogota")
    expect(normalizeSearchText("Perú")).toBe("peru")
    expect(normalizeSearchText("España")).toBe("espana")
    expect(normalizeSearchText("  Buenos_Aires  ")).toBe("  buenos_aires  ")
  })
})
