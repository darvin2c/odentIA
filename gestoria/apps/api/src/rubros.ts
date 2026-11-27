import {
  type Db,
  PRODUCT_RUBROS,
  type ProductRubro,
  type RubroValue,
  storeEvent,
  storeTemplateField,
  TEMPLATE_FIELD_TYPES,
  type TemplateFieldType,
} from "@gestoria/db"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import type { Person } from "./cuenta.js"
import { inStore, StoreError } from "./tiendas.js"

/**
 * Los datos de cada rubro (lienzo «La ficha del producto», tablero 10; decisiones 1 y 2): lo que
 * sus clientas preguntan, con lo que Sofi necesita para vender sola y lo que suma. Las plantillas
 * son las del prototipo aprobado y viven aquí; cada tienda ajusta la suya (`store_template_field`):
 * agrega, quita, cambia el orden y si Sofi lo necesita. Nada de esto frena una venta: lo que falta
 * es el nivel de «qué tan lista está para Sofi» (`readinessOf`), no un requisito.
 */

export interface TemplateField {
  /** La clave del dato en `product.rubro_data`. */
  key: string
  label: string
  type: TemplateFieldType
  /** Las opciones de un dato de opción. */
  options?: string[]
  /** Las columnas de una tabla por talla («Pecho», «Largo»). */
  columns?: string[]
  /** La unidad de un número, de uno por talla o de una tabla («cm», «h»). */
  unit?: string
  /** Sofi lo necesita para vender sola; si no, suma. */
  needed: boolean
  /** Lo que pregunta la IA cuando no lo ve en las fotos (la usa la propuesta de la IA). */
  ask?: string
  /** Palabras con que lo pregunta una clienta (las usa Sofi para encontrarlo). */
  keys?: string[]
}

export interface Rubro {
  label: string
  /** Cómo se llaman las filas y las columnas de la cuadrícula (la columna es nula si no tiene). */
  rowLabel: string
  columnLabel: string | null
  /** Cómo se cuenta: «pares» y «par». */
  unit: string
  unitOne: string
  fields: TemplateField[]
}

