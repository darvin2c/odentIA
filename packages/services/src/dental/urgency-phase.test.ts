/**
 * La fase «Urgencia» que propone el diagnóstico (reglas clínicas del 18 nov, punto 4, caso C2): lo
 * indicado por dolor, infección aguda o trauma, si su tipo lo dejaría en la básica o la quirúrgica.
 * Nunca lo rehabilitador; el odontólogo la mueve con «Planificar…» y su elección no se pisa. Se
 * propone al indicar; un diagnóstico anotado después no mueve lo ya indicado.
 */
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { addEncounterDiagnosis } from "../encounter-diagnoses.js"
import { addPlanItem, listPlanItems, updatePlanItem, updatePlanItemPlanning } from "../plan.js"
import { createService } from "../service-catalog.js"
import { librarySpecialtyIds } from "../specialties.js"
import { ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

/** Los servicios de odentIA con su tipo (por la especialidad del país) y los diagnósticos de la prueba. */
async function withDentalServices() {
  const f = await clinicalFixture()
  await seedOdentiaCatalog(ownerDb)
  await seedDiagnosisCodes([
    { code: "K04.0", title: "Pulpitis" },
    { code: "K02.1", title: "Caries de la dentina" },
  ])
  const service = (name: string, kind: string, officialCode: string, scope: "tooth" | "surfaces") =>
    f.run(async (tx) =>
      createService(tx, "org_a", f.actor, {
        name,
        officialCode,
        specialtyId: (await librarySpecialtyIds(tx, "org_a", [kind])).get(kind) as string,
        scope,
        priceCents: 30000,
      }),
    )
  const endodontics = await service("Endodoncia multirradicular", "endodoncia", "D3330", "tooth")
  const resin = await service("Resina compuesta", "restauradora", "D2391", "surfaces")
  const crown = await service("Corona", "protesis", "D2740", "tooth")
  const extraction = await service("Exodoncia simple", "cirugia", "D7140", "tooth")
  const indicate = (
    serviceId: string,
    site: { toothNumber: number; surfaces?: string[] },
    diagnosisCode: string | null = null,
  ) =>
    f.run((tx) =>
      addPlanItem(tx, ...f.args, {
        serviceId,
        planId: f.plan.id,
        sourceEncounterId: f.encounter.id,
        diagnosisCode,
        ...site,
      }),
    )
  const diagnose = (diagnosisCode: string, toothNumber: number) =>
    f.run((tx) =>
      addEncounterDiagnosis(tx, ...f.args, f.encounter.id, { diagnosisCode, diagnosisType: "provisional", toothNumber }),
    )
  return { ...f, endodontics, resin, crown, extraction, indicate, diagnose }
}

it("la endodoncia de una pulpitis se propone en «Urgencia», con su diagnóstico o con el de la atención en la pieza; la corona no", async () => {
  const f = await withDentalServices()
  // Desde el panel de la pieza: el tratamiento lleva su diagnóstico.
  expect(await f.indicate(f.endodontics.id, { toothNumber: 36 }, "K04.0")).toMatchObject({ phase: "urgencia" })
  // Dictado: el tratamiento llega sin diagnóstico, y la pulpitis de la 46 está en la atención.
  await f.diagnose("K04.0", 46)
  expect(await f.indicate(f.endodontics.id, { toothNumber: 46 })).toMatchObject({ phase: "urgencia" })
  // La corona de esa misma pieza se queda en la rehabilitadora y va después.
  expect(await f.indicate(f.crown.id, { toothNumber: 46 }, "K04.0")).toMatchObject({ phase: "rehabilitadora" })
  // La pulpitis de la 46 no adelanta la endodoncia de otra pieza.
  expect(await f.indicate(f.endodontics.id, { toothNumber: 47 })).toMatchObject({ phase: "basica" })
})

it("la resina de una caries sin pulpitis queda en su fase de siempre", async () => {
  const f = await withDentalServices()
  await f.diagnose("K02.1", 26)
  expect(await f.indicate(f.resin.id, { toothNumber: 26, surfaces: ["occlusal"] }, "K02.1")).toMatchObject({
    phase: "basica",
  })
})

// Nada lo decide el sistema (26 nov): cambiar el servicio, la pieza o el diagnóstico no mueve la
// fase ni el orden. La fase la cambia el odontólogo con «Planificar…»; el Plan lo sugiere en la fila.
it("cambiar el servicio, la pieza o el diagnóstico no le cambia la fase ni el orden", async () => {
  const f = await withDentalServices()
  const change = (itemId: string, patch: Omit<Parameters<typeof updatePlanItem>[5], "encounterId">) =>
    f.run((tx) => updatePlanItem(tx, ...f.args, itemId, { ...patch, encounterId: f.encounter.id }))
  // La exodoncia cambiada por una endodoncia sigue en la quirúrgica, en su lugar.
  const extraction = await f.indicate(f.extraction.id, { toothNumber: 18 })
  const resin = await f.indicate(f.resin.id, { toothNumber: 26, surfaces: ["occlusal"] })
  const changed = await change(extraction.id, { serviceId: f.endodontics.id })
  expect(changed).toMatchObject({ phase: "quirurgica", sortOrder: extraction.sortOrder })
  expect(changed.sortOrder).toBeLessThan(resin.sortOrder)
  const listed = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { phaseSuggestions: true }))
  expect(listed.find((item) => item.id === extraction.id)?.phaseSuggestion).toBe(
    "Sugerencia: por su tipo de tratamiento iría en «Básica o higiénica». Cámbiala con «Planificar…».",
  )
  // La endodoncia de la básica a la que se le anota una pulpitis tampoco va sola a «Urgencia».
  const endo = await f.indicate(f.endodontics.id, { toothNumber: 36 })
  expect(endo).toMatchObject({ phase: "basica" })
  expect(await change(endo.id, { diagnosisCode: "K04.0" })).toMatchObject({ phase: "basica", sortOrder: endo.sortOrder })
  // Ni al cambiarla de pieza a una con pulpitis en la atención.
  await f.diagnose("K04.0", 46)
  expect(await change(endo.id, { toothNumber: 46 })).toMatchObject({ phase: "basica", sortOrder: endo.sortOrder })
  // La que el odontólogo pasó a la básica se queda ahí al cambiarle el servicio.
  const moved = await f.indicate(f.endodontics.id, { toothNumber: 37 }, "K04.0")
  await f.run((tx) => updatePlanItemPlanning(tx, ...f.args, moved.id, { phase: "basica" }))
  expect(await change(moved.id, { serviceId: f.extraction.id })).toMatchObject({ phase: "basica" })
})

