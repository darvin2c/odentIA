/**
 * Los documentos del paciente (ADR 0115): el QR público no dice nada de salud, lo
 * clínico del presupuesto sale solo a quien corresponde, y lo entregado queda congelado.
 */
import { randomUUID } from "node:crypto"
import {
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { and, eq, sql } from "drizzle-orm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configureDocumentChecks } from "./document-check.js"
import { DocumentKit } from "./document-kit.js"
import { livePersonalLinkToken, issuePersonalLink } from "./booking-links.js"
import { createContact } from "./contacts.js"
import { portalBudgetContext, toPortalBudget } from "./portal.js"
import { configurePublicLinks } from "./public-links.js"
import { listDecisionRecipients } from "./responsibilities.js"
import { buildBudgetSnapshot, renderBudgetPdf } from "./budget-pdf.js"
import {
  createBudget,
  decideBudget,
  deliverBudget,
  duplicateBudgetOption,
  getBudgetDetail,
  getBudgetPresentation,
  updateBudgetPresentation,
} from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { demoSignatureStrokes } from "./demo-signature.js"
import { assertStrokes } from "./professional-profiles.js"
import {
  documentCheckToken,
  patientInitials,
  readDocumentCheck,
  readDocumentCheckToken,
} from "./document-check.js"
import { requirePatient } from "./patients.js"
import { addPlanItem } from "./plan.js"
import { cancelPrescription, createPrescription } from "./prescriptions.js"
import { getTemplatePatientGuide, updateService } from "./service-catalog.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const KEY = Buffer.alloc(32, 7)

it("el token: alterado o con otra clave no vale, sin distinguir por qué", () => {
  const id = randomUUID()
  const token = documentCheckToken(KEY, "org_a", "prescription", id)
  expect(readDocumentCheckToken(KEY, token)).toEqual({ orgId: "org_a", type: "prescription", id })
  const [payload, sig] = token.split(".") as [string, string]
  const other = documentCheckToken(KEY, "org_b", "prescription", id).split(".")[0]!
  expect(readDocumentCheckToken(KEY, `${other}.${sig}`)).toBeNull()
  expect(readDocumentCheckToken(KEY, `${payload}.${sig.slice(0, -2)}xx`)).toBeNull()
  expect(readDocumentCheckToken(KEY, payload)).toBeNull()
  expect(readDocumentCheckToken(Buffer.alloc(32, 8), token)).toBeNull()
  expect(readDocumentCheckToken(KEY, "basura")).toBeNull()
  expect(patientInitials("Rosa Quispe")).toBe("R. Q.")
})

it("el QR público de una receta: estados, y nada de salud ni el nombre completo", async () => {
  const f = await clinicalFixture()
  const rx = await f.run((tx) =>
    createPrescription(tx, ...f.args, {
      items: [
        {
          genericName: "Amoxicilina",
          strength: "500 mg",
          dosageForm: "tableta",
          dose: "1 tableta",
          route: "oral",
          frequency: "cada 8 horas",
          duration: "5 días",
          quantity: 15,
        },
      ],
    } as never),
  )
  const person = await f.run((tx) => requirePatient(tx, "org_a", f.patient.id))
  const check = await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id))
  expect(check?.state).toBe("vigente")
  expect(Object.keys(check ?? {}).sort()).toEqual(
    [
      "clinic",
      "fingerprints",
      "issuedAt",
      "label",
      "patientInitials",
      "signer",
      "state",
      "validUntil",
      "voidedAt",
    ].sort(),
  )
  const text = JSON.stringify(check)
  expect(text.toLowerCase()).not.toContain("amoxicilina")
  expect(text).not.toContain(person.displayName)
  expect(check?.patientInitials).toBe(patientInitials(person.displayName))

  // Lo emitido no cambia (ADR 0132): solo para simular el paso del tiempo se aparta la guarda.
  await ownerDb.execute(sql`alter table "prescription" disable trigger prescription_issued_immutable`)
  await ownerDb.execute(
    sql`update "prescription" set "valid_until" = '2020-01-01' where "id" = ${rx.id}`,
  )
  await ownerDb.execute(sql`alter table "prescription" enable trigger prescription_issued_immutable`)
  expect((await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id)))?.state).toBe(
    "vencido",
  )

  await f.run((tx) => cancelPrescription(tx, ...f.args, rx.id, { reason: "Motivo secreto" }))
  const voided = await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", rx.id))
  expect(voided?.state).toBe("anulado")
  expect(voided?.voidedAt).toBeTruthy()
  expect(JSON.stringify(voided)).not.toContain("Motivo secreto")

  // De otra clínica no se lee: es el mismo «no está».
  expect(
    await f.run((tx) => readDocumentCheck(tx, "org_a", "prescription", randomUUID())),
  ).toBeNull()
})

