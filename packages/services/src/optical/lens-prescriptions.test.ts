import { encounter } from "@odentia/db/schema/clinical"
import { lensPrescription } from "@odentia/db/schema/optical"
import { orgProfile } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { updateEncounterDraft } from "../encounters.js"
import { insertOrg, ownerDb, setupTestDb } from "../test-setup.js"
import { productHooks } from "../products.js"
import {
  currentLensPrescriptions,
  issueLensPrescription,
  listLensPrescriptions,
  transcribeLensPrescription,
  verifyLensPrescription,
  voidLensPrescription,
} from "./lens-prescriptions.js"
import { renderLensPrescriptionPdf } from "./lens-prescription-pdf.js"

setupTestDb()

const OPTICA = "org_optica"

beforeAll(async () => {
  await insertOrg(ownerDb, OPTICA, "optica-recetas")
  await ownerDb.update(orgProfile).set({ product: "optical" }).where(eq(orgProfile.organizationId, OPTICA))
})

/** Una atención de la óptica con su examen de la vista guardado. */
async function examined() {
  const f = await clinicalFixture(OPTICA)
  await ownerDb
    .update(encounter)
    .set({
      examination: {
        agudeza: { od: { scLejos: "20/80", ccLejos: "20/20" } },
        refraccion: { od: { esfera: -1.25, cilindro: -0.5, eje: 180 }, oi: { esfera: -1 } },
        dp: { od: 31.5, oi: 32 },
      },
    })
    .where(eq(encounter.id, f.encounter.id))
  return f
}

