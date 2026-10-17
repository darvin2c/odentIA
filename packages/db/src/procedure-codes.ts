/**
 * Siembra la biblioteca oficial odontológica del CPMS (RM-550-2023-MINSA)
 * como proyección 1:1: cada código oficial del ámbito (secciones 1.3+2.7)
 * produce una prestación con key `cpms:<version>:<code>` y nombre oficial
 * íntegro, con un único mapping por plantilla y por código.
 *
 * Fuente: seeds/*.csv regenerados con `pnpm --filter @odentia/db import:cpms`
 * desde el XLSX oficial (SHA-256 verificado). Este seed NO lee el XLSX.
 *
 * Atómico e idempotente: todo corre en una transacción; valida fuente, datos
 * y cobertura (fail closed) y revierte ante cualquier desvío. No reactiva
 * versiones anteriores: solo desactiva (ediciones no vigentes, códigos fuera
 * del ámbito como 15849, plantillas internas previas). Los históricos
 * (snapshots en planes/presupuestos/atenciones) no se tocan.
 *
 * Orden en CLI: `pnpm --filter @odentia/db migrate` → `seed:diagnoses` →
 * `seed:procedures`. Rol owner (bypasea RLS; el rol app solo lee). Los tests
 * lo invocan directo para no divergir del catálogo real.
 */
