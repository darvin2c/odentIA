import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { patient, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import type { Locator, Page, TestInfo } from "@playwright/test"
import { sql } from "drizzle-orm"
import { PANEL, tenant } from "./env"
import { call, chooseOption, expect, fillPatientNames, test, type OwnerFixture, writtenDate } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

async function observe(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

/** Un instante a media mañana (Lima) del mes pasado de la clínica. */
function lastMonth(day: number, hour = 15): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return new Date(Date.UTC(get("year"), get("month") - 2, day, hour))
}

/**
 * Cuatro personas que nos buscaron por primera vez el mes pasado: Lucía escribió
 * por WhatsApp, vino y aceptó su presupuesto; Rosa la registró recepción y tiene
 * su cita por venir; Mario preguntó por Instagram y Pedro por WhatsApp, y
 * ninguno agendó. Ningún envío externo.
 */
async function fourPeople(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const roomId = randomUUID()
  await db.insert(scheduleRoom).values({ id: roomId, organizationId, branchId: owner.branchId, name: "Unidad dental de prueba" })
  const channel = async (name: string) => {
    const id = randomUUID()
    await db.insert(channelConnection).values({ id, organizationId, channel: name, provider: "prueba", displayName: name, configEncrypted: "no-se-usa", webhookSecret: "no-se-usa" })
    return id
  }
  const [whatsapp, instagram] = [await channel("whatsapp"), await channel("instagram")]
  const person = async (displayName: string, createdAt: Date) => {
    const [row] = await db.insert(contact).values({ organizationId, displayName, createdAt }).returning({ id: contact.id })
    return row!.id
  }
  const wrote = async (contactId: string, channelId: string, at: Date) => {
    const conversationId = randomUUID()
    await db.insert(conversation).values({
      id: conversationId, organizationId, contactId, channelConnectionId: channelId, externalThreadId: randomUUID(),
      createdAt: at, lastInboundAt: at, lastMessageAt: at, status: "closed", closedAt: new Date(at.getTime() + 3_600_000), closeReason: "sin_respuesta",
    })
    await db.insert(message).values({ organizationId, conversationId, direction: "in", senderKind: "contact", status: "received", createdAt: at })
  }
  const lucia = await person("Lucía Ramos", lastMonth(3))
  await wrote(lucia, whatsapp, lastMonth(3))
  const luciaPatient = randomUUID()
  await db.insert(patient).values({ id: luciaPatient, organizationId, personId: lucia, patientNumber: 1, referralKind: "redes_sociales", createdAt: lastMonth(5) })
  await db.insert(appointment).values({
    organizationId, branchId: owner.branchId, patientId: luciaPatient, roomId, professionalUserId: owner.user.id, serviceName: "Evaluación",
    startsAt: lastMonth(8), endsAt: new Date(lastMonth(8).getTime() + 30 * 60_000), durationMin: 30, status: "atendida", createdAt: lastMonth(5),
  })
  const [plan] = await db.insert(treatmentPlan).values({ organizationId, patientId: luciaPatient, title: "Plan" }).returning({ id: treatmentPlan.id })
  // Recibió el presupuesto el mes pasado y lo aceptó este mes, después del periodo.
  await db.insert(treatmentBudget).values({
    organizationId, patientId: luciaPatient, planId: plan!.id, budgetNumber: 1, title: "Ortodoncia", currency: "PEN",
    status: "aceptado", presentedAt: lastMonth(9), decidedAt: new Date(),
  })
  const rosa = await person("Rosa Quispe", lastMonth(6))
  const rosaPatient = randomUUID()
  await db.insert(patient).values({ id: rosaPatient, organizationId, personId: rosa, patientNumber: 2, createdAt: lastMonth(6) })
  const soon = new Date(Date.now() + 5 * 86_400_000)
  await db.insert(appointment).values({
    organizationId, branchId: owner.branchId, patientId: rosaPatient, roomId, professionalUserId: owner.user.id, serviceName: "Evaluación",
    startsAt: soon, endsAt: new Date(soon.getTime() + 30 * 60_000), durationMin: 30, status: "programada", createdAt: lastMonth(6),
  })
  await wrote(await person("Mario Torres", lastMonth(4)), instagram, lastMonth(4))
  await wrote(await person("Pedro Salas", lastMonth(7)), whatsapp, lastMonth(7))
  return { luciaPatient }
}

for (const width of [1440, 375]) {
  test.describe(`Reportes › Pacientes a ${width}px`, () => {
    test("el embudo sigue a las mismas personas, dice dónde se caen y cada paso abre su lista", async ({ owner, fixtureDb }, info) => {
      await fourPeople(fixtureDb, owner)
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })

      // El Resumen trae la tarjeta y lleva a la pestaña.
      await gotoHydrated(page, tenant(owner.org.slug, "/reports?period=mes_pasado"))
      const card = page.getByRole("region", { name: "Dónde se caen los pacientes" })
      await expect(card).toContainText("Las 4 personas que nos buscaron por primera vez")
      await expect(card).toContainText("Aquí se caen más: 2 de cada 4 no agendaron")
      await observe(page, info, "resumen")
      await card.getByRole("link", { name: "Ver el embudo" }).click()
      await expect(page).toHaveURL(/tab=pacientes/)

      const figures = page.getByRole("region", { name: "Cifras de pacientes" })
      await expect(figures).toContainText("Nos buscaron por primera vez")
      await expect(figures).toContainText("Escribieron o los registró recepción")
      const funnel = page.getByRole("region", { name: "Dónde se caen los pacientes" })
      // Las mismas personas paso a paso: Lucía nos buscó el mes pasado y aceptó este mes, después del periodo, y cuenta.
      await expect(funnel.getByRole("button", { name: /^Nos buscaron: 4/ })).toBeVisible()
      await expect(funnel.getByRole("button", { name: /^Agendaron: 2\. 50 %/ })).toBeVisible()
      await expect(funnel.getByRole("button", { name: /^Aceptaron: 1\. 100 %/ })).toBeVisible()
      await expect(funnel).toContainText("Aquí se caen más: 2 no agendaron")
      await expect(funnel).toContainText("2 de ellos preguntaron algo y no escriben hace más de 3 días")
      await observe(page, info, "pacientes")

      // Con el teclado: las flechas recorren los pasos y Enter abre la lista de quienes llegaron.
      await funnel.getByRole("button", { name: /^Nos buscaron: 4/ }).focus()
      await page.keyboard.press("ArrowDown")
      await expect(funnel.getByRole("button", { name: /^Agendaron: 2/ })).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(page).toHaveURL(/lista=funnel_booked/)
      const booked = surface(page, { name: "Agendaron" }).first()
      await expect(booked.getByRole("link", { name: "Lucía Ramos" })).toBeVisible()
      await expect(booked.getByRole("link", { name: "Rosa Quispe" })).toBeVisible()
      // Rosa tiene una sola cita, la que viene: no es «otra».
      await expect(booked.getByText("Tiene cita por venir")).toBeVisible()
      await expect(booked.getByText("Cómo se calcula")).toBeVisible()
      await observe(page, info, "lista-agendaron")
      await page.keyboard.press("Escape")
      await expect(page).not.toHaveURL(/lista=/)

      // Quienes se cayeron: aún no son pacientes y abren su conversación en la Bandeja.
      await funnel.getByRole("button", { name: "Ver los 2" }).click()
      await expect(page).toHaveURL(/lista=funnel_lost_booked/)
      const lost = surface(page, { name: "No agendaron" }).first()
      await expect(lost.getByRole("link", { name: "Mario Torres" })).toHaveAttribute("href", /\/inbox\?conversation=/)
      await expect(lost).toContainText("Instagram")
      await page.keyboard.press("Escape")

      // Ver como tabla: los mismos pasos escritos.
      await funnel.getByRole("button", { name: "Ver como tabla" }).click()
      await expect(funnel.getByRole("columnheader", { name: "Del paso anterior" })).toBeVisible()
      await expect(funnel.getByRole("row", { name: /Agendaron 2 50 %/ })).toBeVisible()

      // Por dónde nos buscaron y cómo nos conocieron.
      const channels = page.getByRole("region", { name: "Por dónde nos buscaron" })
      await expect(channels.getByRole("button", { name: /^WhatsApp: 1 de 2/ })).toBeVisible()
      await expect(channels.getByRole("button", { name: /^Recepción: 0 de 1/ })).toBeVisible()
      const referral = page.getByRole("region", { name: "Cómo nos conocieron" })
      await expect(referral.getByRole("button", { name: /^Redes sociales: 1/ })).toBeVisible()
      await expect(page.getByRole("region", { name: "Si vuelven" })).toBeVisible()
      await observe(page, info, "pacientes-tabla")
    })
  })
}