async function budgetWithGuide() {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  return { f, item, budget, serviceId: f.service.id }
}

it("lo sugerido nunca sale sin guardar; al entregar se congela la del servicio", async () => {
  const { f, budget, serviceId } = await budgetWithGuide()
  const [service] = await ownerDb
    .select()
    .from(serviceCatalog)
    .where(eq(serviceCatalog.id, serviceId))
  const [template] = await ownerDb
    .insert(treatmentTemplate)
    .values({
      key: `sugerido-${randomUUID()}`,
      name: "Sugerido",
      kind: "endodoncia",
      scope: "general",
      patientGuide: { how: "Texto sugerido" },
    })
    .returning({ id: treatmentTemplate.id })
  await ownerDb
    .update(serviceCatalog)
    .set({ templateId: template!.id, source: "template" })
    .where(eq(serviceCatalog.id, serviceId))
  expect(service?.patientGuide).toBeNull()
  expect((await f.run((tx) => getTemplatePatientGuide(tx, template!.id))).suggestion).toEqual({
    how: "Texto sugerido",
  })
  // Unido al sugerido pero sin revisar: la línea no trae explicación.
  const draft = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(draft.lines[0]?.guide).toBeNull()

  await f.run((tx) =>
    updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "Lo de la clínica" } }),
  )
  const [reviewed] = await ownerDb
    .select()
    .from(serviceCatalog)
    .where(eq(serviceCatalog.id, serviceId))
  expect(reviewed?.patientGuideReviewedBy).toBe(f.args[1])
  expect(reviewed?.patientGuideReviewedAt).toBeTruthy()

  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "Cambió después" } }),
  )
  const delivered = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(delivered.lines[0]?.guide).toEqual({ how: "Lo de la clínica" })
  expect(delivered.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  // Entregado ya no se edita, ni por el servicio ni en la base.
  await expect(
    f.run((tx) =>
      updateBudgetPresentation(
        tx,
        ...f.args,
        budget.id,
        { proposal: "Otra" },
        { clinicalAccess: true },
      ),
    ),
  ).rejects.toMatchObject({ code: "BUDGET_STATUS" })
  await expect(
    ownerDb
      .update(treatmentBudget)
      .set({ findings: "Otra" })
      .where(eq(treatmentBudget.id, budget.id)),
  ).rejects.toThrow()
  await expect(
    ownerDb
      .update(treatmentBudgetItem)
      .set({ patientGuide: { how: "Otra" } })
      .where(and(eq(treatmentBudgetItem.budgetId, budget.id))),
  ).rejects.toThrow()
})

it("el ajuste para este paciente manda sobre la del servicio", async () => {
  const { f, budget, serviceId } = await budgetWithGuide()
  await f.run((tx) =>
    updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "De la clínica" } }),
  )
  const presentation = await f.run((tx) =>
    getBudgetPresentation(tx, "org_a", f.patient.id, budget.id, { clinicalAccess: true }),
  )
  const lineId = presentation.lines[0]!.id
  expect(presentation.lines[0]?.serviceGuide).toEqual({ how: "De la clínica" })
  await f.run((tx) =>
    updateBudgetPresentation(
      tx,
      ...f.args,
      budget.id,
      { lines: [{ lineId, patientGuide: { how: "Solo para ella" } }] },
      { clinicalAccess: true },
    ),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const snap = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(snap.lines[0]?.guide).toEqual({ how: "Solo para ella" })
})

describe("lo que dice el PDF", () => {
  afterEach(() => vi.restoreAllMocks())

  /** Todo lo que la hoja escribe, sin depender de cómo guarda las fuentes. */
  async function printedText(snap: Parameters<typeof renderBudgetPdf>[0]): Promise<string> {
    const lay = vi.spyOn(DocumentKit.prototype, "lay")
    await renderBudgetPdf(snap)
    return JSON.stringify(lay.mock.calls.map((call) => call[0]))
  }

  it("con varias opciones explica cada tratamiento, y lo repetido solo una vez", async () => {
    const { f, budget, serviceId } = await budgetWithGuide()
    await f.run((tx) =>
      updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { how: "Se limpia y se sella" } }),
    )
    await f.run((tx) => duplicateBudgetOption(tx, ...f.args, budget.id, budget.options[0]!.id))
    const snap = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
    expect(snap.options).toHaveLength(2)
    const text = await printedText(snap)
    expect(text).toContain("Se limpia y se sella")
    expect(text).toContain("Cómo se hace: ver Opción A.")
  })

  it("no remite a una explicación que la hoja no imprimió", async () => {
    const { f, budget, serviceId } = await budgetWithGuide()
    await f.run((tx) => updateService(tx, "org_a", f.args[1], serviceId, { patientGuide: { visits: "2" } }))
    await f.run((tx) => duplicateBudgetOption(tx, ...f.args, budget.id, budget.options[0]!.id))
    const snap = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
    expect(await printedText(snap)).not.toContain("Cómo se hace: ver")
  })

  it("si una línea no dice sus visitas, el total lo dice como un mínimo", async () => {
    const { f, budget } = await budgetWithGuide()
    const snap = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
    const line = snap.lines[0]!
    const text = await printedText({
      ...snap,
      lines: [
        { ...line, id: randomUUID(), plannedSessions: 1, guide: { how: "Uno", visits: "2" } },
        { ...line, id: randomUUID(), plannedSessions: 1, guide: { how: "Otro" } },
      ],
    })
    expect(text).toContain("2 o más visitas")
  })
})

