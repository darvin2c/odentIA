/**
 * Fichas de consulta (mesa del 13 nov, entrega 5): las que vienen con odentIA
 * y cuáles miró la clínica, las que la atención ofrece solas (por la
 * especialidad de la cita, por la edad y, sin servicio, por la de quien
 * atiende), la anterior del mismo tipo, y que nada de esto trabe la atención.
 */
import { randomUUID } from "node:crypto"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { encounter, orgSpecialty, serviceCatalog } from "@odentia/db/schema/clinical"
import { clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  archiveFormTemplate,
  archiveSpecialty,
  reuseFormTemplate,
  createFormResponse,
  createFormTemplate,
  finalizeFormResponse,
  listFormTemplates,
  publishFormTemplate,
  setProfessionalSpecialties,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  ensureClinicForms,
  getEncounterFormOffers,
  listPatientFormResponses,
  markFormTemplateLooked,
} from "./consultation-forms.js"
import { finalizeEncounter, voidEncounter } from "./encounters.js"
import { getTimeline } from "./patient-history.js"
import { listClinicFormTemplates } from "./portal-questionnaire.js"
import { ensureClinicSpecialties } from "./specialties.js"
import { setTestPatientIdentity } from "./test-patient.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const PRODUCT_KEYS = [
  "evaluacion-de-endodoncia",
  "ficha-de-odontopediatria",
  "ficha-de-ortodoncia",
  "ficha-odontoestomatologica",
]

/** Una clínica dental nueva, con sus especialidades y sus fichas, y quien atiende. */
async function clinic(options: { forms?: boolean } = {}) {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const f = await clinicalFixture(orgId)
  await f.run((tx) => ensureClinicSpecialties(tx, orgId))
  if (options.forms !== false) await f.run((tx) => ensureClinicForms(tx, orgId))
  const specialties = new Map(
    (await ownerDb.select().from(orgSpecialty).where(eq(orgSpecialty.organizationId, orgId))).map((row) => [row.key, row]),
  )
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" })
    .returning({ id: branch.id })
  const [room] = await ownerDb
    .insert(scheduleRoom)
    .values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" })
    .returning({ id: scheduleRoom.id })
  let hour = 0
  // Un paciente tiene una sola atención abierta: la primera es la del fixture; para abrir otra, la anterior se firma.
  let open: string | null = f.encounter.id
  let fresh = true
  /** Una atención en curso; con `specialty`, de una cita con un servicio de esa especialidad; con `service: false`, de una cita sin servicio. */
  const attention = async (input: { specialty?: string; service?: false } = {}) => {
    let appointmentId: string | null = null
    if (input.specialty || input.service === false) {
      const [service] = input.specialty
        ? await ownerDb
            .insert(serviceCatalog)
            .values({
              organizationId: orgId,
              name: `Servicio de ${input.specialty}`,
              scope: "general",
              source: "custom",
              priceCents: 10000,
              currency: "PEN",
              specialtyId: specialties.get(input.specialty)!.id,
            })
            .returning({ id: serviceCatalog.id })
        : []
      hour += 1
      const startsAt = new Date(Date.UTC(2026, 10, 13, 13 + hour))
      const [booked] = await ownerDb
        .insert(appointment)
        .values({
          organizationId: orgId,
          branchId: site!.id,
          patientId: f.patient.id,
          professionalUserId: f.actor,
          roomId: room!.id,
          serviceId: service?.id ?? null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          durationMin: 30,
          status: "confirmada",
        })
        .returning({ id: appointment.id })
      appointmentId = booked!.id
    }
    if (fresh && open) {
      fresh = false
      const [session] = await ownerDb.update(encounter).set({ appointmentId }).where(eq(encounter.id, open)).returning()
      return session!
    }
    if (open) {
      const previous = open
      await f.ready(previous)
      await f.run((tx) => finalizeEncounter(tx, orgId, f.actor, f.patient.id, previous))
    }
    const [session] = await ownerDb
      .insert(encounter)
      .values({
        organizationId: orgId,
        patientId: f.patient.id,
        professionalUserId: f.actor,
        reason: "Consulta",
        appointmentId,
      })
      .returning()
    open = session!.id
    return session!
  }
  const offers = (encounterId: string) =>
    f.run((tx) => getEncounterFormOffers(tx, orgId, f.patient.id, encounterId))
  /** La atención abierta se anuló: la siguiente no tiene que firmarla antes. */
  const forget = () => {
    open = null
    fresh = false
  }
  return { ...f, orgId, specialties, attention, offers, forget }
}

