import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { finalizeEncounter } from "./encounters.js"
import {
  completeFollowUp,
  createFollowUp,
  listFollowUps,
  repeatFollowUp,
  stopFollowUpRepeat,
} from "./follow-ups.js"
import { setupTestDb } from "./test-setup.js"

setupTestDb()

const DAY = 86_400_000

it("un control que se repite deja indicado el siguiente al completarlo, uno solo, hasta que se detiene (issue 229, decisión 16)", async () => {
  const f = await clinicalFixture()
  const tomorrow = new Date(Date.now() + DAY).toISOString()
  const indicate = (repeatEveryMonths: number | null) =>
    f.run((tx) =>
      createFollowUp(tx, ...f.args, {
        kind: "mantenimiento",
        title: "Control de presión arterial",
        instructions: "Traer el registro de la casa",
        dueAt: tomorrow,
        originEncounterId: f.encounter.id,
        repeatEveryMonths,
      }),
    )
  await expect(indicate(2)).rejects.toThrow(/cada 1, 3, 6 o 12 meses/)
  const control = await indicate(3)
  expect(control.repeatEveryMonths).toBe(3)

  await f.ready(f.encounter.id)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id, {}))
  const done = await f.run((tx) =>
    completeFollowUp(tx, ...f.args, control.id, {
      encounterId: f.encounter.id,
      outcome: "PA 128/82",
    }),
  )
  expect(done.status).toBe("realizado")

  // El siguiente: los mismos datos, para tres meses después del día en que se hizo.
  const open = () =>
    f.run((tx) => listFollowUps(tx, "org_a", f.patient.id, { status: "pendiente" }))
  const [next] = await open()
  expect(next).toMatchObject({
    title: "Control de presión arterial",
    instructions: "Traer el registro de la casa",
    repeatEveryMonths: 3,
    repeatsFromId: control.id,
    originEncounterId: f.encounter.id,
  })
  const days = (new Date(next!.dueAt).getTime() - Date.now()) / DAY
  expect(days).toBeGreaterThan(87)
  expect(days).toBeLessThan(94)

  // Completarlo por otro camino no deja un segundo siguiente.
  await f.run((tx) => repeatFollowUp(tx, "org_a", f.actor, done))
  expect(await open()).toHaveLength(1)

  // Se detiene: el control sigue en pie, pero al completarlo ya no deja otro.
  const stopped = await f.run((tx) => stopFollowUpRepeat(tx, ...f.args, next!.id))
  expect(stopped.repeatEveryMonths).toBeNull()
  await expect(f.run((tx) => stopFollowUpRepeat(tx, ...f.args, next!.id))).rejects.toThrow(
    /no se repite/,
  )
  await f.run((tx) =>
    completeFollowUp(tx, ...f.args, next!.id, {
      encounterId: f.encounter.id,
      outcome: "PA 124/80",
    }),
  )
  expect(await open()).toHaveLength(0)
})
