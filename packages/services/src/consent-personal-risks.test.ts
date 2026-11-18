/**
 * Reglas clínicas del 18 nov (punto 5, caso C1): el consentimiento de la exodoncia nace con los
 * riesgos propios de su caso, propuestos desde su ficha; se cambian o se borran mientras está
 * pendiente y no se envió a su enlace, y lo firmado no cambia.
 */
import { randomUUID } from "node:crypto"
import { SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import { patientMedication } from "@odentia/db/schema/clinical"
import { user } from "@odentia/db/schema/auth"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  createConsentDocument,
  createConsentTemplate,
  getConsentPrint,
  checkConsentPaperSheet,
  listConsentEvents,
  markConsentPrinted,
  markConsentSentByLink,
  publishConsentTemplate,
  setConsentPersonalRisks,
  signConsentDocument,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createPatient, getPatient } from "./patients.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

let exodoncia: { id: string } | null = null
/** La plantilla sugerida de la exodoncia, publicada una vez en la clínica de prueba. */
async function exodonciaTemplate(f: Fixture) {
  if (exodoncia) return exodoncia
  const suggested = SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === "exodoncia")!
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, "org_a", f.actor, {
      key: "exodoncia",
      title: suggested.title,
      sections: suggested.sections,
    }),
  )
  exodoncia = await f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, draft.id))
  return exodoncia
}

const create = async (f: Fixture) => {
  const template = await exodonciaTemplate(f)
  return f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, {
      patientId: f.patient.id,
      templateId: template.id,
      procedureRef: "Exodoncia de la pieza 48",
    }),
  )
}

const personalRisksOf = async (id: string) => {
  const [row] = await ownerDb
    .select({ sections: consentDocument.sectionsSnapshot })
    .from(consentDocument)
    .where(eq(consentDocument.id, id))
  return (row?.sections as { personalRisks?: string[] } | null)?.personalRisks ?? null
}

it("Teresa, con apixabán y alendronato escrito a mano: la exodoncia nace con sus dos riesgos y se cambian", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(patientMedication).values([
    {
      organizationId: "org_a",
      patientId: f.patient.id,
      name: "Apixabán 5 mg",
      genericName: "apixabán",
      atcCode: "B01AF02",
    },
    {
      organizationId: "org_a",
      patientId: f.patient.id,
      name: "alendronato 70 mg semanal",
      atcCode: "M05BA04",
    },
  ])
  const doc = await create(f)
  expect(await personalRisksOf(doc.id)).toEqual([
    "Toma un anticoagulante (apixabán): puede sangrar más tiempo después de la extracción.",
    "Toma una medicina para los huesos (alendronato): hay un riesgo poco frecuente de que el hueso de la zona no cicatrice (osteonecrosis).",
  ])

  // El profesional lo cambia: la hoja que se imprime dice lo nuevo, y queda en su historia.
  await f.run((tx) =>
    setConsentPersonalRisks(
      tx,
      "org_a",
      f.actor,
      doc.id,
      "Toma apixabán: puede sangrar más.\n\n  Usa prótesis superior.  ",
    ),
  )
  const print = await f.run((tx) => getConsentPrint(tx, "org_a", doc.id))
  expect((print.document.sectionsSnapshot as { personalRisks?: string[] }).personalRisks).toEqual([
    "Toma apixabán: puede sangrar más.",
    "Usa prótesis superior.",
  ])
  const events = await f.run((tx) => listConsentEvents(tx, "org_a", doc.id))
  expect(events.map((event) => [event.toStatus, event.reason])).toContainEqual([
    "riesgos_propios",
    "Cambiados",
  ])
  // La Historia del documento dice quién los cambió (QA del 18 nov).
  expect(events.find((event) => event.toStatus === "riesgos_propios")?.actorName).toBe("Clínico")

  // Vacío los quita: la hoja queda como siempre.
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, doc.id, "  "))
  expect(await personalRisksOf(doc.id)).toBeNull()
  const [row] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, doc.id))
  expect(row?.sectionsSnapshot).not.toHaveProperty("personalRisks")
})

it("sin nada en su ficha, el consentimiento nace sin riesgos propios", async () => {
  const f = await clinicalFixture()
  const doc = await create(f)
  expect(doc.sectionsSnapshot).not.toHaveProperty("personalRisks")
})

