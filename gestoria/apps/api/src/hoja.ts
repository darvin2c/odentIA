import {
  type Db,
  type ProductOption,
  product,
  productVariant,
  stockMovement,
  store,
  storeEvent,
} from "@gestoria/db"
import { and, eq, isNull } from "drizzle-orm"
import { MAX_PRODUCTS, makeSku, productInput } from "./catalogo.js"
import type { Person } from "./cuenta.js"
import { parseMoney } from "./dinero.js"
import { SheetReadError, sheetSource, toExampleColumns } from "./leer-hoja.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * «Subir una hoja» (decisión 10 del lienzo B): el catálogo de una vez, una fila por variante con
 * su producto, sus opciones, su precio y su stock. Llega como CSV (lo guardan Excel, Google
 * Sheets y LibreOffice), se lee en el servidor y primero se muestra qué se va a crear y qué
 * errores hay; nada se guarda hasta confirmar, y con un error no se guarda nada. Solo crea
 * productos nuevos: lo que ya está en el catálogo se cambia en su página. Las fotos se agregan
 * después en cada producto. El stock de cada fila entra al kardex como una entrada.
 */

/** El tope de un importe, el mismo que piden los formularios. */
const MAX_AMOUNT = 100_000_000

/** Lo más que se lee de una vez. */
export const MAX_SHEET_BYTES = 1_000_000
export const MAX_SHEET_ROWS = 2000

/** Las columnas, como las dice la hoja de ejemplo. Se reconocen sin mirar tildes ni mayúsculas. */
const COLUMNS = {
  producto: "Producto",
  categoria: "Categoría",
  opcion1: "Opción 1",
  valor1: "Valor 1",
  opcion2: "Opción 2",
  valor2: "Valor 2",
  opcion3: "Opción 3",
  valor3: "Valor 3",
  codigo: "Código",
  precio: "Precio",
  stock: "Stock",
  costo: "Costo",
  descripcion: "Lo que Sofi puede contar",
} as const
type Column = keyof typeof COLUMNS
const REQUIRED: Column[] = ["producto", "precio", "stock"]

const EXAMPLE_ROWS: string[][] = [
  [
    "Zapatilla urbana",
    "Zapatillas",
    "Color",
    "blanca",
    "Talla",
    "38",
    "",
    "",
    "",
    "129",
    "3",
    "68",
    "Cuero sintético, planta de goma.",
  ],
  [
    "Zapatilla urbana",
    "Zapatillas",
    "Color",
    "blanca",
    "Talla",
    "39",
    "",
    "",
    "",
    "129",
    "2",
    "68",
    "",
  ],
  [
    "Zapatilla urbana",
    "Zapatillas",
    "Color",
    "negra",
    "Talla",
    "38",
    "",
    "",
    "",
    "89",
    "4",
    "55",
    "",
  ],
  [
    "Sandalia",
    "Sandalias",
    "Talla",
    "36",
    "",
    "",
    "",
    "",
    "SAN-36",
    "89",
    "5",
    "",
    "Taco bajo, correa ajustable.",
  ],
  ["Correa de cuero", "Accesorios", "", "", "", "", "", "", "", "45,50", "10", "", ""],
]

/** La hoja de ejemplo, con punto y coma (Excel en español lo abre en columnas) y BOM para las tildes. */
export function exampleSheet(): string {
  const line = (cells: string[]) => cells.map(quote).join(";")
  return `﻿${[Object.values(COLUMNS), ...EXAMPLE_ROWS].map(line).join("\r\n")}\r\n`
}