/** Las plantillas fijas, las del prototipo (`gestoria/apps/web/prototipo/datos.ts`). */
export const RUBROS: Record<ProductRubro, Rubro> = {
  calzado: {
    label: "Calzado",
    rowLabel: "Color",
    columnLabel: "Talla",
    unit: "pares",
    unitOne: "par",
    fields: [
      {
        key: "horma",
        label: "Cómo calza",
        type: "opcion",
        options: ["Normal", "Chico", "Grande"],
        needed: true,
        ask: "¿Cómo calza? No se ve en las fotos.",
        keys: ["calza", "horma", "talla", "me sirve", "me queda", "pie"],
      },
      {
        key: "ancho",
        label: "Si tienes el pie ancho",
        type: "opcion",
        options: ["Tu talla de siempre", "Una talla más"],
        needed: false,
        keys: ["ancho", "pie ancho", "empeine"],
      },
      {
        key: "material",
        label: "Material",
        type: "opcion",
        options: ["Cuero", "Sintético", "Lona", "Gamuza"],
        needed: true,
        ask: "¿De qué material es?",
        keys: ["material", "cuero", "lona", "sintético", "de qué es", "tela"],
      },
      {
        key: "plantilla",
        label: "Largo de la plantilla",
        type: "por_talla",
        unit: "cm",
        needed: false,
        keys: ["plantilla", "cm", "centímetros", "mide", "medida", "largo"],
      },
      {
        key: "limpia",
        label: "Cómo se limpia",
        type: "texto",
        needed: false,
        keys: ["lava", "limpia", "lavadora", "mancha", "destiñe"],
      },
    ],
  },
  ropa: {
    label: "Ropa",
    rowLabel: "Color",
    columnLabel: "Talla",
    unit: "prendas",
    unitOne: "prenda",
    fields: [
      {
        key: "tela",
        label: "Tela",
        type: "opcion",
        options: ["Algodón", "Piqué de algodón", "Poliéster", "Lino", "Jean"],
        needed: true,
        ask: "¿De qué tela es?",
        keys: ["tela", "algodón", "material", "de qué es"],
      },
      {
        key: "medidas",
        label: "Medidas de la prenda por talla",
        type: "tabla",
        columns: ["Pecho", "Largo"],
        unit: "cm",
        needed: true,
        keys: ["medida", "mide", "pecho", "largo", "cm", "me queda", "talla"],
      },
      {
        key: "largo",
        label: "Largo",
        type: "opcion",
        options: ["Corto", "A la cadera", "Largo"],
        needed: false,
        keys: ["largo", "corto"],
      },
      {
        key: "calce",
        label: "Calce",
        type: "opcion",
        options: ["Ajustado", "Regular", "Holgado"],
        needed: false,
        ask: "¿Cómo queda: ajustado, regular u holgado?",
        keys: ["calce", "queda", "ajustado", "holgado", "me sirve"],
      },
      {
        key: "cuidado",
        label: "Cuidado",
        type: "texto",
        needed: false,
        keys: ["lava", "encoge", "lavadora", "plancha", "destiñe"],
      },
    ],
  },
  cosmetica: {
    label: "Cosmética",
    rowLabel: "Tono",
    columnLabel: null,
    unit: "unidades",
    unitOne: "unidad",
    fields: [
      {
        key: "contenido",
        label: "Contenido",
        type: "opcion",
        options: ["3,5 g", "4 g", "15 ml", "30 ml"],
        needed: true,
        ask: "¿Cuánto contiene? Si se lee en la etiqueta, lo propongo.",
        keys: ["contiene", "gramos", "ml", "cuánto trae", "tamaño"],
      },
      {
        key: "piel",
        label: "Para qué tipo de piel",
        type: "opcion",
        options: ["Todo tipo", "Seca", "Grasa", "Mixta", "Sensible"],
        needed: true,
        ask: "¿Para qué tipo de piel es?",
        keys: ["piel", "sensible", "grasa", "seca", "alergia"],
      },
      {
        key: "ingredientes",
        label: "Ingredientes clave",
        type: "texto",
        needed: false,
        keys: ["ingrediente", "tiene", "karité", "vitamina", "vegano", "cruelty"],
      },
      {
        key: "vence",
        label: "Vencimiento del lote en stock",
        type: "fecha",
        needed: true,
        ask: "¿Cuándo vence el lote que tienes?",
        keys: ["vence", "vencimiento", "caduca", "dura"],
      },
      {
        key: "nso",
        label: "Registro sanitario (NSO de DIGEMID)",
        type: "texto",
        needed: true,
        ask: "¿Cuál es su NSO? Está en el envase.",
        keys: ["registro", "nso", "digemid", "original", "sanitario"],
      },
    ],
  },
  tecnologia: {
    label: "Tecnología",
    rowLabel: "Color",
    columnLabel: "Modelo",
    unit: "unidades",
    unitOne: "unidad",
    fields: [
      {
        key: "compatible",
        label: "Con qué equipos funciona",
        type: "texto",
        needed: true,
        ask: "¿Con qué equipos funciona?",
        keys: ["funciona", "iphone", "android", "compatible", "laptop", "sirve con"],
      },
      {
        key: "estado_equipo",
        label: "Nuevo, caja abierta o reacondicionado",
        type: "opcion",
        options: ["Nuevo", "Caja abierta", "Reacondicionado"],
        needed: true,
        ask: "¿Es nuevo, de caja abierta o reacondicionado? La ley pide decirlo.",
        keys: ["nuevo", "original", "usado", "reacondicionado", "caja"],
      },
      {
        // La garantía de la tienda es un dato del rubro, como en el prototipo: Sofi la dice tal
        // cual está aquí y nunca la promete si falta.
        key: "garantia",
        label: "Garantía",
        type: "opcion",
        options: ["3 meses", "6 meses", "1 año"],
        needed: true,
        keys: ["garantía", "falla", "malogra"],
      },
      {
        key: "incluye",
        label: "Qué trae la caja",
        type: "texto",
        needed: false,
        keys: ["trae", "incluye", "cable", "caja", "viene con"],
      },
      {
        key: "bateria",
        label: "Batería",
        type: "numero",
        unit: "h",
        needed: false,
        keys: ["batería", "dura", "horas", "carga"],
      },
    ],
  },
  hogar: {
    label: "Hogar",
    rowLabel: "Color o acabado",
    columnLabel: "Tamaño",
    unit: "unidades",
    unitOne: "unidad",
    fields: [
      {
        key: "medidas",
        label: "Medidas",
        type: "texto",
        needed: true,
        ask: "¿Qué medidas tiene? No se pueden medir en una foto.",
        keys: ["medida", "mide", "tamaño", "cm", "grande"],
      },
      {
        key: "peso",
        label: "Peso",
        type: "numero",
        unit: "kg",
        needed: false,
        keys: ["peso", "pesa", "liviano"],
      },
      {
        key: "material",
        label: "Material",
        type: "opcion",
        options: ["Algodón", "Lino", "Madera", "Cerámica", "Tela y metal"],
        needed: true,
        ask: "¿De qué material es?",
        keys: ["material", "algodón", "de qué es", "tela"],
      },
      {
        key: "arma",
        label: "Si se arma",
        type: "opcion",
        options: ["Viene listo", "Se arma fácil", "Lo armamos"],
        needed: true,
        keys: ["arma", "armar", "instala", "listo"],
      },
      {
        key: "limpia",
        label: "Cómo se limpia",
        type: "texto",
        needed: false,
        keys: ["lava", "limpia", "funda", "mancha"],
      },
      {
        // En el tablero 10 del lienzo, Hogar suma la garantía; el prototipo no la trae.
        key: "garantia",
        label: "Garantía",
        type: "texto",
        needed: false,
        keys: ["garantía", "falla", "malogra"],
      },
    ],
  },
}

