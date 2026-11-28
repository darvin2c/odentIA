import { describe, expect, it } from "vitest"
import {
  cellKey,
  type Draft,
  draftOf,
  gridBody,
  gridOf,
  heldOf,
  idsOf,
  loweredCells,
  patchOf,
  record,
  type Sheet,
} from "./ficha"

/** Una zapatilla blanca y negra en 35 y 36, como la de la tienda de ejemplo. */
function sheet(overrides: Partial<Sheet> = {}): Sheet {
  return {
    id: "p-1",
    name: "Zapatilla urbana",
    category: "Zapatillas",
    description: "",
    code: null,
    listPriceCents: 12900,
    minPriceCents: 10000,
    options: [
      { name: "Color", values: ["blanca", "negra"] },
      { name: "Talla", values: ["35", "36"] },
    ],
    colorOption: 0,
    colors: [
      { id: "c-1", value: "blanca", hex: "#f2f0ea", hex2: null, photoId: null },
      { id: "c-2", value: "negra", hex: "#1f1f1f", hex2: null, photoId: null },
    ],
    variants: [
      {
        id: "v1",
        optionValues: ["blanca", "35"],
        sku: "A",
        barcode: null,
        priceCents: null,
        photoId: null,
        stock: 3,
      },
      {
        id: "v2",
        optionValues: ["blanca", "36"],
        sku: "B",
        barcode: null,
        priceCents: null,
        photoId: null,
        stock: 3,
      },
      {
        id: "v3",
        optionValues: ["negra", "35"],
        sku: "C",
        barcode: null,
        priceCents: 8900,
        photoId: null,
        stock: 0,
      },
      {
        id: "v4",
        optionValues: ["negra", "36"],
        sku: "D",
        barcode: null,
        priceCents: 8900,
        photoId: null,
        stock: 2,
      },
    ],
    photos: [],
    quantityPrices: [],
    promotions: [
      {
        name: "Negra de temporada",
        percentOff: 10,
        startsOn: "2026-11-01",
        endsOn: "2026-11-30",
        scope: { optionIndex: 0, optionValue: "negra" },
      },
    ],
    wholesale: null,
    comboPercentOff: null,
    offers: { delivery: true, discount: true, secondUnit: false, gift: null },
    links: [],
    state: "disponible",
    status: null,
    statusDays: null,
    statusPerDay: null,
    statusDate: null,
    rubro: "calzado",
    rubroData: { horma: "Normal" },
    template: [],
    package: { weightG: null, lengthMm: null, widthMm: null, heightMm: null },
    keywords: [],
    web: { visible: true, slug: null },
    questions: [],
    readiness: { level: "lista", sellsAlone: true, complete: false, done: 1, total: 2, items: [] },
    fromCents: 8900,
    toCents: 12900,
    lastCostCents: null,
    costWarning: null,
    updatedAt: "2026-11-27T00:00:00.000Z",
    ...overrides,
  }
}

const copy = (d: Draft): Draft => structuredClone(d)

describe("el borrador de la ficha", () => {
  it("envía solo lo que cambió, y de los datos del rubro solo la clave que cambió", () => {
    const base = draftOf(sheet())
    const draft = copy(base)
    expect(patchOf(base, draft, sheet())).toBeNull()
    draft.minPriceCents = 9900
    draft.rubroData.material = "Lona"
    expect(patchOf(base, draft, sheet())).toEqual({
      minPriceCents: 9900,
      rubroData: { material: "Lona" },
    })
  })

  it("no vuelve a enviar lo que el servidor rechazó con ese mismo valor", () => {
    const base = draftOf(sheet())
    const draft = copy(base)
    draft.minPriceCents = 99_000
    draft.name = "Zapatilla"
    const rejected = { minPriceCents: JSON.stringify(99_000) }
    expect(patchOf(base, draft, sheet(), rejected)).toEqual({ name: "Zapatilla" })
  })

  it("espera las tres medidas del paquete antes de enviarlas", () => {
    const base = draftOf(sheet())
    const draft = copy(base)
    draft.package.lengthMm = 320
    expect(patchOf(base, draft, sheet())).toBeNull()
    draft.package.widthMm = 200
    draft.package.heightMm = 120
    expect(patchOf(base, draft, sheet())?.package).toEqual({
      weightG: null,
      lengthMm: 320,
      widthMm: 200,
      heightMm: 120,
    })
  })

  it("las promociones de un color van con el índice de su opción en lo guardado", () => {
    const saved = sheet({
      options: [
        { name: "Talla", values: ["35", "36"] },
        { name: "Color", values: ["blanca", "negra"] },
      ],
      colorOption: 1,
      promotions: [
        {
          name: "Negra",
          percentOff: 10,
          startsOn: "2026-11-01",
          endsOn: "2026-11-30",
          scope: { optionIndex: 1, optionValue: "negra" },
        },
      ],
    })
    const base = draftOf(saved)
    expect(base.promotions[0]?.scope).toEqual({ axis: "rows", index: 1, value: "negra" })
    const draft = copy(base)
    draft.promotions[0]!.percentOff = 15
    expect(patchOf(base, draft, saved)?.promotions).toEqual([
      expect.objectContaining({ percentOff: 15, scope: { optionIndex: 1, optionValue: "negra" } }),
    ])
  })
})

