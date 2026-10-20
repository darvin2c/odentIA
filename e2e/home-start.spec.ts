import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { agentHandoff } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { patient, patientCharge } from "@odentia/db/schema/clinical"
import { contact, crmTask } from "@odentia/db/schema/crm"
import type { Page, TestInfo } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import type { WorkspaceHome } from "../apps/platform/src/lib/workspace"
import { tenant, tenantPattern } from "./env"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"

async function observe(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

async function prepareSchedule(owner: OwnerFixture) {
  await call(owner.page, "PUT", "/api/agenda/schedules", owner.org.slug, {
    branchId: owner.branchId, dentistUserId: owner.user.id,
    rules: [{ weekday: 1, startMin: 540, endMin: 1020 }],
  })
}

/**
 * Una jornada con datos reales aislados y ningún envío externo: una cita de
 * quien inicia sesión y otra de otro profesional, una tarea, algo por cobrar
 * anotado hoy y un caso que el agente pasó al equipo.
 */
async function activeDay(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const patientId = randomUUID()
  const otherPatientId = randomUUID()
  const otherDentist = randomUUID()
  const chairId = randomUUID()
  const contactId = randomUUID()
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  await db.insert(user).values({ id: otherDentist, name: "Dra. Otra Profesional", email: `${otherDentist}@inicio.test`, emailVerified: true })
  // La identidad vive en la persona (ADR 0044): cada ficha apunta a la suya.
  const [withAppointment, ofOther] = await db
    .insert(contact)
    .values([
      { organizationId, displayName: "Paciente con cita" },
      { organizationId, displayName: "Paciente de otra profesional" },
    ])
    .returning({ id: contact.id })
  await db.insert(patient).values([
    { id: patientId, organizationId, personId: withAppointment!.id, patientNumber: 1 },
    { id: otherPatientId, organizationId, personId: ofOther!.id, patientNumber: 2 },
  ])
  await db.insert(scheduleChair).values({ id: chairId, organizationId, branchId: owner.branchId, name: "Unidad dental de prueba" })
  await db.insert(appointment).values([
    // La de quien inicia sesión es la última del día: la agenda de la sede lista desde la siguiente
    // cita en pie, así que esa fila está a la vista a cualquier hora en que corra la prueba.
    { organizationId, branchId: owner.branchId, patientId: otherPatientId, chairId, dentistUserId: otherDentist, serviceName: "Control", status: "confirmada",
      startsAt: new Date(`${date}T18:00:00-05:00`), endsAt: new Date(`${date}T18:30:00-05:00`), durationMin: 30 },
    { organizationId, branchId: owner.branchId, patientId, chairId, dentistUserId: owner.user.id, serviceName: "Profilaxis",
      startsAt: new Date(`${date}T19:00:00-05:00`), endsAt: new Date(`${date}T19:30:00-05:00`), durationMin: 30 },
  ])
  await db.insert(crmTask).values({ organizationId, title: "Confirmar seguimiento pendiente", assigneeUserId: owner.user.id, createdBy: "user" })
  await db.insert(patientCharge).values({ organizationId, patientId, description: "Cuenta pendiente", amountCents: 12000, currency: "PEN" })
  await db.insert(contact).values({ id: contactId, organizationId, displayName: "Interlocutor pendiente" })
  // Lo que espera a una persona del agente es un caso derivado: ninguna propuesta espera al equipo (ADR 0023).
  await db.insert(agentHandoff).values({ organizationId, contactId, reason: "Pide hablar con una persona", summary: "Prefiere atención humana.", priority: "alta" })
}

const setRole = (db: Db, owner: OwnerFixture, role: string) =>
  db.update(member).set({ role }).where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))

