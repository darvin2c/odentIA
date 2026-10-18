import { BUNDLED_DIAGNOSIS_LISTS, loadDiagnosisList, withOrgContext } from "@odentia/db"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { searchDiagnosisCodes } from "./diagnosis-codes.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const icd11 = BUNDLED_DIAGNOSIS_LISTS.find((load) => load.system === "ICD-11")!

it("la CIE-11 oficial se carga entera y, sin cambios, el siguiente despliegue no escribe nada", async () => {
  expect(await loadDiagnosisList(ownerDb, icd11)).toEqual({ codes: 17_255, written: 17_255 })
  expect(await loadDiagnosisList(ownerDb, icd11)).toEqual({ codes: 17_255, written: 0 })
  const [release] = await ownerDb.execute<{ official: boolean; code_count: number }>(
    sql`select "official", "code_count" from "diagnosis_code_release" where "system_key" = 'ICD-11' and "edition" = '2026-01'`,
  )
  expect(release).toEqual({ official: true, code_count: 17_255 })
})

it("con la lista completa, el buscador encuentra lo odontológico primero y el código exacto arriba", async () => {
  await loadDiagnosisList(ownerDb, icd11)
  await ownerDb.execute(
    sql`update "org_profile" set "diagnosis_system" = 'ICD-11' where "organization_id" = 'org_a'`,
  )
  const search = (q: string) =>
    withOrgContext(appDb, "org_a", (tx) => searchDiagnosisCodes(tx, "org_a", q))
  expect((await search("caries"))[0]).toMatchObject({ code: "DA08.0", description: "Caries dental" })
  expect((await search("PULPITIS"))[0]?.code).toBe("DA09.0")
  expect((await search("fractura raiz")).map((row) => row.code)).toContain("NA0D.06")
  expect((await search("da0a3"))[0]?.code).toBe("DA0A.3")
  // Fuera de la boca también: la fractura de la mandíbula y la de los huesos de la cara.
  expect((await search("fractura mandibula")).map((row) => row.code)).toContain("NA02.7Z")
})