describe("lo que espera para enviarse", () => {
  it("la promoción de un color nuevo espera a que se guarde ese color, no va como de todo", () => {
    const base = draftOf(sheet())
    const draft = copy(base)
    draft.grid!.rows.push({ id: "r-nuevo", value: "roja", hex: null, hex2: null, photoId: null })
    draft.promotions.push({
      name: "Roja",
      percentOff: 20,
      startsOn: "2026-12-01",
      endsOn: "2026-12-10",
      scope: { axis: "rows", index: -1, value: "roja" },
    })
    draft.name = "Zapatilla"
    expect(heldOf(draft, sheet()).promotions).toBeTruthy()
    expect(patchOf(base, draft, sheet())).toEqual({ name: "Zapatilla" })
  })

  it("el color se reconoce por su nombre aunque nadie lo haya marcado; dos opciones sin color no van en cuadrícula", () => {
    const talla = sheet({
      colorOption: null,
      options: [
        { name: "Talla", values: ["35", "36"] },
        { name: "Color", values: ["blanca", "negra"] },
      ],
      variants: [],
    })
    expect(gridOf(talla)?.rowName).toBe("Color")
    expect(gridOf(talla)?.columnName).toBe("Talla")
    const material = sheet({
      colorOption: null,
      options: [
        { name: "Material", values: ["cuero"] },
        { name: "Talla", values: ["35"] },
      ],
      variants: [],
    })
    expect(gridOf(material)).toBeNull()
  })
})

describe("la cuadrícula", () => {
  it("el color son las filas y la talla las columnas, con su stock y su precio", () => {
    const grid = gridOf(sheet())!
    expect(grid.rows.map((r) => r.value)).toEqual(["blanca", "negra"])
    expect(grid.columns.map((c) => c.value)).toEqual(["35", "36"])
    const negra = grid.rows[1]!.id
    const t36 = grid.columns[1]!.id
    expect(grid.cells[cellKey(negra, t36)]).toEqual({ stock: 2, priceCents: 8900, barcode: null })
  })

  it("un color renombrado va con su nombre de antes, para no rehacer sus variantes", () => {
    const base = draftOf(sheet())
    const draft = copy(base)
    draft.grid!.rows[1]!.value = "negro"
    const body = gridBody(base.grid, draft.grid!)
    // Cada celda lleva el stock que vio la pantalla: el servidor suma solo la diferencia.
    expect(body.cells.find((c) => c.row === "negro" && c.column === "36")).toMatchObject({
      stock: 2,
      seenStock: 2,
    })
    expect(body.rows?.values[1]).toEqual(expect.objectContaining({ was: "negra", value: "negro" }))
    expect(body.rows?.values[0]).not.toHaveProperty("was")
    expect(body.cells).toHaveLength(4)
  })

  it("bajar el stock o quitar un color con stock pide motivo; subirlo no", () => {
    const base = draftOf(sheet())
    const up = copy(base)
    const [blanca, negra] = up.grid!.rows
    const [t35] = up.grid!.columns
    up.grid!.cells[cellKey(blanca!.id, t35!.id)]!.stock = 9
    expect(loweredCells(base.grid, up.grid)).toBe(0)
    const down = copy(base)
    down.grid!.cells[cellKey(blanca!.id, t35!.id)]!.stock = 1
    expect(loweredCells(base.grid, down.grid)).toBe(1)
    const gone = copy(base)
    gone.grid!.rows = gone.grid!.rows.filter((r) => r.id !== negra!.id)
    for (const key of Object.keys(gone.grid!.cells))
      if (key.startsWith(`${negra!.id}|`)) delete gone.grid!.cells[key]
    // La negra 36 tenía 2: quitarla pide motivo; la 35 estaba en 0.
    expect(loweredCells(base.grid, gone.grid)).toBe(1)
  })
})

describe("deshacer", () => {
  it("escribir en el mismo campo seguido es un solo paso; otro cambio, otro paso", () => {
    const base = draftOf(sheet())
    let history = record({ undo: [], redo: [] }, base, "Nombre", "nombre", 1000)
    history = record(history, base, "Nombre", "nombre", 1500)
    expect(history.undo).toHaveLength(1)
    history = record(history, base, "Precio", undefined, 1600)
    expect(history.undo).toHaveLength(2)
    history = record(history, base, "Nombre", "nombre", 5000)
    expect(history.undo).toHaveLength(3)
  })
})
