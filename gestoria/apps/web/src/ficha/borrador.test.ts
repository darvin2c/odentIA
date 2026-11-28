import { describe, expect, it, vi } from "vitest"
import { ApiError } from "../lib/api"
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
      load: async () => now,
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
      load: async () => sheet({ "35": 5, "36": 3 }),
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

/**
 * Un servidor de mentira que guarda como el de verdad: suma a su stock lo que cambió cada celda
 * frente a lo que vio la pantalla (`seenStock`) y devuelve la ficha.
 */
function server(start: { "35": number; "36": number }) {
  const stock = { ...start }
  const bodies: (GridBody & { reason?: string })[] = []
  const patches: Record<string, unknown>[] = []
  const api = {
    patch: async (body: Record<string, unknown>) => {
      patches.push(body)
      return { ...sheet(stock), ...body } as Sheet
    },
    grid: async (body: unknown) => {
      const b = body as GridBody & { reason?: string }
      bodies.push(b)
      for (const cell of b.cells) {
        const size = cell.column as "35" | "36"
        stock[size] = Math.max(0, stock[size] + cell.stock - (cell.seenStock ?? stock[size]))
      }
      return { product: sheet(stock) }
    },
    load: async () => sheet(stock),
  } satisfies SaveApi
  return { api, stock, bodies, patches, sell: (size: "35" | "36") => stock[size]-- }
}

function storeOn(
  s: ReturnType<typeof server>,
  options?: ConstructorParameters<typeof FichaStore>[4],
) {
  const store = new FichaStore(sheet({ ...s.stock }), s.api, () => undefined, false, options)
  const grid = () => store.getSnapshot().draft.grid!
  const key = (size: string) =>
    cellKey(grid().rows[0]!.id, grid().columns.find((c) => c.value === size)!.id)
  const set = (size: string, n: number) =>
    store.change(`Stock: ${size} blanca`, (d) => {
      d.grid!.cells[key(size)]!.stock = n
    })
  const shown = (size: string) => grid().cells[key(size)]!.stock
  /** Guarda lo que falte y espera a que termine (también lo que ya se estaba guardando). */
  const settled = async () => {
    await store.flush()
    await until(() => ["saved", "reason"].includes(store.getSnapshot().status.kind))
  }
  return { store, set, shown, settled }
}

describe("deshacer después de guardar la cuadrícula", () => {
  it("deshacer una baja ya guardada devuelve el stock que había", async () => {
    const s = server({ "35": 3, "36": 3 })
    const { store, set, shown, settled } = storeOn(s)
    set("36", 1)
    store.setReason("Conté y corregí")
    await settled()
    expect(s.stock["36"]).toBe(1)

    store.undo()
    expect(shown("36")).toBe(3)
    await settled()
    // Subir es una entrada: vuelve a 3 en el servidor, sin pedir motivo.
    expect(s.stock["36"]).toBe(3)
    expect(store.getSnapshot().status.kind).toBe("saved")
  })

  it("rehacer después de deshacer vuelve a bajar, y bajar pide el motivo", async () => {
    const s = server({ "35": 3, "36": 3 })
    const { store, set, shown, settled } = storeOn(s)
    set("36", 1)
    store.setReason("Conté y corregí")
    await settled()
    store.undo()
    await settled()
    store.redo()
    expect(shown("36")).toBe(1)
    await settled()
    expect(store.getSnapshot().status.kind).toBe("reason")
    expect(s.stock["36"]).toBe(3)
  })

  it("con varios cambios guardados, deshacer todo deja el stock como estaba y no inventa pares", async () => {
    const s = server({ "35": 3, "36": 3 })
    const { store, set, shown, settled } = storeOn(s)
    // Como pegar: dos celdas suben; luego se corrige una hacia abajo y se guarda con motivo.
    set("35", 9)
    set("36", 8)
    await settled()
    set("36", 2)
    store.setReason("Conté y corregí")
    await settled()
    expect(s.stock).toEqual({ "35": 9, "36": 2 })

    store.undo()
    expect([shown("35"), shown("36")]).toEqual([9, 8])
    store.undo()
    store.undo()
    expect([shown("35"), shown("36")]).toEqual([3, 3])
  })

  it("deshacer no revive lo que se vendió después de guardar", async () => {
    const s = server({ "35": 3, "36": 3 })
    const { store, set, shown, settled } = storeOn(s)
    set("36", 1)
    store.setReason("Conté y corregí")
    await settled()
    // Se vende una 35 y la ficha se pone al día.
    s.sell("35")
    store.receive(sheet({ ...s.stock }))
    store.undo()
    expect([shown("35"), shown("36")]).toEqual([2, 3])
  })
})