/** La fecha de nacimiento de quien cumple `years` años justo hoy (o mañana, con `tomorrow`), en Lima. */
function bornYearsAgo(years: number, tomorrow = false): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(
    new Date(Date.now() + (tomorrow ? 24 * 3_600_000 : 0)),
  )
  return `${Number(today.slice(0, 4)) - years}${today.slice(4)}`
}

it("una clínica dental nace con las cuatro fichas en uso, unidas a su especialidad, y no se repiten", async () => {
  const c = await clinic()
  const templates = await c.run((tx) => listFormTemplates(tx, c.orgId, {}))
  expect(templates.map((row) => row.key).sort()).toEqual(PRODUCT_KEYS)
  for (const row of templates) {
    expect(row).toMatchObject({ status: "publicado", version: 1, respondent: "staff", createdBy: null })
    expect(row.publishedAt).toBeInstanceOf(Date)
  }
  const specialtyOf = (key: string) => templates.find((row) => row.key === key)?.specialtyId
  // En Perú, la ortodoncia de la biblioteca la recibe «Ortodoncia y Ortopedia Maxilar».
  expect(specialtyOf("ficha-de-ortodoncia")).toBe(c.specialties.get("ortodoncia_ortopedia_maxilar")!.id)
  expect(specialtyOf("evaluacion-de-endodoncia")).toBe(c.specialties.get("endodoncia")!.id)
  expect(specialtyOf("ficha-de-odontopediatria")).toBe(c.specialties.get("odontopediatria")!.id)
  expect(specialtyOf("ficha-odontoestomatologica")).toBe(c.specialties.get("odontologia_general")!.id)
  // Otra vez (el worker, cada seis horas): nada nuevo.
  expect(await c.run((tx) => ensureClinicForms(tx, c.orgId))).toEqual([])
  expect((await c.run((tx) => listFormTemplates(tx, c.orgId, {}))).length).toBe(4)
})

it("la ficha que la clínica dejó de usar o ya tenía con ese título no se vuelve a crear, y la suya no dice que vino con el producto", async () => {
  const c = await clinic({ forms: false })
  const schema = { sections: [{ id: "general", title: "General", fields: [{ id: "nota", label: "Nota", type: "texto" }] }] }
  // Ya tenía su «Ficha de ortodoncia»: la clave es la de su título.
  const own = await c.run(async (tx) => {
    const draft = await createFormTemplate(tx, c.orgId, c.actor, { title: "Ficha de ortodoncia", schema })
    return publishFormTemplate(tx, c.orgId, c.actor, draft.id)
  })
  expect(own.key).toBe("ficha-de-ortodoncia")
  const created = await c.run((tx) => ensureClinicForms(tx, c.orgId))
  expect(created.map((row) => row.key).sort()).toEqual(PRODUCT_KEYS.filter((key) => key !== "ficha-de-ortodoncia"))
  const listed = await c.run((tx) => listClinicFormTemplates(tx, c.orgId))
  expect(listed.find((row) => row.id === own.id)).toMatchObject({ fromProduct: false, looked: true })
  expect(listed.find((row) => row.key === "ficha-de-odontopediatria")).toMatchObject({ fromProduct: true, looked: false })

  // Dejar de usar una que vino con el producto: no vuelve sola.
  const pediatric = listed.find((row) => row.key === "ficha-de-odontopediatria")!
  await c.run((tx) => archiveFormTemplate(tx, c.orgId, c.actor, pediatric.id))
  expect(await c.run((tx) => ensureClinicForms(tx, c.orgId))).toEqual([])
  const after = await c.run((tx) => listFormTemplates(tx, c.orgId, { status: "publicado" }))
  expect(after.some((row) => row.key === "ficha-de-odontopediatria")).toBe(false)
})

