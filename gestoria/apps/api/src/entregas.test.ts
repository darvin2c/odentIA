/**
 * Entregas por distrito (lienzo «gestorIA · Configuración, de nuevo», tablero 7), sin base: los
 * distritos del INEI, la plantilla de Lima, el precio de un envío y cuándo llega.
 */
import { describe, expect, it } from "vitest"
import { DISTRICTS, districtFromWords } from "./distritos.js"
import { arrivalDay, deliveryPriceOf, limaTemplate, plainZone, slotWords } from "./entregas.js"

describe("los distritos (UBIGEO del INEI)", () => {
  it("son los 43 de Lima y los 7 del Callao, sin repetirse", () => {
    expect(DISTRICTS.filter((d) => d.code.startsWith("1501"))).toHaveLength(43)
    expect(DISTRICTS.filter((d) => d.code.startsWith("0701"))).toHaveLength(7)
    expect(new Set(DISTRICTS.map((d) => d.code)).size).toBe(50)
  })

  it("entiende cómo lo dice la clienta, y si puede ser más de uno no adivina", () => {
    expect(districtFromWords("SJL")?.code).toBe("150132")
    expect(districtFromWords("surco")?.code).toBe("150140")
    expect(districtFromWords("Jesus Maria")?.code).toBe("150113")
    expect(districtFromWords("Chosica")?.code).toBe("150118")
    expect(districtFromWords("san juan")).toBeNull()
    expect(districtFromWords("Arequipa")).toBeNull()
  })
})

describe("la plantilla de Lima", () => {
  it("pone los 50 distritos en 6 zonas, cada uno una vez", () => {
    const zones = limaTemplate("150115")
    expect(zones).toHaveLength(6)
    const all = zones.flatMap((z) => z.districts)
    expect(all).toHaveLength(50)
    expect(new Set(all).size).toBe(50)
    expect(zones.map((z) => z.districts.length)).toEqual([17, 4, 6, 4, 5, 14])
  })

  it("la zona desde la que despacha es la de hoy y S/ 10", () => {
    const fromOlivos = limaTemplate("150117")
    expect(fromOlivos.find((z) => z.name === "Lima Norte")).toMatchObject({
      priceCents: 1000,
      lead: "hoy",
      cutoff: 780,
    })
    expect(fromOlivos.find((z) => z.name === "Centro y Lima Moderna")).toMatchObject({
      priceCents: 1200,
      lead: "manana",
    })
    expect(fromOlivos.at(-1)).toMatchObject({
      name: "Lejanos y playas",
      payOnDelivery: false,
      freeShipping: false,
      weekdays: [2, 5],
    })
  })
})

describe("el precio y el día de un envío", () => {
  const method = {
    id: "m",
    storeId: "s",
    name: "Reparto",
    type: "DeliveryModeOwnFleet" as const,
    details: "",
    cost: "por_zona" as const,
    priceCents: null,
    zones: [plainZone("Centro", 1000, ["150116"]), plainZone("Sin distritos", 1500)],
    eta: "",
    acceptsPayOnDelivery: true,
    maxDiscountCents: null,
    freeFromCents: null,
    openingHours: [],
    readyIn: null,
    agencies: [],
    freight: null,
    freightCents: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it("por distrito, por nombre de zona, y lo dice si no llega ahí", () => {
    expect(
      deliveryPriceOf(method, { zone: null, district: "150116", listCents: null }),
    ).toMatchObject({ ok: true, listCents: 1000 })
    expect(deliveryPriceOf(method, { zone: "Sin distritos", listCents: null })).toMatchObject({
      ok: true,
      listCents: 1500,
    })
    expect(
      deliveryPriceOf(method, { zone: null, district: "150119", listCents: null }),
    ).toMatchObject({ ok: false, field: "zone" })
  })

  it("por agencia: llevarlo más el flete si se cobra antes", () => {
    const agency = {
      ...method,
      type: "ParcelService" as const,
      cost: "fijo" as const,
      priceCents: 800,
      zones: [],
      freight: "antes" as const,
      freightCents: 2000,
    }
    expect(deliveryPriceOf(agency, { zone: null, listCents: null })).toMatchObject({
      listCents: 2800,
    })
    expect(
      deliveryPriceOf(
        { ...agency, freight: "al_recoger", freightCents: null },
        { zone: null, listCents: null },
      ),
    ).toMatchObject({ listCents: 800 })
  })

  it("hoy antes de la hora de corte, en la hora de la tienda; si no, mañana; en días fijos, el próximo", () => {
    const zone = { lead: "hoy" as const, cutoff: 13 * 60, weekdays: [] }
    // 17:00 UTC son las 12:00 en Lima; 19:00 UTC, las 14:00. Miércoles 25 de noviembre de 2026.
    expect(arrivalDay(zone, "America/Lima", new Date("2026-11-25T17:00:00Z"))).toBe("2026-11-25")
    expect(arrivalDay(zone, "America/Lima", new Date("2026-11-25T19:00:00Z"))).toBe("2026-11-26")
    const fixed = { lead: "dias" as const, cutoff: null, weekdays: [2, 5] }
    expect(arrivalDay(fixed, "America/Lima", new Date("2026-11-25T17:00:00Z"))).toBe("2026-11-27")
    expect(slotWords({ start: 14 * 60, end: 18 * 60 })).toBe("entre 2 y 6 p. m.")
    expect(slotWords({ start: 10 * 60, end: 13 * 60 })).toBe("entre 10 a. m. y 1 p. m.")
  })
})
