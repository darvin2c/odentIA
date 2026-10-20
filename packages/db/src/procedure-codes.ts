/**
 * Siembra el catálogo de servicios (ADR 0067): las listas oficiales de cada
 * país y la biblioteca de odentIA con el código de cada tratamiento en ellas.
 *
 * - Listas oficiales: una edición vigente por lista
 *   (`procedure_catalog_release.csv`), con sus códigos odontológicos tal cual
 *   en `procedure_codes_<lista>.csv` (p. ej. la CPMS del Perú, 505 códigos,
 *   con su procedencia; la CUPS de Colombia). Cada CSV sale del archivo
 *   oficial con su SHA-256 (la CPMS con `import:cpms`). Este seed NO lee los
 *   archivos oficiales.
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
import { TREATMENT_KIND_KEYS, TREATMENT_SCOPES, validateLeavesFinding } from "@odentia/clinical"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { TextDecoder } from "node:util"
import { fileURLToPath } from "node:url"
import { inArray, notInArray, sql } from "drizzle-orm"
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

/**
 * Procedencia por lista, para las que el importador la genera desde el archivo
 * oficial: cada código con su denominación, que debe coincidir.
 */
const PROVENANCE: Record<string, { file: string; header: string; fields: number }> = {
  CPMS: {
    file: "cpms_scope_provenance.csv",
    header: "code,n_oficial,grupo,seccion,subseccion,nombre_subseccion,denominacion",
    fields: 7,
  },
}

function strictLines(file: string, header: string): string[] {
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

function splitHead(line: string, n: number): string[] {
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

/** Carga y valida los CSV; fail closed antes de tocar la base. */
function loadLibrary() {
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
      const codes = strictLines(file, "system_key,code,version,display").map((line) => {
        const [systemKey, code, version, display] = splitHead(line, 4)
        if (!systemKey || !code || !version || !display) throw new Error(`Línea inválida en ${file}: ${line}`)
        if (systemKey !== release.systemKey || version !== release.version) {
          throw new Error(`Código fuera de la edición vigente en ${file}: ${code}`)
        }
        return { systemKey, code, version, display }
      })
      if (codes.length !== release.expectedCount) {
        throw new Error(`Cobertura de ${file}: ${codes.length} códigos frente a expected_count=${release.expectedCount}`)
      }
      if (new Set(codes.map((c) => c.code)).size !== codes.length) throw new Error(`Códigos duplicados en ${file}`)
      const provenance = PROVENANCE[release.systemKey]
      if (provenance) {
        const displays = new Map(
          strictLines(provenance.file, provenance.header).map((line) => {
            const parts = splitHead(line, provenance.fields)
            if (parts.some((part) => !part)) throw new Error(`Línea inválida en ${provenance.file}: ${line}`)
            return [parts[0]!, parts[provenance.fields - 1]!] as const
          }),
        )
        if (displays.size !== release.expectedCount) {
          throw new Error(`Cobertura: ${provenance.file} no concilia con expected_count`)
        }
        for (const c of codes) {
          if (displays.get(c.code) !== c.display) throw new Error(`Código sin procedencia o denominación distinta: ${c.code}`)
        }
      }
      return [release.systemKey, codes] as const
    }),
  )

  // --- Biblioteca (name al final: puede contener comas) ---
  const SCOPES: ReadonlySet<string> = new Set(TREATMENT_SCOPES)
  const KINDS: ReadonlySet<string> = new Set(TREATMENT_KIND_KEYS)
  const templates = strictLines(
    "biblioteca.csv",
    "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,coded_only,name",
  ).map((line) => {
    const [key, kind, scope, minRaw, maxRaw, condition, variant, common, codedOnly, name] = splitHead(line, 10)
    const min = minRaw === "" ? null : Number(minRaw)
    const max = maxRaw === "" ? null : Number(maxRaw)
    if (
      !key ||
      !/^[a-z0-9-]+$/.test(key) ||
      !KINDS.has(kind!) ||
      !SCOPES.has(scope!) ||
      !name ||
      (common !== "true" && common !== "false") ||
      (codedOnly !== "true" && codedOnly !== "false") ||
      (minRaw !== "" && !Number.isInteger(min)) ||
      (maxRaw !== "" && !Number.isInteger(max))
    ) {
      throw new Error(`Línea inválida en biblioteca.csv: ${line}`)
    }
    if (scope === "surfaces" && (min === null || max === null || min < 1 || min > max)) {
      throw new Error(`Scope surfaces sin conteo válido: ${line}`)
    }
    if (scope !== "surfaces" && (min !== null || max !== null)) {
      throw new Error(`Conteo fuera de scope surfaces: ${line}`)
    }
    if (!condition && variant) throw new Error(`Variante sin hallazgo: ${line}`)
    const leaves = condition ? (variant ? { condition, variant } : { condition }) : null
    // Lo que deja en la pieza encaja con el ámbito; la variante, si va, existe.
    if (leaves && validateLeavesFinding(leaves, { scope, strictVariants: false }).length > 0) {
      throw new Error(`Lo que deja en la pieza no encaja: ${line}`)
    }
    return { key, kind: kind!, scope: scope!, min, max, leaves, common: common === "true", codedOnly: codedOnly === "true", name }
  })

  // --- Código de cada tratamiento en cada lista ---
  const mappings = strictLines("biblioteca_codigos.csv", "template_key,system_key,code,version").map(
    (line) => {
      const [templateKey, systemKey, code, version] = splitHead(line, 4)
      if (!templateKey || !systemKey || !code || !version) {
        throw new Error(`Línea inválida en biblioteca_codigos.csv: ${line}`)
      }
      return { templateKey, systemKey, code, version }
    },
  )

  // --- Validación cruzada de la biblioteca (antes de tocar la DB) ---
  if (new Set(templates.map((t) => t.key)).size !== templates.length) {
    throw new Error("Tratamientos duplicados en biblioteca.csv")
  }
  if (new Set(templates.map((t) => t.name.toLowerCase())).size !== templates.length) {
    throw new Error("Nombres repetidos en biblioteca.csv")
  }
  const coded = new Set(mappings.map((m) => m.templateKey))
  for (const t of templates) {
    if (t.codedOnly && !coded.has(t.key)) throw new Error(`Variante sin código en ninguna lista: ${t.key}`)
  }
  const releaseOf = new Map(releases.map((r) => [r.systemKey, r]))
  const codeSets = new Map([...codesBySystem].map(([system, codes]) => [system, new Set(codes.map((c) => c.code))]))
  const templateKeys = new Set(templates.map((t) => t.key))
  const perList = new Set<string>()
  for (const m of mappings) {
    if (!templateKeys.has(m.templateKey)) throw new Error(`Código de un tratamiento que no está: ${m.templateKey}`)
    if (releaseOf.get(m.systemKey)?.version !== m.version) {
      throw new Error(`Código fuera de la edición vigente: ${m.templateKey} ${m.systemKey} ${m.version}`)
    }
    if (!codeSets.get(m.systemKey)!.has(m.code)) {
      throw new Error(`Código inexistente en la lista: ${m.systemKey} ${m.code} ${m.version}`)
    }
    const list = `${m.templateKey}:${m.systemKey}`
    if (perList.has(list)) throw new Error(`Dos códigos de la misma lista para ${m.templateKey}`)
    perList.add(list)
  }

  return { systems, releases, codesBySystem, templates, mappings }
}