it("una ficha que se llama igual que una del producto, con otra clave, tampoco se duplica (la demo ya sembrada)", async () => {
  const c = await clinic({ forms: false })
  const schema = { sections: [{ id: "general", title: "General", fields: [{ id: "nota", label: "Nota", type: "texto" }] }] }
  // La «Evaluación de endodoncia» de antes, con su clave antigua.
  const old = await c.run(async (tx) => {
    const draft = await createFormTemplate(tx, c.orgId, c.actor, { key: "evaluacion-endodoncia", title: "Evaluación de endodoncia", schema })
    return publishFormTemplate(tx, c.orgId, c.actor, draft.id)
  })
  expect(old.key).toBe("evaluacion-endodoncia")
  const created = await c.run((tx) => ensureClinicForms(tx, c.orgId))
  expect(created.map((row) => row.key).sort()).toEqual(PRODUCT_KEYS.filter((key) => key !== "evaluacion-de-endodoncia"))
  const titles = (await c.run((tx) => listFormTemplates(tx, c.orgId, { status: "publicado" }))).map((row) => row.title)
  expect(titles.filter((title) => title === "Evaluación de endodoncia")).toHaveLength(1)
})

it("una ficha del producto dice «sin mirar» hasta que alguien de la clínica la abre o la cambia", async () => {
  const c = await clinic()
  // De cada ficha, la versión en uso (la lista trae también las archivadas).
  const marks = async () =>
    new Map(
      (await c.run((tx) => listClinicFormTemplates(tx, c.orgId)))
        .filter((row) => row.status === "publicado")
        .map((row) => [row.key, row]),
    )
  const before = await marks()
  expect([...before.values()].every((row) => row.fromProduct && !row.looked)).toBe(true)
  // La lista dice también cuál se ofrece por la edad: la pantalla no lo calcula.
  expect(before.get("ficha-de-odontopediatria")?.offeredUnderYears).toBe(12)
  expect(before.get("ficha-de-ortodoncia")?.offeredUnderYears).toBeNull()

  // Abrirla deja una sola constancia, aunque se abra dos veces.
  const orthodontics = before.get("ficha-de-ortodoncia")!
  await c.run((tx) => markFormTemplateLooked(tx, c.orgId, c.actor, orthodontics.id))
  await c.run((tx) => markFormTemplateLooked(tx, c.orgId, c.actor, orthodontics.id))
  const looks = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.action, "form_template.look")))
  expect(looks).toHaveLength(1)
  expect(looks[0]).toMatchObject({ entityId: orthodontics.id, actorUserId: c.actor })

  // Cambiarla (una versión nueva, con autor) también es haberla mirado.
  const endodontics = before.get("evaluacion-de-endodoncia")!
  await c.run(async (tx) => {
    const draft = await createFormTemplate(tx, c.orgId, c.actor, {
      key: endodontics.key,
      title: endodontics.title,
      schema: endodontics.schema,
    })
    return publishFormTemplate(tx, c.orgId, c.actor, draft.id)
  })
  const after = await marks()
  expect(after.get("ficha-de-ortodoncia")).toMatchObject({ fromProduct: true, looked: true })
  expect(after.get("evaluacion-de-endodoncia")).toMatchObject({ fromProduct: true, looked: true, version: 2 })
  expect(after.get("ficha-de-odontopediatria")).toMatchObject({ fromProduct: true, looked: false })
  expect(after.get("ficha-odontoestomatologica")).toMatchObject({ fromProduct: true, looked: false })

  // Una plantilla que no existe responde 404, no un error interno.
  await expect(c.run((tx) => markFormTemplateLooked(tx, c.orgId, c.actor, randomUUID()))).rejects.toMatchObject({ status: 404 })
})

