/**
 * Quién atiende (ADR 0124), en pantalla: caja y recepción no salen como
 * profesionales ni el servidor las acepta, Equipo dice quién atiende y qué días,
 * y quien sale del equipo deja de ofrecerse con sus citas a la vista para
 * pasarlas a otra persona.
 */
import { randomUUID } from "node:crypto"
import { member, user as users } from "@odentia/db/schema/auth"
import { tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]

test("quién atiende: agenda, horarios, equipo y quien sale del equipo", async ({ owner, fixtureDb }, info) => {
  test.setTimeout(180_000)
  const { page, org, branchId } = owner
  const slug = org.slug
  const shot = async (name: string) => info.attach(name, { body: await page.screenshot(), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  const hire = async (name: string, role: string) => {
    const id = randomUUID()
    await fixtureDb.insert(users).values({ id, name, email: `${id}@example.test`, emailVerified: true })
    await fixtureDb.insert(member).values({ id: randomUUID(), organizationId: org.id, userId: id, role, createdAt: new Date() })
    return id
  }
  const viera = await hire("Dra. Clara Viera", "clinician")
  const nuevo = await hire("Dr. Nuevo Sin Horario", "clinician")
  const rita = await hire("Rita Recepción", "reception")
  const carlos = await hire("Carlos Caja", "cashier")

  const room = await call<{ id: string }>(page, "POST", "/api/agenda/rooms", slug, { branchId, name: "Unidad dental 1" }, 201)
  const patient = await call<{ id: string }>(
    page,
    "POST",
    "/api/patients",
    slug,
    {
      submissionId: randomUUID(),
      answers: { demographics: { displayName: "Micaela Ríos", docType: "DNI", docNumber: "45678901" }, respondent: "staff", privacyAccepted: false },
    },
    201,
  )
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  const weekday = new Date(`${date}T17:00:00Z`).getUTCDay()
  const startsAt = `${date}T23:00:00.000Z`
  const endsAt = `${date}T23:45:00.000Z`
  const rules = [{ weekday, startMin: 17 * 60, endMin: 20 * 60 }]
  await call(page, "PUT", "/api/agenda/schedules", slug, { branchId, professionalUserId: viera, rules }, 200)
  const cita = await call<{ id: string; version: number }>(
    page,
    "POST",
    "/api/appointments",
    slug,
    { patientId: patient.id, professionalUserId: viera, roomId: room.id, startsAt, endsAt, reason: "Control" },
    201,
  )

  // El servidor no le da horario ni citas a quien no atiende, ni como excepción.
  const schedule = await api<{ error?: { fields?: Record<string, string> } }>(page, "PUT", "/api/agenda/schedules", slug, { branchId, professionalUserId: carlos, rules })
  expect(schedule.status).toBe(400)
  const booked = await api(page, "POST", "/api/appointments", slug, {
    patientId: patient.id,
    professionalUserId: rita,
    roomId: room.id,
    startsAt: `${date}T22:00:00.000Z`,
    endsAt: `${date}T22:30:00.000Z`,
    outsideSchedule: true,
  })
  expect(booked.status).toBe(400)

  // Agenda: el menú ofrece a quien atiende de oficio, no a recepción, caja ni a quien dirige sin horario.
  await gotoHydrated(page, tenant(slug, `/agenda?date=${date}`))
  await expect(page.getByRole("region", { name: /^Agenda del/ }).getByRole("group", { name: "Dra. Clara Viera" })).toBeVisible()
  await page.getByRole("button", { name: "Profesionales", exact: true }).click()
  const menu = page.getByRole("menu")
  await expect(menu.getByText("No atienden este día")).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: /Dr\. Nuevo Sin Horario/ })).toBeVisible()
  for (const name of ["Rita Recepción", "Carlos Caja", owner.user.name]) await expect(menu.getByText(name)).toHaveCount(0)
  await shot("menu-de-la-agenda")
  await page.keyboard.press("Escape")

  // Horarios y ausencias: solo quien puede atender, y abre en quien atiende de oficio.
  await gotoHydrated(page, tenant(slug, "/settings/availability"))
  const chips = page.getByRole("group", { name: "Profesional" })
  await expect(chips).toContainText("Dra. Clara")
  for (const name of ["Rita", "Carlos"]) await expect(chips).not.toContainText(name)
  await expect(page.getByRole("heading", { name: "Horario semanal de Dra. Clara Viera" })).toBeVisible()
  await shot("horarios")

  // Especialidades: «Quién atiende» no ofrece a recepción ni a caja.
  await gotoHydrated(page, tenant(slug, "/settings/specialties"))
  await page.getByRole("button", { name: "Agregar especialidad" }).first().click()
  const who = page.getByRole("group", { name: "Quién atiende" })
  await expect(who).toContainText("Dra. Clara Viera")
  for (const name of ["Rita Recepción", "Carlos Caja"]) await expect(who).not.toContainText(name)
  await shot("especialidades")

  // Equipo: quién atiende y qué días; a quién le falta horario; a quién no le aplica nada de esto.
  await gotoHydrated(page, tenant(slug, "/settings/team"))
  const row = (text: string) => page.getByRole("row").filter({ hasText: text })
  await expect(row("Dra. Clara Viera")).toContainText(DAYS[weekday] ?? "")
  await expect(row("Dra. Clara Viera")).toContainText("Sin registrar")
  await expect(row("Dr. Nuevo Sin Horario").getByRole("link", { name: "Sin horario" })).toBeVisible()
  await expect(row(owner.user.email)).toContainText("No atiende")
  await expect(row(owner.user.email)).not.toContainText("Sin registrar")
  for (const name of ["Rita Recepción", "Carlos Caja"]) {
    await expect(row(name)).not.toContainText("Sin horario")
    await expect(row(name)).not.toContainText("Sin registrar")
  }
  await shot("equipo")
  // Las acciones de cada fila se alcanzan sin desplazar la tabla de lado.
  await expect(page.getByRole("button", { name: "Acciones de Rita Recepción" })).toBeInViewport({ ratio: 1 })
  await page.setViewportSize({ width: 390, height: 844 })
  // En el teléfono también se ve quién atiende.
  await expect(page.getByRole("link", { name: "Sin horario" })).toBeVisible()
  await expect(page.getByText("No atiende").first()).toBeVisible()
  await shot("equipo-telefono")
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole("button", { name: "Acciones de Rita Recepción" }).click()
  await expect(page.getByRole("menuitem", { name: "Quitar del equipo" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Perfil profesional" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // «Sin horario» lleva a su horario, no al del primero de la lista.
  await row("Dr. Nuevo Sin Horario").getByRole("link", { name: "Sin horario" }).click()
  await expect(page).toHaveURL(tenantPattern(slug, "/settings/availability"))
  await expect(page.getByRole("heading", { name: "Horario semanal de Dr. Nuevo Sin Horario" })).toBeVisible()

  // Sale del equipo: se dice antes qué pasa con su horario y su cita.
  await gotoHydrated(page, tenant(slug, "/settings/team"))
  await page.getByRole("button", { name: "Acciones de Dra. Clara Viera" }).click()
  await page.getByRole("menuitem", { name: "Quitar del equipo" }).click()
  const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Quitar a Dra\. Clara Viera/ }))
  await expect(confirm).toContainText("Su horario se cierra")
  await expect(confirm).toContainText("Tiene 1 cita por venir")
  await shot("quitar-del-equipo")
  await confirm.getByRole("button", { name: "Quitar del equipo" }).click()

  // El aviso lleva a sus citas, marcadas para pasarlas a otra persona.
  await page.getByRole("button", { name: "Ver sus citas" }).click()
  await expect(page).toHaveURL(tenantPattern(slug, "/agenda"))
  await expect(page.getByText("ya no atiende: pásala a otra persona")).toBeVisible()
  await shot("sus-citas")

  // Ya no se ofrece, y la cita sigue en pie.
  const resources = await call<{ professionals: { id: string }[] }>(page, "GET", `/api/agenda/resources?branchId=${branchId}`, slug)
  expect(resources.professionals.map((item) => item.id)).not.toContain(viera)
  const from = encodeURIComponent(`${date}T05:00:00.000Z`)
  const to = encodeURIComponent(new Date(Date.parse(`${date}T05:00:00.000Z`) + 86_400_000).toISOString())
  const open = await call<{ professionals: { id: string }[] }>(page, "GET", `/api/agenda/availability?branchId=${branchId}&from=${from}&to=${to}`, slug)
  expect(open.professionals.map((item) => item.id)).not.toContain(viera)
  expect((await call<{ status: string; professionalUserId: string }>(page, "GET", `/api/appointments/${cita.id}`, slug)).professionalUserId).toBe(viera)

  // Moverla sin cambiar de persona se rechaza, diciendo qué hacer; pasarla a quien atiende, no.
  const same = await api(page, "POST", `/api/appointments/${cita.id}/move`, slug, {
    expectedVersion: cita.version,
    startsAt: `${date}T23:15:00.000Z`,
    endsAt: `${date}T23:59:00.000Z`,
  })
  expect(same.status).toBe(404)
  expect(JSON.stringify(same.body)).toContain("elige a quien atienda")
  await call(page, "PUT", "/api/agenda/schedules", slug, { branchId, professionalUserId: nuevo, rules }, 200)
  const moved = await call<{ professionalUserId: string }>(page, "POST", `/api/appointments/${cita.id}/move`, slug, {
    expectedVersion: cita.version,
    startsAt,
    endsAt,
    professionalUserId: nuevo,
  })
  expect(moved.professionalUserId).toBe(nuevo)
})
