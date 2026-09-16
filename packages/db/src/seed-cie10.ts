import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { createOwnerDb } from "./client.js"

/**
 * Siembra el catálogo CIE-10 desde seeds/cie10.csv (code,description).
 * Idempotente: ON CONFLICT (code) DO NOTHING. Acepta sin cambios el CSV
 * oficial completo del MINSA si se sustituye el archivo.
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const here = dirname(fileURLToPath(import.meta.url))
const csv = readFileSync(join(here, "..", "seeds", "cie10.csv"), "utf8")
const lines = csv
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
const header = lines.shift()
if (header !== "code,description") throw new Error(`CSV inesperado: ${header}`)

const rows: { code: string; description: string }[] = []
for (const line of lines) {
  const comma = line.indexOf(",")
  if (comma < 0) throw new Error(`Línea inválida: ${line}`)
  const code = line.slice(0, comma).trim()
  const description = line.slice(comma + 1).trim()
  if (!code || !description) throw new Error(`Línea inválida: ${line}`)
  rows.push({ code, description })
}

const db = createOwnerDb(url)
for (const { code, description } of rows) {
  await db.execute(
    sql`insert into "cie10_code" ("code", "description") values (${code}, ${description})
        on conflict ("code") do nothing`,
  )
}
console.log(`cie10 seeded: ${rows.length} rows`)
process.exit(0)