it("la ficha se ofrece sola por la especialidad del servicio de la cita, y solo esa", async () => {
  const c = await clinic()
  // Quien atiende es de odontología general: con una cita de ortodoncia no cuenta.
  await c.run((tx) =>
    setProfessionalSpecialties(tx, c.orgId, c.actor, c.actor, [c.specialties.get("odontologia_general")!.id]),
  )
  const session = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  const offers = await c.offers(session.id)
  expect(offers).toHaveLength(1)
  expect(offers[0]).toMatchObject({
    key: "ficha-de-ortodoncia",
    title: "Ficha de ortodoncia",
    why: "cita",
    specialtyName: "Ortodoncia y Ortopedia Maxilar",
    underYears: null,
    today: null,
    previous: null,
  })
  // Con dos fichas de esa especialidad salen las dos: ofrecer por servicio queda fuera.
  await c.run(async (tx) => {
    const draft = await createFormTemplate(tx, c.orgId, c.actor, {
      title: "Control de ortodoncia",
      specialtyId: c.specialties.get("ortodoncia_ortopedia_maxilar")!.id,
      schema: { sections: [{ id: "control", title: "Control", fields: [{ id: "arco", label: "Arco", type: "texto" }] }] },
    })
    return publishFormTemplate(tx, c.orgId, c.actor, draft.id)
  })
  expect((await c.offers(session.id)).map((offer) => offer.title)).toEqual(["Control de ortodoncia", "Ficha de ortodoncia"])
})

it("a un menor de 12 años se le ofrecen las de odontopediatría por su edad, y sin servicio en la cita, las de quien atiende", async () => {
  const c = await clinic()
  await c.run((tx) =>
    setProfessionalSpecialties(tx, c.orgId, c.actor, c.actor, [c.specialties.get("endodoncia")!.id]),
  )
  await setTestPatientIdentity(ownerDb, c.patient.id, { birthDate: bornYearsAgo(6) })
  // La cita no dice de qué es.
  const session = await c.attention({ service: false })
  const offers = await c.offers(session.id)
  expect(offers.map((offer) => [offer.key, offer.why])).toEqual([
    ["ficha-de-odontopediatria", "edad"],
    ["evaluacion-de-endodoncia", "profesional"],
  ])
  expect(offers[0]).toMatchObject({ underYears: 12, specialtyName: "Odontopediatría" })
  expect(offers[1]).toMatchObject({ underYears: null, specialtyName: "Endodoncia" })

  // El día que cumple 12 deja de ofrecerse por edad; la víspera todavía.
  await setTestPatientIdentity(ownerDb, c.patient.id, { birthDate: bornYearsAgo(12) })
  expect((await c.offers(session.id)).map((offer) => offer.why)).toEqual(["profesional"])
  await setTestPatientIdentity(ownerDb, c.patient.id, { birthDate: bornYearsAgo(12, true) })
  expect((await c.offers(session.id)).map((offer) => offer.why)).toEqual(["edad", "profesional"])

  // Con una cita de ortodoncia: la de la cita primero, la de su edad después, y ya no la de quien atiende.
  const orthodontic = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  expect((await c.offers(orthodontic.id)).map((offer) => [offer.key, offer.why])).toEqual([
    ["ficha-de-ortodoncia", "cita"],
    ["ficha-de-odontopediatria", "edad"],
  ])
})

it("sin fecha de nacimiento, sin cita y sin especialidades de quien atiende no se ofrece ninguna; y otra clínica no ve esta atención", async () => {
  const c = await clinic()
  const session = await c.attention()
  expect(await c.offers(session.id)).toEqual([])
  // Una atención sin cita: valen las especialidades de quien atiende.
  await c.run((tx) =>
    setProfessionalSpecialties(tx, c.orgId, c.actor, c.actor, [c.specialties.get("odontologia_general")!.id]),
  )
  expect((await c.offers(session.id)).map((offer) => [offer.key, offer.why])).toEqual([
    ["ficha-odontoestomatologica", "profesional"],
  ])
  // La ficha que se dejó de usar ya no se ofrece.
  const [stomatologic] = await ownerDb
    .select()
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.organizationId, c.orgId), eq(clinicalFormTemplate.key, "ficha-odontoestomatologica")))
  await c.run((tx) => archiveFormTemplate(tx, c.orgId, c.actor, stomatologic!.id))
  expect(await c.offers(session.id)).toEqual([])
  // La atención de otra clínica no existe para esta.
  const other = await clinic()
  await expect(
    other.run((tx) => getEncounterFormOffers(tx, other.orgId, c.patient.id, session.id)),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    c.run((tx) => getEncounterFormOffers(tx, c.orgId, c.patient.id, randomUUID())),
  ).rejects.toMatchObject({ status: 404 })
})

