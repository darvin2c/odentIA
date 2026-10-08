import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { createOwnerDb } from "./client.js"

/**
 * Siembra el catálogo CIE-10 (code,description).
 *
 * Sin argumentos usa `seeds/cie10.csv`: el capítulo de cavidad bucal (K00–K14)
 * y los códigos que usa la clínica. Para cargar el catálogo oficial completo
 * (publicación del MINSA) se pasa el archivo y su SHA-256 publicado:
 *
 *   CIE10_FILE=/ruta/cie10.csv CIE10_SHA256=<hash> pnpm --filter @odentia/db seed:cie10
 *
 * El hash se verifica antes de escribir nada: un archivo distinto del
 * publicado no entra. Acepta separador coma o punto y coma, con o sin BOM.
 * Idempotente: actualiza la descripción si cambió y nunca borra códigos
 * (los diagnósticos registrados los referencian).
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const here = dirname(fileURLToPath(import.meta.url))
const external = process.env.CIE10_FILE
const path = external ?? join(here, "..", "seeds", "cie10.csv")
const bytes = readFileSync(path)
if (external) {
  const expected = process.env.CIE10_SHA256?.trim().toLowerCase()
  if (!expected) throw new Error("CIE10_SHA256 es obligatorio para un archivo externo")
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== expected)
    throw new Error(`El archivo no coincide con el publicado (sha256 ${actual})`)
}

const CIE10_CODE = /^[A-Z][0-9]{2}(\.[0-9X]{1,2})?$/

const text = bytes.toString("utf8").replace(/^﻿/, "")
const lines = text
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
const header = lines.shift()?.toLowerCase().replace(/;/g, ",")
if (header !== "code,description" && header !== "codigo,descripcion")
  throw new Error(`Encabezado inesperado: ${header} (se espera code,description)`)

const rows: { code: string; description: string }[] = []
for (const line of lines) {
  const separator = line.includes(";") ? ";" : ","
  const at = line.indexOf(separator)
  if (at < 0) throw new Error(`Línea inválida: ${line}`)
  const code = line.slice(0, at).trim().toUpperCase()
  const description = line
    .slice(at + 1)
    .trim()
    .replace(/^"|"$/g, "")
  if (!CIE10_CODE.test(code)) throw new Error(`Código CIE-10 inválido: ${code}`)
  if (!description) throw new Error(`Descripción vacía para ${code}`)
  rows.push({ code, description })
}

const db = createOwnerDb(url)
for (const { code, description } of rows) {
  await db.execute(
    sql`insert into "cie10_code" ("code", "description") values (${code}, ${description})
        on conflict ("code") do update set "description" = excluded."description"`,
  )
}
console.log(`cie10 seeded: ${rows.length} rows${external ? " (archivo oficial verificado)" : ""}`)
process.exit(0)
