/**
 * Siembra el catálogo de servicios (ADR 0069): las listas oficiales de cada
 * país y la biblioteca de odentIA con el código de cada tratamiento en ellas.
 *
 * - Listas oficiales: una edición vigente por lista
 *   (`procedure_catalog_release.csv`), con todos sus códigos y la sección
 *   oficial de cada uno en `procedure_codes_<lista>.csv` (p. ej. la CPMS del
 *   Perú, 12 002 códigos). Cada CSV sale del archivo oficial con su SHA-256
 *   (`import:procedures`). Este seed NO lee los archivos oficiales.
 * - Códigos de cada producto: `procedure_code_products.csv` (ADR 0079), los
 *   que ofrece su buscador (odentIA, los odontológicos).
 * - Biblioteca: `seeds/biblioteca.csv`, tratamientos de consultorio con nombre
 *   propio, tipo, ámbito, lo que dejan en la pieza, si van en «Más usados» y
 *   si son la variante de una norma que solo se ofrece donde tiene código;
 *   `seeds/biblioteca_codigos.csv`, el código de cada uno en cada lista.
 *
 * Atómico e idempotente: todo corre en una transacción; valida fuente, datos
 * y cobertura (fail closed) y revierte ante cualquier desvío. No reactiva
 * versiones anteriores: solo desactiva (ediciones no vigentes, códigos fuera
 * del ámbito, tratamientos que ya no están en la biblioteca, como las
 * plantillas `cpms:` de antes). Los históricos (snapshots en planes,
 * presupuestos y atenciones) no se tocan.
 *
 * Orden en CLI: `pnpm --filter @odentia/db migrate` → `seed:diagnoses` →
 * `seed:procedures`. Rol owner (bypasea RLS; el rol app solo lee). Los tests
 * lo invocan directo para no divergir del catálogo real.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"
import { notInArray, sql } from "drizzle-orm"
import type { Db } from "./client.js"

const here = dirname(fileURLToPath(import.meta.url))

export interface ProcedureCodesSeedResult {
  systems: number
  codes: number
  templates: number
  /** Cada lista cargada, con su edición vigente y cuántos códigos y tratamientos ligados. */
  releases: Array<{ systemKey: string; version: string; codes: number; mappings: number }>
}

/** El archivo de códigos de una lista: `procedure_codes_<lista en minúsculas>.csv`. */
export function codesFileOf(systemKey: string): string {
  return `procedure_codes_${systemKey.toLowerCase()}.csv`
}

/** Filas por sentencia al sembrar: miles de códigos sin miles de idas y vueltas. */
const BATCH = 1000

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH))
  return out
}

export function strictLines(file: string, header: string): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(join(here, "..", "seeds", file)),
  )
  if (text.includes("\uFFFD")) throw new Error(`CSV con reemplazos UTF-8: ${file}`)
  const lines = text.split("\n")
  if (lines[lines.length - 1] !== "") throw new Error(`CSV sin newline final: ${file}`)
  lines.pop()
  if (lines.some((l) => l.includes("\r"))) throw new Error(`CSV con CR: ${file}`)
  const actual = lines.shift()
  if (actual !== header) throw new Error(`CSV inesperado en ${file}: ${actual}`)
  return lines
}

export function splitHead(line: string, n: number): string[] {
  // Divide en n campos por las primeras n-1 comas; el resto es el último campo
  // (la denominación oficial puede contener comas y va siempre al final).
  const parts: string[] = []
  let rest = line
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(",")
    if (idx < 0) throw new Error(`Línea inválida: ${line}`)
    parts.push(rest.slice(0, idx).trim())
    rest = rest.slice(idx + 1)
  }
  parts.push(rest.trim())
  return parts
}

/** Las listas oficiales leídas de sus CSV, para sembrarlas y para que una biblioteca valide sus códigos. */
export type ProcedureLists = ReturnType<typeof loadProcedureLists>

