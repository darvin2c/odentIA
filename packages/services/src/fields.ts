import type { Db } from "@odentia/db"
import { customFieldDef } from "@odentia/db/schema/crm"
import { and, asc, eq } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"

const TYPES = ["text", "number", "date", "select"]
const KEY_RE = /^[a-z0-9_]{1,40}$/
const KEY_CHARS = 40
const LABEL_CHARS = 120
const OPTION_CHARS = 80
const OPTIONS_MAX = 50

export interface FieldDef {
  id: string
  key: string
  label: string
  type: string
  options: string[] | null
  position: number
}

function toDef(row: typeof customFieldDef.$inferSelect): FieldDef {
  const options =
    Array.isArray(row.options) && row.options.every((o): o is string => typeof o === "string")
      ? row.options
      : null
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options,
    position: row.position,
  }
}

/** Opciones de una lista: sin vacías ni repetidas, en el orden en que se escribieron. */
function checkType(type: string, options: unknown): string[] | null {
  if (!TYPES.includes(type)) throw validation("Elige el tipo del campo: texto, número, fecha o lista de opciones")
  if (type !== "select") return null
  if (!Array.isArray(options) || !options.every((o) => typeof o === "string")) {
    throw validation("Una lista de opciones necesita al menos una opción")
  }
  const clean = [...new Set(options.map((option: string) => option.trim()).filter(Boolean))]
  if (clean.length === 0) throw validation("Una lista de opciones necesita al menos una opción")
  if (clean.length > OPTIONS_MAX) throw validation(`Una lista admite hasta ${OPTIONS_MAX} opciones`)
  if (clean.some((option) => option.length > OPTION_CHARS)) {
    throw validation(`Cada opción admite hasta ${OPTION_CHARS} caracteres`)
  }
  return clean
}

function checkLabel(raw: string): string {
  const label = raw.trim()
  if (!label) throw validation("Escribe el nombre del campo")
  if (label.length > LABEL_CHARS) throw validation(`El nombre del campo admite hasta ${LABEL_CHARS} caracteres`)
  return label
}

/** Compara nombres como los lee una persona: sin mayúsculas, tildes ni espacios de más. */
function plain(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
}

/**
 * Clave con la que se guarda el dato en cada contacto, derivada del nombre:
 * «Sede preferida» → `sede_preferida`. Nadie la escribe ni la ve; es estable,
 * así que cambiar el nombre después no pierde lo ya guardado.
 */
export function fieldKeyFromLabel(label: string): string {
  const base = plain(label)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, KEY_CHARS)
    .replace(/_+$/g, "")
  return base || "campo"
}

/** La primera clave libre: `sede`, `sede_2`, `sede_3`… */
function freeKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`
    const candidate = `${base.slice(0, KEY_CHARS - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw validation("Ya hay demasiados campos con un nombre parecido: usa otro nombre")
}

const DUPLICATE_NAME = "Ya hay un campo con ese nombre"

export async function listFieldDefs(tx: Db, orgId: string): Promise<FieldDef[]> {
  const rows = await tx
    .select()
    .from(customFieldDef)
    .where(eq(customFieldDef.organizationId, orgId))
    .orderBy(asc(customFieldDef.position), asc(customFieldDef.label))
  return rows.map(toDef)
}

/**
 * Crea un campo. El nombre es lo único que escribe la clínica: la clave se
 * genera a partir de él (se acepta una explícita para integraciones y datos de
 * prueba). Dos campos no pueden llamarse igual, porque en pantalla solo se
 * distinguen por su nombre.
 */
export async function createFieldDef(
  tx: Db,
  orgId: string,
  input: { key?: string; label: string; type: string; options?: string[]; position?: number },
): Promise<FieldDef> {
  const label = checkLabel(input.label)
  const options = checkType(input.type, input.options)
  const existing = await tx
    .select({ key: customFieldDef.key, label: customFieldDef.label })
    .from(customFieldDef)
    .where(eq(customFieldDef.organizationId, orgId))
  if (existing.some((row) => plain(row.label) === plain(label))) {
    throw new ServiceError("FIELD_NAME_TAKEN", 409, DUPLICATE_NAME)
  }
  const taken = new Set(existing.map((row) => row.key))
  let key: string
  if (input.key?.trim()) {
    key = input.key.trim().toLowerCase()
    if (!KEY_RE.test(key)) throw validation("La clave solo admite minúsculas, números y guion bajo (hasta 40)")
    if (taken.has(key)) throw new ServiceError("FIELD_NAME_TAKEN", 409, DUPLICATE_NAME)
  } else {
    key = freeKey(fieldKeyFromLabel(label), taken)
  }
  try {
    const [created] = await tx
      .insert(customFieldDef)
      .values({
        organizationId: orgId,
        key,
        label,
        type: input.type,
        options,
        position: input.position ?? 0,
      })
      .returning()
    if (!created) throw new Error("No se pudo crear el campo")
    return toDef(created)
  } catch (error) {
    // Dos altas a la vez con el mismo nombre: la segunda lo dice en vez de fallar sin motivo.
    if (isUniqueViolation(error)) throw new ServiceError("FIELD_NAME_TAKEN", 409, DUPLICATE_NAME)
    throw error
  }
}

/**
 * Edita un campo: su nombre y, si es una lista, sus opciones. El tipo y la
 * clave no cambian, porque de ellos depende lo que ya está guardado en cada
 * contacto. Quitar una opción no toca a los contactos que la tenían: la
 * conservan hasta que alguien edite ese dato y elija otra.
 */
export async function updateFieldDef(
  tx: Db,
  orgId: string,
  id: string,
  input: { label?: string; options?: string[]; position?: number },
): Promise<FieldDef> {
  const [row] = await tx
    .select()
    .from(customFieldDef)
    .where(and(eq(customFieldDef.id, id), eq(customFieldDef.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Campo")
  const patch: Partial<typeof customFieldDef.$inferInsert> = {}
  if (input.label !== undefined) {
    const label = checkLabel(input.label)
    if (plain(label) !== plain(row.label)) {
      const others = await tx
        .select({ id: customFieldDef.id, label: customFieldDef.label })
        .from(customFieldDef)
        .where(eq(customFieldDef.organizationId, orgId))
      if (others.some((other) => other.id !== id && plain(other.label) === plain(label))) {
        throw new ServiceError("FIELD_NAME_TAKEN", 409, DUPLICATE_NAME)
      }
    }
    patch.label = label
  }
  // Solo una lista tiene opciones: en los demás tipos se ignoran.
  if (input.options !== undefined) patch.options = checkType(row.type, input.options)
  if (input.position !== undefined) patch.position = input.position
  if (Object.keys(patch).length === 0) return toDef(row)
  const [updated] = await tx
    .update(customFieldDef)
    .set(patch)
    .where(and(eq(customFieldDef.id, id), eq(customFieldDef.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Campo")
  return toDef(updated)
}

export async function deleteFieldDef(tx: Db, orgId: string, id: string): Promise<void> {
  // Los valores ya guardados en contact.custom_fields quedan huérfanos pero
  // intactos; sanitizeCustomFields los descarta en la próxima edición.
  const deleted = await tx
    .delete(customFieldDef)
    .where(and(eq(customFieldDef.id, id), eq(customFieldDef.organizationId, orgId)))
    .returning({ id: customFieldDef.id })
  if (deleted.length === 0) throw notFound("Campo")
}
