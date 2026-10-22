/**
 * La atención hace todo lo de la visita (fase 3, paso 2B; ADR 0033): el
 * consentimiento que se propone solo por sus servicios, la firma en la clínica
 * sin dibujar la del profesional y la firma en papel, el cierre que avisa sin
 * bloquear, lo que falta publicar en «Te espera», las órdenes y los papeles de
 * salud que solo van a la persona o a su representante legal.
 */
import { createHash, randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
import { encounter, patientDocument, serviceCatalog } from "@odentia/db/schema/clinical"
import { crmTask } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  advanceClinicalOrder,
  cancelClinicalOrder,
  createClinicalOrder,
  createConsentTemplate,
  createFormResponse,
  createFormTemplate,
  getEncounterConsentNeeds,
  listConsentsToPublish,
  listFormTemplates,
  prepareEncounterConsents,
  publishConsentTemplate,
  publishFormTemplate,
  setConsentTemplateServices,
  setProfessionalSpecialties,
  createSpecialty,
  revokeConsentDocument,
  signConsentDocument,
} from "./clinical-forms.js"
import { generateConsentPdf } from "./consent-pdf.js"
import { clinicalFixture, seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { createContact } from "./contacts.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import {
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
  getEncounterClosing,
  updateEncounterDraft,
} from "./encounters.js"
import {
  getHealthDocumentSendOptions,
  listHealthDocumentRecipients,
  renderHealthDocumentPdf,
  sendHealthDocument,
} from "./health-documents.js"
import { createPatient, getPatient } from "./patients.js"
import { grantResponsibility } from "./responsibilities.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const sections = {
  procedure: "Extracción de la pieza dentaria con anestesia local.",
  benefits: ["Quitar el dolor y la infección"],
  risks: ["Sangrado y dolor los primeros días"],
  alternatives: ["Tratamiento de conductos cuando es posible"],
  consequences: "La infección puede avanzar y causar dolor.",
}

/** Clínica con una exodoncia por pieza, una paciente adulta con su atención abierta y un diagnóstico. */
async function visit() {
  const f = await clinicalFixture()
  await seedDiagnosisCodes([{ code: "K01.1", title: "Diente impactado" }])
  const [extraction] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: "org_a",
      name: "Exodoncia simple",
      scope: "tooth",
      source: "custom",
      priceCents: 15000,
      currency: "PEN",
    })
    .returning()
  if (!extraction) throw new Error("Sin servicio")
  const lucia = await f.run((tx) =>
    createPatient(tx, "org_a", f.actor, { displayName: "Lucía Fernández", birthDate: "1995-07-30" }),
  )
  const draft = await f.run((tx) =>
    createEncounter(tx, "org_a", f.actor, lucia.id, { reason: "Dolor en la muela del juicio" }),
  )
  await f.run((tx) =>
    addEncounterDiagnosis(tx, "org_a", f.actor, lucia.id, draft.id, {
      diagnosisCode: "K01.1",
      diagnosisType: "confirmed",
      toothNumber: 38,
    }),
  )
  const template = async (title: string, publish = true) => {
    const created = await f.run((tx) =>
      createConsentTemplate(tx, "org_a", f.actor, { key: `t-${randomUUID().slice(0, 8)}`, title, sections }),
    )
    return publish ? f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, created.id)) : created
  }
  const self = async () => {
    const own = (await f.run((tx) => getPatient(tx, "org_a", lucia.id))).contacts.find(
      (link) => link.relationship === "self",
    )
    if (!own) throw new Error("Sin persona propia")
    return own.contactId
  }
  return { ...f, extraction, lucia, draft, template, self }
}

