/**
 * Lo que Argos calcula de cada clienta, sin base: los bordes de cada grupo (45, 90, 91, 365 y 366
 * días), las 5 compras del año, el ritmo, la mitad con rebaja, una sola compra y sin compras, y la
 * línea de quién es.
 */
import { describe, expect, it } from "vitest"
import { computedOf, daysBetween, type Purchase, whoLine } from "./clientas-perfil.js"
import { addDays } from "./hora.js"

const TODAY = "2026-11-27"

/** Una compra hace `ago` días, de una sandalia beige 37 de S/ 100 si no se dice otra cosa. */
const buy = (ago: number, over: Partial<Purchase> = {}): Purchase => ({
  day: addDays(TODAY, -ago),
  spentCents: 10_000,
  ceded: false,
  promo: false,
  items: [{ category: "Sandalias", color: "beige", measure: "37" }],
  zone: null,
  ...over,
})

const of = (...purchases: Purchase[]) => computedOf(purchases, TODAY, "PEN")

describe("los días", () => {
  it("se cuentan en el calendario", () => {
    expect(daysBetween("2026-11-01", "2026-11-27")).toBe(26)
    expect(daysBetween("2025-11-27", "2026-11-27")).toBe(365)
    // El cambio de hora no mueve el día: son días del calendario.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2)
  })
})

describe("el grupo de una clienta", () => {
  it("sin compras", () => {
    const k = of()
    expect(k).toMatchObject({
      segment: "sin_compras",
      ordersCount: 0,
      totalCents: 0,
      rhythmDays: null,
      lastBoughtDays: null,
      priceSensitivity: null,
    })
    expect(k.why).toBe("Todavía no compra.")
  })

  it("una sola compra es nueva hasta los 90 días; a los 91, dormida", () => {
    expect(of(buy(0))).toMatchObject({ segment: "nueva", why: "Su primera compra fue hoy." })
    expect(of(buy(1)).why).toBe("Su primera compra fue hace 1 día.")
    expect(of(buy(90))).toMatchObject({
      segment: "nueva",
      why: "Su primera compra fue hace 90 días.",
      rhythmDays: null,
      lastBoughtDays: 90,
    })
    expect(of(buy(91))).toMatchObject({
      segment: "dormida",
      why: "91 días sin comprar (más de 90).",
    })
  })

  it("dormida hasta los 365 días; a los 366, perdida", () => {
    expect(of(buy(365), buy(400)).segment).toBe("dormida")
    expect(of(buy(366))).toMatchObject({
      segment: "perdida",
      why: "No compra hace 366 días, más de un año.",
    })
  })

  it("el ritmo son los días entre la primera y la última, entre las compras menos una", () => {
    // De hace 130 a hace 10: 120 días en 3 tramos.
    expect(of(buy(10), buy(50), buy(90), buy(130)).rhythmDays).toBe(40)
    // 55,5 se redondea a 56.
    expect(of(buy(4), buy(75), buy(115)).rhythmDays).toBe(56)
  })

  it("en riesgo: pasó max(45, vez y media su ritmo) sin comprar", () => {
    // Ritmo 10: el tope es 45. A los 45 sigue frecuente; a los 46, en riesgo.
    expect(of(buy(45), buy(55)).segment).toBe("frecuente")
    expect(of(buy(46), buy(56))).toMatchObject({
      segment: "riesgo",
      why: "Compraba cada 10 días y ya van 46.",
    })
    // Ritmo 40: el tope es 60.
    expect(of(buy(60), buy(100), buy(140)).segment).toBe("frecuente")
    expect(of(buy(62), buy(102), buy(142))).toMatchObject({
      segment: "riesgo",
      why: "Compraba cada 40 días y ya van 62.",
    })
  })

  it("frecuente: 2 compras o más, al día con su ritmo", () => {
    expect(of(buy(25), buy(60))).toMatchObject({
      segment: "frecuente",
      why: "2 compras, una cada 35 días.",
    })
    expect(of(buy(0), buy(0)).why).toBe("2 compras, el mismo día.")
  })

  it("VIP: 5 compras o más en el año y la última hace 90 días o menos", () => {
    const five = [buy(3), buy(40), buy(80), buy(120), buy(240)]
    expect(of(...five)).toMatchObject({
      segment: "vip",
      why: "5 compras, S/ 500 en 8 meses.",
      ordersCount: 5,
      totalCents: 50_000,
      avgCents: 10_000,
    })
    // Cuatro en el año y una de antes: no es VIP.
    expect(of(buy(3), buy(40), buy(80), buy(120), buy(370)).segment).toBe("frecuente")
    // Cinco en el año, pero la última hace 91: dormida gana antes.
    expect(of(buy(91), buy(120), buy(150), buy(200), buy(300)).segment).toBe("dormida")
    // Cinco en el año aunque ya pasó su ritmo: VIP va antes que en riesgo.
    expect(of(buy(90), buy(100), buy(110), buy(120), buy(130)).segment).toBe("vip")
  })
})

