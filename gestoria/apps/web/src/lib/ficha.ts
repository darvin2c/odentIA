import type { ProductOption, Promotion, QuantityPrice, Relation } from "./tienda"

/**
 * La ficha del producto (lienzo «La ficha del producto», prototipo aprobado): lo que la pantalla
 * sabe de la ficha que devuelve el servidor y el borrador que se guarda solo. Aquí no se decide
 * nada de precio, stock ni estados: eso es del servidor (`apps/api/src/catalogo.ts`, `ficha.ts`,
 * `precio.ts`). Aquí solo se arma lo que se envía y se compara lo escrito con lo guardado.
 */

export type ProductRubro = "calzado" | "ropa" | "cosmetica" | "tecnologia" | "hogar"
export type ProductStatus = "encargo" | "cupo" | "preventa" | "liquidacion" | "no_se_vende"
export type SaleState = "disponible" | "agotado" | ProductStatus
export type TemplateFieldType = "opcion" | "numero" | "texto" | "por_talla" | "tabla" | "fecha"
export type RubroValue =
  | string
  | number
  | Record<string, number>
  | Record<string, (number | null)[]>
  | { noAplica: true }

export interface TemplateField {
  key: string
  label: string
  type: TemplateFieldType
  options?: string[]
  columns?: string[]
  unit?: string
  needed: boolean
  ask?: string
  keys?: string[]
}

export interface RubroTemplate {
  id: ProductRubro
  label: string
  rowLabel: string
  columnLabel: string | null
  unit: string
  unitOne: string
  adjusted: boolean
  fields: TemplateField[]
}

export interface ReadinessItem {
  id: string
  label: string
  ok: boolean
  needed: boolean
}

export interface Readiness {
  level: "basica" | "falta_poco" | "lista"
  sellsAlone: boolean
  complete: boolean
  done: number
  total: number
  items: ReadinessItem[]
}

export interface SheetQuestion {
  id: string
  question: string
  conversationId: string | null
  askedBy: string | null
  askedAt: string
  answer: string | null
  answeredBy: string | null
  answeredAt: string | null
  saveRequested: boolean
  savedBy: string | null
  savedAt: string | null
  /** La hizo en «Probar a Sofi»: queda en la ficha, pero no va a «Te toca». */
  test?: boolean
}

export interface SheetVariant {
  id: string
  optionValues: string[]
  sku: string
  barcode: string | null
  priceCents: number | null
  photoId: string | null
  stock: number
}

export interface SheetColor {
  id: string | null
  value: string
  hex: string | null
  hex2: string | null
  photoId: string | null
}

export interface ScopedPromotion extends Promotion {
  scope: { optionIndex: number; optionValue: string } | null
}

export interface Offers {
  delivery: boolean
  discount: boolean
  secondUnit: boolean
  gift: string | null
}

export interface PackageSize {
  weightG: number | null
  lengthMm: number | null
  widthMm: number | null
  heightMm: number | null
}

/** La ficha entera, como la devuelve el servidor (`detailIn` de `apps/api/src/catalogo.ts`). */
export interface Sheet {
  id: string
  name: string
  category: string | null
  description: string
  code: string | null
  listPriceCents: number
  minPriceCents: number | null
  options: ProductOption[]
  colorOption: number | null
  colors: SheetColor[]
  variants: SheetVariant[]
  photos: { id: string; position: number; colorId: string | null }[]
  quantityPrices: QuantityPrice[]
  promotions: ScopedPromotion[]
  wholesale: QuantityPrice | null
  comboPercentOff: number | null
  offers: Offers
  links: { productId: string; kind: Relation; name: string }[]
  state: SaleState
  status: ProductStatus | null
  statusDays: number | null
  statusPerDay: number | null
  statusDate: string | null
  rubro: ProductRubro | null
  rubroData: Record<string, RubroValue>
  template: TemplateField[]
  package: PackageSize
  keywords: string[]
  web: { visible: boolean; slug: string | null }
  questions: SheetQuestion[]
  readiness: Readiness
  fromCents: number
  toCents: number
  lastCostCents: number | null
  costWarning: unknown
  updatedAt: string
}

export interface HistoryEvent {
  id: string
  action: string
  actorName: string | null
  changes: { field: string; from: unknown; to: unknown }[]
  reason: string | null
  createdAt: string
}

