import { isDiagnosisSystem } from "@odentia/clinical"
import { createOwnerDb } from "./client.js"
import {
  BUNDLED_DIAGNOSIS_LISTS,
  DEV_DIAGNOSIS_LISTS,
  type DiagnosisListLoad,
  loadDiagnosisList,
  newerOfficialEdition,
  WHO_ICD11_LICENSE,
} from "./diagnosis-catalog.js"

/**
 * Carga las listas de diagnósticos (ADR 0041). Idempotente y sin escribir nada
 * si no hubo cambios: corre en cada despliegue, después de las migraciones.
 *
 * Sin variables carga las listas oficiales que viven en el repositorio,
 * verificadas con su SHA-256: la CIE-11 de la OMS (`seeds/oficiales/ICD-11/`)
 * y la CIE-10 del MINSA (`seeds/oficiales/ICD-10-PE/`, ADR 0103). Fuera de
 * producción (`NODE_ENV` distinto de `production`) carga además la semilla
 * mínima de desarrollo de la CIE-10, que NO es oficial.
 *
 * Un archivo oficial que no vive en el repositorio (la CIE-10 de la OMS con el
 * permiso escrito de la OPS, otra lista nacional o una edición nueva) entra con su
 * lista, su edición, su licencia y el SHA-256 calculado al descargarlo; se
 * acepta el .zip tal como se descargó:
 *
 *   DIAGNOSIS_SYSTEM=ICD-10 DIAGNOSIS_FILE=/ruta/cie10.xml DIAGNOSIS_SHA256=<hash> \
 *   DIAGNOSIS_EDITION=2019 DIAGNOSIS_LICENSE="<permiso escrito de la OPS>" \
 *   DIAGNOSIS_SOURCE_URL=<url> pnpm --filter @odentia/db seed:diagnoses
 *
 * Una edición nueva de la CIE-11 (la OMS publica una por año, en «Información
 * › Archivo de hoja de cálculo» de icd.who.int/browse):
 *
 *   CIE11_FILE=/ruta/SimpleTabulation-ICD-11-MMS-es.zip CIE11_SHA256=<hash> \
 *   CIE11_EDITION=2027-01 pnpm --filter @odentia/db seed:diagnoses
 *
 * Una lista nacional (CIE-10 MINSA, CIE-10-ES) es otra lista: va con su
 * `DIAGNOSIS_SYSTEM` (ICD-10-PE, ICD-10-ES), nunca en lugar de la de la OMS.
 */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} es obligatoria para cargar un archivo oficial`)
  return value
}

function loads(): { lists: DiagnosisListLoad[]; bundled: boolean } {
  if (process.env.CIE11_FILE) {
    return {
      bundled: false,
      lists: [
        {
          system: "ICD-11",
          edition: required("CIE11_EDITION"),
          official: true,
          license: process.env.CIE11_LICENSE?.trim() || WHO_ICD11_LICENSE,
          sourceUrl: process.env.CIE11_SOURCE_URL?.trim() || "https://icd.who.int/",
          sha256: required("CIE11_SHA256"),
          path: required("CIE11_FILE"),
        },
      ],
    }
  }
  if (process.env.DIAGNOSIS_FILE) {
    const system = required("DIAGNOSIS_SYSTEM")
    if (!isDiagnosisSystem(system)) throw new Error(`Lista desconocida: ${system}`)
    return {
      bundled: false,
      lists: [
        {
          system,
          edition: required("DIAGNOSIS_EDITION"),
          official: true,
          license: required("DIAGNOSIS_LICENSE"),
          sourceUrl: required("DIAGNOSIS_SOURCE_URL"),
          sha256: required("DIAGNOSIS_SHA256"),
          path: required("DIAGNOSIS_FILE"),
        },
      ],
    }
  }
  if (process.env.CIE10_FILE)
    throw new Error("CIE10_FILE ya no se usa: indica DIAGNOSIS_SYSTEM=ICD-10 y DIAGNOSIS_FILE")
  const production = process.env.NODE_ENV === "production"
  return {
    bundled: true,
    lists: [...BUNDLED_DIAGNOSIS_LISTS, ...(production ? [] : DEV_DIAGNOSIS_LISTS)],
  }
}

const db = createOwnerDb(url)
const { lists, bundled } = loads()
for (const load of lists) {
  const newer = bundled && load.official ? await newerOfficialEdition(db, load) : null
  if (newer) {
    console.log(`${load.system} ${load.edition}: ya está cargada la edición ${newer}, no se pisa`)
    continue
  }
  const { codes, written } = await loadDiagnosisList(db, load)
  const kind = load.official ? "archivo oficial verificado" : "semilla de desarrollo, no oficial"
  console.log(
    `${load.system} ${load.edition}: ${codes} códigos (${kind}); ${written ? `${written} escritos` : "sin cambios"}`,
  )
}
process.exit(0)