it("lo encontrado: según el rol y el destinatario; nunca en el detalle del presupuesto", async () => {
  const { f, budget } = await budgetWithGuide()
  await f.run((tx) =>
    updateBudgetPresentation(
      tx,
      ...f.args,
      budget.id,
      { findings: "Pulpitis del molar" },
      { clinicalAccess: true },
    ),
  )

  const detail = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))
  expect(JSON.stringify(detail)).not.toContain("Pulpitis del molar")
  expect(detail.hasFindings).toBe(true)

  const asReception = await f.run((tx) =>
    getBudgetPresentation(tx, "org_a", f.patient.id, budget.id, { clinicalAccess: false }),
  )
  expect(asReception.findings).toBeNull()
  expect(asReception.hasFindings).toBe(true)

  const snap = (actor: Parameters<typeof buildBudgetSnapshot>[4]) =>
    f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id, actor))
  expect((await snap({ memberRole: "reception" })).findings).toBeNull()
  expect((await snap({ memberRole: "cashier" })).allergies).toEqual([])
  expect((await snap({ memberRole: "admin" })).findings).toBe("Pulpitis del molar")
  const recipients = await f.run((tx) => listDecisionRecipients(tx, "org_a", f.patient.id))
  expect((await snap({ recipientContactId: recipients[0]!.contactId })).findings).toBe(
    "Pulpitis del molar",
  )
  expect((await snap({ recipientContactId: randomUUID() })).findings).toBeNull()
  // Sale sin romperse, con y sin lo clínico.
  const pdf = await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
  expect(Buffer.from((await renderBudgetPdf(pdf)).slice(0, 5)).toString("latin1")).toBe("%PDF-")
})