for (const width of [1440, 390]) {
  test.describe(`Inicio a ${width}px`, () => {
    test("clínica nueva: «Prepara tu primera atención» y nada más", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      // Inicio ya no pide los datos del pulso ni los resultados operativos.
      const retired: string[] = []
      page.on("request", request => {
        if (/\/api\/(workspace\/pulse|crm\/performance|reports\/management)/.test(request.url())) retired.push(request.url())
      })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const start = page.getByRole("region", { name: "Siguiente paso" })
      await expect(start.getByRole("heading", { name: "Prepara tu primera atención", exact: true })).toBeVisible()
      const primary = start.getByRole("link", { name: "Definir horarios", exact: true })
      await expect(primary).toBeInViewport()
      // Quien puede encenderlos ve también encender Recepción y el Administrador (fase 2.1, decisión 3).
      await expect(start.getByRole("list", { name: "Puesta en marcha" }).getByRole("listitem")).toHaveCount(4)
      await expect(start).toContainText("Encender a Sofi y a Argos")
      await expect(page.getByRole("region", { name: "Te espera" })).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Agenda de hoy", exact: true })).toHaveCount(0)
      expect(retired).toEqual([])
      await observe(page, info, "nueva")
      await primary.focus()
      await primary.press("Enter")
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/availability"))
    })

    test("al terminar la puesta en marcha queda «Nada te espera por ahora», sin advertencias", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await prepareSchedule(owner)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const start = page.getByRole("region", { name: "Siguiente paso" })
      await expect(start.getByRole("link", { name: "Preparar una unidad dental", exact: true })).toBeInViewport()
      await observe(page, info, "parcial")
      await call(page, "POST", "/api/agenda/chairs", owner.org.slug, { branchId: owner.branchId, name: "Unidad dental inicial" }, 201)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(start.getByRole("link", { name: "Registrar un paciente", exact: true })).toBeInViewport()
      await call(page, "POST", "/api/patients", owner.org.slug, {
        submissionId: randomUUID(), answers: { demographics: { displayName: "Primera paciente", docType: "DNI", docNumber: "76543210" }, respondent: "staff", privacyAccepted: false },
      }, 201)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      // Sin Recepción ni el Administrador no sale ningún recordatorio: es el último paso.
      await expect(start.getByRole("link", { name: "Encender a Sofi y a Argos", exact: true })).toBeInViewport()
      await call(page, "PUT", "/api/agent/config", owner.org.slug, { enabled: true })
      await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      // Con los pasos hechos, Inicio pasa a sus dos bloques: una línea y la agenda a la vista.
      await expect(start).toHaveCount(0)
      const waiting = page.getByRole("region", { name: "Te espera" })
      await expect(waiting.getByText("Nada te espera por ahora", { exact: true })).toBeVisible()
      const agenda = page.getByRole("region", { name: "Agenda de hoy" })
      await expect(agenda).toContainText("Hoy no hay citas en")
      await expect(page.getByText(/No acredita|los ceros no indican|Sin actividad todavía|Sin pendientes en este resumen/)).toHaveCount(0)
      const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
      expect(home.setup).toEqual({ availability: true, chairs: true, patients: true, agent: true })
      expect(home.waiting).toEqual([])
      expect(home.today?.summary).toEqual({ total: 0, waiting: 0, attending: 0, attended: 0, upcoming: 0, unconfirmed: 0 })
      await observe(page, info, "configurada-sin-pendientes")
      await agenda.getByRole("button", { name: "Abrir la Agenda", exact: true }).click()
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/agenda"))
    })

    test("quien dirige y atiende: una lista «Te espera», sus pacientes, la agenda de la sede y la caja en una línea", async ({ owner, fixtureDb }, info) => {
      await activeDay(fixtureDb, owner)
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const waiting = page.getByRole("region", { name: "Te espera" })
      // El título dice cuántos asuntos esperan, también al lector de pantalla.
      await expect(waiting.getByRole("heading", { name: "Te espera 2 asuntos", exact: true })).toBeInViewport()
      await expect(page.getByRole("region", { name: "Siguiente paso" })).toHaveCount(0)
      // El caso «Ahora» va antes que la tarea: el orden lo entrega el servidor. Nada espera tu aprobación.
      const rows = waiting.getByRole("listitem")
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText("Interlocutor pendiente · Pide hablar con una persona")
      await expect(rows.nth(0)).toContainText("Te lo pasó Sofi")
      await expect(rows.nth(0).getByRole("link", { name: /Revisar$/ })).toBeVisible()
      await expect(waiting).not.toContainText("espera tu aprobación")
      await expect(rows.nth(1)).toContainText("Confirmar seguimiento pendiente")
      await expect(rows.nth(1)).toContainText("Sin fecha")
      // La tarea se marca hecha desde la propia fila.
      await expect(rows.nth(1).getByRole("button", { name: /^Hecha/ })).toBeVisible()

      // Hoy atiende: «Mis pacientes de hoy», también siendo la dueña (tablero 7); su cita va en «Más tarde».
      const mine = page.getByRole("region", { name: "Mis pacientes de hoy" })
      await expect(mine.getByRole("list", { name: "Más tarde" })).toContainText("Paciente con cita")
      await expect(mine).not.toContainText("Paciente de otra profesional")
      await expect(page.getByRole("region", { name: "Agenda de hoy" })).toHaveCount(0)
      // La agenda de la sede, en una línea con su resumen, igual al de la Agenda de ese día.
      const agendaLine = page.getByRole("link", { name: /^Agenda de / })
      await expect(agendaLine).toContainText("2 citas · 0 en sala · 0 atendidas · 2 por venir")
      // La caja del día, en una línea que lleva a Finanzas.
      const cash = page.getByRole("link", { name: /^Caja de hoy/ })
      await expect(cash).toContainText("1 persona por cobrar")

      // Lo que se retiró no vuelve con otro nombre.
      for (const name of ["Pendiente de ti", "Para atender hoy", "El agente hoy", "Pulso"]) {
        await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0)
      }
      for (const name of ["Cobranza pendiente", "Presupuestos por seguir"]) {
        await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0)
      }
      await expect(page.getByRole("link", { name: /^(Citas de hoy|Tareas abiertas|Cuentas con saldo)/ })).toHaveCount(0)

      const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
      expect(home.waiting.map(row => row.kind)).toEqual(["case", "task"])
      expect(home.today).toMatchObject({ scope: "mine", summary: { total: 1, attended: 0, upcoming: 1, unconfirmed: 1 } })
      expect(home.agendaLine).toMatchObject({ branch: { id: owner.branchId }, summary: { total: 2, waiting: 0, attended: 0, upcoming: 2, unconfirmed: 1 } })
      expect(home.cash?.toCollect.map(row => row.displayName)).toEqual(["Paciente con cita"])
      // Una sede que no existe no rompe Inicio ni mezcla sedes: vale la primera activa.
      const fallback = await call<WorkspaceHome>(page, "GET", `/api/workspace/home?branch=${randomUUID()}`, owner.org.slug)
      expect(fallback.agendaLine?.branch.id).toBe(owner.branchId)
      expect((await api(page, "GET", "/api/workspace/home?branch=no-es-una-sede", owner.org.slug)).status).toBe(400)

      const task = rows.nth(1).getByRole("link", { name: /Confirmar seguimiento pendiente/ })
      expect((await task.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
      await observe(page, info, "direccion")
      // Toda la fila es el enlace, también con teclado.
      await task.focus()
      await task.press("Enter")
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/tasks"))
    })

    test("odontólogo: solo sus pacientes de hoy, y cada fila abre la ficha", async ({ owner, fixtureDb }, info) => {
      await activeDay(fixtureDb, owner)
      await setRole(fixtureDb, owner, "dentist")
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
      // El servidor no entrega citas de otro profesional, caja ni lo que decide recepción.
      expect(home.today).toMatchObject({ scope: "mine", summary: { total: 1, attended: 0, upcoming: 1, unconfirmed: 1 } })
      expect(home.today?.appointments.map(row => row.patientName)).toEqual(["Paciente con cita"])
      expect(home.cash).toBeNull()
      expect(home.waiting.some(row => row.kind === "case")).toBe(false)

      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const mine = page.getByRole("region", { name: "Mis pacientes de hoy" })
      await expect(mine).toContainText("1 paciente · 0 atendidos · 1 por venir")
      await expect(mine).not.toContainText("Paciente de otra profesional")
      await expect(page.getByRole("region", { name: "Agenda de hoy" })).toHaveCount(0)
      await expect(page.getByRole("link", { name: /^Caja de hoy/ })).toHaveCount(0)
      await observe(page, info, "odontologo")
      await mine.getByRole("link", { name: /Paciente con cita/ }).click()
      // La ficha lleva a la página de su persona (ADR 0029).
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/people/"))
    })

    test("recepción marca «Llegó» en Inicio y quien atiende la ve en su sala de espera", async ({ owner, fixtureDb }, info) => {
      await activeDay(fixtureDb, owner)
      await setRole(fixtureDb, owner, "reception")
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const agenda = page.getByRole("region", { name: "Agenda de hoy" })
      // Cada fila abre la cita y lleva su paso al lado: «Llegó».
      await agenda.getByRole("button", { name: "Llegó: Paciente con cita" }).click()
      await expect(agenda.getByRole("button", { name: "Deshacer: Paciente con cita" })).toBeVisible()
      await expect(agenda).toContainText("1 en sala")
      await expect(agenda.getByRole("link", { name: /Paciente con cita.*Llegó \d/ })).toBeVisible()
      await observe(page, info, "recepcion-llego")
      // Quien atiende la ve en «Sala de espera», con «Atender» en su botón.
      await setRole(fixtureDb, owner, "dentist")
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const sala = page.getByRole("region", { name: "Mis pacientes de hoy" }).getByRole("list", { name: "Sala de espera" })
      await expect(sala).toContainText("Paciente con cita")
      await expect(sala).toContainText(/espera \d+ min/)
      await expect(sala.getByRole("button", { name: "Atender: Paciente con cita" })).toBeVisible()
      await observe(page, info, "sala-de-espera")
      // «No vino» ya no procede: la persona está en la clínica.
      const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
      const waiting = home.today?.appointments.find(row => row.patientName === "Paciente con cita")
      expect(waiting).toMatchObject({ visit: "llego" })
      const noShow = await api(page, "POST", `/api/appointments/${waiting?.id}/status`, owner.org.slug, { status: "no_asistio" })
      expect(noShow.status).toBe(409)
    })

    test("caja: «Por cobrar» con la persona atendida hoy y «Cobrar» abre el cobro", async ({ owner, fixtureDb }, info) => {
      await activeDay(fixtureDb, owner)
      await setRole(fixtureDb, owner, "cashier")
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
      expect(home.today).toBeNull()
      expect(home.cash).toMatchObject({ branchId: owner.branchId, collectedCents: 0, tickets: 0 })
      // La misma lista que Finanzas › Caja marca como de hoy.
      const debts = await call<Array<{ patientId: string; attendedTodayAt: string | null }>>(page, "GET", `/api/finance/debts?branchId=${owner.branchId}`, owner.org.slug)
      expect(home.cash?.toCollect.map(row => row.patientId)).toEqual(debts.filter(row => row.attendedTodayAt).map(row => row.patientId))

      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const cash = page.getByRole("region", { name: "Caja de hoy" })
      await expect(cash).toContainText("en 0 cobros")
      await expect(cash).toContainText("Por cobrar · 1 persona")
      await expect(page.getByRole("region", { name: "Agenda de hoy" })).toHaveCount(0)
      await observe(page, info, "caja")
      await cash.getByRole("button", { name: /Paciente con cita.*Cobrar$/ }).click()
      await expect(page.getByRole("heading", { name: /Cobrar/ }).first()).toBeVisible()
    })

    test("sin pendientes lo dice en una línea y la agenda sigue a la vista", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      const task = await call<{ id: string }>(page, "POST", "/api/tasks", owner.org.slug, { title: "Revisar caso", assigneeUserId: owner.user.id }, 201)
      await call(page, "PATCH", `/api/tasks/${task.id}`, owner.org.slug, { status: "done" })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const waiting = page.getByRole("region", { name: "Te espera" })
      await expect(waiting.getByText("Nada te espera por ahora", { exact: true })).toBeInViewport()
      await expect(waiting.getByRole("listitem")).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Agenda de hoy", exact: true })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Todo atendido en este resumen", exact: true })).toHaveCount(0)
      await observe(page, info, "nada-espera")
      await call(page, "PATCH", `/api/tasks/${task.id}`, owner.org.slug, { status: "open" })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(waiting.getByRole("link", { name: /Revisar caso/ })).toBeVisible()
      await expect(waiting.getByText("Nada te espera por ahora", { exact: true })).toHaveCount(0)
    })

    test("error recuperable no se confunde con una clínica vacía", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      let failing = true
      await page.route("**/api/workspace/home*", async route => {
        if (!failing || route.request().method() !== "GET") return route.continue()
        await route.fulfill({ status: 503, contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin, "access-control-allow-credentials": "true" }, body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Fallo controlado" } }) })
      })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const alert = page.getByRole("alert").filter({ hasText: "No pudimos cargar tu jornada" })
      const retry = alert.getByRole("button", { name: "Reintentar" })
      await expect(retry).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole("region", { name: "Siguiente paso" })).toHaveCount(0)
      await expect(page.getByRole("region", { name: "Te espera" })).toHaveCount(0)
      await observe(page, info, "error-recuperable")
      failing = false
      await retry.click()
      await expect(page.getByRole("region", { name: "Siguiente paso" }).getByRole("link", { name: "Definir horarios", exact: true })).toBeInViewport()
    })

    for (const role of ["reception", "dentist", "cashier"] as const) {
      test(`${role}: su «Hoy» y nada de configuración ajena`, async ({ owner, fixtureDb }, info) => {
        await setRole(fixtureDb, owner, role)
        const page = owner.page
        await page.setViewportSize({ width, height: 844 })
        await gotoHydrated(page, tenant(owner.org.slug, "/home"))
        // Sin permiso para configurar no hay puesta en marcha: se dice que nada espera.
        await expect(page.getByRole("region", { name: "Siguiente paso" })).toHaveCount(0)
        await expect(page.getByRole("link", { name: "Definir horarios", exact: true })).toHaveCount(0)
        await expect(page.getByRole("region", { name: "Te espera" }).getByText("Nada te espera por ahora", { exact: true })).toBeVisible()
        const block = role === "reception" ? "Agenda de hoy" : role === "dentist" ? "Mis pacientes de hoy" : "Caja de hoy"
        const action = role === "reception" ? "Abrir la Agenda" : role === "dentist" ? "Ver mi agenda" : "Ir a Caja"
        for (const name of ["Agenda de hoy", "Mis pacientes de hoy", "Caja de hoy"]) {
          await expect(page.getByRole("region", { name, exact: true })).toHaveCount(name === block ? 1 : 0)
        }
        const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
        expect(home.setup).toBeNull()
        expect(home.access.configure).toBe(false)
        expect(home.access.finance).toBe(role === "cashier")
        expect(home.access.clinical).toBe(role === "dentist")
        expect(home.today?.scope ?? null).toBe(role === "reception" ? "branch" : role === "dentist" ? "mine" : null)
        expect(home.cash === null).toBe(role !== "cashier")
        const forbidden = await api(page, "PUT", "/api/agenda/schedules", owner.org.slug, { branchId: owner.branchId, dentistUserId: owner.user.id, rules: [] })
        expect(forbidden.status).toBe(403)
        await observe(page, info, role)
        await page.getByRole("region", { name: block, exact: true }).getByRole("button", { name: action, exact: true }).click()
        await expect(page).toHaveURL(tenantPattern(owner.org.slug, role === "cashier" ? "/finance" : "/agenda"))
      })
    }
  })
}