import { TREATMENT_SCOPES, TREATMENT_SPECIALTIES } from "@odentia/clinical"
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
  systemKey: string
  version: string
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

  // --- Edición importada (una fila) ---
  const releaseLines = strictLines(
    "procedure_catalog_release.csv",
    "system_key,version,scope,source_url,source_sha256,expected_count,is_current",
  )
  if (releaseLines.length !== 1) throw new Error("procedure_catalog_release.csv debe tener una fila")
  const [relSystem, relVersion, relScope, relSourceUrl, relSha, relExpectedRaw, relCurrentRaw] =
    splitHead(releaseLines[0]!, 7)
  const release = {
    systemKey: relSystem!,
    version: relVersion!,
    scope: relScope!,
    sourceUrl: relSourceUrl!,
    sourceSha256: relSha!,
    expectedCount: Number(relExpectedRaw),
    isCurrent: relCurrentRaw === "true",
  }
  if (
    !release.systemKey ||
    !release.version ||
    !release.scope ||
    !release.sourceUrl ||
    !/^[0-9a-f]{64}$/.test(release.sourceSha256) ||
    !Number.isInteger(release.expectedCount) ||
    release.expectedCount <= 0 ||
    !release.isCurrent
  ) {
    throw new Error(`Fila inválida en procedure_catalog_release.csv: ${releaseLines[0]}`)
  }

  // --- Códigos (display al final: puede contener comas) ---
  const codes = strictLines("procedure_codes_cpms.csv", "system_key,code,version,display").map(
    (line) => {
      const [systemKey, code, version, display] = splitHead(line, 4)
      if (!systemKey || !code || !version || !display) {
        throw new Error(`Línea inválida en procedure_codes_cpms.csv: ${line}`)
      }
      return { systemKey, code, version, display }
    },
  )

  // --- Plantillas 1:1 (name al final: puede contener comas) ---
  const SCOPES: ReadonlySet<string> = new Set(TREATMENT_SCOPES)
  const SPECIALTIES: ReadonlySet<string> = new Set(TREATMENT_SPECIALTIES)
  const templates = strictLines(
    "treatment_templates_cpms.csv",
    "template_key,specialty,scope,surface_count_min,surface_count_max,system_key,code,version,name",
  ).map((line) => {
    const [key, specialty, scope, minRaw, maxRaw, systemKey, code, version, name] = splitHead(
      line,
      9,
    )
    const min = minRaw === "" ? null : Number(minRaw)
    const max = maxRaw === "" ? null : Number(maxRaw)
    if (
      !key ||
      !SPECIALTIES.has(specialty!) ||
      !SCOPES.has(scope!) ||
      !systemKey ||
      !code ||
      !version ||
      !name ||
      (minRaw !== "" && !Number.isInteger(min)) ||
      (maxRaw !== "" && !Number.isInteger(max))
    ) {
      throw new Error(`Línea inválida en treatment_templates_cpms.csv: ${line}`)
    }
    if (key !== `cpms:${version}:${code}`) {
      throw new Error(`Key no proyecta 1:1 el código oficial: ${line}`)
    }
    if (scope === "surfaces" && (min === null || max === null)) {
      throw new Error(`Scope surfaces sin conteo: ${line}`)
    }
    if (scope !== "surfaces" && (min !== null || max !== null)) {
      throw new Error(`Conteo fuera de scope surfaces: ${line}`)
    }
    return { key, specialty, scope: scope!, min, max, systemKey, code, version, name }
  })

  // --- Procedencia (conciliación; denominación al final) ---
  const provenance = strictLines(
    "cpms_scope_provenance.csv",
    "code,n_oficial,grupo,seccion,subseccion,nombre_subseccion,denominacion",
  ).map((line) => {
    const [code, n, group, section, subsection, subsectionName, display] = splitHead(line, 7)
    if (!code || !n || !group || !section || !subsection || !subsectionName || !display) {
      throw new Error(`Línea inválida en cpms_scope_provenance.csv: ${line}`)
    }
    return { code, display }
  })

  // --- Validación cruzada fuente/datos/cobertura (antes de tocar la DB) ---
  if (codes.length !== release.expectedCount) {
    throw new Error(
      `Cobertura: ${codes.length} códigos frente a expected_count=${release.expectedCount}`,
    )
  }
  if (templates.length !== release.expectedCount || provenance.length !== release.expectedCount) {
    throw new Error("Cobertura: plantillas o procedencia no concilian con expected_count")
  }
  if (new Set(codes.map((c) => `${c.systemKey}:${c.code}:${c.version}`)).size !== codes.length) {
    throw new Error("Códigos duplicados en procedure_codes_cpms.csv")
  }
  if (new Set(templates.map((t) => t.key)).size !== templates.length) {
    throw new Error("Plantillas duplicadas en treatment_templates_cpms.csv")
  }
  const codeByKey = new Map(codes.map((c) => [`${c.systemKey}:${c.code}:${c.version}`, c]))
  for (const t of templates) {
    const code = codeByKey.get(`${t.systemKey}:${t.code}:${t.version}`)
    if (!code) throw new Error(`Plantilla sin código en catálogo: ${t.key}`)
    if (code.display !== t.name)
      throw new Error(`Nombre distinto a la denominación oficial: ${t.key}`)
    if (t.systemKey !== release.systemKey || t.version !== release.version) {
      throw new Error(`Plantilla fuera de la edición vigente: ${t.key}`)
    }
  }
  const provByCode = new Map(provenance.map((p) => [p.code, p.display]))
  for (const c of codes) {
    if (c.systemKey !== release.systemKey || c.version !== release.version) {
      throw new Error(`Código fuera de la edición vigente: ${c.code}`)
    }
    if (provByCode.get(c.code) !== c.display) {
      throw new Error(`Código sin procedencia o denominación distinta: ${c.code}`)
    }
  }

  return { systems, release, codes, templates }
}