it("enviado a su enlace o firmado, ya no se cambia: el servidor lo rechaza", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .insert(patientMedication)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      name: "Eliquis",
      atcCode: "B01AF02",
    })
  const sent = await create(f)
  await f.run((tx) => markConsentSentByLink(tx, "org_a", f.actor, sent.id))
  await expect(
    f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, sent.id, "Otro texto")),
  ).rejects.toMatchObject({ code: "CONSENT_SENT" })

  const signed = await create(f)
  await ownerDb
    .update(consentDocument)
    .set({ status: "firmado", signedAt: new Date(), signerName: "Teresa" })
    .where(eq(consentDocument.id, signed.id))
  await expect(
    f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, signed.id, "Otro texto")),
  ).rejects.toMatchObject({ code: "CONSENT_STATUS" })
  expect(await personalRisksOf(signed.id)).toEqual([
    "Toma un anticoagulante (Eliquis): puede sangrar más tiempo después de la extracción.",
  ])
})

it("lo firmado es lo que vio: si los riesgos propios cambiaron después de mostrarse, no se firma", async () => {
  const f = await clinicalFixture()
  const teresa = await f.run((tx) =>
    createPatient(tx, "org_a", f.actor, { displayName: "Teresa Huamán", birthDate: "1950-03-12" }),
  )
  const self = (await f.run((tx) => getPatient(tx, "org_a", teresa.id))).contacts.find(
    (link) => link.relationship === "self",
  )!.contactId
  await ownerDb
    .insert(patientMedication)
    .values({ organizationId: "org_a", patientId: teresa.id, name: "Eliquis", atcCode: "B01AF02" })
  const template = await exodonciaTemplate(f)
  const prepare = () =>
    f.run((tx) =>
      createConsentDocument(tx, "org_a", f.actor, {
        patientId: teresa.id,
        templateId: template.id,
        procedureRef: "Exodoncia de la pieza 48",
      }),
    )
  const shown = ["Toma un anticoagulante (Eliquis): puede sangrar más tiempo después de la extracción."]
  const sign = (id: string, extra: Partial<Parameters<typeof signConsentDocument>[4]>) =>
    f.run((tx) =>
      signConsentDocument(tx, "org_a", f.actor, id, {
        signerKind: "paciente",
        signerContactId: self,
        signatureData: { strokes: [[[1, 1], [2, 2]]] },
        comprehensionConfirmed: true,
        ...extra,
      }),
    )

  // En la tablet se le mostró A y, mientras, otro lo cambió a B: no se firma B sin que lo lea.
  const tablet = await prepare()
  expect(await personalRisksOf(tablet.id)).toEqual(shown)
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, tablet.id, "Toma Eliquis: lo suspende 1 día."))
  await expect(sign(tablet.id, { personalRisksShown: shown })).rejects.toMatchObject({
    code: "CONSENT_CHANGED",
    message: "Los riesgos propios cambiaron después de mostrarse: vuelve a mostrarle la hoja.",
  })
  // Sin decir lo que vio, tampoco: para el servidor, su hoja no tenía riesgos propios.
  await expect(sign(tablet.id, {})).rejects.toMatchObject({ code: "CONSENT_CHANGED" })
  // Con la hoja nueva a la vista, firma.
  const signed = await sign(tablet.id, { personalRisksShown: ["Toma Eliquis: lo suspende 1 día."] })
  expect(signed.status).toBe("firmado")

  // En papel: se imprimió con A y se quitaron después; la foto de esa hoja no firma lo de ahora.
  const paper = await prepare()
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, paper.id, null))
  await expect(
    sign(paper.id, { method: "papel", paperDocumentId: randomUUID(), signatureData: undefined, personalRisksShown: shown }),
  ).rejects.toMatchObject({
    code: "CONSENT_CHANGED",
    message: "Los riesgos propios cambiaron después de imprimir la hoja: imprímela de nuevo y que la firme.",
  })
})