it("el consentimiento se propone por el servicio, se prepara lleno y el cierre pide decir por qué falta", async () => {
  const v = await visit()
  const exodoncia = await v.template("Exodoncia simple o quirúrgica")
  await v.run((tx) => setConsentTemplateServices(tx, "org_a", v.actor, exodoncia.id, [v.extraction.id]))
  // Sin el servicio registrado no se pide nada.
  expect(await v.run((tx) => getEncounterConsentNeeds(tx, "org_a", v.lucia.id, v.draft.id))).toEqual([])

  await v.run((tx) =>
    addEncounterProcedure(tx, "org_a", v.actor, v.lucia.id, v.draft.id, {
      serviceId: v.extraction.id,
      toothNumber: 38,
    }),
  )
  const [need] = await v.run((tx) => getEncounterConsentNeeds(tx, "org_a", v.lucia.id, v.draft.id))
  expect(need).toMatchObject({
    templateKey: exodoncia.key,
    status: "sin_preparar",
    procedureRef: "Exodoncia simple · pieza 38",
    diagnosisCode: "K01.1",
    services: ["Exodoncia simple"],
  })

  // «Preparar» lo genera una sola vez, con lo de la atención.
  const prepared = await v.run((tx) => prepareEncounterConsents(tx, "org_a", v.actor, v.lucia.id, v.draft.id))
  expect(prepared.created).toHaveLength(1)
  expect(prepared.created[0]).toMatchObject({
    encounterId: v.draft.id,
    procedureRef: "Exodoncia simple · pieza 38",
    diagnosisCode: "K01.1",
    status: "pendiente",
  })
  const again = await v.run((tx) => prepareEncounterConsents(tx, "org_a", v.actor, v.lucia.id, v.draft.id))
  expect(again.created).toHaveLength(0)

  // El cierre lo nombra y no bloquea, pero sin motivo no se cierra.
  await v.run((tx) =>
    updateEncounterDraft(tx, "org_a", v.actor, v.lucia.id, v.draft.id, { evolution: "Sin complicaciones" }),
  )
  const closing = await v.run((tx) => getEncounterClosing(tx, "org_a", v.actor, v.lucia.id, v.draft.id))
  expect(closing.ready).toBe(true)
  expect(closing.consents).toEqual([expect.objectContaining({ status: "pendiente", title: "Exodoncia simple o quirúrgica" })])
  await expect(
    v.run((tx) => finalizeEncounter(tx, "org_a", v.actor, v.lucia.id, v.draft.id)),
  ).rejects.toMatchObject({ code: "CONSENT_UNSIGNED", status: 409 })
  await v.run((tx) =>
    finalizeEncounter(tx, "org_a", v.actor, v.lucia.id, v.draft.id, {
      consentSkipReason: "Urgencia: se firmará en la próxima visita",
    }),
  )
  const [closed] = await ownerDb.select().from(encounter).where(eq(encounter.id, v.draft.id))
  expect(closed).toMatchObject({
    status: "finalizada",
    consentSkipReason: "Urgencia: se firmará en la próxima visita",
  })
})