test("«Cómo nos conoció» se elige de una lista y «Otro» pide cuál", async ({ owner, fixtureDb }, info) => {
  const { luciaPatient } = await fourPeople(fixtureDb, owner)
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, `/patients/${luciaPatient}?tab=filiacion`))
  await page.getByRole("button", { name: "Más datos" }).click()
  await expect(page.getByText("Redes sociales")).toBeVisible()
  await page.getByRole("button", { name: "Editar", exact: true }).last().click()
  const form = surface(page, { name: "Editar más datos" }).first()
  await expect(form.getByLabel("¿Cuál?")).toHaveCount(0)
  await form.getByRole("combobox", { name: "Cómo nos conoció" }).click()
  await page.getByRole("option", { name: "Otro" }).click()
  await form.getByLabel("¿Cuál?").fill("Feria de salud")
  await info.attach("mas-datos", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await form.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Otro: Feria de salud")).toBeVisible()
  expect(await referralOf(fixtureDb, owner.org.id, "Lucía Ramos")).toEqual({ kind: "otro", said: "Feria de salud" })

  // Dejarlo sin registrar borra también lo que dijo: no vuelve a «Otro».
  await page.getByRole("button", { name: "Editar", exact: true }).last().click()
  const again = surface(page, { name: "Editar más datos" }).first()
  await chooseOption(again.getByRole("combobox", { name: "Cómo nos conoció" }), { label: "No registrado" })
  await expect(again.getByLabel("¿Cuál?")).toHaveCount(0)
  await again.getByRole("button", { name: "Guardar" }).click()
  await expect(page.getByText("Otro: Feria de salud")).toHaveCount(0)
  await expect.poll(() => referralOf(fixtureDb, owner.org.id, "Lucía Ramos")).toEqual({ kind: null, said: null })
})