it("en el control, la ficha de hoy trae la anterior del mismo tipo, aunque la plantilla haya cambiado de versión", async () => {
  const c = await clinic()
  const orthodonticsId = c.specialties.get("ortodoncia_ortopedia_maxilar")!.id
  const template = async () =>
    (await c.run((tx) => listFormTemplates(tx, c.orgId, { status: "publicado" }))).find(
      (row) => row.key === "ficha-de-ortodoncia",
    )!
  // La evaluación: se llena y se finaliza.
  const first = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  const initial = await c.run(async (tx) =>
    createFormResponse(tx, c.orgId, c.actor, {
      templateId: (await template()).id,
      patientId: c.patient.id,
      encounterId: first.id,
      answers: { clase_molar_derecha: "Clase II división 1", overjet: 6, overbite: 4 },
    }),
  )
  // En su propia atención, la de hoy no es «la anterior» de sí misma.
  let [offer] = await c.offers(first.id)
  expect(offer).toMatchObject({ today: { responseId: initial.id, status: "borrador" }, previous: null })
  await c.run((tx) => finalizeFormResponse(tx, c.orgId, c.actor, initial.id))
  ;[offer] = await c.offers(first.id)
  expect(offer).toMatchObject({ today: { responseId: initial.id, status: "finalizado" }, previous: null })

  // La clínica cambia la ficha: versión 2, con la misma clave.
  const current = await template()
  await c.run(async (tx) => {
    const draft = await createFormTemplate(tx, c.orgId, c.actor, {
      key: current.key,
      title: current.title,
      specialtyId: orthodonticsId,
      schema: current.schema,
    })
    return publishFormTemplate(tx, c.orgId, c.actor, draft.id)
  })

  // El control, un mes después: se ofrece con la del 12 de octubre.
  const control = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  ;[offer] = await c.offers(control.id)
  expect(offer).toMatchObject({ key: "ficha-de-ortodoncia", why: "cita", today: null })
  expect(offer?.previous).toMatchObject({ responseId: initial.id, professionalUserId: c.actor })
  expect(offer?.previous?.finalizedAt).toBeInstanceOf(Date)
  expect(offer?.templateId).toBe((await template()).id)

  // «Empezar la de hoy»: la lista del paciente dice cuál poner al lado.
  const today = await c.run(async (tx) =>
    createFormResponse(tx, c.orgId, c.actor, {
      templateId: (await template()).id,
      patientId: c.patient.id,
      encounterId: control.id,
    }),
  )
  const listed = await c.run((tx) => listPatientFormResponses(tx, c.orgId, { patientId: c.patient.id }))
  expect(listed.find((row) => row.id === today.id)).toMatchObject({ previousId: initial.id, templateVersion: 2 })
  expect(listed.find((row) => row.id === initial.id)).toMatchObject({ previousId: null })
  ;[offer] = await c.offers(control.id)
  expect(offer).toMatchObject({ today: { responseId: today.id, status: "borrador" } })
  expect(offer?.previous?.responseId).toBe(initial.id)
})

it("la ficha finalizada en una atención que después se anuló no se pone al lado", async () => {
  const c = await clinic()
  const template = (await c.run((tx) => listFormTemplates(tx, c.orgId, { status: "publicado" }))).find(
    (row) => row.key === "ficha-de-ortodoncia",
  )!
  // Se anula una atención en curso (firmada ya no se anula): su ficha finalizada se conserva, marcada.
  const first = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  const initial = await c.run((tx) =>
    createFormResponse(tx, c.orgId, c.actor, {
      templateId: template.id,
      patientId: c.patient.id,
      encounterId: first.id,
      answers: { clase_molar_derecha: "Clase I" },
    }),
  )
  await c.run((tx) => finalizeFormResponse(tx, c.orgId, c.actor, initial.id))
  await c.run((tx) => voidEncounter(tx, c.orgId, c.actor, c.patient.id, first.id, { reason: "Paciente equivocado" }))
  c.forget()

  const control = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  const [offer] = await c.offers(control.id)
  expect(offer).toMatchObject({ key: "ficha-de-ortodoncia", previous: null })
  const today = await c.run((tx) =>
    createFormResponse(tx, c.orgId, c.actor, { templateId: template.id, patientId: c.patient.id, encounterId: control.id }),
  )
  const listed = await c.run((tx) => listPatientFormResponses(tx, c.orgId, { patientId: c.patient.id }))
  expect(listed.find((row) => row.id === today.id)?.previousId).toBeNull()
})