/** Carga y valida los CSV de las listas; fail closed antes de tocar la base. */
export function loadProcedureLists() {
  // --- Sistemas ---
  const systems = strictLines(
    "procedure_code_systems.csv",
    "key,title,publisher,country,license,source_url",
  ).map((line) => {
    const [key, title, publisher, country, license, sourceUrl] = splitHead(line, 6)
    if (!key || !title || !publisher || !country || !license || !sourceUrl) {
      throw new Error(`Línea inválida en procedure_code_systems.csv: ${line}`)
    }
    return { key, title, publisher, country, license, sourceUrl }
  })

  // --- Ediciones vigentes: una por lista ---
  const systemKeys = new Set(systems.map((s) => s.key))
  const releases = strictLines(
    "procedure_catalog_release.csv",
    "system_key,version,scope,source_url,source_sha256,expected_count,is_current",
  ).map((line) => {
    const [systemKey, version, scope, sourceUrl, sourceSha256, expectedRaw, currentRaw] = splitHead(line, 7)
    const release = {
      systemKey: systemKey!,
      version: version!,
      scope: scope!,
      sourceUrl: sourceUrl!,
      sourceSha256: sourceSha256!,
      expectedCount: Number(expectedRaw),
    }
    if (
      !release.systemKey ||
      !systemKeys.has(release.systemKey) ||
      !release.version ||
      !release.scope ||
      !release.sourceUrl ||
      !/^[0-9a-f]{64}$/.test(release.sourceSha256) ||
      !Number.isInteger(release.expectedCount) ||
      release.expectedCount <= 0 ||
      currentRaw !== "true"
    ) {
      throw new Error(`Fila inválida en procedure_catalog_release.csv: ${line}`)
    }
    return release
  })
  if (releases.length === 0) throw new Error("procedure_catalog_release.csv sin ediciones")
  if (new Set(releases.map((r) => r.systemKey)).size !== releases.length) {
    throw new Error("procedure_catalog_release.csv: una sola edición vigente por lista")
  }

  // --- Códigos de cada lista (display al final: puede contener comas) ---
  const codesBySystem = new Map(
    releases.map((release) => {
      const file = codesFileOf(release.systemKey)
      const codes = strictLines(file, "system_key,code,version,section,display").map((line) => {
        const [systemKey, code, version, section, display] = splitHead(line, 5)
        if (!systemKey || !code || !version || !display) throw new Error(`Línea inválida en ${file}: ${line}`)
        if (systemKey !== release.systemKey || version !== release.version) {
          throw new Error(`Código fuera de la edición vigente en ${file}: ${code}`)
        }
        return { systemKey, code, version, section: section || null, display }
      })
      if (codes.length !== release.expectedCount) {
        throw new Error(`Cobertura de ${file}: ${codes.length} códigos frente a expected_count=${release.expectedCount}`)
      }
      if (new Set(codes.map((c) => c.code)).size !== codes.length) throw new Error(`Códigos duplicados en ${file}`)
      return [release.systemKey, codes] as const
    }),
  )

  const codeSets = new Map([...codesBySystem].map(([system, codes]) => [system, new Set(codes.map((c) => c.code))]))

  // --- Los códigos de cada producto: de una lista cargada y vigentes en ella ---
  const products = strictLines("procedure_code_products.csv", "system_key,product,code").map((line) => {
    const [systemKey, product, code] = splitHead(line, 3)
    if (!systemKey || !product || !/^[a-z]+$/.test(product) || !code) {
      throw new Error(`Línea inválida en procedure_code_products.csv: ${line}`)
    }
    if (!codeSets.get(systemKey)?.has(code)) {
      throw new Error(`Código de un producto que no está en la edición vigente: ${systemKey} ${code}`)
    }
    return { systemKey, product, code }
  })
  if (new Set(products.map((p) => `${p.systemKey}:${p.product}:${p.code}`)).size !== products.length) {
    throw new Error("Códigos repetidos en procedure_code_products.csv")
  }

  return { systems, releases, codesBySystem, codeSets, products }
}

