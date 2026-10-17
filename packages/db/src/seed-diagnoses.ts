import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type DiagnosisSystemKey, isDiagnosisSystem } from "@odentia/clinical"
import { and, eq, sql } from "drizzle-orm"
import { createOwnerDb } from "./client.js"
import {
  assertSha256,
  type DiagnosisCatalogRow,
  parseDiagnosisFile,
  prepareDiagnosisRows,
} from "./diagnosis-import.js"
import { diagnosisCatalog, diagnosisCodeRelease } from "./schema/clinical.js"

/**
 * Carga las listas de diagnósticos (ADR 0041). Idempotente: actualiza título,
 * edición y URI de cada código y nunca borra uno (los diagnósticos
 * registrados lo referencian).
 *
 * Sin variables carga las dos semillas mínimas de desarrollo, que NO son
 * listas oficiales: `seeds/cie10.csv` (los 124 códigos de la cavidad bucal y
 * Z01.2, sin fuente verificada) y `seeds/cie11-minimo.csv` (unos pocos
 * códigos de la boca y los dientes, por verificar contra la OMS).
 *
 * Un archivo oficial entra con su lista, su edición, su licencia y el SHA-256
 * calculado al descargarlo; se verifica antes de escribir nada:
 *
 *   DIAGNOSIS_SYSTEM=ICD-10 DIAGNOSIS_FILE=/ruta/cie10.xml DIAGNOSIS_SHA256=<hash> \
 *   DIAGNOSIS_EDITION=2019 DIAGNOSIS_LICENSE="<permiso escrito de la OPS>" \
 *   DIAGNOSIS_SOURCE_URL=<url> pnpm --filter @odentia/db seed:diagnoses
 *
 * La CIE-11 de la OMS (licencia CC BY-ND 3.0 IGO: se cita la fuente y se
 * guardan código, título y URI sin modificarlos) se carga con la tabulación
 * que publica la OMS (columnas Code, Title, ClassKind y la URI):
 *
 *   CIE11_FILE=/ruta/SimpleTabulation-ICD-11-MMS-es.txt CIE11_SHA256=<hash> \
 *   CIE11_EDITION=2025-01 pnpm --filter @odentia/db seed:diagnoses
 *
 * Una lista nacional (CIE-10 MINSA, CIE-10-ES) es otra lista: va con su
 * `DIAGNOSIS_SYSTEM` (ICD-10-PE, ICD-10-ES), nunca en lugar de la de la OMS.
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const here = dirname(fileURLToPath(import.meta.url))

interface Load {
  system: DiagnosisSystemKey
  edition: string
  official: boolean
  license: string
  sourceUrl: string | null
  sha256: string | null
  path: string
}

const WHO_ICD11_LICENSE =
  "CIE-11 © Organización Mundial de la Salud, licencia CC BY-ND 3.0 IGO (https://icd.who.int/es/docs/icd11-license.pdf): se cita la fuente y no se modifica el contenido."

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} es obligatoria para cargar un archivo oficial`)
  return value
}

function loads(): Load[] {
  if (process.env.CIE11_FILE) {
    return [
      {
        system: "ICD-11",
        edition: required("CIE11_EDITION"),
        official: true,
        license: process.env.CIE11_LICENSE?.trim() || WHO_ICD11_LICENSE,
        sourceUrl: process.env.CIE11_SOURCE_URL?.trim() || "https://icd.who.int/",
        sha256: required("CIE11_SHA256"),
        path: required("CIE11_FILE"),
      },
    ]
  }
  if (process.env.DIAGNOSIS_FILE) {
    const system = required("DIAGNOSIS_SYSTEM")
    if (!isDiagnosisSystem(system)) throw new Error(`Lista desconocida: ${system}`)
    return [
      {
        system,
        edition: required("DIAGNOSIS_EDITION"),
        official: true,
        license: required("DIAGNOSIS_LICENSE"),
        sourceUrl: required("DIAGNOSIS_SOURCE_URL"),
        sha256: required("DIAGNOSIS_SHA256"),
        path: required("DIAGNOSIS_FILE"),
      },
    ]
  }
  if (process.env.CIE10_FILE)
    throw new Error("CIE10_FILE ya no se usa: indica DIAGNOSIS_SYSTEM=ICD-10 y DIAGNOSIS_FILE")
  return [
    {
      system: "ICD-10",
      edition: "semilla-desarrollo",
      official: false,
      license:
        "Semilla mínima de desarrollo, no oficial: sin fuente verificada ni permiso de uso comercial.",
      sourceUrl: null,
      sha256: null,
      path: join(here, "..", "seeds", "cie10.csv"),
    },
    {
      system: "ICD-11",
      edition: "semilla-desarrollo",
      official: false,
      license: `Semilla mínima de desarrollo, no oficial: verificar contra la OMS. ${WHO_ICD11_LICENSE}`,
      sourceUrl: null,
      sha256: null,
      path: join(here, "..", "seeds", "cie11-minimo.csv"),
    },
  ]
}

const db = createOwnerDb(url)
for (const load of loads()) {
  const bytes = readFileSync(load.path)
  const sha = load.sha256 ? assertSha256(bytes, load.sha256) : null
  const rows: DiagnosisCatalogRow[] = prepareDiagnosisRows(
    load.system,
    parseDiagnosisFile(bytes.toString("utf8")),
  )
  await db.transaction(async (tx) => {
    await tx
      .insert(diagnosisCodeRelease)
      .values({
        systemKey: load.system,
        edition: load.edition,
        official: load.official,
        license: load.license,
        sourceUrl: load.sourceUrl,
        sourceSha256: sha,
        codeCount: rows.length,
      })
      .onConflictDoUpdate({
        target: [diagnosisCodeRelease.systemKey, diagnosisCodeRelease.edition],
        set: {
          official: load.official,
          license: load.license,
          sourceUrl: load.sourceUrl,
          sourceSha256: sha,
          codeCount: rows.length,
          loadedAt: new Date(),
        },
      })
    for (let start = 0; start < rows.length; start += 500) {
      await tx
        .insert(diagnosisCatalog)
        .values(
          rows.slice(start, start + 500).map((row) => ({
            systemKey: load.system,
            code: row.code,
            edition: load.edition,
            title: row.title,
            uri: row.uri,
            isCategory: row.isCategory,
            isDental: row.isDental,
            searchText: row.searchText,
          })),
        )
        .onConflictDoUpdate({
          target: [diagnosisCatalog.systemKey, diagnosisCatalog.code],
          set: {
            edition: sql`excluded."edition"`,
            title: sql`excluded."title"`,
            uri: sql`excluded."uri"`,
            isDental: sql`excluded."is_dental"`,
            searchText: sql`excluded."search_text"`,
          },
        })
    }
    // Una categoría lo es por los códigos de toda la lista, también los de otra carga.
    const all = await tx
      .select({ code: diagnosisCatalog.code, isCategory: diagnosisCatalog.isCategory })
      .from(diagnosisCatalog)
      .where(eq(diagnosisCatalog.systemKey, load.system))
    const prefixes = new Set<string>()
    for (const { code } of all)
      for (let end = 3; end < code.length; end++) prefixes.add(code.slice(0, end))
    for (const { code, isCategory } of all) {
      if (prefixes.has(code) === isCategory) continue
      await tx
        .update(diagnosisCatalog)
        .set({ isCategory: prefixes.has(code) })
        .where(and(eq(diagnosisCatalog.systemKey, load.system), eq(diagnosisCatalog.code, code)))
    }
  })
  console.log(
    `${load.system} ${load.edition}: ${rows.length} códigos${load.official ? " (archivo oficial verificado)" : " (semilla de desarrollo, no oficial)"}`,
  )
}
process.exit(0)
