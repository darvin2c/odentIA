import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { withOrgContext } from "@odentia/db"
import { encounter, encounterDictationSegment } from "@odentia/db/schema/clinical"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { dictationContext, listDictationSaid, releaseDictationSegment, settleDictationRetry, settleDictationSegment, startDictationSegment, unusedOnce } from "./dictation-said.js"
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
    const shape = (started: Awaited<ReturnType<typeof start>>) => ({ repeated: started.repeated, inProgress: started.inProgress, context: started.context })
    expect(shape(await start(first, "Tomo losartán de cincuenta."))).toEqual({ repeated: false, inProgress: false, context: "" })
    // Mientras Clío lo ordena, un segundo pedido del mismo tramo no paga otra llamada (revisión del 21 nov, C1).
    expect(shape(await start(first, "Tomo losartán de cincuenta."))).toEqual({ repeated: false, inProgress: true, context: "" })
    // El proveedor falló: deja de estar en curso y se puede volver a intentar, con el mismo contexto.
    await fx.run((tx) => releaseDictationSegment(tx, ORG, fx.encounter.id, first))
    expect(shape(await start(first, "Tomo losartán de cincuenta."))).toEqual({ repeated: false, inProgress: false, context: "" })
    await fx.run((tx) => settleDictationSegment(tx, ORG, fx.encounter.id, first, [{ said: "Tomo losartán", why: "sin_lugar" }, { said: "Tomo losartán", why: "sin_lugar" }]))
    expect(shape(await start(first, "Tomo losartán de cincuenta."))).toEqual({ repeated: true, inProgress: false, context: "" })
    // El servicio que guarda las sugerencias también lo ve ordenado.
    expect((await fx.run((tx) => saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: [], segmentId: first }))).repeated).toBe(true)
    expect((await start(randomUUID(), "¿Alergias?")).context).toBe("Tomo losartán de cincuenta.")

    const said = await fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(said.map((item) => [item.transcript, item.organized, item.unused])).toEqual([
      ["Tomo losartán de cincuenta.", true, [{ said: "Tomo losartán", why: "sin_lugar" }]],
      ["¿Alergias?", false, []],
    ])
    expect(said[0]?.turns).toBeNull()
    // Ningún repaso lo leyó todavía.
    expect(said.map((item) => item.reviewed)).toEqual([false, false])
    await enable(false)
  })

  it("«Intentar otra vez» una frase no la guarda como otro tramo: sale de «No lo usé» o vuelve con lo de ahora (C3)", async () => {
    await enable(true)
    const fx = await clinicalFixture()
    const first = randomUUID()
    await fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId: first, transcript: "Buenos días. Y algo de la tiroides." }))
    await fx.run((tx) => settleDictationSegment(tx, ORG, fx.encounter.id, first, [{ said: "Y algo de la tiroides", why: "sin_lugar" }]))
    const retry = (segmentId: string) =>
      fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId, transcript: "Y algo de la tiroides", retryOf: first }))
    const again = randomUUID()
    expect((await retry(again)).inProgress).toBe(false)
    // Dos toques a la vez: el segundo espera.
    expect((await retry(randomUUID())).inProgress).toBe(true)
    await fx.run((tx) => settleDictationRetry(tx, ORG, fx.encounter.id, first, "Y algo de la tiroides", [{ said: "Y algo de la tiroides", why: "sin_lugar", detail: "otra vez" }]))
    const said = await fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id))
    // Antes se guardaba como otro tramo, con otra hora: la frase salía dos veces en «Lo que se dijo».
    expect(said.map((item) => [item.transcript, item.unused])).toEqual([["Buenos días. Y algo de la tiroides.", [{ said: "Y algo de la tiroides", why: "sin_lugar", detail: "otra vez" }]]])
    await enable(false)
  })

  it("un reintento que tampoco la usa ni la devuelve la deja en «No lo usé» con su motivo (QA del 21 nov)", async () => {
    await enable(true)
    const fx = await clinicalFixture()
    const first = randomUUID()
    await fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId: first, transcript: "Yo creo que peso como sesenta kilos." }))
    await fx.run((tx) => settleDictationSegment(tx, ORG, fx.encounter.id, first, [{ said: "yo creo que peso como sesenta kilos", why: "sin_lugar", detail: "peso dicho, no medido" }]))
    // Clío no propuso nada ni la devolvió: antes la frase desaparecía de «No lo usé».
    await fx.run((tx) => settleDictationRetry(tx, ORG, fx.encounter.id, first, "yo creo que peso como sesenta kilos", [], false))
    const [said] = await fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(said?.unused).toEqual([{ said: "yo creo que peso como sesenta kilos", why: "sin_lugar", detail: "peso dicho, no medido" }])
    // Si esta vez sí la usó, sale.
    await fx.run((tx) => settleDictationRetry(tx, ORG, fx.encounter.id, first, "yo creo que peso como sesenta kilos", [], true))
    expect((await fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id)))[0]?.unused).toEqual([])
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

  it("con la atención cerrada no se agrega nada; con algo dicho no está vacía: no se descarta de un toque", async () => {
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
    // Antes se borraba con un toque, y con ella la conversación (QA del 21 nov): ahora se anula con su motivo.
    await expect(fx.run((tx) => discardEmptyEncounter(tx, ORG, fx.actor, person!.id, draft!.id))).rejects.toMatchObject({
      code: "ENCOUNTER_NOT_EMPTY",
      message: "Tiene lo que se dijo en la consulta: termínala o anúlala con su motivo",
    })
    expect(await ownerDb.select().from(encounterDictationSegment).where(eq(encounterDictationSegment.encounterId, draft!.id))).toHaveLength(1)
    await enable(false)
  })
})