/** Siembra idempotente del catálogo oficial sobre una conexión owner. */
export async function seedProcedureCodes(db: Db): Promise<ProcedureCodesSeedResult> {
  const { systems, release, codes, templates } = loadLibrary()
  const scopeKeys = templates.map((t) => t.key)
  const scopeCodes = codes.map((c) => c.code)

  await db.transaction(async (tx) => {
    // Lock por sistema: dos seeds concurrentes del mismo sistema se serializan.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${"procedure-seed:" + release.systemKey}))`,
    )
    // Protección anti-retroceso: si el CSV trae una edición inactiva mientras otra
    // sigue vigente, se rechaza en vez de apagar la nueva silenciosamente. Retirar
    // una edición vigente requiere hacerlo a mano antes de sembrar la anterior.
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

    for (const c of codes) {
      await tx.execute(
        sql`insert into "procedure_code" ("system_key", "code", "version", "display", "is_active")
          values (${c.systemKey}, ${c.code}, ${c.version}, ${c.display}, true)
          on conflict ("system_key", "code", "version") do update set
            "display" = excluded."display",
            "is_active" = true`,
      )
    }
    // Códigos fuera del ámbito o de versiones previas quedan inactivos (p. ej. 15849);
    // las filas históricas se conservan, nunca se borran.
    await tx.execute(
      sql`update "procedure_code" set "is_active" = false
        where "system_key" = ${release.systemKey} and "version" <> ${release.version}`,
    )
    await tx.execute(
      sql`update "procedure_code" set "is_active" = false
        where "system_key" = ${release.systemKey} and "version" = ${release.version}
          and ${notInArray(sql`"code"`, scopeCodes)}`,
    )

    for (const t of templates) {
      await tx.execute(
        sql`insert into "treatment_template"
        ("key", "name", "specialty", "scope", "surface_count_min", "surface_count_max", "is_active", "version")
        values (${t.key}, ${t.name}, ${t.specialty}, ${t.scope}, ${t.min}, ${t.max}, true, 1)
        on conflict ("key") do update set
          "name" = excluded."name",
          "specialty" = excluded."specialty",
          "scope" = excluded."scope",
          "surface_count_min" = excluded."surface_count_min",
          "surface_count_max" = excluded."surface_count_max",
          "is_active" = true,
          "version" = "treatment_template"."version" + (
            ("treatment_template"."name", "treatment_template"."specialty", "treatment_template"."scope",
             "treatment_template"."surface_count_min", "treatment_template"."surface_count_max")
            IS DISTINCT FROM
            (excluded."name", excluded."specialty", excluded."scope",
             excluded."surface_count_min", excluded."surface_count_max")
          )::int`,
      )
    }
    // Plantillas internas previas y versiones CPMS retiradas quedan inactivas; las
    // filas se conservan. No toca otros sistemas: solo claves internas (un `:`) y
    // las propias `cpms:`.
    await tx.execute(
      sql`update "treatment_template" set "is_active" = false
        where ${notInArray(sql`"key"`, scopeKeys)}
          and ("key" not like '%:%:%' or "key" like 'cpms:%')`,
    )
    // Mappings 1:1 por upsert, sin borrar: los de versiones oficiales retiradas se
    // conservan para detalle de lectura y referencias de ofertas; solo se
    // desactivan plantillas y códigos. El único por plantilla impide divergencias
    // (una fila distinta para la misma plantilla falla y revierte).
    for (const t of templates) {
      const found = await tx.execute(
        sql`select "id" from "treatment_template" where "key" = ${t.key} limit 1`,
      )
      const templateId = (found as unknown as { id: string }[])[0]?.id
      if (!templateId) throw new Error(`Plantilla no sembrada: ${t.key}`)
      await tx.execute(
        sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version", "is_primary")
          values (${templateId}, ${t.systemKey}, ${t.code}, ${t.version}, true)
          on conflict ("template_id", "system_key", "code", "version") do update set
            "is_primary" = true`,
      )
    }

    // Conciliación dentro de la transacción: cobertura exacta o rollback.
    const checks = (await tx.execute(sql`
      select 'codes' as kind, count(*)::text as count from "procedure_code"
        where "system_key" = ${release.systemKey} and "version" = ${release.version} and "is_active"
      union all
      select 'templates', count(*)::text from "treatment_template"
        where ${inArray(sql`"key"`, scopeKeys)} and "is_active"
      union all
      select 'mappings', count(*)::text from "treatment_template_code" where
        "template_id" in (select "id" from "treatment_template" where ${inArray(sql`"key"`, scopeKeys)})`)) as unknown as {
      kind: string
      count: string
    }[]
    const got = new Map(checks.map((r) => [r.kind, Number(r.count)]))
    for (const kind of ["codes", "templates", "mappings"]) {
      if (got.get(kind) !== release.expectedCount) {
        throw new Error(
          `Conciliación falló (${kind}): ${got.get(kind)} frente a ${release.expectedCount}`,
        )
      }
    }
  })

  return {
    systems: systems.length,
    codes: codes.length,
    templates: templates.length,
    systemKey: release.systemKey,
    version: release.version,
  }
}