/** Lo que pone la tienda del estado: nulo es «según el stock» (disponible o agotado). */
export type StatusDraft =
  | null
  | { kind: "encargo"; days: number }
  | { kind: "cupo"; perDay: number }
  | { kind: "preventa"; date: string }
  | { kind: "liquidacion" }
  | { kind: "no_se_vende" }

/* --------------------------------------------------------------------- la cuadrícula */

/** Un color (o tono): una fila de la cuadrícula. `id` es de la pantalla, no cambia al renombrarlo. */
export interface GridRow {
  id: string
  value: string
  hex: string | null
  hex2: string | null
  photoId: string | null
}

/** Una talla (o tamaño, o modelo): una columna de la cuadrícula. */
export interface GridColumn {
  id: string
  value: string
}

export interface GridCell {
  stock: number
  priceCents: number | null
  barcode: string | null
}

/**
 * «Tallas y stock» como en el prototipo: los colores y las tallas, y una celda por combinación.
 * `rowName` o `columnName` nulos: el producto no tiene ese eje (una sola fila o columna).
 */
export interface Grid {
  rowName: string | null
  rows: GridRow[]
  columnName: string | null
  columns: GridColumn[]
  /** Por `${row.id}|${column.id}`; sin eje, su id es «_». */
  cells: Record<string, GridCell>
}

export const NO_AXIS = "_"
export const cellKey = (row: string, column: string) => `${row}|${column}`

/** El borrador de la ficha: lo que la persona ve y cambia, antes de guardarse. */
export interface Draft {
  name: string
  category: string | null
  description: string
  code: string | null
  listPriceCents: number
  minPriceCents: number | null
  status: StatusDraft
  rubro: ProductRubro | null
  rubroData: Record<string, RubroValue | null>
  package: PackageSize
  keywords: string[]
  web: { visible: boolean; slug: string | null }
  wholesale: QuantityPrice | null
  comboPercentOff: number | null
  offers: Offers
  quantityPrices: QuantityPrice[]
  /** El alcance de una promoción va por el eje y su valor: no cambia si se reordenan las opciones. */
  promotions: DraftPromotion[]
  links: { productId: string; kind: Relation }[]
  /** Nula si el producto tiene tres opciones: la cuadrícula tiene solo colores y tallas. */
  grid: Grid | null
}

export interface DraftPromotion extends Promotion {
  /**
   * De un color o una talla: su eje y su valor (sigue al eje si se reordenan las opciones). Sin
   * eje (un producto de tres opciones), el índice de su opción tal cual vino.
   */
  scope: { axis: "rows" | "columns" | null; index: number; value: string } | null
}

/** Los ids de las filas y columnas: el nombre que tenían al cargarse, para seguirlas al renombrar. */
/** Un id que no se repite, tampoco con los de un borrador recuperado de otra visita. */
export const newId = (prefix: string) => `${prefix}${crypto.randomUUID().slice(0, 8)}`

/** Una celda vacía: sin stock, con el precio del producto y sin código de barras. */
export const emptyCell = (): GridCell => ({ stock: 0, priceCents: null, barcode: null })

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** La opción del color: la de `colorOption` o, si no la marcó nadie, la que se llama así. */
export function colorIndexOf(sheet: Pick<Sheet, "options" | "colorOption">): number | null {
  if (sheet.colorOption !== null && sheet.options[sheet.colorOption]) return sheet.colorOption
  const i = sheet.options.findIndex((o) =>
    ["color", "colores", "tono", "tonos"].includes(o.name.trim().toLocaleLowerCase("es")),
  )
  return i >= 0 ? i : null
}

/** Las opciones del producto como cuadrícula: el color son las filas; la otra, las columnas. */
export function axesOf(sheet: Pick<Sheet, "options" | "colorOption">): {
  rows: number | null
  columns: number | null
} {
  const { options } = sheet
  if (options.length > 2) return { rows: null, columns: null }
  const color = colorIndexOf(sheet)
  if (color !== null)
    return { rows: color, columns: options.length === 2 ? (color === 0 ? 1 : 0) : null }
  // Sin color, una sola opción va en columnas (como las tallas). Dos opciones sin color no
  // caben: la cuadrícula guardaría la primera como color (`saveGrid` del servidor).
  if (options.length === 1) return { rows: null, columns: 0 }
  return { rows: null, columns: null }
}