describe("el papel según quien lo recibe", () => {
  afterEach(() => {
    configureDocumentChecks(null)
    configurePublicLinks(null)
  })

  it("el QR y lo clínico: de quien decide y recibe; nunca de otro ni a una dirección sin verificar", async () => {
    const { f, budget } = await budgetWithGuide()
    configureDocumentChecks(KEY)
    configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
    await f.run((tx) =>
      updateBudgetPresentation(tx, ...f.args, budget.id, { findings: "Pulpitis" }, { clinicalAccess: true }),
    )
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const [decider] = await f.run((tx) => listDecisionRecipients(tx, "org_a", f.patient.id))
    const economic = await f.run((tx) => createContact(tx, "org_a", { displayName: "Paga la cuenta" } as never))
    // Quien no decide, aunque tenga su propio enlace: no se imprime en lo suyo.
    for (const contactId of [decider!.contactId, economic.id]) {
      await f.run((tx) =>
        issuePersonalLink(tx, "org_a", { contactId, patientId: f.patient.id }, { secretsKey: KEY }),
      )
    }
    const snap = (actor: Parameters<typeof buildBudgetSnapshot>[4]) =>
      f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id, actor))
    const deciderToken = await f.run((tx) =>
      livePersonalLinkToken(tx, "org_a", { contactId: decider!.contactId, patientId: f.patient.id }, { secretsKey: KEY }),
    )

    // Imprime el equipo: el de quien decide, porque se le entrega en mano.
    expect((await snap({ memberRole: "reception" })).personalLinkUrl).toContain(deciderToken!)
    // Se envía a quien decide: el suyo y lo clínico.
    const toDecider = await snap({ recipientContactId: decider!.contactId })
    expect(toDecider.personalLinkUrl).toContain(deciderToken!)
    expect(toDecider.findings).toBe("Pulpitis")
    expect(toDecider.carriesClinical).toBe(true)
    // A quien paga, aunque lo envíe quien lee lo clínico: ni QR ni datos clínicos.
    const toEconomic = await snap({ memberRole: "admin", recipientContactId: economic.id })
    expect(toEconomic.personalLinkUrl).toBeNull()
    expect(toEconomic.findings).toBeNull()
    expect(toEconomic.carriesClinical).toBe(false)
    // Una dirección escrita a mano, aunque sea para quien decide: nada.
    const typed = await snap({ memberRole: "admin", recipientContactId: decider!.contactId, unverifiedAddress: true })
    expect(typed.personalLinkUrl).toBeNull()
    expect(typed.findings).toBeNull()
    expect(typed.carriesClinical).toBe(false)
  })

  it("lo entregado queda fijo: condiciones y medios; el borrador dice lo vigente", async () => {
    const { f, budget } = await budgetWithGuide()
    const setTerms = (payment: string) =>
      ownerDb.execute(sql`update "org_profile" set "budget_payment_terms" = ${payment} where "organization_id" = 'org_a'`)
    const snap = () => f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))
    await setTerms("Al entregar")
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    await setTerms("Cambió después")
    await ownerDb.execute(sql`update "organization_payment_method" set "name" = 'Otro medio' where "organization_id" = 'org_a'`)
    const after = await snap()
    expect(after.terms.payment).toBe("Al entregar")
    expect(after.paymentMethods).not.toContain("Otro medio")
    // El portal y «Su enlace» leen lo mismo.
    const detail = await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))
    const context = await f.run((tx) => portalBudgetContext(tx, "org_a", [budget.id], true))
    expect(context.terms.payment).toBe("Cambió después")
    expect(toPortalBudget(detail, context).terms.payment).toBe("Al entregar")
    // La base tampoco deja cambiarlo.
    await expect(
      ownerDb.update(treatmentBudget).set({ deliveredSnapshot: null }).where(eq(treatmentBudget.id, budget.id)),
    ).rejects.toThrow()
  })

  it("dice por dónde respondió; sin ese dato, no supone un canal", async () => {
    const first = await budgetWithGuide()
    const { f, item, budget } = first
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    const decisions = [{ planItemId: item.id, decision: "aceptado" as const }]
    await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions }, { skipOwnPlan: true, via: "portal" }))
    const words = async () =>
      (await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))).decisionWords?.text
    expect(await words()).toBe("Aceptó por el portal")
    await ownerDb.update(treatmentBudget).set({ decidedVia: "conversacion" }).where(eq(treatmentBudget.id, budget.id))
    expect(await words()).toBe("Aceptó por la conversación")
    await ownerDb.update(treatmentBudget).set({ decidedVia: null, decidedBy: null }).where(eq(treatmentBudget.id, budget.id))
    expect(await words()).toBe("Aceptó")

    const second = await budgetWithGuide()
    await second.f.run((tx) => deliverBudget(tx, ...second.f.args, second.budget.id))
    const answered = await second.f.run((tx) =>
      decideBudget(tx, ...second.f.args, second.budget.id, {
        decisions: [{ planItemId: second.item.id, decision: "aceptado" }],
      }),
    )
    expect(answered.decidedVia).toBe("clinica")
  })
})