it("firma en la clínica sin dibujar la del profesional, y en papel con la foto de la hoja", async () => {
  const v = await visit()
  const exodoncia = await v.template("Exodoncia simple o quirúrgica")
  const anestesia = await v.template("Anestesia local odontológica")
  for (const t of [exodoncia, anestesia])
    await v.run((tx) => setConsentTemplateServices(tx, "org_a", v.actor, t.id, [v.extraction.id]))
  await v.run((tx) =>
    addEncounterProcedure(tx, "org_a", v.actor, v.lucia.id, v.draft.id, { serviceId: v.extraction.id, toothNumber: 38 }),
  )
  const { created } = await v.run((tx) => prepareEncounterConsents(tx, "org_a", v.actor, v.lucia.id, v.draft.id))
  expect(created).toHaveLength(2)
  const signer = await v.self()
  const [first, second] = created as [(typeof created)[number], (typeof created)[number]]

  // En la unidad dental: la persona dibuja; el profesional confirma con su perfil.
  const inChair = await v.run((tx) =>
    signConsentDocument(tx, "org_a", v.actor, first.id, {
      signerKind: "paciente",
      signerContactId: signer,
      signatureData: { strokes: [[[1, 1], [2, 2]]] },
      comprehensionConfirmed: true,
    }),
  )
  expect(inChair).toMatchObject({
    status: "firmado",
    signatureMethod: "clinica",
    signatureLevel: "simple",
    professionalSignature: null,
    informerRegistration: "COP 12345",
  })

  // En papel: sin la foto de la hoja no se cierra el pendiente.
  await expect(
    v.run((tx) =>
      signConsentDocument(tx, "org_a", v.actor, second.id, {
        signerKind: "paciente",
        signerContactId: signer,
        comprehensionConfirmed: true,
        method: "papel",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const [photo] = await ownerDb
    .insert(patientDocument)
    .values({
      organizationId: "org_a",
      patientId: v.lucia.id,
      category: "consentimiento",
      label: "Hoja firmada de anestesia local",
      storageKey: `org_a/${randomUUID()}.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 1024,
    })
    .returning()
  const onPaper = await v.run((tx) =>
    signConsentDocument(tx, "org_a", v.actor, second.id, {
      signerKind: "paciente",
      signerContactId: signer,
      comprehensionConfirmed: true,
      method: "papel",
      paperDocumentId: photo!.id,
    }),
  )
  expect(onPaper).toMatchObject({ status: "firmado", signatureMethod: "papel", paperDocumentId: photo!.id })
  expect(onPaper.signatureData).toBeNull()

  // Firmados los dos, el cierre ya no pide nada.
  const closing = await v.run((tx) => getEncounterClosing(tx, "org_a", v.actor, v.lucia.id, v.draft.id))
  expect(closing.consents).toEqual([])
})

it("el consentimiento sale con el PDF guardado al firmar, y la revocación tiene el suyo (#47)", async () => {
  const v = await visit()
  const exodoncia = await v.template("Exodoncia simple o quirúrgica")
  await v.run((tx) => setConsentTemplateServices(tx, "org_a", v.actor, exodoncia.id, [v.extraction.id]))
  await v.run((tx) =>
    addEncounterProcedure(tx, "org_a", v.actor, v.lucia.id, v.draft.id, { serviceId: v.extraction.id, toothNumber: 38 }),
  )
  const { created } = await v.run((tx) => prepareEncounterConsents(tx, "org_a", v.actor, v.lucia.id, v.draft.id))
  const signer = await v.self()
  const consent = created[0]!
  const signed = await v.run((tx) =>
    signConsentDocument(tx, "org_a", v.actor, consent.id, {
      signerKind: "paciente",
      signerContactId: signer,
      signatureData: { strokes: [[[1, 1], [2, 2]]] },
      comprehensionConfirmed: true,
    }),
  )
  // La declaración que aceptó queda en el documento.
  expect(signed.declarationSnapshot).toMatch(/He leído y comprendido/)
  const files = new Map<string, Uint8Array>()
  const storage = {
    putPatientDocument: async ({ bytes }: { bytes: Uint8Array }) => {
      const objectKey = `org_a/${randomUUID()}.pdf`
      files.set(objectKey, bytes)
      return { objectKey, mimeType: "application/pdf", filename: "x.pdf", size: bytes.byteLength }
    },
    deleteAttachment: async (key: string) => void files.delete(key),
    getAttachment: async (key: string) => files.get(key)!,
  }
  const pdf = (id: string) =>
    generateConsentPdf({ run: v.run, storage, orgId: "org_a", userId: v.actor, consentId: id })
  const withPdf = await pdf(consent.id)
  const [file] = await ownerDb.select().from(patientDocument).where(eq(patientDocument.id, withPdf.pdfDocumentId!))
  const stored = files.get(file!.storageKey)!

  // Lo que se envía son los bytes guardados, los de la huella; no uno nuevo.
  const sent = await v.run((tx) => renderHealthDocumentPdf(tx, "org_a", v.lucia.id, "consent", consent.id, storage))
  expect(sent.bytes).toEqual(stored)
  expect(createHash("sha256").update(sent.bytes).digest("hex")).toBe(withPdf.pdfSha256)
  // Si el archivo guardado cambió, no se envía.
  files.set(file!.storageKey, new Uint8Array([...stored, 32]))
  await expect(
    v.run((tx) => renderHealthDocumentPdf(tx, "org_a", v.lucia.id, "consent", consent.id, storage)),
  ).rejects.toMatchObject({ code: "CONSENT_PDF_ALTERED" })
  files.set(file!.storageKey, stored)

  // Revocar guarda otro PDF; el firmado queda como estaba.
  await v.run((tx) =>
    revokeConsentDocument(tx, "org_a", v.actor, consent.id, {
      reason: "Prefiere esperar",
      revokerContactId: signer,
      signatureData: { strokes: [[[3, 3], [4, 4]]] },
    }),
  )
  const revoked = await pdf(consent.id)
  expect(revoked).toMatchObject({ status: "revocado", pdfDocumentId: withPdf.pdfDocumentId, pdfSha256: withPdf.pdfSha256 })
  expect(revoked.revokePdfDocumentId).toBeTruthy()
  expect(revoked.revokePdfSha256).not.toBe(withPdf.pdfSha256)
  // Una segunda vez no guarda otro.
  expect((await pdf(consent.id)).revokePdfDocumentId).toBe(revoked.revokePdfDocumentId)
})

it("sin plantilla publicada se firma en papel y quien configura lo ve hasta publicarla", async () => {
  const v = await visit()
  const draftTemplate = await v.template("Implante dental", false)
  await v.run((tx) => setConsentTemplateServices(tx, "org_a", v.actor, draftTemplate.id, [v.extraction.id]))
  await v.run((tx) =>
    addEncounterProcedure(tx, "org_a", v.actor, v.lucia.id, v.draft.id, { serviceId: v.extraction.id, toothNumber: 38 }),
  )
  const [need] = await v.run((tx) => getEncounterConsentNeeds(tx, "org_a", v.lucia.id, v.draft.id))
  expect(need).toMatchObject({ status: "sin_publicar", templateId: null, title: "Implante dental" })
  await expect(
    v.run((tx) =>
      prepareEncounterConsents(tx, "org_a", v.actor, v.lucia.id, v.draft.id, [draftTemplate.key]),
    ),
  ).rejects.toMatchObject({ code: "CONSENT_NOT_PUBLISHED" })

  const pending = await v.run((tx) => listConsentsToPublish(tx, "org_a"))
  expect(pending).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ templateKey: draftTemplate.key, title: "Implante dental", requestedByName: "Clínico" }),
    ]),
  )
  await v.run((tx) => publishConsentTemplate(tx, "org_a", v.actor, draftTemplate.id))
  expect((await v.run((tx) => listConsentsToPublish(tx, "org_a"))).map((row) => row.templateKey)).not.toContain(
    draftTemplate.key,
  )
})

it("órdenes: imagen con el diagnóstico de la atención, resultado y cancelación con motivo; la derivación deja la tarea al colega", async () => {
  const v = await visit()
  const image = await v.run((tx) =>
    createClinicalOrder(tx, "org_a", v.actor, {
      kind: "imagen",
      patientId: v.lucia.id,
      encounterId: v.draft.id,
      recipient: "Centro de imágenes",
      title: "Radiografía panorámica",
    }),
  )
  expect(image).toMatchObject({ kind: "imagen", diagnosisCode: "K01.1", status: "solicitado" })
  await expect(
    v.run((tx) => advanceClinicalOrder(tx, "org_a", v.actor, image.id, "completado")),
  ).rejects.toMatchObject({ status: 400 })
  const [result] = await ownerDb
    .insert(patientDocument)
    .values({
      organizationId: "org_a",
      patientId: v.lucia.id,
      category: "radiografia",
      imageType: "panoramica",
      label: "Panorámica",
      storageKey: `org_a/${randomUUID()}.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 2048,
    })
    .returning()
  const done = await v.run((tx) =>
    advanceClinicalOrder(tx, "org_a", v.actor, image.id, "completado", null, { resultDocumentId: result!.id }),
  )
  expect(done).toMatchObject({ status: "completado", resultDocumentId: result!.id })

  const lab = await v.run((tx) =>
    createClinicalOrder(tx, "org_a", v.actor, {
      kind: "laboratorio",
      patientId: v.lucia.id,
      recipient: "Laboratorio Central",
      title: "Hemograma",
    }),
  )
  await expect(v.run((tx) => cancelClinicalOrder(tx, "org_a", v.actor, lab.id, " "))).rejects.toMatchObject({
    status: 400,
  })
  expect(await v.run((tx) => cancelClinicalOrder(tx, "org_a", v.actor, lab.id, "Ya lo trajo hecho"))).toMatchObject({
    status: "cancelado",
    cancelReason: "Ya lo trajo hecho",
  })

  // Derivación: a un colega que atiende sí, con su tarea; a recepción no.
  const colleague = randomUUID()
  const reception = randomUUID()
  await ownerDb.insert(user).values([
    { id: colleague, name: "Dr. Luis Paredes", email: `${colleague}@example.test` },
    { id: reception, name: "Recepción", email: `${reception}@example.test` },
  ])
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: "org_a", userId: colleague, role: "dentist", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_a", userId: reception, role: "reception", createdAt: new Date() },
  ])
  await expect(
    v.run((tx) =>
      createClinicalOrder(tx, "org_a", v.actor, {
        kind: "interconsulta",
        patientId: v.lucia.id,
        recipientUserId: reception,
        title: "Evaluación de ortodoncia",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const referral = await v.run((tx) =>
    createClinicalOrder(tx, "org_a", v.actor, {
      kind: "interconsulta",
      patientId: v.lucia.id,
      recipientUserId: colleague,
      title: "Evaluación de ortodoncia",
    }),
  )
  expect(referral).toMatchObject({ recipient: "Dr. Luis Paredes", recipientUserId: colleague })
  const tasks = await ownerDb
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, "org_a"), eq(crmTask.assigneeUserId, colleague)))
  expect(tasks).toEqual([expect.objectContaining({ title: "Derivación: Evaluación de ortodoncia" })])
})

it("los papeles de salud van solo a la persona adulta o a su representante legal; sin canal, solo imprimir", async () => {
  const v = await visit()
  const mother = await v.run((tx) => createContact(tx, "org_a", { displayName: "Marta Tutora", phone: "+51944000222" }))
  const payer = await v.run((tx) => createContact(tx, "org_a", { displayName: "Pagador", email: "pagador@example.com" }))
  const child = await v.run((tx) =>
    createPatient(tx, "org_a", v.actor, {
      displayName: "Mateo Niño",
      birthDate: "2019-03-03",
      contacts: [
        { contactId: mother.id, relationship: "guardian", relationshipDetail: "Madre", isPreferred: true },
        { contactId: payer.id, relationship: "family", relationshipDetail: "Tío", isPreferred: false },
      ],
    }),
  )
  // Hoy en la clínica (Lima): la representación vigente se cuenta con su día, no con UTC.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  for (const [contactId, kind] of [
    [mother.id, "representante_legal"],
    [payer.id, "responsable_economico"],
  ] as const) {
    await v.run((tx) =>
      grantResponsibility(tx, "org_a", v.actor, child.id, {
        contactId,
        kind,
        startsAt: today,
        endsAt: null,
        evidenceDocumentId: null,
      }),
    )
  }
  // Un menor no lo recibe en su chat; el responsable económico tampoco.
  const childRecipients = await v.run((tx) => listHealthDocumentRecipients(tx, "org_a", child.id))
  expect(childRecipients.map((r) => [r.displayName, r.relation])).toEqual([["Marta Tutora", "representante_legal"]])
  // La adulta lo recibe ella misma.
  const adult = await v.run((tx) => listHealthDocumentRecipients(tx, "org_a", v.lucia.id))
  expect(adult.map((r) => r.relation)).toEqual(["paciente"])

  const order = await v.run((tx) =>
    createClinicalOrder(tx, "org_a", v.actor, {
      kind: "imagen",
      patientId: child.id,
      recipient: "Centro de imágenes",
      title: "Radiografía periapical",
    }),
  )
  // Sin WhatsApp ni correo por donde enviarlo, solo se imprime.
  const options = await v.run((tx) =>
    getHealthDocumentSendOptions(tx, "org_a", child.id, { documentType: "order", documentId: order.id }),
  )
  expect(options.recipient?.displayName).toBe("Marta Tutora")
  expect(options.channels.every((c) => c.channel === "whatsapp" || c.channel === "email")).toBe(true)
  expect(options.printOnly).toMatch(/solo se puede imprimir/)
  // Nunca a quien no es la persona ni su representante.
  await expect(
    v.run((tx) =>
      sendHealthDocument(
        tx,
        "org_a",
        v.actor,
        {
          patientId: child.id,
          documentType: "order",
          documentId: order.id,
          recipientContactId: payer.id,
          connectionId: randomUUID(),
        },
        { storage: {} as never },
      ),
    ),
  ).rejects.toMatchObject({ code: "DOCUMENT_RECIPIENT_NOT_AUTHORIZED", status: 403 })
})

it("formulario desde la atención: primero los de su especialidad y responsable quien atiende", async () => {
  const v = await visit()
  const specialty = await v.run((tx) => createSpecialty(tx, "org_a", v.actor, { name: `Cirugía ${randomUUID().slice(0, 4)}` }))
  await v.run((tx) => setProfessionalSpecialties(tx, "org_a", v.actor, v.actor, [specialty.id]))
  const schema = { sections: [{ id: "s1", title: "Datos", fields: [{ id: "f1", label: "Nota", type: "texto" }] }] }
  const general = await v.run(async (tx) => {
    const t = await createFormTemplate(tx, "org_a", v.actor, { title: `General ${randomUUID().slice(0, 4)}`, schema })
    return publishFormTemplate(tx, "org_a", v.actor, t.id)
  })
  const surgical = await v.run(async (tx) => {
    const t = await createFormTemplate(tx, "org_a", v.actor, {
      title: `Cirugía ${randomUUID().slice(0, 4)}`,
      schema,
      specialtyId: specialty.id,
    })
    return publishFormTemplate(tx, "org_a", v.actor, t.id)
  })
  const ordered = await v.run((tx) =>
    listFormTemplates(tx, "org_a", { status: "publicado", forUserId: v.actor }),
  )
  const ids = ordered.map((t) => t.id)
  expect(ids.indexOf(surgical.id)).toBeLessThan(ids.indexOf(general.id))
  const response = await v.run((tx) =>
    createFormResponse(tx, "org_a", v.actor, { templateId: general.id, patientId: v.lucia.id, encounterId: v.draft.id }),
  )
  expect(response.professionalUserId).toBe(v.actor)
})