/**
 * La cuadrícula de la ficha. `ids` da el id de cada fila y columna por su nombre, para que la
 * misma fila siga siendo la misma después de guardar (lo que se envió con ese id).
 */
export function gridOf(
  sheet: Pick<Sheet, "options" | "colorOption" | "colors" | "variants">,
  ids?: { rows: Map<string, string>; columns: Map<string, string> },
): Grid | null {
  const axes = axesOf(sheet)
  if (sheet.options.length > 0 && axes.rows === null && axes.columns === null) return null
  const rowOption = axes.rows === null ? null : sheet.options[axes.rows]!
  const columnOption = axes.columns === null ? null : sheet.options[axes.columns]!
  const idOf = (map: Map<string, string> | undefined, value: string, prefix: string) =>
    map?.get(value.toLocaleLowerCase("es")) ?? newId(prefix)
  const rows: GridRow[] = rowOption
    ? rowOption.values.map((value) => {
        const look = sheet.colors.find((c) => sameText(c.value, value))
        return {
          id: idOf(ids?.rows, value, "r"),
          value,
          hex: look?.hex ?? null,
          hex2: look?.hex2 ?? null,
          photoId: look?.photoId ?? null,
        }
      })
    : [{ id: NO_AXIS, value: "", hex: null, hex2: null, photoId: null }]
  const columns: GridColumn[] = columnOption
    ? columnOption.values.map((value) => ({ id: idOf(ids?.columns, value, "c"), value }))
    : [{ id: NO_AXIS, value: "" }]
  const cells: Record<string, GridCell> = {}
  for (const row of rows)
    for (const column of columns) {
      const variant = sheet.variants.find(
        (v) =>
          (axes.rows === null || sameText(v.optionValues[axes.rows] ?? "", row.value)) &&
          (axes.columns === null || sameText(v.optionValues[axes.columns] ?? "", column.value)),
      )
      // Una combinación sin variante (se quitó a mano) se muestra vacía: guardar la vuelve a crear.
      cells[cellKey(row.id, column.id)] = {
        stock: variant?.stock ?? 0,
        priceCents: variant?.priceCents ?? null,
        barcode: variant?.barcode ?? null,
      }
    }
  return {
    rowName: rowOption?.name ?? null,
    rows,
    columnName: columnOption?.name ?? null,
    columns,
    cells,
  }
}

export function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es")
}

/** El estado como lo pone la tienda, desde la ficha. */
export function statusOf(sheet: Sheet): StatusDraft {
  switch (sheet.status) {
    case "encargo":
      return { kind: "encargo", days: sheet.statusDays ?? 1 }
    case "cupo":
      return { kind: "cupo", perDay: sheet.statusPerDay ?? 1 }
    case "preventa":
      return { kind: "preventa", date: sheet.statusDate ?? "" }
    case "liquidacion":
      return { kind: "liquidacion" }
    case "no_se_vende":
      return { kind: "no_se_vende" }
    default:
      return null
  }
}

/** El borrador que corresponde a la ficha guardada. */
export function draftOf(sheet: Sheet, grid: Grid | null = gridOf(sheet)): Draft {
  const axisOfIndex = (index: number): "rows" | "columns" | null => {
    const axes = axesOf(sheet)
    return axes.rows === index ? "rows" : axes.columns === index ? "columns" : null
  }
  return {
    name: sheet.name,
    category: sheet.category,
    description: sheet.description,
    code: sheet.code,
    listPriceCents: sheet.listPriceCents,
    minPriceCents: sheet.minPriceCents,
    status: statusOf(sheet),
    rubro: sheet.rubro,
    rubroData: { ...sheet.rubroData },
    package: { ...sheet.package },
    keywords: [...sheet.keywords],
    web: { ...sheet.web },
    wholesale: sheet.wholesale ? { ...sheet.wholesale } : null,
    comboPercentOff: sheet.comboPercentOff,
    offers: { ...sheet.offers },
    quantityPrices: sheet.quantityPrices.map((q) => ({ ...q })),
    promotions: sheet.promotions.map(({ scope, ...promo }) => ({
      ...promo,
      scope: scope
        ? {
            axis: axisOfIndex(scope.optionIndex),
            index: scope.optionIndex,
            value: scope.optionValue,
          }
        : null,
    })),
    links: sheet.links.map(({ productId, kind }) => ({ productId, kind })),
    grid,
  }
}

