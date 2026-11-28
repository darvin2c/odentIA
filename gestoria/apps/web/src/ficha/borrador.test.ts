import { describe, expect, it } from "vitest"
import { cellKey, type Sheet } from "../lib/ficha"
import { FichaStore, type GridSaved, type SaveApi } from "./borrador"

/** Una zapatilla blanca en 35 y 36, con 3 de cada una. */
function sheet(stock: { "35": number; "36": number }): Sheet {
  return {
    id: "p-1",
    name: "Zapatilla",
    category: null,
    description: "",
    code: null,
    listPriceCents: 12900,
    minPriceCents: null,
    options: [
      { name: "Color", values: ["blanca"] },
      { name: "Talla", values: ["35", "36"] },
    ],
    colorOption: 0,
    colors: [{ id: "c-1", value: "blanca", hex: "#ffffff", hex2: null, photoId: null }],
    variants: (["35", "36"] as const).map((size) => ({
      id: `v${size}`,
      optionValues: ["blanca", size],
      sku: size,
      barcode: null,
      priceCents: null,
      photoId: null,
      stock: stock[size],
    })),
    photos: [],
    quantityPrices: [],
    promotions: [],
    wholesale: null,
    comboPercentOff: null,
    offers: { delivery: false, discount: false, secondUnit: false, gift: null },
    links: [],
    state: "disponible",
    status: null,
    statusDays: null,
    statusPerDay: null,
    statusDate: null,
    rubro: null,
    rubroData: {},
    template: [],
    package: { weightG: null, lengthMm: null, widthMm: null, heightMm: null },
    keywords: [],
    web: { visible: true, slug: null },
    questions: [],
    readiness: { level: "lista", sellsAlone: true, complete: true, done: 1, total: 1, items: [] },
    fromCents: 12900,
    toCents: 12900,
    lastCostCents: null,
    costWarning: null,
    updatedAt: "2026-11-27T00:00:00.000Z",
  }
}

/** Espera a que pase algo de lo que corre por detrás (un envío). */
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(done()).toBe(true)
}

type GridBody = { cells: { column: string | null; stock: number; seenStock?: number }[] }

describe("la cuadrícula y lo que se vende mientras se edita", () => {
  it("lo que se sigue editando mientras se guarda no devuelve una unidad vendida", async () => {
    const sent: GridBody[] = []
    let release: (value: Sheet) => void = () => undefined
    // Lo que tiene el servidor ahora.
    let now = sheet({ "35": 3, "36": 3 })
    const api = {
      patch: async () => sheet({ "35": 3, "36": 3 }),
      grid: (body) => {
        sent.push(body as GridBody)
        // La primera vez queda esperando; las demás responden al momento.
        if (sent.length === 1)
          return new Promise<GridSaved>((resolve) => (release = (product) => resolve({ product })))
        return Promise.resolve({ product: now })
      },
    } satisfies SaveApi
    const store = new FichaStore(sheet({ "35": 3, "36": 3 }), api, () => undefined, false)
    const grid = () => store.getSnapshot().draft.grid!
    const key = (size: string) =>
      cellKey(grid().rows[0]!.id, grid().columns.find((c) => c.value === size)!.id)

    // Sube la 36 de 3 a 4 y se empieza a guardar.
    store.change("Stock 36", (d) => {
      d.grid!.cells[key("36")]!.stock = 4
    })
    const first = store.flush()
    await until(() => sent.length === 1)
    // Mientras se guarda, cambia el precio de la 35 (su stock lo deja como lo vio: 3)…
    store.change("Precio 35", (d) => {
      d.grid!.cells[key("35")]!.priceCents = 11900
    })
    // …y en ese momento se vende una 35: el servidor responde con 2.
    now = sheet({ "35": 2, "36": 4 })
    release(now)
    await first
    await store.flush()

    const second = sent.at(-1)!
    expect(sent.length).toBeGreaterThan(1)
    const cell35 = second.cells.find((c) => c.column === "35")!
    // La 35 no se tocó en la pantalla: no puede volver a 3 (sería devolver lo vendido).
    expect(cell35.stock - (cell35.seenStock ?? cell35.stock)).toBe(0)
    expect(cell35.stock).toBe(2)
    expect(store.getSnapshot().draft.grid!.cells[key("35")]!.stock).toBe(2)
  })

  it("manda el stock que vio con cada celda: el servidor suma solo la diferencia", async () => {
    const sent: GridBody[] = []
    const api = {
      patch: async () => sheet({ "35": 3, "36": 3 }),
      grid: async (body: unknown) => {
        sent.push(body as GridBody)
        return { product: sheet({ "35": 5, "36": 3 }) }
      },
    } satisfies SaveApi
    const store = new FichaStore(sheet({ "35": 3, "36": 3 }), api, () => undefined, false)
    const grid = store.getSnapshot().draft.grid!
    const k35 = cellKey(grid.rows[0]!.id, grid.columns[0]!.id)
    store.change("Stock 35", (d) => {
      d.grid!.cells[k35]!.stock = 5
    })
    await store.flush()
    expect(sent[0]!.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "35", stock: 5, seenStock: 3 }),
        expect.objectContaining({ column: "36", stock: 3, seenStock: 3 }),
      ]),
    )
  })
})