/** Lo que guardó la ficha de una persona: la opción de la lista y lo que dijo. */
async function referralOf(db: Db, organizationId: string, displayName: string) {
  const rows = await db.execute<{ kind: string | null; said: string | null }>(sql`
    select p.referral_kind as kind, p.referral_source as said from patient p
    join contact c on c.organization_id = p.organization_id and c.id = p.person_id
    where p.organization_id = ${organizationId} and c.display_name = ${displayName}`)
  return rows[0] ?? null
}

test("registro en línea: «Cómo nos conoció» es la misma lista cuando la clínica la pregunta, y «¿Cuál?» solo va con «Otro»", async ({ owner, fixtureDb, browser }, info) => {
  const page = owner.page
  const current = await call<{ version: number; fields: Record<string, string> }>(page, "GET", "/api/patient-registration/config", owner.org.slug)
  await call(page, "PUT", "/api/patient-registration/config", owner.org.slug, {
    enabled: true,
    fields: { ...current.fields, referralSource: "optional" },
    privacyNotice: "Aviso e2e: tus datos se usan solo para tu atención clínica (demostración).",
    expectedVersion: current.version,
  })
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
  const anon = await context.newPage()
  const progress = anon.getByText(/^Paso \d+ de \d+$/)
  // Un paso por pantalla: lo opcional se salta y en salud se contesta «No».
  const advanceTo = async (target: Locator) => {
    for (let step = 0; step < 8 && !(await target.isVisible()); step += 1) {
      for (const question of [/alérgic/, /alguna enfermedad/, /algún medicamento/]) {
        const group = anon.getByRole("group", { name: question }).first()
        if (await group.isVisible()) await group.getByRole("button", { name: "No", exact: true }).click()
      }
      const before = await progress.textContent()
      const skip = anon.getByRole("button", { name: "Saltar", exact: true })
      await ((await skip.isVisible()) ? skip : anon.getByRole("button", { name: "Siguiente", exact: true })).click()
      await expect(progress).not.toHaveText(before ?? "")
    }
    await expect(target).toBeVisible()
  }
  try {
    await gotoHydrated(anon, tenant(owner.org.slug, "/registro?via=qr"))
    await anon.getByRole("radio", { name: "Para mí" }).click()
    await advanceTo(anon.getByLabel(/^Nombres/))
    await fillPatientNames(anon, "Olga Referida")
    await anon.getByLabel("Fecha de nacimiento").fill(writtenDate("1985-06-15"))
    // «¿Cómo te contactamos?»: el celular va con el país de la clínica ya elegido.
    const phone = anon.getByRole("textbox", { name: /^Tu celular/ })
    await advanceTo(phone)
    await phone.fill("999300301")
    // «Para conocerte mejor»: una lista, no texto libre; «¿Cuál?» aparece con «Otro» y se va con otra opción.
    const kind = anon.getByRole("combobox", { name: /^Cómo nos conoció/ })
    await advanceTo(kind)
    const which = anon.getByLabel("¿Cuál?", { exact: true })
    await expect(which).toHaveCount(0)
    await chooseOption(kind, { label: "Otro" })
    await which.fill("Volante")
    await chooseOption(kind, { label: "Recomendación de alguien" })
    await expect(which).toHaveCount(0)
    await info.attach("registro-en-linea", { body: await anon.screenshot({ fullPage: true }), contentType: "image/png" })
    // Con la respuesta puesta se sigue con «Siguiente»: «Saltar» la borraría.
    const answered = await progress.textContent()
    await anon.getByRole("button", { name: "Siguiente", exact: true }).click()
    await expect(progress).not.toHaveText(answered ?? "")
    const consent = anon.getByRole("checkbox", { name: /Autorizo el tratamiento de mis datos/ })
    await advanceTo(consent)
    await consent.check()
    await anon.getByRole("button", { name: "Enviar registro", exact: true }).click()
    await expect(anon.getByRole("heading", { name: "Registro recibido" })).toBeVisible({ timeout: 20_000 })
  } finally {
    await context.close()
  }
  // Lo escrito con «Otro» no viaja cuando al final eligió otra opción.
  expect(await referralOf(fixtureDb, owner.org.id, "Olga Referida")).toEqual({ kind: "recomendacion", said: null })
})