describe("la respuesta en consulta y la firma de quien decide", () => {
  const strokes = [
    [
      [10, 10],
      [200, 120],
      [400, 60],
    ],
  ]

  it("un borrador mostrado en la atención se entrega y se responde en una sola operación, sin enviar nada", async () => {
    const { f, item, budget } = await budgetWithGuide()
    const decisions = [{ planItemId: item.id, decision: "aceptado" as const }]
    // Sin decir que fue en consulta, un borrador no se responde.
    await expect(f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions }))).rejects.toMatchObject({
      code: "BUDGET_STATUS",
    })
    const answered = await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions }, { inPerson: true }))
    expect(answered.status).toBe("aceptado")
    expect(answered.presentedAt).not.toBeNull()
    expect(answered.decidedVia).toBe("clinica")
    expect(answered.decidedBy).toBe(f.actor)
    // Lo anotado por el equipo sin firma es su palabra: dice quién lo anotó.
    const words = (await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))).decisionWords
    expect(words).toMatchObject({ text: "Aceptó", notedBy: "Clínico", signature: null })
  })

  it("si falla la respuesta, tampoco queda entregado", async () => {
    const { f, budget } = await budgetWithGuide()
    await expect(
      f.run((tx) =>
        decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: randomUUID(), decision: "aceptado" }] }, { inPerson: true }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    expect((await f.run((tx) => getBudgetDetail(tx, "org_a", f.patient.id, budget.id))).status).toBe("borrador")
  })

  it("la firma en la tablet: de quien decide, sobre lo que acepta, una vez y sin reescribirse", async () => {
    const { f, item, budget } = await budgetWithGuide()
    const decisions = [{ planItemId: item.id, decision: "aceptado" as const }]
    // Sin quién decide no hay de quién es la firma.
    await expect(
      f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions, signature: { strokes } }, { inPerson: true })),
    ).rejects.toMatchObject({ code: "BUDGET_SIGNER_REQUIRED" })
    // Se firma lo que acepta: «lo piensa» no se firma.
    await expect(
      f.run((tx) =>
        decideBudget(
          tx,
          ...f.args,
          budget.id,
          {
            decisions: [{ planItemId: item.id, decision: "pospuesto" }],
            decidedByContactId: f.patient.personId,
            signature: { strokes },
          },
          { inPerson: true },
        ),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    const signed = await f.run((tx) =>
      decideBudget(
        tx,
        ...f.args,
        budget.id,
        { decisions, decidedByContactId: f.patient.personId, signature: { strokes } },
        { inPerson: true },
      ),
    )
    expect(signed.decisionSignedAt).not.toBeNull()
    // Los trazos no viajan con el presupuesto: solo a su hoja.
    expect(signed).not.toHaveProperty("decisionSignature")
    const words = (await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))).decisionWords
    expect(words).toMatchObject({
      text: "Aceptó y firmó en la clínica",
      by: "Paciente de prueba",
      notedBy: null,
      signature: { strokes, signerName: "Paciente de prueba", signerKind: "paciente" },
    })
    expect(words?.signature?.declaration).toMatch(/Acepto los tratamientos que dicen «Aceptado»/)
    // Su hoja sale con la firma.
    const pdf = await renderBudgetPdf(await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id)))
    expect(pdf.byteLength).toBeGreaterThan(1000)
    // La base no deja reescribir ni quitar lo firmado.
    await expect(
      ownerDb.update(treatmentBudget).set({ decisionSignature: null, decisionSignedAt: null }).where(eq(treatmentBudget.id, budget.id)),
    ).rejects.toThrow()
  })

  it("lo que responde después no queda bajo la firma: la hoja dice qué firmó y cómo respondió lo demás", async () => {
    const f = await clinicalFixture()
    const add = () =>
      f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
    const [first, second] = [await add(), await add()]
    const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [first.id, second.id] }))
    await f.run((tx) =>
      decideBudget(
        tx,
        ...f.args,
        budget.id,
        {
          decisions: [
            { planItemId: first.id, decision: "aceptado" },
            { planItemId: second.id, decision: "pospuesto" },
          ],
          decidedByContactId: f.patient.personId,
          signature: { strokes },
        },
        { inPerson: true },
      ),
    )
    const words = async () => (await f.run((tx) => buildBudgetSnapshot(tx, "org_a", f.patient.id, budget.id))).decisionWords
    expect(await words()).toMatchObject({ text: "Aceptó una parte y firmó en la clínica", signedAll: true })
    // Días después acepta lo otro por su enlace: eso no lo firmó.
    await f.run((tx) =>
      decideBudget(
        tx,
        "org_a",
        null,
        f.patient.id,
        budget.id,
        { decisions: [{ planItemId: second.id, decision: "aceptado" }], decidedByContactId: f.patient.personId },
        { skipOwnPlan: true, via: "enlace" },
      ),
    )
    const later = await words()
    expect(later).toMatchObject({ text: "Aceptó por su enlace", signedAll: false })
    expect(later?.signature?.accepted).toEqual(["Tratamiento propio"])
    // Lo que leyó al firmar, y el papel suma el nivel de la firma, que la nota no dice.
    expect(later?.signature?.note).toBe("Su respuesta queda guardada con la fecha y la hora de su firma.")
    expect(later?.signatureNote).toBe(later?.signature?.note)
    expect(later?.signatureKind).toMatch(/^Firma electrónica simple/)
  })

  it("la firma de la demo es una firma válida", () => {
    expect(() => assertStrokes(demoSignatureStrokes("Andrés Vilca"), "La firma", "signature")).not.toThrow()
  })

  it("el agente y el portal no firman por la persona", async () => {
    const { f, item, budget } = await budgetWithGuide()
    await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
    await expect(
      f.run((tx) =>
        decideBudget(
          tx,
          "org_a",
          null,
          f.patient.id,
          budget.id,
          {
            decisions: [{ planItemId: item.id, decision: "aceptado" }],
            decidedByContactId: f.patient.personId,
            signature: { strokes },
          },
          { skipOwnPlan: true, via: "portal" },
        ),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})