describe("la receta de lentes de vistIA (entrega 3)", () => {
  it("la atención de una óptica guarda el examen de la vista y señala el dato mal escrito", async () => {
    const f = await clinicalFixture(OPTICA)
    const saved = await f.run((tx) =>
      updateEncounterDraft(tx, ...f.args, f.encounter.id, {
        examination: { refraccion: { od: { esfera: -2, cilindro: -0.75, eje: 90 } }, salud: { presion: { od: 24 } } },
      }),
    )
    expect(saved.examination).toEqual({ refraccion: { od: { esfera: -2, cilindro: -0.75, eje: 90 } }, salud: { presion: { od: 24 } } })
    await expect(
      f.run((tx) => updateEncounterDraft(tx, ...f.args, f.encounter.id, { examination: { refraccion: { od: { esfera: -2, cilindro: -0.75 } } } })),
    ).rejects.toMatchObject({ status: 400, fields: { "examination.refraccion.od.eje": "Eje OD: con cilindro hace falta el eje" } })
  })

  it("la de anteojos sale de la refracción del examen, con la DP y la firma de quien examinó", async () => {
    const f = await examined()
    const issued = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" }))
    expect(issued).toMatchObject({
      kind: "anteojos",
      source: "examen",
      lenses: { od: { esfera: -1.25, cilindro: -0.5, eje: 180 }, oi: { esfera: -1 } },
      pupillaryDistance: { od: 31.5, oi: 32 },
      prescriberRegistration: "COP 12345",
      notices: [],
    })
    expect(issued.verifiedAt).not.toBeNull()
    // Una atención emite una sola receta de cada tipo mientras no se anule.
    await expect(
      f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" })),
    ).rejects.toMatchObject({ status: 409, code: "PRESCRIPTION_EXISTS" })
    // La de lentes de contacto lleva lo suyo.
    const contact = await f.run((tx) =>
      issueLensPrescription(tx, ...f.args, {
        encounterId: f.encounter.id,
        kind: "contacto",
        lenses: { od: { esfera: -1.25, curvaBase: 8.6, diametro: 14.2, marca: "Acuvue" } },
      }),
    )
    expect(contact.lenses).toEqual({ od: { esfera: -1.25, curvaBase: 8.6, diametro: 14.2, marca: "Acuvue" } })
    const current = await f.run((tx) => currentLensPrescriptions(tx, OPTICA, f.patient.id))
    expect(current.anteojos?.id).toBe(issued.id)
    expect(current.contacto?.id).toBe(contact.id)
  })

  it("sin refracción no hay receta de anteojos, y un dato mal escrito dice cuál", async () => {
    const f = await clinicalFixture(OPTICA)
    await expect(
      f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" })),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      f.run((tx) =>
        issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "contacto", lenses: { od: { esfera: -1, curvaBase: 6 } } }),
      ),
    ).rejects.toMatchObject({ fields: { "lentes.od.curvaBase": expect.any(String) } })
  })

  it("la externa queda sin verificar hasta que la revise un optómetra, y anulada sale de las vigentes", async () => {
    const f = await clinicalFixture(OPTICA)
    const external = await f.run((tx) =>
      transcribeLensPrescription(tx, ...f.args, {
        kind: "anteojos",
        lenses: { od: { esfera: 2, adicion: 2.5 }, oi: { esfera: 2.25, adicion: 2.5 } },
        issuedOn: "2026-01-10",
        prescriberName: "Dra. Ana Ruiz",
        prescriberRegistration: "CMP 12345",
      }),
    )
    expect(external).toMatchObject({ source: "externa", verifiedAt: null, validUntil: "2027-01-10" })
    expect(external.notices).toEqual(["Transcrita, sin verificar: un optómetra todavía no la revisó."])
    const verified = await f.run((tx) => verifyLensPrescription(tx, ...f.args, external.id))
    expect(verified.verifiedAt).not.toBeNull()
    expect(verified.notices).toEqual([])
    const voided = await f.run((tx) => voidLensPrescription(tx, ...f.args, external.id, { reason: "Transcrita con un error" }))
    expect(voided).toMatchObject({ voidReason: "Transcrita con un error" })
    expect(await f.run((tx) => currentLensPrescriptions(tx, OPTICA, f.patient.id))).toEqual({})
    expect((await f.run((tx) => listLensPrescriptions(tx, OPTICA, f.patient.id))).map((item) => item.id)).toEqual([external.id])
    // En la copia de la historia, con su motivo.
    const sections = await f.run(async (tx) => (await productHooks(tx, OPTICA)).recordSections(tx, { orgId: OPTICA, patientId: f.patient.id }))
    expect(sections).toEqual([
      {
        title: "Recetas de lentes",
        lines: [
          "10/01/2026 · Anteojos · externa, de Dra. Ana Ruiz · anulada: Transcrita con un error",
          "  OD +2,00 · Add +2,50",
          "  OI +2,25 · Add +2,50",
        ],
        empty: "Sin recetas de lentes.",
      },
    ])
  })

  it("emitida no cambia: la aplicación solo la verifica o la anula", async () => {
    const f = await examined()
    const issued = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" }))
    await expect(
      f.run((tx) => tx.update(lensPrescription).set({ lenses: { od: { esfera: 5 } } }).where(eq(lensPrescription.id, issued.id))),
    ).rejects.toThrow()
    await expect(f.run((tx) => tx.delete(lensPrescription).where(eq(lensPrescription.id, issued.id)))).rejects.toThrow()
  })

  it("la receta se imprime en PDF, la de la óptica y la externa", async () => {
    const f = await examined()
    const issued = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" }))
    const pdf = await f.run((tx) => renderLensPrescriptionPdf(tx, OPTICA, f.patient.id, issued.id))
    expect(Buffer.from(pdf.bytes.slice(0, 5)).toString()).toBe("%PDF-")
    expect(pdf.filename).toMatch(/^Receta-de-anteojos-\d{4}-\d{2}-\d{2}\.pdf$/)
    const external = await f.run((tx) =>
      transcribeLensPrescription(tx, ...f.args, {
        kind: "contacto",
        lenses: { od: { esfera: -3, curvaBase: 8.4, diametro: 14, marca: "Biofinity" } },
        issuedOn: "2026-02-01",
        prescriberName: "Dr. Luis Paz",
      }),
    )
    await f.run((tx) => voidLensPrescription(tx, ...f.args, external.id, { reason: "Duplicada" }))
    const voided = await f.run((tx) => renderLensPrescriptionPdf(tx, OPTICA, f.patient.id, external.id))
    expect(voided.bytes.length).toBeGreaterThan(1000)
  })

  it("en una clínica de otro producto no hay recetas de lentes", async () => {
    const f = await clinicalFixture("org_a")
    await expect(f.run((tx) => listLensPrescriptions(tx, "org_a", f.patient.id))).rejects.toMatchObject({ status: 404 })
  })
})