/**
 * La biblioteca de un producto, que se siembra con las listas en la misma
 * transacción (odentIA: `dental/library.ts`, ADR 0069 y 0079).
 */
export interface CatalogLibrary {
  /** Lee y valida sus CSV contra las listas; fail closed antes de tocar la base. */
  prepare(lists: ProcedureLists): PreparedLibrary
}

export interface PreparedLibrary {
  templates: number
  /** Cuántos tratamientos lleva ligados la edición vigente de una lista. */
  mappings(systemKey: string): number
  /** Siembra sus tratamientos y sus códigos y concilia sus tratamientos. */
  seed(tx: Db): Promise<void>
}

/**
 * Siembra idempotente de las listas oficiales sobre una conexión owner y, si
 * se da, de la biblioteca de un producto con sus códigos.
 */
export async function seedProcedureCodes(db: Db, library?: CatalogLibrary): Promise<ProcedureCodesSeedResult> {
  const lists = loadProcedureLists()
  const { systems, releases, codesBySystem, products } = lists
  const prepared = library?.prepare(lists) ?? null
  const mappingsOf = (system: string) => prepared?.mappings(system) ?? null

  await db.transaction(async (tx) => {
    // Lock por lista, en orden fijo: dos seeds concurrentes se serializan.
    for (const release of [...releases].sort((a, b) => a.systemKey.localeCompare(b.systemKey))) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${"procedure-seed:" + release.systemKey}))`,
      )
    }
    // Una lista vigente en la base que ya no está en el CSV no se retira sola:
    // dejarla vigente en silencio o apagarla sin querer son igual de malos.
    // Retirarla es una decisión: se hace a mano antes de sembrar.
    const current = (await tx.execute(
      sql`select "system_key" from "procedure_catalog_release" where "is_current"`,
    )) as unknown as { system_key: string }[]
    const inCsv = new Set(releases.map((r) => r.systemKey))
    const orphan = current.find((row) => !inCsv.has(row.system_key))
    if (orphan) {
      throw new Error(
        `La lista ${orphan.system_key} sigue vigente en la base pero ya no está en procedure_catalog_release.csv: retírala a mano antes de sembrar`,
      )
    }
    for (const s of systems) {
      await tx.execute(
        sql`insert into "procedure_code_system" ("key", "title", "publisher", "country", "license", "source_url")
          values (${s.key}, ${s.title}, ${s.publisher}, ${s.country}, ${s.license}, ${s.sourceUrl})
          on conflict ("key") do update set
            "title" = excluded."title",
            "publisher" = excluded."publisher",
            "country" = excluded."country",
            "license" = excluded."license",
            "source_url" = excluded."source_url"`,
      )
    }

    for (const release of releases) {
      // Protección anti-retroceso: si el CSV trae una edición inactiva mientras
      // otra sigue vigente, se rechaza en vez de apagar la nueva en silencio.
      // Retirar una edición vigente requiere hacerlo a mano antes de sembrar.
      const existing = (await tx.execute(
        sql`select "version", "is_current" from "procedure_catalog_release"
          where "system_key" = ${release.systemKey}`,
      )) as unknown as { version: string; is_current: boolean }[]
      const otherCurrent = existing.find((r) => r.is_current && r.version !== release.version)
      if (otherCurrent && existing.some((r) => r.version === release.version && !r.is_current)) {
        throw new Error(
          `Edición ${otherCurrent.version} vigente; el seed trae ${release.version} inactiva en DB: ` +
            `no se importa una edición anterior sobre la vigente`,
        )
      }
      // Edición vigente: solo desactiva las demás (jamás reactiva anteriores).
      await tx.execute(
        sql`update "procedure_catalog_release" set "is_current" = false
          where "system_key" = ${release.systemKey} and "version" <> ${release.version}`,
      )
      await tx.execute(
        sql`insert into "procedure_catalog_release"
          ("system_key", "version", "scope", "source_url", "source_sha256", "expected_count", "is_current")
          values (${release.systemKey}, ${release.version}, ${release.scope}, ${release.sourceUrl},
                  ${release.sourceSha256}, ${release.expectedCount}, true)
          on conflict ("system_key", "version") do update set
            "scope" = excluded."scope",
            "source_url" = excluded."source_url",
            "source_sha256" = excluded."source_sha256",
            "expected_count" = excluded."expected_count",
            "is_current" = true`,
      )
      const codes = codesBySystem.get(release.systemKey)!
      for (const batch of chunks(codes)) {
        await tx.execute(
          sql`insert into "procedure_code" ("system_key", "code", "version", "section", "display", "is_active")
            values ${sql.join(
              batch.map((c) => sql`(${c.systemKey}, ${c.code}, ${c.version}, ${c.section}, ${c.display}, true)`),
              sql`, `,
            )}
            on conflict ("system_key", "code", "version") do update set
              "section" = excluded."section",
              "display" = excluded."display",
              "is_active" = true`,
        )
      }
      // Códigos fuera del ámbito o de versiones previas quedan inactivos (p. ej.
      // el 15849 de la CPMS); las filas históricas se conservan, nunca se borran.
      await tx.execute(
        sql`update "procedure_code" set "is_active" = false
          where "system_key" = ${release.systemKey} and "version" <> ${release.version}`,
      )
      await tx.execute(
        sql`update "procedure_code" set "is_active" = false
          where "system_key" = ${release.systemKey} and "version" = ${release.version}
            and ${notInArray(
              sql`"code"`,
              codes.map((c) => c.code),
            )}`,
      )
    }

    // La biblioteca del producto, si la hay, con su código en cada lista.
    if (prepared) await prepared.seed(tx)

    // Los códigos de cada producto se reemplazan enteros, lista por lista.
    for (const release of releases) {
      await tx.execute(sql`delete from "procedure_code_product" where "system_key" = ${release.systemKey}`)
    }
    for (const batch of chunks(products)) {
      await tx.execute(
        sql`insert into "procedure_code_product" ("system_key", "product", "code")
          values ${sql.join(
            batch.map((p) => sql`(${p.systemKey}, ${p.product}, ${p.code})`),
            sql`, `,
          )}`,
      )
    }

    // Conciliación dentro de la transacción: cobertura exacta o rollback.
    for (const release of releases) {
      const [row] = (await tx.execute(sql`
        select
          (select count(*)::int from "procedure_code"
            where "system_key" = ${release.systemKey} and "version" = ${release.version} and "is_active") as codes,
          (select count(*)::int from "treatment_template_code"
            where "system_key" = ${release.systemKey} and "version" = ${release.version}) as mappings`)) as unknown as {
        codes: number
        mappings: number
      }[]
      // Sin biblioteca no se toca lo ligado: solo se concilian los códigos.
      const expectedMappings = mappingsOf(release.systemKey) ?? row?.mappings
      if (row?.codes !== release.expectedCount || row?.mappings !== expectedMappings) {
        throw new Error(
          `Conciliación falló (${release.systemKey}): ${row?.codes} códigos frente a ${release.expectedCount}, ` +
            `${row?.mappings} tratamientos ligados frente a ${expectedMappings}`,
        )
      }
    }
  })

  return {
    systems: systems.length,
    codes: [...codesBySystem.values()].reduce((sum, codes) => sum + codes.length, 0),
    templates: prepared?.templates ?? 0,
    releases: releases.map((release) => ({
      systemKey: release.systemKey,
      version: release.version,
      codes: codesBySystem.get(release.systemKey)!.length,
      mappings: mappingsOf(release.systemKey) ?? 0,
    })),
  }
}