it("en papel vale la hoja que salió impresa, aunque la pestaña se recargue: el servidor la recuerda", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .insert(patientMedication)
    .values({ organizationId: "org_a", patientId: f.patient.id, name: "Eliquis", atcCode: "B01AF02" })
  const doc = await create(f)
  const printed = ["Toma un anticoagulante (Eliquis): puede sangrar más tiempo después de la extracción."]
  // Se imprime con un riesgo; después se cambia a otro (en esta u otra pestaña).
  expect(await f.run((tx) => markConsentPrinted(tx, "org_a", doc.id, printed))).toEqual({ printedPersonalRisks: printed })
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, doc.id, "Toma Eliquis: lo suspende 1 día."))
  // La pestaña recargada ya no sabe qué se imprimió y manda lo que tiene a la vista: no basta.
  const now = ["Toma Eliquis: lo suspende 1 día."]
  await expect(f.run((tx) => checkConsentPaperSheet(tx, "org_a", doc.id, now))).rejects.toMatchObject({
    code: "CONSENT_CHANGED",
    message: "Los riesgos propios cambiaron después de imprimir la hoja: imprímela de nuevo y que la firme.",
  })
  // La nota de lo impreso no cambia la hoja ni dice que alguien la editó.
  const [row] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, doc.id))
  expect((row?.sectionsSnapshot as { personalRisks?: string[] } | undefined)?.personalRisks).toEqual(now)
  // Impresa de nuevo, con lo de ahora: se puede firmar en papel.
  await f.run((tx) => markConsentPrinted(tx, "org_a", doc.id, now))
  await expect(f.run((tx) => checkConsentPaperSheet(tx, "org_a", doc.id, now))).resolves.toBeUndefined()
  // Sin impresión anotada, vale la hoja a la vista (como antes).
  const other = await create(f)
  await expect(f.run((tx) => checkConsentPaperSheet(tx, "org_a", other.id, printed))).resolves.toBeUndefined()
  await expect(f.run((tx) => checkConsentPaperSheet(tx, "org_a", other.id, []))).rejects.toMatchObject({
    code: "CONSENT_CHANGED",
  })
})

it("si otra pestaña cambió los riesgos mientras los editaba, no se pisan: 409 con un mensaje claro", async () => {
  const f = await clinicalFixture()
  await ownerDb
    .insert(patientMedication)
    .values({ organizationId: "org_a", patientId: f.patient.id, name: "Eliquis", atcCode: "B01AF02" })
  const doc = await create(f)
  const proposed = ["Toma un anticoagulante (Eliquis): puede sangrar más tiempo después de la extracción."]
  // Luis, en otro equipo, guarda tres riesgos.
  const luis = randomUUID()
  await ownerDb.insert(user).values({ id: luis, name: "Luis Prado", email: `${luis}@example.test` })
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", luis, doc.id, "Uno.\nDos.\nTres.", proposed))
  // Quien todavía veía el propuesto no pisa lo de Luis, y el aviso dice quién fue (QA de diseño, H6).
  await expect(
    f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, doc.id, "Solo uno.", proposed)),
  ).rejects.toMatchObject({
    code: "CONSENT_RISKS_CHANGED",
    status: 409,
    message: "Luis Prado cambió los riesgos propios mientras los editabas. Mira los de ahora y vuelve a guardar lo tuyo.",
  })
  expect(await personalRisksOf(doc.id)).toEqual(["Uno.", "Dos.", "Tres."])
  // El reintento de lo mismo que ya quedó (se perdió la respuesta) no falla ni deja otro evento.
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", luis, doc.id, "Uno.\nDos.\nTres.", proposed))
  const changes = (await f.run((tx) => listConsentEvents(tx, "org_a", doc.id))).filter(
    (event) => event.toStatus === "riesgos_propios",
  )
  expect(changes).toHaveLength(1)
  // Con lo de ahora a la vista, guarda.
  await f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, doc.id, "Solo uno.", ["Uno.", "Dos.", "Tres."]))
  expect(await personalRisksOf(doc.id)).toEqual(["Solo uno."])
  // La misma persona en otra pestaña: ni «Alguien» ni su propio nombre.
  await expect(
    f.run((tx) => setConsentPersonalRisks(tx, "org_a", f.actor, doc.id, "Otro.", ["Uno.", "Dos.", "Tres."])),
  ).rejects.toMatchObject({
    message: "Los cambiaste en otra pestaña mientras los editabas aquí. Mira los de ahora y vuelve a guardar lo tuyo.",
  })
})