// Nada lo decide el sistema (26 nov): la pulpitis anotada después de indicar la endodoncia ya no la
// mueve sola a «Urgencia». La fase la cambia el odontólogo con «Planificar…».
it("anotar la pulpitis después de indicar la endodoncia no le cambia la fase ni el orden", async () => {
  const f = await withDentalServices()
  const endo = await f.indicate(f.endodontics.id, { toothNumber: 36 })
  expect(endo).toMatchObject({ phase: "basica" })
  const kept = await f.indicate(f.endodontics.id, { toothNumber: 46 })
  await f.run((tx) => updatePlanItemPlanning(tx, ...f.args, kept.id, { phase: "quirurgica" }))
  const before = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  await f.diagnose("K04.0", 36)
  await f.diagnose("K04.0", 46)
  const items = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))
  const of = (list: typeof items, id: string) => list.find((item) => item.id === id)!
  expect(of(items, endo.id).phase).toBe("basica")
  expect(of(items, endo.id).sortOrder).toBe(of(before, endo.id).sortOrder)
  expect(of(items, kept.id).phase).toBe("quirurgica")
  // El Plan lo sugiere en la fila, sin cambiarla; lo que se planificó a mano no.
  const shown = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { phaseSuggestions: true }))
  expect(of(shown, endo.id).phaseSuggestion).toBe("Sugerencia: con pulpitis de la 36 iría en «Urgencia». Cámbiala con «Planificar…».")
  expect(of(shown, kept.id).phaseSuggestion).toBeUndefined()
  expect(of(items, endo.id).phaseSuggestion).toBeUndefined()
})

// Revisión de código del 26 nov: la fase que una persona eligió al indicar también es suya; el Plan no
// le sugiere cambiarla para siempre.
it("la fase elegida al indicar cuenta como elegida: el Plan no sugiere cambiarla", async () => {
  const f = await withDentalServices()
  const chosen = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.extraction.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, toothNumber: 18, phase: "basica" }),
  )
  expect(chosen).toMatchObject({ phase: "basica" })
  // Sin elegirla, lo que la regla pondría en otra fase sí lleva la sugerencia.
  const other = await f.indicate(f.endodontics.id, { toothNumber: 38 })
  await f.diagnose("K04.0", 38)
  const shown = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { phaseSuggestions: true }))
  expect(shown.find((item) => item.id === chosen.id)?.phaseSuggestion).toBeUndefined()
  expect(shown.find((item) => item.id === other.id)?.phaseSuggestion).toContain("iría en «Urgencia»")
})
