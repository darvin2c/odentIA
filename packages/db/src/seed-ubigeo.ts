import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { createOwnerDb } from "./client.js"

/**
 * Siembra el ubigeo del INEI (code,department,province,district).
 *
 * Sin argumentos carga los 25 departamentos (código DD0000). El catálogo
 * completo de provincias y distritos se carga desde la publicación oficial
 * del INEI con su SHA-256:
 *
 *   UBIGEO_FILE=/ruta/ubigeo.csv UBIGEO_SHA256=<hash> pnpm --filter @odentia/db seed:ubigeo
 *
 * Un archivo cuyo hash no coincide no entra. Idempotente: actualiza nombres y
 * nunca borra códigos (las fichas los referencian).
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const here = dirname(fileURLToPath(import.meta.url))
const external = process.env.UBIGEO_FILE
const bytes = readFileSync(external ?? join(here, "..", "seeds", "ubigeo-departamentos.csv"))
if (external) {
  const expected = process.env.UBIGEO_SHA256?.trim().toLowerCase()
  if (!expected) throw new Error("UBIGEO_SHA256 es obligatorio para un archivo externo")
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== expected)
    throw new Error(`El archivo no coincide con el publicado (sha256 ${actual})`)
}

const lines = bytes
  .toString("utf8")
  .replace(/^﻿/, "")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
const header = lines.shift()?.toLowerCase().replace(/;/g, ",")
if (header !== "code,department,province,district")
  throw new Error(`Encabezado inesperado: ${header} (se espera code,department,province,district)`)

const rows = lines.map((line) => {
  const [code, department, province, district] = line
    .split(line.includes(";") ? ";" : ",")
    .map((cell) => cell.trim().replace(/^"|"$/g, ""))
  if (!code || !/^\d{6}$/.test(code)) throw new Error(`Ubigeo inválido: ${code}`)
  if (!department) throw new Error(`Departamento vacío para ${code}`)
  return { code, department, province: province || null, district: district || null }
})

const db = createOwnerDb(url)
for (const row of rows) {
  await db.execute(
    sql`insert into "ubigeo" ("code", "department", "province", "district")
        values (${row.code}, ${row.department}, ${row.province}, ${row.district})
        on conflict ("code") do update set "department" = excluded."department",
          "province" = excluded."province", "district" = excluded."district"`,
  )
}
console.log(`ubigeo seeded: ${rows.length} rows${external ? " (archivo oficial verificado)" : ""}`)
process.exit(0)