it("nada traba la atención: con una ficha ofrecida y sin tocarla, la atención se firma", async () => {
  const c = await clinic()
  await c.run((tx) =>
    setProfessionalSpecialties(tx, c.orgId, c.actor, c.actor, [c.specialties.get("endodoncia")!.id]),
  )
  // La atención del fixture: sin cita, con una ficha que se ofrece por quien atiende.
  expect((await c.offers(c.encounter.id)).map((offer) => offer.key)).toEqual(["evaluacion-de-endodoncia"])
  await c.ready(c.encounter.id)
  const closed = await c.run((tx) => finalizeEncounter(tx, c.orgId, c.actor, c.patient.id, c.encounter.id))
  expect(closed.encounter.status).toBe("finalizada")
  // Se firmó sin empezarla: ofrecer no es pedir. Firmada, ya no ofrece nada.
  expect(await c.offers(c.encounter.id)).toEqual([])
})

it("un solo nombre: desactivar una especialidad nombra la ficha de consulta que la traba, y la Historia dice «ficha de consulta»", async () => {
  const c = await clinic()
  const orthodontics = c.specialties.get("ortodoncia_ortopedia_maxilar")!
  await expect(c.run((tx) => archiveSpecialty(tx, c.orgId, c.actor, orthodontics.id))).rejects.toMatchObject({
    code: "HAS_PUBLISHED",
    message: "Deja de usar primero las fichas de consulta de esta especialidad",
  })
  // Una ficha sin atención sale suelta en la Historia, con su nombre.
  const template = (await c.run((tx) => listFormTemplates(tx, c.orgId, { status: "publicado" }))).find(
    (row) => row.key === "ficha-de-ortodoncia",
  )!
  const loose = await c.run((tx) =>
    createFormResponse(tx, c.orgId, c.actor, { templateId: template.id, patientId: c.patient.id, encounterId: null }),
  )
  await c.run((tx) => finalizeFormResponse(tx, c.orgId, c.actor, loose.id))
  const { data } = await c.run((tx) => getTimeline(tx, c.orgId, c.patient.id, { types: ["form"] }))
  expect(data.find((row) => row.refId === loose.id)?.title).toBe("Se completó la ficha de consulta: Ficha de ortodoncia")
})

// QA del 14 nov (clínica H4): desde el tercer control dejaba de verse la ficha de inicio.
it("desde el tercer control, la de hoy trae también la de inicio para comparar", async () => {
  const c = await clinic()
  const template = (await c.run((tx) => listFormTemplates(tx, c.orgId, { status: "publicado" }))).find(
    (row) => row.key === "ficha-de-ortodoncia",
  )!
  const finished: string[] = []
  for (const answer of ["Clase II división 1", "Clase II división 1", "Clase I"]) {
    const visit = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
    const row = await c.run((tx) =>
      createFormResponse(tx, c.orgId, c.actor, { templateId: template.id, patientId: c.patient.id, encounterId: visit.id, answers: { clase_molar_derecha: answer } }),
    )
    await c.run((tx) => finalizeFormResponse(tx, c.orgId, c.actor, row.id))
    finished.push(row.id)
  }
  const listed = await c.run((tx) => listPatientFormResponses(tx, c.orgId, { patientId: c.patient.id }))
  const byId = new Map(listed.map((row) => [row.id, row]))
  // La segunda: su anterior es la de inicio, sin repetirla.
  expect(byId.get(finished[1]!)).toMatchObject({ previousId: finished[0], firstId: null })
  // La tercera: la anterior y, aparte, la de inicio.
  expect(byId.get(finished[2]!)).toMatchObject({ previousId: finished[1], firstId: finished[0] })
})

