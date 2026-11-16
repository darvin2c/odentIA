import { encounterSite } from "@odentia/db/schema/clinical"
import { clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createFormResponse } from "./clinical-forms.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/**
 * Tablero P09 del estudio de la atención (16 nov): la ficha de una especialidad empezada en la
 * atención toma la pieza de la atención y no la pide en otro odontograma, solo si la atención
 * tiene una sola pieza. Con la 36 y la 46, adivinar sería un error.
 */

const ORG = "org_a"
const SCHEMA = {
  sections: [
    {
      id: "pieza",
      title: "Pieza tratada",
      fields: [
        { id: "pieza", label: "Pieza", type: "pieza" },
        { id: "dolor", label: "Dolor", type: "texto" },
      ],
    },
  ],
}

async function attentionWithTeeth(teeth: string[]) {
  const fx = await clinicalFixture(ORG)
  for (const tooth of teeth) {
    await ownerDb
      .insert(encounterSite)
      .values({ organizationId: ORG, encounterId: fx.encounter.id, siteSystem: "ISO-3950", siteCode: tooth })
  }
  const [template] = await ownerDb
    .insert(clinicalFormTemplate)
    .values({ organizationId: ORG, key: `endo-${fx.actor}`, title: "Ficha de endodoncia", status: "publicado", schema: SCHEMA })
    .returning()
  const start = (answers: Record<string, unknown> = {}) =>
    fx.run((tx) =>
      createFormResponse(tx, ORG, fx.actor, {
        templateId: template!.id,
        patientId: fx.patient.id,
        encounterId: fx.encounter.id,
        answers,
      }),
    )
  return { fx, start }
}

describe("la ficha de la especialidad toma la pieza de la atención", () => {
  it("con una sola pieza en la atención, la ficha empieza con ella", async () => {
    const { start } = await attentionWithTeeth(["36"])
    const form = await start()
    expect(form.answers).toEqual({ pieza: 36 })
  })

  it("con dos piezas no adivina: la pregunta queda sin responder", async () => {
    const { start } = await attentionWithTeeth(["36", "46"])
    const form = await start()
    expect(form.answers).toEqual({})
  })

  it("lo que se mandó escrito gana sobre la pieza de la atención", async () => {
    const { start } = await attentionWithTeeth(["36"])
    const form = await start({ pieza: 46 })
    expect(form.answers).toEqual({ pieza: 46 })
  })
})
