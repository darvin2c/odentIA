import { FDI_ADULT_ROWS, FDI_CHILD_ROWS } from "./anatomy.js"
import { describe, expect, it } from "vitest"
import { ARCH_ASPECT, type ArchLayout, archLayout, archNeighbor } from "./odontogram-arch.js"

const adult = { upper: FDI_ADULT_ROWS[0]!, lower: FDI_ADULT_ROWS[1]! }
const child = { upper: FDI_CHILD_ROWS[0]!, lower: FDI_CHILD_ROWS[1]! }

/** Lo que ocupa cada pieza girada, para saber si queda dentro del dibujo. */
function extent(t: ArchLayout["teeth"][number]) {
  const r = (t.rotation * Math.PI) / 180
  return {
    x: (Math.abs(Math.cos(r)) * t.w) / 2 + (Math.abs(Math.sin(r)) * t.h) / 2,
    y: (Math.abs(Math.sin(r)) * t.w) / 2 + (Math.abs(Math.cos(r)) * t.h) / 2,
  }
}

/** Distancia libre entre dos piezas que no son vecinas en su fila (discos del ancho de la pieza). */
function minClearance(layout: ArchLayout, rows: readonly (readonly number[])[]) {
  let clear = Number.POSITIVE_INFINITY
  const { teeth } = layout
  for (let i = 0; i < teeth.length; i++) {
    for (let j = i + 1; j < teeth.length; j++) {
      const a = teeth[i]!
      const b = teeth[j]!
      const neighbors = rows.some((row) => Math.abs(row.indexOf(a.tooth) - row.indexOf(b.tooth)) === 1 && row.includes(a.tooth) && row.includes(b.tooth))
      if (neighbors) continue
      clear = Math.min(clear, Math.hypot(a.x - b.x, a.y - b.y) - (a.w + b.w) / 2)
    }
  }
  return clear
}

describe("arco del odontograma en herradura", () => {
  // Anchos medidos en la app: subir una imagen y ficha en el celular, el
  // diagnóstico, el tope de hoy, la ficha a 1280 px y el tope nuevo.
  const cases = [
    ...[228, 254, 278, 334, 360, 455, 520].map((w) => ({ w, name: "permanente", outer: adult, inner: undefined })),
    ...[228, 278, 360, 520].map((w) => ({ w, name: "temporal", outer: child, inner: undefined })),
    ...[254, 278, 360, 455, 520].map((w) => ({ w, name: "mixta", outer: adult, inner: child })),
  ]

  it.each(cases)("$name a $w px: ninguna pieza se pisa y todo queda dentro", ({ w, outer, inner }) => {
    const layout = archLayout(w, outer, inner)
    const rows = [outer.upper, outer.lower, ...(inner ? [inner.upper, inner.lower] : [])]
    expect(layout.teeth).toHaveLength(rows.flat().length)
    for (const row of rows) {
      const placed = row.map((n) => layout.teeth.find((t) => t.tooth === n)!)
      for (let i = 1; i < placed.length; i++) {
        const a = placed[i - 1]!
        const b = placed[i]!
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.tooth} y ${b.tooth}`).toBeGreaterThanOrEqual((a.w + b.w) / 2)
      }
    }
    expect(minClearance(layout, rows)).toBeGreaterThan(1)
    for (const t of layout.teeth) {
      const e = extent(t)
      expect(t.x - e.x).toBeGreaterThanOrEqual(-0.5)
      expect(t.x + e.x).toBeLessThanOrEqual(w + 0.5)
      expect(t.y - e.y).toBeGreaterThanOrEqual(-0.5)
      expect(t.y + e.y).toBeLessThanOrEqual(layout.height + 0.5)
    }
  })

  it("es más ancho que alto y, al mismo ancho, las piezas son más grandes que las del óvalo (29 px a 360)", () => {
    const layout = archLayout(360, adult)
    expect(layout.height).toBeCloseTo(360 * ARCH_ASPECT)
    expect(layout.teeth[0]!.w).toBeGreaterThan(29)
  })

  it("la cara vestibular mira hacia afuera: arriba los incisivos giran media vuelta, abajo no", () => {
    const layout = archLayout(360, adult)
    const turn = (n: number) => ((layout.teeth.find((t) => t.tooth === n)!.rotation % 360) + 360) % 360
    expect(Math.abs(turn(11) - 180)).toBeLessThan(15)
    expect(Math.min(turn(41), 360 - turn(41))).toBeLessThan(15)
  })

  it("los números van por dentro, salvo los de las permanentes en dentición mixta", () => {
    const center = { x: 180, y: 162 }
    const distance = (x: number, y: number) => Math.hypot(x - center.x, y - center.y)
    const own = archLayout(360, adult).teeth.find((t) => t.tooth === 11)!
    expect(distance(own.labelX, own.labelY)).toBeLessThan(distance(own.x, own.y))
    const mixed = archLayout(360, adult, child).teeth
    const permanent = mixed.find((t) => t.tooth === 11)!
    const temporary = mixed.find((t) => t.tooth === 51)!
    expect(distance(permanent.labelX, permanent.labelY)).toBeGreaterThan(distance(permanent.x, permanent.y))
    expect(distance(temporary.labelX, temporary.labelY)).toBeLessThan(distance(temporary.x, temporary.y))
  })
})

describe("recorrido del arco con el teclado", () => {
  const rows = [adult.upper, child.upper, child.lower, adult.lower]

  it("← → siguen la fila como se ve y se detienen en los extremos", () => {
    expect(archNeighbor(rows, 16, "ArrowRight")).toBe(15)
    expect(archNeighbor(rows, 16, "ArrowLeft")).toBe(17)
    expect(archNeighbor(rows, 18, "ArrowLeft")).toBe(18)
    expect(archNeighbor(rows, 46, "ArrowRight")).toBe(45)
  })

  it("Inicio y Fin van a las puntas de la fila", () => {
    expect(archNeighbor(rows, 11, "Home")).toBe(18)
    expect(archNeighbor(rows, 31, "End")).toBe(38)
  })

  it("↑ ↓ pasan a la fila de al lado, a la misma posición", () => {
    const adultOnly = [adult.upper, adult.lower]
    expect(archNeighbor(adultOnly, 16, "ArrowDown")).toBe(46)
    expect(archNeighbor(adultOnly, 46, "ArrowUp")).toBe(16)
    expect(archNeighbor(adultOnly, 16, "ArrowUp")).toBeNull()
    expect(archNeighbor(rows, 11, "ArrowDown")).toBe(51)
    expect(archNeighbor(rows, 51, "ArrowDown")).toBe(81)
  })

  it("otras teclas no mueven el foco", () => {
    expect(archNeighbor(rows, 16, "Tab")).toBeNull()
  })
})
