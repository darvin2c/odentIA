import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { agentProposal } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import { patient, patientCharge } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, crmTask } from "@odentia/db/schema/crm"
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

/** Datos operativos reales aislados; ningún envío ni ejecución externa. */
async function activeDay(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const patientId = randomUUID()
  const chairId = randomUUID()
  const contactId = randomUUID()
  const channelId = randomUUID()
  const conversationId = randomUUID()
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  await db.insert(patient).values({ id: patientId, organizationId, displayName: "Paciente con cita", patientNumber: 1 })
  await db.insert(scheduleChair).values({ id: chairId, organizationId, branchId: owner.branchId, name: "Sillón de prueba" })
  await db.insert(appointment).values({ organizationId, branchId: owner.branchId, patientId, chairId,
    dentistUserId: owner.user.id, startsAt: new Date(`${date}T18:00:00-05:00`), endsAt: new Date(`${date}T18:30:00-05:00`), durationMin: 30 })
  await db.insert(crmTask).values({ organizationId, title: "Confirmar seguimiento pendiente", assigneeUserId: owner.user.id, createdBy: "user" })
  await db.insert(patientCharge).values({ organizationId, patientId, description: "Cuenta pendiente", amountCents: 12000, currency: "PEN" })
  await db.insert(contact).values({ id: contactId, organizationId, displayName: "Interlocutor pendiente" })
  await db.insert(channelConnection).values({ id: channelId, organizationId, channel: "whatsapp", provider: "prueba", displayName: "Canal controlado", configEncrypted: "no-se-usa", webhookSecret: "no-se-usa" })
  await db.insert(conversation).values({ id: conversationId, organizationId, contactId, channelConnectionId: channelId, externalThreadId: randomUUID(), unreadCount: 1, agentStatus: "off" })
  await db.insert(agentProposal).values({ organizationId, contactId, conversationId, action: "enviar_mensaje", payload: { text: "Confirmación pendiente" }, afterSummary: "Revisar respuesta antes de enviar", idempotencyKey: randomUUID() })
}

