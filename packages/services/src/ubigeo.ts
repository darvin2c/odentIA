/** Catálogo de ubigeo del INEI (global, sin organización). */
import type { Db } from "@odentia/db"
import { ubigeo } from "@odentia/db/schema/clinical"
import { asc, ilike, or, sql } from "drizzle-orm"

export interface UbigeoItem {
  code: string
  department: string
  province: string | null
  district: string | null
  /** «Lima / Lima / Miraflores». */
  label: string
}

const label = (row: { department: string; province: string | null; district: string | null }) =>
  [row.department, row.province, row.district].filter(Boolean).join(" / ")

/** Busca por código o nombre; sin término devuelve los departamentos. */
export async function searchUbigeo(tx: Db, q: string, limit = 30): Promise<UbigeoItem[]> {
  const term = q.trim()
  const like = `%${term}%`
  const rows = await tx
    .select()
    .from(ubigeo)
    .where(
      term
        ? or(
            ilike(ubigeo.code, `${term}%`),
            ilike(ubigeo.department, like),
            ilike(ubigeo.province, like),
            ilike(ubigeo.district, like),
          )
        : sql`${ubigeo.province} is null`,
    )
    .orderBy(asc(ubigeo.code))
    .limit(Math.min(Math.max(limit, 1), 100))
  return rows.map((row) => ({ ...row, label: label(row) }))
}
