/**
 * Reglas clínicas del 18 nov (punto 1): lo escrito a mano antes del cambio («alendronato 70 mg
 * semanal», guardado con `atc_code` nulo) recibe el código de su DCI con la migración 0150, y lo
 * escrito no cambia. La lista de nombres de la migración es la de `HABITUAL_MEDICATIONS`.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  HABITUAL_MEDICATIONS,
  matchHabitualMedication,
  medicationClassOf,
  normalizeDrugText,
} from "@odentia/clinical"
import { patientMedication } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const migration = readFileSync(
  fileURLToPath(new URL("../../db/drizzle/0150_medicinas_por_su_nombre.sql", import.meta.url)),
  "utf8",
)

it("la migración reconoce los mismos nombres que el código: DCI, nombre local y marca", () => {
  const coded = HABITUAL_MEDICATIONS.filter((entry) => medicationClassOf(entry.atc) !== null)
  const expected = coded.flatMap((entry) =>
    [entry.dci, ...(entry.names ?? [])].map(
      (name) => `('${entry.atc}', '${normalizeDrugText(name)}')`,
    ),
  )
  const listed = [...migration.matchAll(/\('([A-Z0-9]+)', '([^']+)'\)/g)].map((match) => match[0])
  expect(listed.sort()).toEqual(expected.sort())
})

it("lo escrito a mano antes recibe el código de su DCI y conserva su texto; lo demás no cambia", async () => {
  const f = await clinicalFixture()
  const rows = await ownerDb
    .insert(patientMedication)
    .values(
      [
        { name: "Alendronato 70 mg semanal" },
        { name: "Mis pastillas del hueso", genericName: "risedronato  35mg" },
        { name: "ELIQUIS" },
        { name: "Sintrom 4 mg, según INR" },
        // No es un nombre entero de la lista, no es del grupo o ya tiene código: no se toca.
        { name: "ácido 5 mg" },
        { name: "alendro" },
        { name: "raloxifeno 60 mg" },
        { name: "Losartán 50 mg" },
        { name: "Fosamax", atcCode: "M05B" },
        // Una combinación no es su primera medicina (la misma regla que `matchHabitualMedication`).
        { name: "Alendronato + colecalciferol 70 mg/2800 UI" },
        { name: "Eliquis/aspirina" },
        { name: "Prolia y calcio" },
        { name: "Warfarina 5 mg e ibuprofeno" },
        // La dosis y la frecuencia, sí.
        { name: "alendronato 70 mg/semana" },
        { name: "Xarelto 20 mg mañana y noche" },
      ].map((row) => ({ organizationId: "org_a", patientId: f.patient.id, ...row })),
    )
    .returning({ id: patientMedication.id })
  await ownerDb.execute(sql.raw(migration))
  const after = await Promise.all(
    rows.map(async ({ id }) => {
      const [row] = await ownerDb
        .select({
          name: patientMedication.name,
          genericName: patientMedication.genericName,
          atc: patientMedication.atcCode,
        })
        .from(patientMedication)
        .where(eq(patientMedication.id, id))
      return row
    }),
  )
  expect(after).toEqual([
    { name: "Alendronato 70 mg semanal", genericName: null, atc: "M05BA04" },
    { name: "Mis pastillas del hueso", genericName: "risedronato  35mg", atc: "M05BA07" },
    { name: "ELIQUIS", genericName: null, atc: "B01AF02" },
    { name: "Sintrom 4 mg, según INR", genericName: null, atc: "B01AA07" },
    { name: "ácido 5 mg", genericName: null, atc: null },
    { name: "alendro", genericName: null, atc: null },
    { name: "raloxifeno 60 mg", genericName: null, atc: null },
    { name: "Losartán 50 mg", genericName: null, atc: null },
    { name: "Fosamax", genericName: null, atc: "M05B" },
    { name: "Alendronato + colecalciferol 70 mg/2800 UI", genericName: null, atc: null },
    { name: "Eliquis/aspirina", genericName: null, atc: null },
    { name: "Prolia y calcio", genericName: null, atc: null },
    { name: "Warfarina 5 mg e ibuprofeno", genericName: null, atc: null },
    { name: "alendronato 70 mg/semana", genericName: null, atc: "M05BA04" },
    { name: "Xarelto 20 mg mañana y noche", genericName: null, atc: "B01AF01" },
  ])
  // Lo mismo que dice el código para cada texto del grupo (el que ya tenía código no se toca).
  for (const row of after.filter((row) => row!.name !== "Fosamax")) {
    const atc = matchHabitualMedication(row!.genericName ?? row!.name)?.entry.atc ?? null
    expect([row!.name, medicationClassOf(atc) ? atc : null]).toEqual([row!.name, row!.atc])
  }
})