for (const width of [1440, 390]) {
  test.describe(`Inicio a ${width}px`, () => {
    test("organización nueva: acción principal y puesta en marcha progresiva", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      const pulseLoaded = page.waitForResponse(response => response.url().endsWith("/api/workspace/pulse") && response.ok())
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const start = page.getByRole("region", { name: "Siguiente paso" })
      const primary = start.getByRole("link", { name: "Definir horarios", exact: true })
      await expect(primary).toBeInViewport()
      await expect(start.getByRole("list", { name: "Puesta en marcha" }).getByRole("listitem")).toHaveCount(3)
      await expect(page.getByRole("region", { name: "Pendiente de ti" })).toHaveCount(0)
      await expect(page.getByRole("region", { name: "El agente hoy" })).toHaveCount(0)
      await expect(page.getByRole("link", { name: /^Citas de hoy/ })).toHaveCount(0)
      await pulseLoaded
      await expect(page.getByRole("region", { name: "Pulso", exact: true })).toHaveCount(0)
      await observe(page, info, "nueva")
      await primary.focus()
      await primary.press("Enter")
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/availability"))
    })

    test("configuración parcial avanza hasta sin actividad, sin inventar éxito", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await prepareSchedule(owner)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const start = page.getByRole("region", { name: "Siguiente paso" })
      await expect(start.getByRole("link", { name: "Preparar un sillón", exact: true })).toBeInViewport()
      await observe(page, info, "parcial")
      await call(page, "POST", "/api/agenda/chairs", owner.org.slug, { branchId: owner.branchId, name: "Sillón inicial" }, 201)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(start.getByRole("link", { name: "Registrar un paciente", exact: true })).toBeInViewport()
      await call(page, "POST", "/api/patients", owner.org.slug, {
        submissionId: randomUUID(), answers: { demographics: { displayName: "Primera paciente", docType: "DNI", docNumber: "76543210" }, respondent: "staff", privacyAccepted: false },
      }, 201)
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(start.getByRole("link", { name: "Abrir agenda", exact: true })).toBeInViewport()
      await expect(start.getByRole("list", { name: "Puesta en marcha" })).toHaveCount(0)
      const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
      expect(home.setup).toEqual({ availability: true, chairs: true, patients: true })
      expect(home.activity).toEqual({ recorded: false, completedToday: false })
      await observe(page, info, "configurada-sin-actividad")
    })

    test("jornada activa conserva decisiones, agenda, conversaciones, tareas y cobranza", async ({ owner, fixtureDb }, info) => {
      await activeDay(fixtureDb, owner)
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(page.getByRole("region", { name: "Pendiente de ti" }).getByRole("heading", { name: /Pendiente de ti/ })).toBeInViewport()
      await expect(page.getByRole("region", { name: "Siguiente paso" })).toHaveCount(0)
      await expect(page.getByRole("heading", { name: "Agenda de hoy", exact: true })).toBeVisible()
      await expect(page.getByRole("link", { name: "Paciente con cita", exact: true })).toBeVisible()
      await expect(page.getByRole("link", { name: "Confirmar seguimiento pendiente", exact: true })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Cobranza pendiente", exact: true })).toBeVisible()
      await expect(page.getByRole("link", { name: /sin leer/ })).toBeVisible()
      await observe(page, info, "activa")
      const task = page.getByRole("link", { name: "Confirmar seguimiento pendiente", exact: true })
      await task.click()
      await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/tasks"))
    })

    test("sin actividad y todo atendido requieren evidencia distinta", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      const task = await call<{ id: string }>(page, "POST", "/api/tasks", owner.org.slug, { title: "Revisar caso", assigneeUserId: owner.user.id }, 201)
      await call(page, "PATCH", `/api/tasks/${task.id}`, owner.org.slug, { status: "done" })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(page.getByRole("heading", { name: "Todo atendido en este resumen", exact: true })).toBeInViewport()
      await expect(page.getByRole("list", { name: "Puesta en marcha" })).toHaveCount(0)
      await observe(page, info, "atendido")
      await call(page, "PATCH", `/api/tasks/${task.id}`, owner.org.slug, { status: "open" })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      await expect(page.getByRole("link", { name: "Revisar caso", exact: true })).toBeVisible()
      await expect(page.getByRole("heading", { name: "Todo atendido en este resumen", exact: true })).toHaveCount(0)
    })

    test("error recuperable no se confunde con organización vacía", async ({ owner }, info) => {
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      let failing = true
      await page.route("**/api/workspace/home", async route => {
        if (!failing || route.request().method() !== "GET") return route.continue()
        await route.fulfill({ status: 503, contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin, "access-control-allow-credentials": "true" }, body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "Fallo controlado" } }) })
      })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))
      const retry = page.getByRole("alert").getByRole("button", { name: "Volver a intentar" })
      await expect(retry).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole("region", { name: "Siguiente paso" })).toHaveCount(0)
      await observe(page, info, "error-recuperable")
      failing = false
      await retry.click()
      await expect(page.getByRole("region", { name: "Siguiente paso" }).getByRole("link", { name: "Definir horarios", exact: true })).toBeInViewport()
    })

    for (const role of ["reception", "dentist", "cashier"] as const) {
      test(`${role}: siguiente paso autorizado sin configuración ajena`, async ({ owner, fixtureDb }, info) => {
        await fixtureDb.update(member).set({ role }).where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))
        const page = owner.page
        await page.setViewportSize({ width, height: 844 })
        await gotoHydrated(page, tenant(owner.org.slug, "/home"))
        const start = page.getByRole("region", { name: "Siguiente paso" })
        const action = role === "reception" ? "Registrar un paciente" : role === "dentist" ? "Revisar agenda" : "Revisar cuentas"
        await expect(start.getByRole("link", { name: action, exact: true })).toBeInViewport()
        await expect(start.getByRole("list", { name: "Puesta en marcha" })).toHaveCount(0)
        await expect(page.getByRole("link", { name: "Definir horarios", exact: true })).toHaveCount(0)
        const home = await call<WorkspaceHome>(page, "GET", "/api/workspace/home", owner.org.slug)
        expect(home.setup).toBeNull()
        expect(home.access.configure).toBe(false)
        expect(home.access.finance).toBe(role === "cashier")
        expect(home.access.clinical).toBe(role === "dentist")
        const forbidden = await api(page, "PUT", "/api/agenda/schedules", owner.org.slug, { branchId: owner.branchId, dentistUserId: owner.user.id, rules: [] })
        expect(forbidden.status).toBe(403)
        await observe(page, info, role)
        await start.getByRole("link", { name: action, exact: true }).click()
        await expect(page).toHaveURL(tenantPattern(owner.org.slug, role === "reception" ? "/patients" : role === "dentist" ? "/agenda" : "/finance"))
      })
    }
  })
}