// QA del 14 nov (desarrollo H8): «Miraste N de 4» cambiaba de total y «Volver a usar» la marcaba.
it("apagar una ficha del producto cuenta como decidida, y encenderla otra vez no cambia la marca", async () => {
  const c = await clinic()
  const marks = async () =>
    new Map(
      (await c.run((tx) => listClinicFormTemplates(tx, c.orgId)))
        .filter((row) => row.status === "publicado")
        .map((row) => [row.key, row]),
    )
  const pediatric = (await marks()).get("ficha-de-odontopediatria")!
  expect(pediatric).toMatchObject({ fromProduct: true, looked: false })
  await c.run((tx) => archiveFormTemplate(tx, c.orgId, c.actor, pediatric.id))
  expect((await marks()).get("ficha-de-odontopediatria")).toMatchObject({ fromProduct: true, looked: true, inUse: false })
  await c.run((tx) => reuseFormTemplate(tx, c.orgId, c.actor, pediatric.id))
  expect((await marks()).get("ficha-de-odontopediatria")).toMatchObject({ fromProduct: true, looked: true, inUse: true })
  // Las cuatro siguen siendo del producto, en uso o no: el total no cambia.
  expect([...(await marks()).values()].filter((row) => row.fromProduct)).toHaveLength(4)
})

// QA del 14 nov (desarrollo H6 y H7): la API ofrecía fichas en una atención firmada o anulada, y de una especialidad desactivada.
it("una atención firmada o anulada no ofrece ninguna ficha, ni una especialidad desactivada ofrece las suyas", async () => {
  const c = await clinic()
  const signed = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  expect(await c.offers(signed.id)).toHaveLength(1)
  // La siguiente atención firma la anterior.
  const open = await c.attention({ specialty: "ortodoncia_ortopedia_maxilar" })
  expect(await c.offers(signed.id)).toEqual([])
  // Una especialidad desactivada (aquí, a mano): su ficha no se ofrece aunque la cita sea de ella.
  await ownerDb
    .update(orgSpecialty)
    .set({ isActive: false })
    .where(eq(orgSpecialty.id, c.specialties.get("ortodoncia_ortopedia_maxilar")!.id))
  expect((await c.offers(open.id)).map((offer) => offer.key)).not.toContain("ficha-de-ortodoncia")
  await c.run((tx) => voidEncounter(tx, c.orgId, c.actor, c.patient.id, open.id, { reason: "Paciente equivocado" }))
  expect(await c.offers(open.id)).toEqual([])
})

// QA del 14 nov (desarrollo H6): en clínicas sin especialidades, el worker creaba las 13 de la biblioteca, activas.
it("copiar las fichas del producto no crea especialidades: sin la suya activa, la ficha entra sin especialidad", async () => {
  const c = await clinic({ forms: false })
  // Una clínica sin especialidades (como las que nacieron antes de que las tuvieran).
  await ownerDb.delete(orgSpecialty).where(eq(orgSpecialty.organizationId, c.orgId))
  const created = await c.run((tx) => ensureClinicForms(tx, c.orgId))
  expect(created).toHaveLength(4)
  expect(created.every((row) => row.specialtyId === null)).toBe(true)
  expect(await ownerDb.select().from(orgSpecialty).where(eq(orgSpecialty.organizationId, c.orgId))).toEqual([])

  // Con su especialidad desactivada, tampoco se une a ella ni la reactiva.
  const other = await clinic({ forms: false })
  const pediatric = other.specialties.get("odontopediatria")!
  await ownerDb.update(orgSpecialty).set({ isActive: false }).where(eq(orgSpecialty.id, pediatric.id))
  const copies = await other.run((tx) => ensureClinicForms(tx, other.orgId))
  expect(copies.find((row) => row.key === "ficha-de-odontopediatria")?.specialtyId).toBeNull()
  expect(copies.find((row) => row.key === "ficha-de-ortodoncia")?.specialtyId).toBe(
    other.specialties.get("ortodoncia_ortopedia_maxilar")!.id,
  )
  const [still] = await ownerDb.select().from(orgSpecialty).where(eq(orgSpecialty.id, pediatric.id))
  expect(still?.isActive).toBe(false)
})