/** Los campos del producto que se guardan con `PATCH /productos/:id`. */
export const PATCH_FIELDS = [
  "name",
  "category",
  "description",
  "code",
  "listPriceCents",
  "minPriceCents",
  "status",
  "rubro",
  "rubroData",
  "package",
  "keywords",
  "web",
  "wholesale",
  "comboPercentOff",
  "offers",
  "quantityPrices",
  "promotions",
  "links",
] as const
export type PatchField = (typeof PATCH_FIELDS)[number]

/** Lo que cambió en el borrador frente a lo guardado, campo por campo (sin la cuadrícula). */
export function changedFields(base: Draft, draft: Draft): PatchField[] {
  return PATCH_FIELDS.filter((field) => !same(base[field], draft[field]))
}

/**
 * El cambio que se envía: solo los campos que cambiaron, menos los que el servidor ya rechazó con
 * ese mismo valor (`rejected`). De los datos del rubro van solo los que cambiaron (`null` borra).
 * Las promociones de un color o una talla llevan el índice de su opción en el producto guardado.
 */
/** El índice de la opción de una promoción de un color o una talla en lo guardado; -1 si no está. */
function scopeIndex(
  scope: NonNullable<DraftPromotion["scope"]>,
  draft: Draft,
  saved: Pick<Sheet, "options">,
) {
  if (scope.axis === null) return scope.index
  const name = scope.axis === "rows" ? draft.grid?.rowName : draft.grid?.columnName
  const index = name ? saved.options.findIndex((o) => sameText(o.name, name)) : -1
  // El color o la talla todavía no se guardó (la cuadrícula espera): la promoción espera con ella.
  if (index < 0 || !saved.options[index]?.values.some((v) => sameText(v, scope.value))) return -1
  return index
}

/**
 * Lo que está a medio escribir y espera para enviarse, con por qué: las medidas van las tres
 * juntas, la preventa con su día y una promoción de un color o una talla con ese color guardado.
 */
export function heldOf(
  draft: Draft,
  saved: Pick<Sheet, "options">,
): Partial<Record<PatchField, string>> {
  const held: Partial<Record<PatchField, string>> = {}
  const dims = [draft.package.lengthMm, draft.package.widthMm, draft.package.heightMm]
  if (dims.some((v) => v === null) && dims.some((v) => v !== null))
    held.package = "Completa el largo, el ancho y el alto del paquete para guardarlo"
  if (draft.status?.kind === "preventa" && !draft.status.date)
    held.status = "Elige el día que llega la preventa para guardarla"
  if (draft.promotions.some((p) => p.scope && scopeIndex(p.scope, draft, saved) < 0))
    held.promotions = "La promoción se guarda cuando se guarde su color o su talla"
  return held
}

/**
 * El cambio que se envía: solo los campos que cambiaron, menos los que el servidor ya rechazó con
 * ese mismo valor (`rejected`) y los que esperan (`heldOf`). De los datos del rubro van solo los
 * que cambiaron (`null` borra). Las promociones de un color o una talla llevan el índice de su
 * opción en el producto guardado.
 */
export function patchOf(
  base: Draft,
  draft: Draft,
  saved: Pick<Sheet, "options">,
  rejected: Partial<Record<string, string>> = {},
): Record<string, unknown> | null {
  const body: Record<string, unknown> = {}
  const held = heldOf(draft, saved)
  for (const field of changedFields(base, draft)) {
    if (held[field]) continue
    if (rejected[field] === JSON.stringify(draft[field])) continue
    if (field === "rubroData") {
      const data: Record<string, unknown> = {}
      for (const key of new Set([
        ...Object.keys(base.rubroData),
        ...Object.keys(draft.rubroData),
      ])) {
        const next = draft.rubroData[key] ?? null
        if (same(base.rubroData[key] ?? null, next)) continue
        if (rejected[`rubroData.${key}`] === JSON.stringify(next)) continue
        data[key] = next
      }
      // El rubro va junto: los datos se comprueban contra su plantilla.
      if (Object.keys(data).length > 0) {
        body.rubroData = data
        if (draft.rubro !== base.rubro) body.rubro = draft.rubro
      }
      continue
    }
    if (field === "promotions") {
      body.promotions = draft.promotions.map(({ scope, ...promo }) => ({
        ...promo,
        scope: scope
          ? { optionIndex: scopeIndex(scope, draft, saved), optionValue: scope.value }
          : null,
      }))
      continue
    }
    body[field] = draft[field]
  }
  return Object.keys(body).length > 0 ? body : null
}

