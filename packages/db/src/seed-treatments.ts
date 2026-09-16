import { TREATMENT_TEMPLATES } from "@odentia/clinical"
import { sql } from "drizzle-orm"
import { createOwnerDb } from "./client.js"

/**
 * Siembra la biblioteca global de prestaciones (treatment_template).
 * Idempotente: UPSERT por key (las keys quedan congeladas); la versión solo
 * aumenta cuando el contenido realmente cambia. Jamás toca tarifas:
 * treatment_template no tiene precios.
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const db = createOwnerDb(url)
for (const tpl of TREATMENT_TEMPLATES) {
  await db.execute(
    sql`insert into "treatment_template"
      ("key", "name", "specialty", "scope", "surface_count_min", "surface_count_max", "is_active", "version", "external_codings")
      values (${tpl.key}, ${tpl.name}, ${tpl.specialty}, ${tpl.scope}, ${tpl.surfaceCountMin}, ${tpl.surfaceCountMax}, true, 1, '[]'::jsonb)
      on conflict ("key") do update set
        "name" = excluded."name",
        "specialty" = excluded."specialty",
        "scope" = excluded."scope",
        "surface_count_min" = excluded."surface_count_min",
        "surface_count_max" = excluded."surface_count_max",
        "version" = "treatment_template"."version" + (
          ("treatment_template"."name", "treatment_template"."specialty", "treatment_template"."scope",
           "treatment_template"."surface_count_min", "treatment_template"."surface_count_max")
          IS DISTINCT FROM
          (excluded."name", excluded."specialty", excluded."scope",
           excluded."surface_count_min", excluded."surface_count_max")
        )::int`,
  )
}
console.log(`treatment templates seeded: ${TREATMENT_TEMPLATES.length} rows`)
process.exit(0)