describe("«No lo usé» dice cada frase una vez y solo lo que no se usó (QA del 22 nov, H4 y H6)", () => {
  it("sin preguntas ni repetidos, con el motivo del aviso, y sin lo que ya está en una sugerencia", async () => {
    await enable(true)
    const fx = await clinicalFixture()
    const id = randomUUID()
    const transcript = "cuanto pesa mateo mas o menos? debe pesar unos 24 kilos doctora. tomo losartan para la presion."
    await fx.run((tx) => startDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { segmentId: id, transcript }))
    await fx.run((tx) => saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: [{ kind: "nota", payload: { presentIllness: "Toma losartán para la presión." }, sourceText: "tomo losartan para la presion" }], transcript }))
    await fx.run((tx) =>
      settleDictationSegment(tx, ORG, fx.encounter.id, id, [
        { said: "cuanto pesa mateo mas o menos?", why: "sin_lugar" },
        { said: "debe pesar unos 24 kilos", why: "sin_lugar" },
        { said: "debe pesar unos 24 kilos doctora", why: "sin_lugar", detail: "Es un peso o una talla dichos, no medidos: si hace falta, mídelo." },
        { said: "tomo losartan", why: "sin_lugar" },
        { said: "tomo losartan para la presion", why: "no_propuesta", detail: "No encontré «enalapril» en lo que se dijo: no lo propuse." },
      ]),
    )
    const [said] = await fx.run((tx) => listDictationSaid(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(said?.unused).toEqual([
      { said: "debe pesar unos 24 kilos doctora", why: "sin_lugar", detail: "Es un peso o una talla dichos, no medidos: si hace falta, mídelo." },
      { said: "tomo losartan para la presion", why: "no_propuesta", detail: "No encontré «enalapril» en lo que se dijo: no lo propuse." },
    ])
    await enable(false)
  })

  it("una frase repetida queda una vez, con su motivo si alguna lo trae", () => {
    expect(
      unusedOnce([
        { said: "mi papa es diabetico", why: "sin_lugar" },
        { said: "¿Y desde cuándo?", why: "sin_lugar" },
        { said: "Mi papá es diabético", why: "sin_lugar", detail: "Es de la salud de un familiar." },
        { said: null, why: "sin_lugar" },
        { said: null, why: "sin_lugar" },
      ]),
    ).toEqual([
      { said: "Mi papá es diabético", why: "sin_lugar", detail: "Es de la salud de un familiar." },
      { said: null, why: "sin_lugar" },
    ])
  })
})

// QA del 23 nov (verificador 2): «cuanto pesa lucas mas o menos», que preguntó la doctora sin «?», salía
// en «No lo usé» con «no supe dónde va».
describe("una pregunta no es algo que Clío no usó", () => {
  const item = (said: string) => ({ said, why: "sin_lugar" as const })
  it("empieza con una palabra de pregunta, con tilde o sin ella: no se lista", () => {
    const kept = unusedOnce(["cuanto pesa lucas mas o menos", "Qué le duele", "y desde cuando le pasa", "donde le duele", "cual muela es", "como dos semanas", "no que yo sepa", "que yo sepa no", "tiene asma"].map(item))
    expect(kept.map((one) => one.said)).toEqual(["como dos semanas", "no que yo sepa", "que yo sepa no", "tiene asma"])
  })
  it("lo que pregunta quien atiende («tiene», «toma algo») no se lista; dicho por quien acompaña, sí", () => {
    const turns = [
      { quien: "dra" as const, texto: "tiene alguna alergia" },
      { quien: "acompanante" as const, vinculo: "madre", texto: "toma algo para la tiroides pero no me acuerdo" },
      { quien: "dra" as const, texto: "toma algo mas" },
    ]
    const kept = unusedOnce([item("tiene alguna alergia"), item("toma algo para la tiroides pero no me acuerdo"), item("toma algo mas")], turns)
    expect(kept.map((one) => one.said)).toEqual(["toma algo para la tiroides pero no me acuerdo"])
    // Sin saber quién lo dijo, «tiene…» puede ser la respuesta («tiene asma»): se lista.
    expect(unusedOnce([item("tiene alguna alergia")]).map((one) => one.said)).toEqual(["tiene alguna alergia"])
  })
})

describe("no es historia clínica", () => {
  // `encounters.ts` solo mira si hay algo dicho, para no dar la atención por vacía.
  it("solo lo leen el dictado, «Lo que se dijo» y la demo: ni la copia de la historia ni FHIR", () => {
    const root = join(import.meta.dirname)
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    const readers = files.filter((file) => /encounterDictationSegment|encounter_dictation_segment/.test(readFileSync(join(root, file), "utf8")))
    expect(readers.map((file) => file.replaceAll("\\", "/")).sort()).toEqual(["dental/seed-demo.ts", "dictation-review.ts", "dictation-said.ts", "encounter-dictation.ts", "encounters.ts"])
  })
})