/** El nombre que tenía en lo guardado cada fila y columna, por su id. */
function namesOf(grid: Grid | null) {
  return {
    rows: new Map((grid?.rows ?? []).map((r) => [r.id, r.value])),
    columns: new Map((grid?.columns ?? []).map((c) => [c.id, c.value])),
  }
}

export function gridChanged(base: Draft, draft: Draft): boolean {
  return !same(base.grid, draft.grid)
}

/** Cuántas celdas bajan de stock frente a lo guardado (y las que se quitan con stock): piden motivo. */
export function loweredCells(base: Grid | null, draft: Grid | null): number {
  if (!base || !draft) return 0
  let n = 0
  for (const [key, cell] of Object.entries(base.cells)) {
    if (cell.stock === 0) continue
    const next = draft.cells[key]
    if (!next || next.stock < cell.stock) n++
  }
  return n
}

/**
 * El cuerpo de `POST /productos/:id/cuadricula` (`gridInput` del servidor): cada fila y columna con
 * su nombre guardado (`was`) si cambió, y una celda por combinación.
 */
export function gridBody(
  base: Grid | null,
  draft: Grid,
  extra: { reason?: string; unitCostCents?: number | null } = {},
) {
  const before = namesOf(base)
  const withWas = <T extends { id: string; value: string }>(
    item: T,
    names: Map<string, string>,
  ) => {
    const was = names.get(item.id)
    return was !== undefined && was !== item.value ? { was } : {}
  }
  const hasRows = draft.rowName !== null
  const hasColumns = draft.columnName !== null
  return {
    rows: hasRows
      ? {
          name: draft.rowName!,
          values: draft.rows.map((row) => ({
            ...withWas(row, before.rows),
            value: row.value,
            hex: row.hex,
            hex2: row.hex ? row.hex2 : null,
            photoId: row.photoId,
          })),
        }
      : null,
    columns: hasColumns
      ? {
          name: draft.columnName!,
          values: draft.columns.map((column) => ({
            ...withWas(column, before.columns),
            value: column.value,
          })),
        }
      : null,
    cells: draft.rows.flatMap((row) =>
      draft.columns.map((column) => {
        const cell = draft.cells[cellKey(row.id, column.id)] ?? {
          stock: 0,
          priceCents: null,
          barcode: null,
        }
        return {
          row: hasRows ? row.value : null,
          column: hasColumns ? column.value : null,
          stock: cell.stock,
          priceCents: cell.priceCents,
          barcode: cell.barcode,
        }
      }),
    ),
    unitCostCents: extra.unitCostCents ?? null,
    ...(extra.reason ? { reason: extra.reason } : {}),
  }
}

/** Los ids de lo que se envió, por su nombre: así lo que vuelve del servidor conserva sus ids. */
export function idsOf(grid: Grid | null) {
  const key = (v: string) => v.toLocaleLowerCase("es")
  return {
    rows: new Map((grid?.rows ?? []).map((r) => [key(r.value), r.id])),
    columns: new Map((grid?.columns ?? []).map((c) => [key(c.value), c.id])),
  }
}

/* ---------------------------------------------------------------- deshacer y rehacer */

export interface Step {
  draft: Draft
  /** La cuadrícula guardada cuando se anotó: al volver, el stock se suma sobre la de ahora. */
  base?: Grid | null
  label: string
  group?: string
  at: number
}

export interface History {
  undo: Step[]
  redo: Step[]
}

/** Un cambio nuevo: lo de antes va a deshacer. Escribir en el mismo campo seguido es un solo paso. */
export function record(
  history: History,
  before: Draft,
  label: string,
  group: string | undefined,
  now: number,
  base: Grid | null = null,
): History {
  const last = history.undo.at(-1)
  if (group && last?.group === group && now - last.at < 1500)
    return { undo: [...history.undo.slice(0, -1), { ...last, at: now }], redo: [] }
  return {
    undo: [...history.undo, { draft: before, base, label, group, at: now }].slice(-100),
    redo: [],
  }
}