/** Siembra idempotente del catálogo oficial sobre una conexión owner. */
export async function seedProcedureCodes(db: Db): Promise<ProcedureCodesSeedResult> {
  const { systems, releases, codesBySystem, templates, mappings } = loadLibrary()
  const scopeKeys = templates.map((t) => t.key)

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
      for (const c of codes) {
        await tx.execute(
          sql`insert into "procedure_code" ("system_key", "code", "version", "display", "is_active")
            values (${c.systemKey}, ${c.code}, ${c.version}, ${c.display}, true)
            on conflict ("system_key", "code", "version") do update set
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

    for (const t of templates) {
      const leaves = t.leaves ? JSON.stringify(t.leaves) : null
      await tx.execute(
        sql`insert into "treatment_template"
        ("key", "name", "specialty", "scope", "surface_count_min", "surface_count_max", "leaves_finding", "is_common", "coded_only", "is_active", "version")
        values (${t.key}, ${t.name}, ${t.kind}, ${t.scope}, ${t.min}, ${t.max}, ${leaves}::jsonb, ${t.common}, ${t.codedOnly}, true, 1)
        on conflict ("key") do update set
          "name" = excluded."name",
          "specialty" = excluded."specialty",
          "scope" = excluded."scope",
          "surface_count_min" = excluded."surface_count_min",
          "surface_count_max" = excluded."surface_count_max",
          "leaves_finding" = excluded."leaves_finding",
          "is_common" = excluded."is_common",
          "coded_only" = excluded."coded_only",
          "is_active" = true,
          "version" = "treatment_template"."version" + (
            ("treatment_template"."name", "treatment_template"."specialty", "treatment_template"."scope",
             "treatment_template"."surface_count_min", "treatment_template"."surface_count_max",
             "treatment_template"."leaves_finding")
            IS DISTINCT FROM
            (excluded."name", excluded."specialty", excluded."scope",
             excluded."surface_count_min", excluded."surface_count_max", excluded."leaves_finding")
          )::int`,
      )
    }
    // Lo que ya no está en la biblioteca (las plantillas `cpms:` de antes)
    // queda inactivo; las filas se conservan para los servicios que las usan.
    await tx.execute(
      sql`update "treatment_template" set "is_active" = false where ${notInArray(sql`"key"`, scopeKeys)}`,
    )
    // El código de cada tratamiento en cada edición se reemplaza entero: un
    // cambio de código en el CSV no deja el viejo. Otras ediciones no se tocan.
    for (const release of releases) {
      await tx.execute(
        sql`delete from "treatment_template_code"
          where "system_key" = ${release.systemKey} and "version" = ${release.version}`,
      )
    }
    for (const m of mappings) {
      await tx.execute(
        sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version")
          select "id", ${m.systemKey}, ${m.code}, ${m.version} from "treatment_template" where "key" = ${m.templateKey}`,
      )
    }

    // Conciliación dentro de la transacción: cobertura exacta o rollback.
    const [active] = (await tx.execute(
      sql`select count(*)::int as count from "treatment_template" where ${inArray(sql`"key"`, scopeKeys)} and "is_active"`,
    )) as unknown as { count: number }[]
    if (active?.count !== templates.length) {
      throw new Error(`Conciliación falló (templates): ${active?.count} frente a ${templates.length}`)
    }
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
      const expectedMappings = mappings.filter((m) => m.systemKey === release.systemKey).length
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
    templates: templates.length,
    releases: releases.map((release) => ({
      systemKey: release.systemKey,
      version: release.version,
      codes: codesBySystem.get(release.systemKey)!.length,
      mappings: mappings.filter((m) => m.systemKey === release.systemKey).length,
    })),
  }
}