const sameText = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" }) === 0

/** La plantilla de un rubro para la tienda: la fija con lo que ella ajustó, en su orden. */
export function mergeTemplate(
  rubro: ProductRubro,
  rows: (typeof storeTemplateField.$inferSelect)[],
): TemplateField[] {
  const fixed = RUBROS[rubro].fields
  if (rows.length === 0) return fixed
  const out: TemplateField[] = []
  for (const row of [...rows].sort((a, b) => a.position - b.position)) {
    if (row.hidden) continue
    const base = fixed.find((f) => f.key === row.key)
    if (base) out.push({ ...base, needed: row.needed })
    else if (row.label && row.type)
      out.push({
        key: row.key,
        label: row.label,
        type: row.type,
        needed: row.needed,
        ...(row.options ? { options: row.options } : {}),
        ...(row.columns ? { columns: row.columns } : {}),
        ...(row.unit ? { unit: row.unit } : {}),
      })
  }
  // Un dato fijo que llegó después de que la tienda ajustó su plantilla se suma al final.
  for (const field of fixed) if (!rows.some((row) => row.key === field.key)) out.push(field)
  return out
}

export async function templateIn(tx: Db, storeId: string, rubro: ProductRubro) {
  const rows = await tx
    .select()
    .from(storeTemplateField)
    .where(and(eq(storeTemplateField.storeId, storeId), eq(storeTemplateField.rubro, rubro)))
    .orderBy(asc(storeTemplateField.position))
  return mergeTemplate(rubro, rows)
}

/** Las plantillas de todos los rubros, como las tiene la tienda: para la ficha y para ajustarlas. */
export async function storeTemplates(appDb: Db, person: Person, storeId: string) {
  return inStore(appDb, person, storeId, "catalogo.ver", async (tx) => {
    const rows = await tx
      .select()
      .from(storeTemplateField)
      .where(eq(storeTemplateField.storeId, storeId))
    return {
      rubros: PRODUCT_RUBROS.map((id) => {
        const own = rows.filter((row) => row.rubro === id)
        const { fields: _fixed, ...rest } = RUBROS[id]
        return {
          id,
          ...rest,
          adjusted: own.length > 0,
          fields: mergeTemplate(id, own),
        }
      }),
    }
  })
}

