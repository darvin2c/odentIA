import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { DiagnosisSystemKey } from "@odentia/clinical"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { Db } from "./client.js"
import {
  assertSha256,
  type DiagnosisCatalogRow,
  diagnosisFileText,
  parseDiagnosisFile,
  prepareDiagnosisRows,
} from "./diagnosis-import.js"
import { diagnosisCatalog, diagnosisCodeRelease } from "./schema/clinical.js"

/**
 * Carga de las listas de diagnósticos (ADR 0041). Idempotente: escribe solo
 * los códigos nuevos o cambiados y nunca borra uno (los diagnósticos
 * registrados lo referencian). Sin cambios, no escribe nada, así que puede
 * correr en cada despliegue. La usan `seed:diagnoses` y las pruebas.
 */

const here = dirname(fileURLToPath(import.meta.url))

export interface DiagnosisListLoad {
  system: DiagnosisSystemKey
  edition: string
  official: boolean
  license: string
  sourceUrl: string | null
  /** SHA-256 del archivo tal como se publicó (el .zip, si se descargó así). Obligatorio en una lista oficial. */
  sha256: string | null
  path: string
}

/** La cita que pide la licencia de la CIE-11 (cláusula 1.3) y lo que se carga de ella. */
export const WHO_ICD11_LICENSE =
  "Clasificación Internacional de Enfermedades, undécima revisión (CIE-11), Organización Mundial de la Salud (OMS) 2019, https://icd.who.int/browse11. Licencia Creative Commons Atribución-SinDerivadas 3.0 IGO (CC BY-ND 3.0 IGO), https://icd.who.int/en/docs/icd11-license.pdf. Se cargan los capítulos 01 a 25 con su código, título y URI sin cambios."

/**
 * Listas oficiales que viven en el repositorio, byte a byte como las publica
 * su editor: se cargan en todos los entornos, también en producción al
 * migrar. Solo entra una lista cuya licencia permite redistribuirla; la
 * CIE-11 sí (CC BY-ND 3.0 IGO, sin modificarla). La CIE-10 en español es de
 * la OPS y no se incluye: se carga con su archivo y su permiso escrito.
 */
export const BUNDLED_DIAGNOSIS_LISTS: readonly DiagnosisListLoad[] = [
  {
    system: "ICD-11",
    edition: "2026-01",
    official: true,
    license: WHO_ICD11_LICENSE,
    sourceUrl:
      "https://icdcdn.who.int/static/releasefiles/2026-01/SimpleTabulation-ICD-11-MMS-es.zip",
    sha256: "7c7e5a02706aefd6ff2c95675ad4d33e3f2b2a518a1cabc8bf9f10c07b33113f",
    path: join(here, "..", "seeds", "oficiales", "ICD-11", "2026-01", "SimpleTabulation-ICD-11-MMS-es.zip"),
  },
]

/**
 * Semilla mínima de desarrollo, NO oficial: los 124 códigos de la CIE-10 de la
 * cavidad bucal y Z01.2, y 41 de la atención primaria para latidIA (issue 229:
 * amigdalitis, hipertensión, diabetes, asma…), sin fuente verificada ni permiso
 * de la OPS. Nunca en producción.
 */
export const DEV_DIAGNOSIS_LISTS: readonly DiagnosisListLoad[] = [
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
]

/** Las filas de la lista, después de verificar el SHA-256 del archivo. */
export function readDiagnosisList(load: DiagnosisListLoad): {
  sha: string | null
  rows: DiagnosisCatalogRow[]
} {
  if (load.official && !load.sha256)
    throw new Error(`${load.system} ${load.edition}: una lista oficial necesita su SHA-256`)
  const bytes = readFileSync(load.path)
  const sha = load.sha256 ? assertSha256(bytes, load.sha256) : null
  return { sha, rows: prepareDiagnosisRows(load.system, parseDiagnosisFile(diagnosisFileText(bytes))) }
}

export interface DiagnosisListResult {
  codes: number
  /** Códigos insertados o con algo distinto; 0 si ya estaba cargada igual. */
  written: number
}

/**
 * Una edición oficial más nueva de la misma lista, si ya está cargada: la
 * lista incluida no la pisa con títulos más viejos en el próximo despliegue.
 * Las ediciones son «AAAA» o «AAAA-MM» y se ordenan como texto.
 */