function quote(cell: string): string {
  return /[";,\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()

/** Lee un CSV: comillas dobles, saltos de línea dentro de comillas y el separador de la cabecera. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "")
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ""
  const separator = [";", ",", "\t"]
    .map((sep) => ({ sep, n: firstLine.split(sep).length }))
    .sort((a, b) => b.n - a.n)[0]!.sep
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === "") quoted = true
    else if (ch === separator) {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

export interface SheetError {
  /** La fila de la hoja (la cabecera es la 1); 0 si es de toda la hoja. */
  row: number
  message: string
}

interface PlannedVariant {
  row: number
  values: string[]
  sku: string | null
  priceCents: number
  stock: number
  costCents: number | null
}

export interface PlannedProduct {
  /** Los archivos de sus fotos, si la hoja trae la columna «Foto» (en «Cargar muchos»). */
  photoFiles: string[]
  name: string
  category: string | null
  description: string
  options: ProductOption[]
  listPriceCents: number
  variants: PlannedVariant[]
}

export interface SheetPlan {
  products: PlannedProduct[]
  errors: SheetError[]
}

const sameText = (a: string, b: string) => fold(a) === fold(b)

/**
 * Lo que haría la hoja, sin guardar nada: los productos con sus variantes y cada error con su
 * fila. `existing` son los nombres que ya están en el catálogo y `skus` los códigos en uso.
 */
export function planSheet(
  source: string | string[][],
  currency: string,
  existing: Set<string>,
  skus: Set<string>,
  extraColumns: readonly string[] = [],
): SheetPlan {
  const errors: SheetError[] = []
  // Excel guarda «CSV (delimitado por comas)» sin UTF-8: las tildes llegan rotas.
  if (typeof source === "string" && source.includes("\uFFFD"))
    return {
      products: [],
      errors: [
        {
          row: 0,
          message:
            "La hoja no está en UTF-8 y se perderían las tildes. En Excel: Archivo › Guardar como › CSV UTF-8.",
        },
      ],
    }
  // Las tallas en columnas y «Talla» o «Color» sueltas pasan a las columnas de la hoja de ejemplo.
  const read = toExampleColumns(typeof source === "string" ? parseCsv(source) : source, [
    ...Object.values(COLUMNS),
    ...extraColumns,
  ])
  const rows = read.rows
  if (rows.length < 2)
    return {
      products: [],
      errors: [{ row: 0, message: "La hoja está vacía: deja la cabecera y una fila por variante" }],
    }
  if (rows.length - 1 > MAX_SHEET_ROWS)
    return {
      products: [],
      errors: [{ row: 0, message: `Hasta ${MAX_SHEET_ROWS} filas por hoja: divídela en partes` }],
    }
  const header = rows[0]!.map(fold)
  const index = {} as Record<Column, number>
  for (const [key, title] of Object.entries(COLUMNS) as [Column, string][])
    index[key] = header.indexOf(fold(title))
  const missing = REQUIRED.filter((key) => index[key] < 0)
  if (missing.length > 0)
    return {
      products: [],
      errors: [
        {
          row: 1,
          message: `Faltan las columnas ${missing.map((k) => `«${COLUMNS[k]}»`).join(", ")}. Usa la hoja de ejemplo.`,
        },
      ],
    }
  const cell = (r: string[], key: Column) => (index[key] >= 0 ? (r[index[key]] ?? "").trim() : "")

  // Los nombres del catálogo, una vez: compararlos fila por fila tardaba segundos con 2000.
  const taken = new Set([...existing].map(fold))
  const byName = new Map<string, PlannedProduct>()
  // Las combinaciones ya leídas de cada producto, para ver una repetida sin recorrerlas.
  const seen = new Map<string, Set<string>>()
  const sheetSkus = new Set<string>()
  // Cada fila, con su número en la hoja (la cabecera es la 1).
  const readRow = (r: string[], row: number): boolean => {
    const fail = (message: string): boolean => {
      errors.push({ row, message })
      return false
    }
    const name = cell(r, "producto")
    if (!name) return fail("Falta el nombre del producto")
    if (name.length > 120) return fail("El nombre del producto tiene más de 120 caracteres")
    if (taken.has(fold(name)))
      return fail(`«${name}» ya está en tu catálogo: cámbialo en su página`)
    const options: ProductOption[] = []
    const values: string[] = []
    for (const n of [1, 2, 3] as const) {
      const option = cell(r, `opcion${n}`)
      const value = cell(r, `valor${n}`)
      if (!option && !value) continue
      if (!option || !value) return fail(`La opción ${n} necesita su nombre y su valor`)
      if (value.includes(",")) return fail("Un valor de opción no lleva comas")
      if (option.length > 30 || value.length > 30)
        return fail("Una opción o un valor tiene más de 30 caracteres")
      options.push({ name: option, values: [value] })
      values.push(value)
    }
    const priceCents = parseMoney(cell(r, "precio"), currency)
    if (!priceCents || priceCents > MAX_AMOUNT)
      return fail("Escribe el precio con números, como 129 o 129.90")
    const stockText = cell(r, "stock")
    if (!/^\d{1,6}$/.test(stockText)) return fail("Escribe el stock como un número entero, 0 o más")
    const costText = cell(r, "costo")
    const costCents = costText ? parseMoney(costText, currency) : null
    if (costText && (costCents === null || costCents > MAX_AMOUNT))
      return fail("Escribe el costo con números, como 68 o 68.50")
    const sku = cell(r, "codigo") || null
    if (sku) {
      if (!/^[A-Za-z0-9._/-]{1,40}$/.test(sku))
        return fail("El código lleva hasta 40 letras, números, puntos o guiones, sin espacios")
      if (skus.has(sku.toLowerCase()) || sheetSkus.has(sku.toLowerCase()))
        return fail(`El código «${sku}» ya se usa`)
      sheetSkus.add(sku.toLowerCase())
    }
    const key = fold(name)
    let planned = byName.get(key)
    if (!planned) {
      planned = {
        photoFiles: [],
        name,
        category: cell(r, "categoria").slice(0, 60) || null,
        description: cell(r, "descripcion").slice(0, 2000),
        options: options.map((o) => ({ name: o.name, values: [] })),
        listPriceCents: priceCents,
        variants: [],
      }
      byName.set(key, planned)
    }
    if (
      planned.options.length !== options.length ||
      planned.options.some((o, n) => !sameText(o.name, options[n]!.name))
    )
      return fail(
        `Las opciones no son las mismas que en las otras filas de «${planned.name}» (${planned.options.map((o) => o.name).join(", ") || "sin opciones"})`,
      )
    const combos = seen.get(key) ?? new Set<string>()
    seen.set(key, combos)
    const combo = JSON.stringify(values.map(fold))
    if (combos.has(combo)) return fail(`Esa combinación de «${planned.name}» ya está en otra fila`)
    if (planned.options.length === 0 && planned.variants.length > 0)
      return fail(`«${planned.name}» no tiene opciones: va en una sola fila`)
    if (planned.variants.length >= 200) return fail(`«${planned.name}» tiene más de 200 variantes`)
    planned.options.forEach((o, n) => {
      if (!o.values.some((v) => sameText(v, values[n]!))) o.values.push(values[n]!)
    })
    if (!planned.description) planned.description = cell(r, "descripcion").slice(0, 2000)
    combos.add(combo)
    const fotoAt = header.indexOf("foto")
    if (fotoAt >= 0)
      for (const file of (r[fotoAt] ?? "")
        .split(/[,;]/)
        .map((f) => f.trim())
        .filter(Boolean))
        if (!planned.photoFiles.includes(file) && planned.photoFiles.length < 20)
          planned.photoFiles.push(file.slice(0, 200))
    planned.variants.push({ row, values, sku, priceCents, stock: Number(stockText), costCents })
    return true
  }
  for (const [i, r] of rows.slice(1).entries()) readRow(r, read.sourceRows[i + 1] ?? i + 2)
  // Cada producto cumple las mismas reglas que al crearlo a mano; el error va en su primera fila.
  for (const planned of byName.values()) {
    const checked = productInput.safeParse({
      name: planned.name,
      category: planned.category,
      description: planned.description,
      listPriceCents: planned.listPriceCents,
      options: planned.options,
    })
    if (!checked.success)
      errors.push({
        row: planned.variants[0]?.row ?? 0,
        message: `«${planned.name}»: ${checked.error.issues[0]?.message ?? "revisa sus datos"}`,
      })
  }
  errors.sort((a, b) => a.row - b.row)
  if (existing.size + byName.size > MAX_PRODUCTS)
    errors.push({ row: 0, message: `Tu catálogo pasaría de ${MAX_PRODUCTS} productos` })
  return { products: [...byName.values()], errors }
}

/** Lo que se muestra antes de confirmar: cada producto con sus números, y los errores. */
function summary(plan: SheetPlan) {
  return {
    products: plan.products.map((p) => ({
      name: p.name,
      category: p.category,
      options: p.options,
      variants: p.variants.length,
      stock: p.variants.reduce((sum, v) => sum + v.stock, 0),
      fromCents: Math.min(...p.variants.map((v) => v.priceCents)),
      toCents: Math.max(...p.variants.map((v) => v.priceCents)),
    })),
    errors: plan.errors,
  }
}

/** Lo que la hoja necesita de la tienda: su moneda, los nombres y los códigos que ya usa. */
export async function sheetContext(tx: Db, storeId: string) {
  const [{ currency }] = (await tx
    .select({ currency: store.currency })
    .from(store)
    .where(eq(store.id, storeId))) as [{ currency: string }]
  const names = await tx
    .select({ name: product.name })
    .from(product)
    .where(eq(product.storeId, storeId))
  const skus = new Set(
    (
      await tx
        .select({ sku: productVariant.sku })
        .from(productVariant)
        .where(and(eq(productVariant.storeId, storeId), isNull(productVariant.removedAt)))
    ).map((v) => v.sku.toLowerCase()),
  )
  return { currency, names: new Set(names.map((n) => n.name)), skus }
}

/**
 * Guarda productos ya revisados, en la transacción de quien llama: cada producto, cada variante
 * con su código (si no trae, se arma uno) y su entrada de stock en el kardex (con `reason`). Lo
 * usan «Subir una hoja» y «Cargar muchos». Devuelve el id de cada producto por su nombre.
 */
export async function createPlanned(
  tx: Db,
  storeId: string,
  person: Person,
  products: PlannedProduct[],
  skus: Set<string>,
  reason: string,
): Promise<Map<string, string>> {
  // Los códigos que traen quedan tomados antes de armar los que faltan.
  for (const p of products) for (const v of p.variants) if (v.sku) skus.add(v.sku.toLowerCase())
  // De a tantas filas por consulta: tres consultas por bloque, no tres por fila.
  const created = await tx
    .insert(product)
    .values(
      products.map((p) => ({
        storeId,
        name: p.name,
        category: p.category,
        description: p.description,
        listPriceCents: p.listPriceCents,
        options: p.options,
      })),
    )
    .returning({ id: product.id, name: product.name })
  const idOf = new Map(created.map((row) => [fold(row.name), row.id]))
  const rows = products.flatMap((p) =>
    p.variants.map((v) => ({
      planned: v,
      values: {
        storeId,
        productId: idOf.get(fold(p.name))!,
        optionValues: v.values,
        sku: v.sku ?? makeSku(p.name, v.values, skus),
        priceCents: v.priceCents === p.listPriceCents ? null : v.priceCents,
      },
    })),
  )
  for (let at = 0; at < rows.length; at += 500) {
    const chunk = rows.slice(at, at + 500)
    const variants = await tx
      .insert(productVariant)
      .values(chunk.map((row) => row.values))
      .returning({ id: productVariant.id, sku: productVariant.sku })
    const variantOf = new Map(variants.map((v) => [v.sku.toLowerCase(), v.id]))
    const entries = chunk
      .filter((row) => row.planned.stock > 0)
      .map((row) => ({
        storeId,
        variantId: variantOf.get(row.values.sku.toLowerCase())!,
        kind: "entrada" as const,
        quantity: row.planned.stock,
        unitCostCents: row.planned.costCents,
        reason,
        actorUserId: person.userId,
      }))
    // El disparador pone el saldo fila por fila, en este orden.
    if (entries.length > 0) await tx.insert(stockMovement).values(entries)
  }
  return idOf
}

/** La hoja tal como llegó (CSV o Excel), lista para `planSheet`; o el error de leerla. */
export function readSheetBytes(bytes: Uint8Array): string | string[][] | SheetError {
  try {
    const source = sheetSource(bytes)
    return "text" in source ? source.text : source.rows
  } catch (error) {
    if (error instanceof SheetReadError) return { row: 0, message: error.message }
    throw error
  }
}

export const sheetNameKey = fold

/**
 * Revisa la hoja (CSV o Excel, con las tallas en filas o en columnas) y, con `confirm` y sin
 * errores, la guarda entera en una transacción.
 */
export async function uploadSheet(
  appDb: Db,
  person: Person,
  storeId: string,
  bytes: Uint8Array,
  confirm: boolean,
) {
  const source = readSheetBytes(bytes)
  if (typeof source === "object" && !Array.isArray(source))
    return { products: [], errors: [source], saved: false }
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const { currency, names, skus } = await sheetContext(tx, storeId)
    const plan = planSheet(source, currency, names, skus)
    const result = summary(plan)
    if (!confirm || plan.errors.length > 0 || plan.products.length === 0)
      return { ...result, saved: false }
    await createPlanned(tx, storeId, person, plan.products, skus, "Hoja subida")
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "catalogo.hoja",
      detail: {
        productos: plan.products.length,
        variantes: plan.products.reduce((n, p) => n + p.variants.length, 0),
      },
    })
    return { ...result, saved: true }
  })
}
