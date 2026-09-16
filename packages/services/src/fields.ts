import type { Db } from "@odentia/db"
import { customFieldDef } from "@odentia/db/schema/crm"
import { and, asc, eq } from "drizzle-orm"
import { notFound, validation } from "./errors.js"

const TYPES = ["text", "number", "date", "select"]
const KEY_RE = /^[a-z0-9_]{1,40}$/

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

function checkType(type: string, options: unknown): string[] | null {
  if (!TYPES.includes(type)) throw validation("Tipo inválido (text|number|date|select)")
  if (type === "select") {
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every((o) => typeof o === "string")
    ) {
      throw validation("select requiere options: string[] no vacío")
    }
    return options as string[]
  }
  return null
}

export async function listFieldDefs(tx: Db, orgId: string): Promise<FieldDef[]> {
  const rows = await tx
    .select()
    .from(customFieldDef)
    .where(eq(customFieldDef.organizationId, orgId))
    .orderBy(asc(customFieldDef.position), asc(customFieldDef.label))
  return rows.map(toDef)
}

export async function createFieldDef(
  tx: Db,
  orgId: string,
  input: { key: string; label: string; type: string; options?: string[]; position?: number },
): Promise<FieldDef> {
  const key = input.key.trim().toLowerCase()
  if (!KEY_RE.test(key)) throw validation("key: solo minúsculas, números y _ (máx 40)")
  const label = input.label.trim()
  if (!label) throw validation("El label es obligatorio")
  const options = checkType(input.type, input.options)
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
}

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
    const label = input.label.trim()
    if (!label) throw validation("El label es obligatorio")
    patch.label = label
  }
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