/**
 * Invitar a volver (#139): Lucía no viene hace ocho meses y nadie la invitó;
 * a Carmen la invitó el agente el mes pasado y vino después. Ningún envío externo.
 */
async function invitedToReturn(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const roomId = randomUUID()
  await db.insert(scheduleRoom).values({ id: roomId, organizationId, branchId: owner.branchId, name: "Unidad dental de prueba" })
  const attended = async (displayName: string, patientNumber: number, visits: Date[]) => {
    const [person] = await db.insert(contact).values({ organizationId, displayName, createdAt: visits[0] }).returning({ id: contact.id })
    const patientId = randomUUID()
    await db.insert(patient).values({ id: patientId, organizationId, personId: person!.id, patientNumber, createdAt: visits[0] })
    for (const startsAt of visits) {
      await db.insert(appointment).values({
        organizationId, branchId: owner.branchId, patientId, roomId, professionalUserId: owner.user.id, serviceName: "Limpieza",
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status: "atendida", createdAt: startsAt,
      })
    }
    return patientId
  }
  const monthsAgo = (months: number) => new Date(Date.now() - months * 30 * 86_400_000)
  await attended("Lucía Fernández", 1, [monthsAgo(8)])
  const carmen = await attended("Carmen Huamán", 2, [monthsAgo(10), lastMonth(20)])
  await db.insert(auditEvent).values({
    organizationId, action: "paciente.invitada_a_volver", entity: "patient", entityId: carmen, metadata: { via: "agente" }, createdAt: lastMonth(5),
  })
}

test("invitar a volver: el atajo, «Ya la invité», lo que dice la fila y quién volvió en Reportes", async ({ owner, fixtureDb }, info) => {
  await invitedToReturn(fixtureDb, owner)
  const page = owner.page
  const slug = owner.org.slug

  // El atajo muestra solo a quien le toca, con lo que sigue y quién se encarga.
  await gotoHydrated(page, tenant(slug, "/people?atajo=por_invitar_a_volver"))
  const lucia = page.getByRole("row", { name: /Lucía Fernández/ })
  await expect(lucia).toContainText("Toca invitarla a volver")
  await expect(lucia).toContainText("Lo lleva una persona del equipo")
  await expect(page.getByRole("row", { name: /Carmen Huamán/ })).toHaveCount(0)
  await observe(page, info, "por-invitar")

  // «Ya la invité»: sale del atajo y su fila dice cuándo y quién, y cuándo le vuelve a tocar.
  await lucia.getByRole("button", { name: "Ya la invité" }).click()
  await expect(page.getByRole("row", { name: /Lucía Fernández/ })).toHaveCount(0)
  await gotoHydrated(page, tenant(slug, "/people"))
  const invited = page.getByRole("row", { name: /Lucía Fernández/ })
  await expect(invited).toContainText(new RegExp(`Invitada por ${owner.user.name} el \\d{1,2} \\S+ · la próxima, en \\S+`))
  await expect(invited).toContainText("Lo lleva una persona del equipo")
  await observe(page, info, "ya-invitada")

  // Reportes cuenta a quien volvió tras la invitación del mes pasado; la de hoy es de este mes.
  await gotoHydrated(page, tenant(slug, "/reports?period=mes_pasado&tab=pacientes"))
  const returns = page.getByRole("region", { name: "Si vuelven" })
  const figure = returns.getByText("Volvieron tras la invitación", { exact: true }).locator("..")
  await expect(figure).toContainText("1 de 1 invitada")
  await observe(page, info, "volvieron-tras-la-invitacion")
  await figure.getByRole("button", { name: "Ver quiénes" }).click()
  await expect(page).toHaveURL(/lista=invited_returned/)
  const list = surface(page, { name: "Volvieron tras la invitación" }).first()
  await expect(list.getByRole("link", { name: "Carmen Huamán" })).toBeVisible()
  await expect(list.getByRole("link", { name: "Lucía Fernández" })).toHaveCount(0)
  await expect(list.getByText("Cómo se calcula")).toBeVisible()
})