export async function newerOfficialEdition(db: Db, load: DiagnosisListLoad): Promise<string | null> {
  const releases = await db
    .select({ edition: diagnosisCodeRelease.edition })
    .from(diagnosisCodeRelease)
    .where(and(eq(diagnosisCodeRelease.systemKey, load.system), eq(diagnosisCodeRelease.official, true)))
  const newer = releases.map((r) => r.edition).filter((edition) => edition > load.edition)
  return newer.sort().at(-1) ?? null
}

export async function loadDiagnosisList(db: Db, load: DiagnosisListLoad): Promise<DiagnosisListResult> {
  const { sha, rows } = readDiagnosisList(load)
  return db.transaction(async (tx) => {
    const [release] = await tx
      .select()
      .from(diagnosisCodeRelease)
      .where(
        and(
          eq(diagnosisCodeRelease.systemKey, load.system),
          eq(diagnosisCodeRelease.edition, load.edition),
        ),
      )
    const sameRelease =
      release?.official === load.official &&
      release.license === load.license &&
      release.sourceUrl === load.sourceUrl &&
      release.sourceSha256 === sha &&
      release.codeCount === rows.length
    if (!sameRelease) {
      const values = {
        official: load.official,
        license: load.license,
        sourceUrl: load.sourceUrl,
        sourceSha256: sha,
        codeCount: rows.length,
        loadedAt: new Date(),
      }
      await tx
        .insert(diagnosisCodeRelease)
        .values({ systemKey: load.system, edition: load.edition, ...values })
        .onConflictDoUpdate({
          target: [diagnosisCodeRelease.systemKey, diagnosisCodeRelease.edition],
          set: values,
        })
    }

    const existing = new Map(
      (
        await tx
          .select({
            code: diagnosisCatalog.code,
            edition: diagnosisCatalog.edition,
            title: diagnosisCatalog.title,
            uri: diagnosisCatalog.uri,
            isCategory: diagnosisCatalog.isCategory,
            searchText: diagnosisCatalog.searchText,
          })
          .from(diagnosisCatalog)
          .where(eq(diagnosisCatalog.systemKey, load.system))
      ).map((row) => [row.code, row]),
    )
    const changed = rows.filter((row) => {
      const old = existing.get(row.code)
      return (
        !old ||
        old.edition !== load.edition ||
        old.title !== row.title ||
        old.uri !== row.uri ||
        old.searchText !== row.searchText
      )
    })
    // `isCategory` solo vale al insertar: en un código que ya estaba lo decide el paso siguiente.
    for (let start = 0; start < changed.length; start += 500)
      await tx
        .insert(diagnosisCatalog)
        .values(
          changed.slice(start, start + 500).map((row) => ({
            systemKey: load.system,
            code: row.code,
            edition: load.edition,
            title: row.title,
            uri: row.uri,
            isCategory: row.isCategory,
            searchText: row.searchText,
          })),
        )
        .onConflictDoUpdate({
          target: [diagnosisCatalog.systemKey, diagnosisCatalog.code],
          set: {
            edition: sql`excluded."edition"`,
            title: sql`excluded."title"`,
            uri: sql`excluded."uri"`,
            searchText: sql`excluded."search_text"`,
          },
        })

    // Una categoría lo es por los códigos de toda la lista, también los de otra carga.
    const isCategoryNow = new Map<string, boolean>()
    for (const [code, old] of existing) isCategoryNow.set(code, old.isCategory)
    for (const row of rows) if (!existing.has(row.code)) isCategoryNow.set(row.code, row.isCategory)
    const prefixes = new Set<string>()
    for (const code of isCategoryNow.keys())
      for (let end = 3; end < code.length; end++) prefixes.add(code.slice(0, end))
    const becomeCategory: string[] = []
    const stopBeingCategory: string[] = []
    for (const [code, isCategory] of isCategoryNow) {
      if (prefixes.has(code) && !isCategory) becomeCategory.push(code)
      else if (!prefixes.has(code) && isCategory) stopBeingCategory.push(code)
    }
    for (const [isCategory, codes] of [
      [true, becomeCategory],
      [false, stopBeingCategory],
    ] as const)
      for (let start = 0; start < codes.length; start += 1000)
        await tx
          .update(diagnosisCatalog)
          .set({ isCategory })
          .where(
            and(
              eq(diagnosisCatalog.systemKey, load.system),
              inArray(diagnosisCatalog.code, codes.slice(start, start + 1000)),
            ),
          )
    return {
      codes: rows.length,
      written: changed.length + becomeCategory.length + stopBeingCategory.length,
    }
  })
}
