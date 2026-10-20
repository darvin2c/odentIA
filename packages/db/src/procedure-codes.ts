/**
 * Siembra el catálogo de servicios (ADR 0067): las listas oficiales de cada
 * país y la biblioteca de odentIA con el código de cada tratamiento en ellas.
 *
 * - Listas oficiales: hoy la CPMS (RM-550-2023-MINSA), con sus 505 códigos
 *   odontológicos tal cual y su procedencia. Los CSV salen de
 *   `pnpm --filter @odentia/db import:cpms` desde el XLSX oficial (SHA-256
 *   verificado). Este seed NO lee el XLSX.
 * - Biblioteca: `seeds/biblioteca.csv`, tratamientos de consultorio con nombre
 *   propio, tipo, ámbito, lo que dejan en la pieza y si van en «Más usados»;
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

  // --- Biblioteca (name al final: puede contener comas) ---
  const SCOPES: ReadonlySet<string> = new Set(TREATMENT_SCOPES)
  const KINDS: ReadonlySet<string> = new Set(TREATMENT_KIND_KEYS)
  const templates = strictLines(
    "biblioteca.csv",
    "key,kind,scope,surface_count_min,surface_count_max,leaves_condition,leaves_variant,common,name",
  ).map((line) => {
    const [key, kind, scope, minRaw, maxRaw, condition, variant, common, name] = splitHead(line, 9)
    const min = minRaw === "" ? null : Number(minRaw)
    const max = maxRaw === "" ? null : Number(maxRaw)
    if (
      !key ||
      !/^[a-z0-9-]+$/.test(key) ||
      !KINDS.has(kind!) ||
      !SCOPES.has(scope!) ||
      !name ||
      (common !== "true" && common !== "false") ||
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
    return { key, kind: kind!, scope: scope!, min, max, leaves, common: common === "true", name }
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
  if (provenance.length !== release.expectedCount) {
    throw new Error("Cobertura: la procedencia no concilia con expected_count")
  }
  if (new Set(codes.map((c) => `${c.systemKey}:${c.code}:${c.version}`)).size !== codes.length) {
    throw new Error("Códigos duplicados en procedure_codes_cpms.csv")
  }
  if (new Set(templates.map((t) => t.key)).size !== templates.length) {
    throw new Error("Tratamientos duplicados en biblioteca.csv")
  }
  if (new Set(templates.map((t) => t.name.toLowerCase())).size !== templates.length) {
    throw new Error("Nombres repetidos en biblioteca.csv")
  }
  const codeByKey = new Map(codes.map((c) => [`${c.systemKey}:${c.code}:${c.version}`, c]))
  const templateKeys = new Set(templates.map((t) => t.key))
  const perList = new Set<string>()
  for (const m of mappings) {
    if (!templateKeys.has(m.templateKey)) throw new Error(`Código de un tratamiento que no está: ${m.templateKey}`)
    if (!codeByKey.has(`${m.systemKey}:${m.code}:${m.version}`)) {
      throw new Error(`Código inexistente en la lista: ${m.systemKey} ${m.code} ${m.version}`)
    }
    if (m.systemKey !== release.systemKey || m.version !== release.version) {
      throw new Error(`Código fuera de la edición vigente: ${m.templateKey}`)
    }
    const list = `${m.templateKey}:${m.systemKey}:${m.version}`
    if (perList.has(list)) throw new Error(`Dos códigos de la misma lista para ${m.templateKey}`)
    perList.add(list)
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

  return { systems, release, codes, templates, mappings }
}

/** Siembra idempotente del catálogo oficial sobre una conexión owner. */
export async function seedProcedureCodes(db: Db): Promise<ProcedureCodesSeedResult> {
  const { systems, release, codes, templates, mappings } = loadLibrary()
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
      const leaves = t.leaves ? JSON.stringify(t.leaves) : null
      await tx.execute(
        sql`insert into "treatment_template"
        ("key", "name", "specialty", "scope", "surface_count_min", "surface_count_max", "leaves_finding", "is_common", "is_active", "version")
        values (${t.key}, ${t.name}, ${t.kind}, ${t.scope}, ${t.min}, ${t.max}, ${leaves}::jsonb, ${t.common}, true, 1)
        on conflict ("key") do update set
          "name" = excluded."name",
          "specialty" = excluded."specialty",
          "scope" = excluded."scope",
          "surface_count_min" = excluded."surface_count_min",
          "surface_count_max" = excluded."surface_count_max",
          "leaves_finding" = excluded."leaves_finding",
          "is_common" = excluded."is_common",
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
    // El código de cada tratamiento en esta edición se reemplaza entero: un
    // cambio de código en el CSV no deja el viejo. Otras ediciones y listas no
    // se tocan.
    await tx.execute(
      sql`delete from "treatment_template_code"
        where "system_key" = ${release.systemKey} and "version" = ${release.version}`,
    )
    for (const m of mappings) {
      await tx.execute(
        sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version")
          select "id", ${m.systemKey}, ${m.code}, ${m.version} from "treatment_template" where "key" = ${m.templateKey}`,
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
      select 'mappings', count(*)::text from "treatment_template_code"
        where "system_key" = ${release.systemKey} and "version" = ${release.version}`)) as unknown as {
      kind: string
      count: string
    }[]
    const got = new Map(checks.map((r) => [r.kind, Number(r.count)]))
    const expected = new Map([
      ["codes", release.expectedCount],
      ["templates", templates.length],
      ["mappings", mappings.length],
    ])
    for (const [kind, count] of expected) {
      if (got.get(kind) !== count) {
        throw new Error(`Conciliación falló (${kind}): ${got.get(kind)} frente a ${count}`)
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