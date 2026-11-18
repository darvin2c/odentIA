/**
 * La fase «Urgencia» que propone el diagnóstico (reglas clínicas del 18 nov, punto 4, caso C2): lo
 * indicado por dolor, infección aguda o trauma, si su tipo lo dejaría en la básica o la quirúrgica.
 * Nunca lo rehabilitador; el odontólogo la mueve con «Planificar…» y su elección no se pisa.
 */
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { expect, it } from "vitest"
import { clinicalFixture, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { addEncounterDiagnosis } from "../encounter-diagnoses.js"
import { addPlanItem, updatePlanItem, updatePlanItemPlanning } from "../plan.js"
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

it("cambiar el servicio vuelve a proponer la fase, salvo la que se eligió a mano con «Planificar…»", async () => {
  const f = await withDentalServices()
  const change = (itemId: string, serviceId: string) =>
    f.run((tx) => updatePlanItem(tx, ...f.args, itemId, { serviceId, encounterId: f.encounter.id }))
  // La endodoncia de una pulpitis cambiada por una exodoncia sigue en urgencia: el diagnóstico es el mismo.
  const endo = await f.indicate(f.endodontics.id, { toothNumber: 36 }, "K04.0")
  expect(await change(endo.id, f.extraction.id)).toMatchObject({ phase: "urgencia" })
  // La que el odontólogo pasó a la básica se queda ahí al cambiarle el servicio.
  const moved = await f.indicate(f.endodontics.id, { toothNumber: 37 }, "K04.0")
  await f.run((tx) => updatePlanItemPlanning(tx, ...f.args, moved.id, { phase: "basica" }))
  expect(await change(moved.id, f.extraction.id)).toMatchObject({ phase: "basica" })
})