const fieldLabel = z
  .string()
  .trim()
  .min(1, "Escribe el nombre del dato")
  .max(60, "Máximo 60 caracteres")
const shortValue = z.string().trim().min(1, "Escribe cada valor").max(30, "Máximo 30 caracteres")

export const templateInput = z.object({
  fields: z
    .array(
      z.object({
        /** La clave de un dato que ya está; sin ella, es uno nuevo de la tienda. */
        key: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,39}$/)
          .optional(),
        needed: z.boolean(),
        /** Quitarlo de la plantilla: sus valores en los productos quedan, sin mostrarse. */
        hidden: z.boolean().default(false),
        label: fieldLabel.optional(),
        type: z.enum(TEMPLATE_FIELD_TYPES).optional(),
        options: z.array(shortValue).min(1).max(20).optional(),
        columns: z.array(shortValue).min(1).max(6).optional(),
        unit: z.string().trim().min(1).max(12).optional(),
      }),
    )
    .max(40, "Hasta 40 datos por rubro"),
})

/** La clave de un dato nuevo: su nombre sin tildes, en minúsculas («¿Es vegano?» → «es_vegano»). */
export function fieldKey(label: string, taken: Set<string>): string {
  const base =
    label
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 32) || "dato"
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`
  taken.add(key)
  return key
}

/**
 * Guarda la plantilla de un rubro de la tienda tal como queda, en su orden. Un dato fijo solo
 * cambia si Sofi lo necesita, su lugar o si se quita; un dato de la tienda, también su nombre, su
 * tipo y sus valores. Lo que ya guardaron los productos no se toca.
 */
export async function saveTemplate(
  appDb: Db,
  person: Person,
  storeId: string,
  rubro: string,
  input: z.infer<typeof templateInput>,
) {
  const id = PRODUCT_RUBROS.find((r) => r === rubro)
  if (!id) throw new StoreError(404, "NOT_FOUND", "Ese rubro no existe")
  return inStore(appDb, person, storeId, "configuracion", async (tx) => {
    const fixed = RUBROS[id].fields
    const current = await tx
      .select()
      .from(storeTemplateField)
      .where(and(eq(storeTemplateField.storeId, storeId), eq(storeTemplateField.rubro, id)))
    const taken = new Set([...fixed.map((f) => f.key), ...current.map((row) => row.key)])
    const fields: Record<string, string> = {}
    const seen = new Set<string>()
    const now = new Date()
    const rows = input.fields.map((field, position) => {
      const base = field.key ? fixed.find((f) => f.key === field.key) : undefined
      const own = field.key ? current.find((row) => row.key === field.key && row.label) : undefined
      if (field.key && !base && !own) fields[`fields.${position}.key`] = "Ese dato ya no está"
      const label = field.label ?? own?.label ?? undefined
      const type = field.type ?? own?.type ?? undefined
      if (!base && (!label || !type))
        fields[`fields.${position}.label`] = "Escribe el nombre y el tipo"
      if (!base && type === "opcion" && !(field.options ?? own?.options)?.length)
        fields[`fields.${position}.options`] = "Escribe las opciones"
      if (!base && type === "tabla" && !(field.columns ?? own?.columns)?.length)
        fields[`fields.${position}.columns`] = "Escribe las columnas"
      if (!base && label && fixed.some((f) => sameText(f.label, label)) && !field.key)
        fields[`fields.${position}.label`] = "Ese dato ya está en la plantilla"
      const key = field.key ?? fieldKey(label ?? "dato", taken)
      if (seen.has(key)) fields[`fields.${position}.key`] = "Ese dato está dos veces"
      seen.add(key)
      return {
        storeId,
        rubro: id,
        key,
        position,
        needed: field.needed,
        hidden: field.hidden,
        label: base ? null : (label ?? null),
        type: base ? null : (type ?? null),
        options: base ? null : (field.options ?? own?.options ?? null),
        columns: base ? null : (field.columns ?? own?.columns ?? null),
        unit: base ? null : (field.unit ?? own?.unit ?? null),
        updatedBy: person.userId,
        updatedAt: now,
      }
    })
    // Un dato fijo que no viene en la lista se quita (queda guardado como quitado).
    for (const field of fixed)
      if (!seen.has(field.key))
        rows.push({
          storeId,
          rubro: id,
          key: field.key,
          position: rows.length,
          needed: field.needed,
          hidden: true,
          label: null,
          type: null,
          options: null,
          columns: null,
          unit: null,
          updatedBy: person.userId,
          updatedAt: now,
        })
    if (Object.keys(fields).length > 0)
      throw new StoreError(400, "VALIDATION_ERROR", Object.values(fields)[0]!, fields)
    await tx
      .delete(storeTemplateField)
      .where(and(eq(storeTemplateField.storeId, storeId), eq(storeTemplateField.rubro, id)))
    await tx.insert(storeTemplateField).values(rows)
    await tx.insert(storeEvent).values({
      storeId,
      actorUserId: person.userId,
      action: "catalogo.plantilla",
      subject: RUBROS[id].label,
      detail: { datos: rows.filter((r) => !r.hidden).map((r) => r.key) },
    })
    return { id, fields: mergeTemplate(id, rows) }
  })
}

/* --------------------------------------------------------------- los datos del producto */

const NO_APLICA = z.object({ noAplica: z.literal(true) }).strict()
const measure = z.number().finite().min(0).max(1_000_000)
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/

/** Lo que vale para un dato de la plantilla, o «No aplica». */
function valueSchema(field: TemplateField): z.ZodType<RubroValue> {
  const one = (() => {
    switch (field.type) {
      case "opcion":
        return z
          .string()
          .trim()
          .refine((v) => (field.options ?? []).some((o) => sameText(o, v)), {
            message: `Elige una de las opciones de «${field.label}»`,
          })
          .transform((v) => (field.options ?? []).find((o) => sameText(o, v)) ?? v)
      case "numero":
        return measure
      case "texto":
        return z.string().trim().min(1).max(500, "Máximo 500 caracteres")
      case "por_talla":
        return z
          .record(z.string().trim().min(1).max(30), measure)
          .refine((v) => Object.keys(v).length <= 60, "Hasta 60 tallas")
      case "tabla":
        return z
          .record(z.string().trim().min(1).max(30), z.array(measure.nullable()))
          .refine((v) => Object.keys(v).length <= 60, "Hasta 60 tallas")
          .refine(
            (v) => Object.values(v).every((row) => row.length === (field.columns ?? []).length),
            `Cada fila lleva ${(field.columns ?? []).length} columnas`,
          )
      case "fecha":
        return z.string().regex(ISO_DATE, "Escribe la fecha como AAAA-MM o AAAA-MM-DD")
    }
  })()
  return z.union([NO_APLICA, one]) as z.ZodType<RubroValue>
}

/**
 * Pone al día los datos del rubro con lo que trae el cambio: un valor nuevo se comprueba contra la
 * plantilla, `null` lo borra y lo que no viene se queda. Un dato que no está en la plantilla de la
 * tienda no se acepta (uno que se quitó de la plantilla queda guardado, sin mostrarse).
 */
export function applyRubroData(
  template: TemplateField[],
  current: Record<string, RubroValue>,
  patch: Record<string, unknown>,
): { ok: true; data: Record<string, RubroValue> } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  const data = { ...current }
  for (const [key, raw] of Object.entries(patch)) {
    const field = template.find((f) => f.key === key)
    if (!field) {
      fields[`rubroData.${key}`] = "Ese dato no está en la plantilla"
      continue
    }
    if (raw === null || raw === "") {
      delete data[key]
      continue
    }
    const parsed = valueSchema(field).safeParse(raw)
    if (!parsed.success) fields[`rubroData.${key}`] = parsed.error.issues[0]?.message ?? "No vale"
    else data[key] = parsed.data
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, data }
}

/** Si un dato está respondido: con un valor o con «No aplica». */
export function isAnswered(value: RubroValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim() !== ""
  if (typeof value === "number") return true
  if ("noAplica" in value) return true
  return Object.keys(value).length > 0
}

/* ------------------------------------------------- qué tan lista está para Sofi */

export interface ReadinessItem {
  /** Lo que mira: `precio`, `stock`, `fotos`, `dato:<clave>`, `ofertas`, `palabras`, `paquete`. */
  id: string
  label: string
  ok: boolean
  /** Sofi lo necesita para vender sola; si no, suma. */
  needed: boolean
}

export type ReadinessLevel = "basica" | "falta_poco" | "lista"

export interface ReadinessInput {
  listPriceCents: number
  minPriceCents: number | null
  /** El stock de las variantes que se venden. */
  stock: number
  /** Por encargo, con cupo o en preventa se vende sin stock. */
  sellsWithoutStock: boolean
  /** Los colores, si tiene: cuáles tienen su foto (propia o una foto de ese color). */
  colors: { value: string; hasPhoto: boolean }[]
  photoCount: number
  rowLabel: string
  template: TemplateField[]
  rubroData: Record<string, RubroValue>
  /** Si Sofi puede ofrecer algo (envío, unos soles, un regalo, la 2.ª unidad); sin el dato, no se mira. */
  offersSomething?: boolean
  keywordCount: number
  hasPackage: boolean
}

/**
 * Lo que sabe Sofi de un producto y lo que le falta (tablero 10, «qué tan lista está para Sofi»),
 * como el prototipo (`prototipo/sofi.ts`): lo que necesita para vender sola y lo que suma. Nada de
 * esto frena la venta. «Lista»: no le falta nada de lo que necesita; «Le falta poco»: uno o dos;
 * «Básica»: más. El video se sumará cuando haya dónde guardarlo.
 */
export function readinessOf(input: ReadinessInput) {
  const items: ReadinessItem[] = [
    {
      id: "precio",
      label: "Precio y mínimo",
      ok: input.listPriceCents > 0 && input.minPriceCents !== null,
      needed: true,
    },
    {
      id: "stock",
      label: "Stock por variante",
      ok: input.stock > 0 || input.sellsWithoutStock,
      needed: true,
    },
    {
      id: "fotos",
      label: input.colors.length ? `Una foto de cada ${input.rowLabel.toLowerCase()}` : "Una foto",
      ok: input.colors.length ? input.colors.every((c) => c.hasPhoto) : input.photoCount > 0,
      needed: true,
    },
    ...input.template.map((field) => ({
      id: `dato:${field.key}`,
      label: field.label,
      ok: isAnswered(input.rubroData[field.key]),
      needed: field.needed,
    })),
    ...(input.offersSomething === undefined
      ? []
      : [
          {
            id: "ofertas",
            label: "Lo que puede ofrecer",
            ok: input.offersSomething,
            needed: false,
          },
        ]),
    { id: "palabras", label: "Cómo la buscan", ok: input.keywordCount > 0, needed: false },
    { id: "paquete", label: "Paquete para la agencia", ok: input.hasPackage, needed: false },
  ]
  const neededMissing = items.filter((i) => i.needed && !i.ok)
  const extraMissing = items.filter((i) => !i.needed && !i.ok)
  const level: ReadinessLevel =
    neededMissing.length === 0 ? "lista" : neededMissing.length <= 2 ? "falta_poco" : "basica"
  return {
    level,
    /** Sofi lo vende sola: no le falta nada de lo que necesita. */
    sellsAlone: neededMissing.length === 0,
    /** Responde todo: no le falta nada. */
    complete: neededMissing.length + extraMissing.length === 0,
    done: items.filter((i) => i.ok).length,
    total: items.length,
    items,
  }
}