describe("lo que compra", () => {
  it("cuenta en cuántas compras llevó cada cosa, de lo más a lo menos", () => {
    const k = of(
      buy(1, { items: [{ category: "Zapatillas", color: "blanca", measure: "38" }] }),
      buy(20),
      buy(40),
      buy(60, {
        items: [
          { category: "Sandalias", color: "negra", measure: "37" },
          { category: "Sandalias", color: "negra", measure: "37" },
        ],
      }),
    )
    expect(k.categories).toEqual([
      ["Sandalias", 3],
      ["Zapatillas", 1],
    ])
    expect(k.colors).toEqual([
      ["beige", 2],
      ["blanca", 1],
      ["negra", 1],
    ])
    expect(k.measures).toEqual([
      ["37", 3],
      ["38", 1],
    ])
  })
})

describe("si es sensible al precio", () => {
  it("con la mitad o más de sus compras con rebaja, «pide rebaja»", () => {
    const k = of(
      buy(1, { ceded: true }),
      buy(10, { ceded: true }),
      buy(20, { ceded: true }),
      buy(30, { ceded: true }),
      buy(40),
      buy(50),
    )
    expect(k).toMatchObject({
      priceSensitivity: "rebaja",
      sensitivityWhy: "4 de 6 compras con rebaja",
    })
    expect(of(buy(1, { ceded: true }), buy(10)).priceSensitivity).toBe("rebaja")
    // Menos de la mitad: nada.
    expect(of(buy(1, { ceded: true }), buy(10), buy(20)).priceSensitivity).toBeNull()
  })

  it("si pesa más la promoción, «compra en liquidación»; si empatan, rebaja", () => {
    expect(of(buy(1, { promo: true }), buy(10, { promo: true }), buy(20))).toMatchObject({
      priceSensitivity: "liquidacion",
      sensitivityWhy: "2 de 3 compras en liquidación",
    })
    expect(of(buy(1, { promo: true }), buy(10, { ceded: true })).priceSensitivity).toBe("rebaja")
  })

  it("con una sola compra no se dice", () => {
    expect(of(buy(1, { ceded: true })).priceSensitivity).toBeNull()
  })
})

describe("quién es, en una línea", () => {
  it("lo que compra, en qué medida, dónde y si pide rebaja (sin su grupo)", () => {
    const purchases = [buy(1, { ceded: true, zone: "Surco" }), buy(10, { ceded: true })]
    const computed = computedOf(purchases, TODAY, "PEN")
    expect(
      whoLine({
        purchases,
        computed,
        measureLabel: "Talla",
        district: "San Isidro, su oficina",
      }),
    ).toBe("compra sandalias beige en talla 37 · San Isidro · pide rebaja")
    // Sin distrito en el perfil, ninguno (la zona de reparto no es un distrito); la medida del perfil manda.
    expect(whoLine({ purchases, computed, measureLabel: "Talla", measure: "38" })).toBe(
      "compra sandalias beige en talla 38 · pide rebaja",
    )
  })

  it("sin compras, lo que preguntó", () => {
    expect(
      whoLine({
        purchases: [],
        computed: of(),
        measureLabel: "Talla",
        district: "Surco",
        wanted: [{ text: "Botín de cuero marrón · 43" }],
      }),
    ).toBe("preguntó por botín de cuero marrón · 43 · Surco")
    expect(whoLine({ purchases: [], computed: of(), measureLabel: "Talla" })).toBe(
      "todavía no compra",
    )
  })
})
