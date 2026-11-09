import { encounter, patientDocument } from "@odentia/db/schema/clinical"
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
  lensPrescriptionCheck,
  listLensPrescriptions,
  transcribeLensPrescription,
  verifyLensPrescription,
  voidLensPrescription,
} from "./lens-prescriptions.js"
import { renderLensPrescriptionPdf } from "./lens-prescription-pdf.js"
import { collectPortalPapers } from "../portal-papers.js"

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
    // La de la óptica nace verificada: no se desverifica.
    await expect(
      f.run((tx) => tx.update(lensPrescription).set({ verifiedAt: null, verifiedBy: null }).where(eq(lensPrescription.id, issued.id))),
    ).rejects.toThrow()
    await f.run((tx) => voidLensPrescription(tx, ...f.args, issued.id, { reason: "Error de transcripción" }))
    // Anulada, ya nada cambia: ni se desanula ni se reescribe su motivo, tampoco para el dueño de la base.
    await expect(
      f.run((tx) => tx.update(lensPrescription).set({ voidedAt: null, voidedBy: null, voidReason: null }).where(eq(lensPrescription.id, issued.id))),
    ).rejects.toThrow()
    await expect(
      f.run((tx) => tx.update(lensPrescription).set({ voidReason: "Otro motivo" }).where(eq(lensPrescription.id, issued.id))),
    ).rejects.toThrow()
    await expect(ownerDb.update(lensPrescription).set({ lenses: { od: { esfera: 5 } } }).where(eq(lensPrescription.id, issued.id))).rejects.toThrow()
  })

  it("la externa se verifica una sola vez, y verificada no vuelve atrás", async () => {
    const f = await clinicalFixture(OPTICA)
    const external = await f.run((tx) =>
      transcribeLensPrescription(tx, ...f.args, {
        kind: "anteojos",
        lenses: { od: { esfera: -1 } },
        issuedOn: "2026-03-01",
        prescriberName: "Dra. Ana Ruiz",
      }),
    )
    await f.run((tx) => verifyLensPrescription(tx, ...f.args, external.id))
    await expect(
      f.run((tx) => tx.update(lensPrescription).set({ verifiedAt: null, verifiedBy: null }).where(eq(lensPrescription.id, external.id))),
    ).rejects.toThrow()
  })

  it("quien atendió emite otra desde el examen ya firmado, después de anular la primera", async () => {
    const f = await examined()
    const first = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" }))
    await ownerDb
      .update(encounter)
      .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Lic. Rosa Paz", signerRegistration: "COP 12345" })
      .where(eq(encounter.id, f.encounter.id))
    await f.run((tx) => voidLensPrescription(tx, ...f.args, first.id, { reason: "El eje estaba mal" }))
    const again = await f.run((tx) =>
      issueLensPrescription(tx, ...f.args, {
        encounterId: f.encounter.id,
        kind: "anteojos",
        lenses: { od: { esfera: -1.25, cilindro: -0.5, eje: 175 }, oi: { esfera: -1 } },
      }),
    )
    expect(again).toMatchObject({ source: "examen", encounterId: f.encounter.id, lenses: { od: { eje: 175 } } })
  })

  it("la de lentes de contacto del examen compensa la distancia al ojo y no lleva prisma", async () => {
    const f = await clinicalFixture(OPTICA)
    await ownerDb
      .update(encounter)
      .set({ examination: { refraccion: { od: { esfera: -8, prisma: 1, base: "adentro" }, oi: { esfera: 6 } } } })
      .where(eq(encounter.id, f.encounter.id))
    const contact = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "contacto" }))
    expect(contact.lenses).toEqual({ od: { esfera: -7.25 }, oi: { esfera: 6.5 } })
    await expect(
      f.run((tx) =>
        issueLensPrescription(tx, ...f.args, {
          encounterId: f.encounter.id,
          kind: "contacto",
          lenses: { od: { esfera: -7.25, prisma: 1, base: "adentro" } },
        }),
      ),
    ).rejects.toMatchObject({ fields: { "lentes.od.prisma": expect.any(String) } })
  })

  it("la externa guarda el prisma, la distancia pupilar y su foto, que debe ser de la misma persona", async () => {
    const f = await clinicalFixture(OPTICA)
    const other = await clinicalFixture(OPTICA)
    const [photo] = await ownerDb
      .insert(patientDocument)
      .values({
        organizationId: OPTICA,
        patientId: f.patient.id,
        category: "otro",
        label: "Receta externa",
        storageKey: "fotos/receta.jpg",
        contentType: "image/jpeg",
        sizeBytes: 1000,
      })
      .returning()
    const input = {
      kind: "anteojos",
      lenses: { od: { esfera: 1, prisma: 2, base: "adentro", prisma2: 1, base2: "arriba" } },
      issuedOn: "2026-04-01",
      prescriberName: "Dr. Luis Paz",
      pupillaryDistance: { binocular: 63 },
    }
    const saved = await f.run((tx) => transcribeLensPrescription(tx, ...f.args, { ...input, photoDocumentId: photo!.id }))
    expect(saved).toMatchObject({
      lenses: { od: { esfera: 1, prisma: 2, base: "adentro", prisma2: 1, base2: "arriba" } },
      pupillaryDistance: { binocular: 63 },
      photoDocumentId: photo!.id,
    })
    // La foto de otra persona no se une.
    await expect(
      other.run((tx) => transcribeLensPrescription(tx, ...other.args, { ...input, photoDocumentId: photo!.id })),
    ).rejects.toMatchObject({ fields: { photoDocumentId: expect.any(String) } })
    // Todos los errores a la vez, cada uno junto a su dato.
    await expect(
      f.run((tx) =>
        transcribeLensPrescription(tx, ...f.args, { ...input, lenses: { od: { esfera: 1.1 } }, pupillaryDistance: { od: 50 } }),
      ),
    ).rejects.toMatchObject({ fields: { "lentes.od.esfera": expect.any(String), "pupillaryDistance.od": expect.any(String) } })
  })

  it("el QR dice si la receta está vigente, vencida o anulada", async () => {
    const f = await examined()
    const issued = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" }))
    expect(await f.run((tx) => lensPrescriptionCheck(tx, OPTICA, issued.id))).toMatchObject({
      patientId: f.patient.id,
      state: "vigente",
      label: "Receta de anteojos",
      validUntil: issued.validUntil,
      signer: { registration: "COP 12345" },
    })
    const old = await f.run((tx) =>
      transcribeLensPrescription(tx, ...f.args, { kind: "anteojos", lenses: { od: { esfera: 1 } }, issuedOn: "2024-01-01", prescriberName: "Dra. Ruiz" }),
    )
    expect((await f.run((tx) => lensPrescriptionCheck(tx, OPTICA, old.id)))?.state).toBe("vencido")
    await f.run((tx) => voidLensPrescription(tx, ...f.args, issued.id, { reason: "Duplicada" }))
    expect((await f.run((tx) => lensPrescriptionCheck(tx, OPTICA, issued.id)))?.state).toBe("anulado")
    const hook = await f.run(async (tx) => (await productHooks(tx, OPTICA)).documentCheck?.(tx, OPTICA, "lens_prescription", issued.id))
    expect(hook?.state).toBe("anulado")
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

  it("el cliente ve su receta en «Tus documentos» del portal", async () => {
    const f = await examined()
    const issued = await f.run((tx) => issueLensPrescription(tx, ...f.args, { encounterId: f.encounter.id, kind: "anteojos" }))
    const papers = await f.run((tx) => collectPortalPapers(tx, OPTICA, f.patient.id, { account: false }))
    expect(papers.filter((paper) => paper.kind === "producto")).toEqual([
      expect.objectContaining({ id: issued.id, type: "Receta de lentes", title: "Receta de anteojos", stateWord: null, image: false }),
    ])
    // La externa sin verificar no está terminada: no llega a su portal hasta que la revise un optómetra.
    const external = await f.run((tx) =>
      transcribeLensPrescription(tx, ...f.args, { kind: "contacto", lenses: { od: { esfera: -2 } }, issuedOn: "2026-05-01", prescriberName: "Dra. Ruiz" }),
    )
    const before = await f.run((tx) => collectPortalPapers(tx, OPTICA, f.patient.id, { account: false }))
    expect(before.some((paper) => paper.id === external.id)).toBe(false)
    await f.run((tx) => verifyLensPrescription(tx, ...f.args, external.id))
    const after = await f.run((tx) => collectPortalPapers(tx, OPTICA, f.patient.id, { account: false }))
    expect(after.some((paper) => paper.id === external.id)).toBe(true)
    // La receta de otra persona no está en su portal ni se imprime con su ficha.
    const other = await clinicalFixture(OPTICA)
    const theirs = await other.run((tx) => collectPortalPapers(tx, OPTICA, other.patient.id, { account: false }))
    expect(theirs.some((paper) => paper.id === issued.id)).toBe(false)
    await expect(other.run((tx) => renderLensPrescriptionPdf(tx, OPTICA, other.patient.id, issued.id))).rejects.toMatchObject({ status: 404 })
  })

  it("en una clínica de otro producto no hay recetas de lentes", async () => {
    const f = await clinicalFixture("org_a")
    await expect(f.run((tx) => listLensPrescriptions(tx, "org_a", f.patient.id))).rejects.toMatchObject({ status: 404 })
  })
})
