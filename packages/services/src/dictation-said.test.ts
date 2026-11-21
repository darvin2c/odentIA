import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { withOrgContext } from "@odentia/db"
import { encounter, encounterDictationSegment } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { dictationContext, listDictationSaid, settleDictationSegment, startDictationSegment } from "./dictation-said.js"
import { saveDictationSegment } from "./encounter-dictation.js"
import { discardEmptyEncounter } from "./encounters.js"
import { nextPatientNumber } from "./patients.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * «Lo que se dijo» guardado con la atención (mesa del 20 nov 2026, P2; ADR 0209): cada tramo,
 * tal cual llegó, antes de que Clío lo ordene. Lo que hace la pausa de punta a punta (el modelo,
 * el permiso) lo prueba la ruta (`apps/api/src/routes/encounter-dictation.test.ts`).
 */
setupTestDb()
const ORG = "org_a"
const enable = (on: boolean) => withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: on }))

describe("el contexto de la pausa", () => {
  it("es el final de lo dicho, en palabras enteras", () => {
    expect(dictationContext(["Buenos días.", "Me duele una muela."])).toBe("Buenos días. Me duele una muela.")
    expect(dictationContext(["uno dos tres cuatro"], 9)).toBe("cuatro")
    expect(dictationContext(["uno dos tres cuatro"], 12)).toBe("tres cuatro")
    expect(dictationContext([], 9)).toBe("")
  })
})

describe("cada tramo se guarda antes de ordenarlo", () => {
  it("queda tal cual, ordenado una sola vez, y la pausa siguiente lee lo anterior", async () => {
    await enable(true)
    const fx = await clinicalFixture()
    const start = (segmentId: string, transcript: string) =>
      fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId, transcript }))
    const first = randomUUID()
    expect(await start(first, "Tomo losartán de cincuenta.")).toEqual({ repeated: false, context: "" })
    // Sin ordenar todavía (el proveedor falló): se puede volver a intentar, con el mismo contexto.
    expect(await start(first, "Tomo losartán de cincuenta.")).toEqual({ repeated: false, context: "" })
    await fx.run((tx) => settleDictationSegment(tx, ORG, fx.encounter.id, first, [{ said: "Tomo losartán", why: "sin_lugar" }, { said: "Tomo losartán", why: "sin_lugar" }]))
    expect(await start(first, "Tomo losartán de cincuenta.")).toEqual({ repeated: true, context: "" })
    // El servicio que guarda las sugerencias también lo ve ordenado.
    expect((await fx.run((tx) => saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: [], segmentId: first }))).repeated).toBe(true)
    expect((await start(randomUUID(), "¿Alergias?")).context).toBe("Tomo losartán de cincuenta.")

    const said = await fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(said.map((item) => [item.transcript, item.organized, item.unused])).toEqual([
      ["Tomo losartán de cincuenta.", true, [{ said: "Tomo losartán", why: "sin_lugar" }]],
      ["¿Alergias?", false, []],
    ])
    expect(said[0]?.turns).toBeNull()
    await enable(false)
  })

  it("lo dicho no se reescribe ni se borra, y otra clínica no lo ve", async () => {
    await enable(true)
    const fx = await clinicalFixture()
    await fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId: randomUUID(), transcript: "Le duele al frío." }))
    await expect(fx.run((tx) => tx.update(encounterDictationSegment).set({ transcript: "otra cosa" }).where(eq(encounterDictationSegment.encounterId, fx.encounter.id)))).rejects.toMatchObject({ cause: { message: expect.stringContaining("permission denied") } })
    await expect(fx.run((tx) => tx.delete(encounterDictationSegment).where(eq(encounterDictationSegment.encounterId, fx.encounter.id)))).rejects.toMatchObject({ cause: { message: expect.stringContaining("permission denied") } })
    const fromB = await withOrgContext(appDb, "org_b", (tx) => tx.select().from(encounterDictationSegment).where(eq(encounterDictationSegment.encounterId, fx.encounter.id)))
    expect(fromB).toEqual([])
    // Ni el dueño de la base lo reescribe.
    await expect(ownerDb.execute(sql`update encounter_dictation_segment set transcript = 'otra cosa' where encounter_id = ${fx.encounter.id}::uuid`)).rejects.toMatchObject({ cause: { message: "Lo que se dijo no se reescribe" } })
    await enable(false)
  })

  it("con la atención cerrada no se agrega nada; descartada vacía, lo dicho se va con ella", async () => {
    await enable(true)
    const fx = await clinicalFixture()
    // Una atención anulada: lo que se dijo queda como quedó.
    await ownerDb.update(encounter).set({ status: "anulada", voidedAt: new Date(), voidedBy: fx.actor, voidReason: "Prueba" }).where(eq(encounter.id, fx.encounter.id))
    await expect(
      ownerDb.insert(encounterDictationSegment).values({ organizationId: ORG, patientId: fx.patient.id, encounterId: fx.encounter.id, segmentId: "x", transcript: "Algo", createdBy: fx.actor }),
    ).rejects.toMatchObject({ cause: { message: "Lo que se dijo se guarda mientras la atención está en borrador" } })

    // Otra paciente, con su atención en borrador vacía y algo de charla dicho.
    const [person] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente sin nada", patientNumber: await nextPatientNumber(ownerDb, ORG) })
    const [draft] = await ownerDb.insert(encounter).values({ organizationId: ORG, patientId: person!.id, professionalUserId: fx.actor }).returning()
    await fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, person!.id, draft!.id, { segmentId: randomUUID(), transcript: "Buenos días, ¿encontró estacionamiento?" }))
    await fx.run((tx) => discardEmptyEncounter(tx, ORG, fx.actor, person!.id, draft!.id))
    expect(await ownerDb.select().from(encounterDictationSegment).where(eq(encounterDictationSegment.encounterId, draft!.id))).toEqual([])
    await enable(false)
  })
})

describe("no es historia clínica", () => {
  it("solo lo leen el dictado, «Lo que se dijo» y la demo: ni la copia de la historia ni FHIR", () => {
    const root = join(import.meta.dirname)
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    const readers = files.filter((file) => /encounterDictationSegment|encounter_dictation_segment/.test(readFileSync(join(root, file), "utf8")))
    expect(readers.map((file) => file.replaceAll("\\", "/")).sort()).toEqual(["dental/seed-demo.ts", "dictation-said.ts", "encounter-dictation.ts"])
  })
})