describe("lo que se escribe en un campo", () => {
  it("no guarda lo de a medias: espera a que se salga del campo", async () => {
    vi.useFakeTimers()
    try {
      const s = server({ "35": 3, "36": 3 })
      let typing = true
      const { store } = storeOn(s, { typing: () => typing })
      // Ctrl+Z del navegador deja «1» un momento y luego «149».
      store.change("Cambiaste el precio", (d) => (d.listPriceCents = 100), { group: "precio" })
      await vi.advanceTimersByTimeAsync(3000)
      expect(s.patches).toEqual([])
      store.change("Cambiaste el precio", (d) => (d.listPriceCents = 14900), { group: "precio" })
      typing = false
      store.release()
      await vi.advanceTimersByTimeAsync(3000)
      expect(s.patches).toEqual([expect.objectContaining({ listPriceCents: 14900 })])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("la misma ficha en dos pestañas", () => {
  /** Un servidor con versión: lo que llega con una versión vieja responde 409, como el de verdad. */
  function versioned() {
    let current = { ...sheet({ "35": 3, "36": 3 }), updatedAt: "2026-11-27T00:00:00.000Z" }
    let n = 0
    const bump = (change: Partial<Sheet>) => {
      n++
      current = { ...current, ...change, updatedAt: `2026-11-27T00:00:0${n}.000Z` }
    }
    const api = {
      patch: async (body: Record<string, unknown>) => {
        const { version, ...change } = body
        if (version !== undefined && version !== current.updatedAt)
          throw new ApiError(409, "STALE", "Alguien cambió esta ficha mientras la tenías abierta.")
        bump(change as Partial<Sheet>)
        return current
      },
      grid: async () => ({ product: current }),
      load: async () => current,
    } satisfies SaveApi
    return { api, bump, now: () => current }
  }

  it("lo que cambió la otra pestaña en otro campo se toma, y lo mío se guarda encima", async () => {
    const s = versioned()
    const store = new FichaStore(s.now(), s.api, () => undefined, false)
    // La otra pestaña cambia el nombre.
    s.bump({ name: "Zapatilla de la otra pestaña" })
    store.change("Cambiaste el precio", (d) => (d.listPriceCents = 13900))
    await store.flush()
    await until(() => store.getSnapshot().status.kind === "saved")
    expect(s.now()).toMatchObject({ name: "Zapatilla de la otra pestaña", listPriceCents: 13900 })
    expect(store.getSnapshot().draft.name).toBe("Zapatilla de la otra pestaña")
    expect(store.getSnapshot().news).toMatch(/Alguien cambió esta ficha/)
  })

  it("si las dos cambiaron lo mismo, avisa y no pisa: lo escrito se queda", async () => {
    const s = versioned()
    const store = new FichaStore(s.now(), s.api, () => undefined, false)
    s.bump({ listPriceCents: 15900 })
    store.change("Cambiaste el precio", (d) => (d.listPriceCents = 13900))
    await store.flush()
    await until(() => store.getSnapshot().status.kind === "conflict")
    const status = store.getSnapshot().status
    expect(status.kind === "conflict" && status.message).toMatch(
      /Alguien cambió esta ficha.*precio/,
    )
    expect(s.now().listPriceCents).toBe(15900)
    expect(store.getSnapshot().draft.listPriceCents).toBe(13900)
    // La persona decide: guarda lo suyo.
    store.keepMine()
    await until(() => store.getSnapshot().status.kind === "saved")
    expect(s.now().listPriceCents).toBe(13900)
  })

  it("o toma lo de la otra pestaña", async () => {
    const s = versioned()
    const store = new FichaStore(s.now(), s.api, () => undefined, false)
    s.bump({ listPriceCents: 15900 })
    store.change("Cambiaste el precio", (d) => (d.listPriceCents = 13900))
    await store.flush()
    await until(() => store.getSnapshot().status.kind === "conflict")
    store.takeTheirs()
    await until(() => store.getSnapshot().status.kind === "saved")
    expect(store.getSnapshot().draft.listPriceCents).toBe(15900)
    expect(s.now().listPriceCents).toBe(15900)
  })
})