/**
 * Un paso de deshacer o rehacer sobre lo guardado de ahora: el stock que tenía de más o de menos
 * frente a su cuadrícula guardada se pone sobre la de ahora. Así, si se vendió algo después, volver
 * atrás no revive lo vendido.
 */
export function onBase(step: Step, now: Grid | null): Draft {
  const grid = step.draft.grid
  if (!grid || !step.base || !now) return step.draft
  const cells = { ...grid.cells }
  for (const [key, cell] of Object.entries(grid.cells)) {
    const then = step.base.cells[key]
    const current = now.cells[key]
    if (!then || !current) continue
    cells[key] = { ...cell, stock: Math.max(0, current.stock + cell.stock - then.stock) }
  }
  return { ...step.draft, grid: { ...grid, cells } }
}

/* ------------------------------------------------------------------ números y textos */

/** Un número escrito como se dice («3», «3,5», «3.5»); null si no es un número. */
export function readNumber(text: string): number | null {
  const clean = text.trim().replace(/\s+/g, "").replace(",", ".")
  if (!/^\d+(\.\d+)?$/.test(clean)) return null
  return Number(clean)
}

/** «35 a 42» si son números seguidos; si no, separados por comas. */
export function valuesText(values: string[]): string {
  const numbers = values.map((v) => (/^(0|[1-9]\d{0,2})$/.test(v) ? Number(v) : Number.NaN))
  const consecutive =
    values.length > 2 &&
    numbers.every((n, i) => Number.isInteger(n) && (i === 0 || n === numbers[i - 1]! + 1))
  return consecutive ? `${values[0]} a ${values.at(-1)}` : values.join(", ")
}

/** Dónde vive cada cosa que mira «qué tan lista está para Sofi», para llevar a ella. */
export function anchorOf(itemId: string): string {
  if (itemId.startsWith("dato:")) return `dato-${itemId.slice(5)}`
  return (
    {
      precio: "precio",
      stock: "variantes",
      fotos: "fotos",
      ofertas: "ofertas",
      palabras: "organizacion",
      paquete: "paquete",
      // Lo que usó Sofi en la prueba: el estado, las preguntas respondidas y lo que no supo.
      estado: "estado",
      preguntas: "preguntas",
      "no-supo": "no-supo",
    }[itemId] ?? "datos"
  )
}

/** Los estados como los ve la persona y lo que dice Sofi en cada uno (decisión 8). */
export const STATES: Record<SaleState, { label: string; sofi: string }> = {
  disponible: { label: "Disponible", sofi: "Ofrece y vende con el stock de cada variante." },
  agotado: { label: "Agotado", sofi: "«Se acabó. ¿Te aviso cuando vuelva?»" },
  encargo: { label: "Por encargo", sofi: "«No la tengo ahora: te la consigo en {dias} días.»" },
  cupo: { label: "Con cupo por día", sofi: "«Hago {cupo} por día. ¿Para qué fecha la quieres?»" },
  preventa: {
    label: "Preventa",
    sofi: "«Llega el {fecha}. Si la pides hoy, sale apenas llegue.»",
  },
  liquidacion: {
    label: "Liquidación",
    sofi: "«Está en liquidación: es su precio final.» No negocia.",
  },
  no_se_vende: { label: "Ya no se vende", sofi: "No lo ofrece; recomienda lo más parecido." },
}

/** Lo que cambió, en palabras, para «Quién cambió qué» (los campos del historial de la ficha). */
export const FIELD_NAMES: Record<string, string> = {
  name: "el nombre",
  category: "la categoría",
  description: "la descripción",
  code: "el código",
  listPriceCents: "el precio",
  minPriceCents: "el mínimo",
  status: "el estado",
  rubro: "el rubro",
  rubroData: "los datos del rubro",
  package: "el paquete",
  keywords: "cómo la buscan",
  web: "el catálogo web",
  wholesale: "el precio por mayor",
  comboPercentOff: "el combo",
  offers: "lo que Sofi puede ofrecer",
  quantityPrices: "el precio por cantidad",
  promotions: "las promociones",
  links: "la venta cruzada",
  options: "los colores y las tallas",
  question: "una pregunta",
}
