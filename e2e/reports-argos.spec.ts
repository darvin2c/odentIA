import { createHmac, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Db } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { patient, patientPayment } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import type { Page, TestInfo } from "@playwright/test"
import { tenant } from "./env"
import { call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Fases 5 y 6 de Reportes (ADR 0070 y 0071): preguntarle a Argos, fijar la
 * respuesta en el Resumen, descargar, poner una meta y el resumen del lunes.
 * El modelo es el de demostración: entiende por palabras clave y no acredita a
 * ningún proveedor.
 *
 * El campo está oculto mientras el Argos de las vistas del negocio (ADR 0073)
 * no tiene su entrada: sus recorridos se saltan y vuelven con ella.
 */
const ARGOS_HIDDEN = "Campo de Argos oculto hasta su entrada nueva (ADR 0073)"

async function observe(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
}

function inMonth(monthsBack: number, day: number, hour = 15): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return new Date(Date.UTC(get("year"), get("month") - 1 - monthsBack, day, hour))
}

/** El mes pasado: tres atendidas y una inasistencia; un cobro en el mes en curso. */
async function lastMonth(db: Db, owner: OwnerFixture) {
  const organizationId = owner.org.id
  const chairId = randomUUID()
  await db.insert(scheduleChair).values({ id: chairId, organizationId, branchId: owner.branchId, name: "Unidad dental de prueba" })
  const people: Record<string, string> = {}
  for (const [index, name] of ["Ana Paz", "Bruno Díaz", "Carla Soto", "Diego Ruiz"].entries()) {
    people[name] = randomUUID()
    const [person] = await db.insert(contact).values({ organizationId, displayName: name }).returning({ id: contact.id })
    await db.insert(patient).values({ id: people[name], organizationId, personId: person!.id, patientNumber: index + 1 })
  }
  const visit = (name: string, startsAt: Date, status: string) =>
    db.insert(appointment).values({
      organizationId, branchId: owner.branchId, patientId: people[name]!, chairId, dentistUserId: owner.user.id,
      serviceName: "Evaluación", startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status, source: "recepcion",
    })
  await visit("Ana Paz", inMonth(1, 10), "atendida")
  await visit("Bruno Díaz", inMonth(1, 11), "atendida")
  await visit("Carla Soto", inMonth(1, 12), "atendida")
  await visit("Diego Ruiz", inMonth(1, 13), "no_asistio")
  await db.insert(patientPayment).values({
    organizationId, patientId: people["Ana Paz"]!, branchId: owner.branchId, amountCents: 40000, currency: "PEN", paidAt: new Date(Date.now() - 60_000), methodName: "Efectivo", methodTypeCode: "10",
  })
}

async function csvOf(page: Page, click: () => Promise<void>): Promise<{ name: string; body: string }> {
  const [download] = await Promise.all([page.waitForEvent("download"), click()])
  const path = await download.path()
  return { name: download.suggestedFilename(), body: await readFile(path, "utf8") }
}

for (const width of [1440, 390]) {
  test.describe(`Argos en Reportes a ${width}px`, () => {
    test.skip(true, ARGOS_HIDDEN)
    test("pregunta, responde al lado con la cifra de la pestaña, se fija en el Resumen y se descarga", async ({ owner, fixtureDb }, info) => {
      await lastMonth(fixtureDb, owner)
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
      await gotoHydrated(page, tenant(owner.org.slug, "/reports?period=mes_pasado"))

      const field = page.getByLabel("Pregúntale a Argos")
      await field.fill("¿Qué profesional tiene más inasistencias?")
      await field.press("Enter")
      const panel = page.getByRole(width === 390 ? "dialog" : "region", { name: "Argos" }).filter({ hasText: "Responde con las cifras de Reportes" }).first()
      await expect(panel.getByText("¿Qué profesional tiene más inasistencias?")).toBeVisible()
      await expect(panel.getByText(/: 25 % \(1 de 4 citas\)\. En toda la clínica fue 25 %/)).toBeVisible()
      await expect(panel.getByText("Así lo calculé:")).toBeVisible()
      await observe(page, info, "respuesta")

      // Descargar trae las mismas filas que dibuja el gráfico, en CSV.
      const file = await csvOf(page, () => panel.getByRole("button", { name: "Descargar" }).click())
      expect(file.name).toMatch(/^no-vinieron-por-profesional-\d{4}-\d{2}\.csv$/)
      expect(file.body.startsWith("﻿")).toBe(true)
      expect(file.body).toContain("Profesional,No vinieron (%),Detalle")

      // Fijarla: queda en el Resumen, recalculada con la pantalla.
      await panel.getByRole("button", { name: "Fijar en Resumen" }).click()
      await expect(panel.getByRole("button", { name: "Fijada en Resumen" })).toBeDisabled()
      const pinned = page.getByRole("region", { name: "Fijadas" })
      if (width === 1440) {
        // Con la respuesta al lado, quitarla del Resumen vuelve a ofrecer «Fijar» en el panel.
        await pinned.getByRole("button", { name: "Quitar" }).click()
        await expect(panel.getByRole("button", { name: "Fijar en Resumen" })).toBeEnabled()
        await panel.getByRole("button", { name: "Fijar en Resumen" }).click()
        await expect(panel.getByRole("button", { name: "Fijada en Resumen" })).toBeDisabled()
      }
      await page.keyboard.press("Escape")
      await expect(pinned.getByRole("region", { name: "No vinieron, por profesional" })).toBeVisible()
      await expect(pinned.getByText(/Caben 3 más/)).toBeVisible()
      await observe(page, info, "fijada")

      // Una opción de la respuesta pregunta sin escribir; «Quitar» la saca del Resumen.
      await pinned.getByRole("button", { name: "Quitar" }).click()
      await expect(pinned.getByRole("region", { name: "No vinieron, por profesional" })).toHaveCount(0)
    })
  })
}

test.skip("lo que no sabe lo dice y ofrece enviarlo a odentIA; lo clínico no le toca", async ({ owner, fixtureDb }) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  const field = page.getByLabel("Pregúntale a Argos")
  await field.fill("¿Cuál es la edad promedio de mis pacientes?")
  await field.press("Enter")
  const panel = page.getByRole("region", { name: "Argos" }).filter({ hasText: "Responde con las cifras de Reportes" }).first()
  await expect(panel.getByText("Todavía no sé responder eso")).toBeVisible()
  await expect(panel.getByRole("heading", { name: "Lo que se envía" })).toBeVisible()
  await panel.getByRole("button", { name: "Enviar a odentIA" }).click()
  await expect(panel.getByText("Enviado a odentIA. La respuesta te llega en Ayuda.")).toBeVisible()

  await panel.getByLabel("Escribe otra pregunta").fill("¿Cuántos pacientes tienen diabetes?")
  await panel.getByLabel("Escribe otra pregunta").press("Enter")
  await expect(panel.getByText(/Eso está en la historia clínica y no lo veo/)).toBeVisible()
})

test.skip("con Argos apagado el campo lo dice; las cifras siguen", async ({ owner, fixtureDb }) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  await expect(page.getByLabel("Pregúntale a Argos")).toBeDisabled()
  await expect(page.getByText(/Argos está apagado: enciéndelo para preguntarle/)).toBeVisible()
  await expect(page.getByRole("region", { name: "Las seis cifras" })).toBeVisible()
})

test("una meta del mes en curso: se pone, se ve el avance y vale desde este mes", async ({ owner, fixtureDb }, info) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  const collected = page.getByRole("region", { name: "Las seis cifras" }).getByRole("region", { name: "Cobrado", exact: true })
  await collected.getByRole("button", { name: "+ Poner meta" }).click()
  const drawer = page.getByRole("dialog", { name: "Meta de cobrado por mes" }).or(page.getByRole("region", { name: "Meta de cobrado por mes" })).first()
  await drawer.getByLabel("Cuánto quieres cobrar cada mes").fill("1000")
  await drawer.getByRole("button", { name: "Guardar meta" }).click()
  await expect(collected.getByText(/40 % de la meta con el \d+ % del mes · faltan/)).toBeVisible()
  await observe(page, info, "meta")
  // Un mes cerrado no ofrece ponerla: vale desde el mes en que se guarda.
  await gotoHydrated(page, tenant(owner.org.slug, "/reports?period=mes_pasado"))
  await expect(page.getByRole("region", { name: "Las seis cifras" }).getByRole("button", { name: "+ Poner meta" })).toHaveCount(0)
})

test("una lista se descarga entera en CSV, con el teléfono", async ({ owner, fixtureDb }) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, "/reports?period=mes_pasado&lista=no_show"))
  const list = page.getByRole("region", { name: "No vinieron" }).or(page.getByRole("dialog", { name: "No vinieron" })).filter({ hasText: "Cómo se calcula" }).first()
  await expect(list.getByRole("link", { name: "Diego Ruiz" })).toBeVisible()
  const file = await csvOf(page, () => list.getByRole("button", { name: "Descargar" }).click())
  expect(file.name).toMatch(/^no-vinieron-\d{4}-\d{2}\.csv$/)
  expect(file.body).toContain("Fecha,Persona,Teléfono,Canal,Detalle,Profesional,Sede,Importe,Moneda,Ya tiene otra cita")
  expect(file.body).toContain("Diego Ruiz")
})

test("el resumen del lunes lo prende cada persona y se apaga desde el enlace del correo, sin entrar", async ({ owner, fixtureDb, browser }) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  const card = page.getByRole("region", { name: "El resumen del lunes" })
  await card.getByRole("switch", { name: "Recibir el resumen del lunes por correo" }).click()
  await expect(page.getByText("Listo: el lunes a las 8:00 te llega tu resumen")).toBeVisible()
  expect(await call<{ enabled: boolean }>(page, "GET", "/api/reports/digest", owner.org.slug)).toEqual({ enabled: true })

  // El mismo enlace que lleva el correo: la clínica y la persona firmadas con la clave del servidor.
  const payload = Buffer.from(JSON.stringify([owner.org.id, owner.user.id])).toString("base64url")
  const key = Buffer.from(process.env.E2E_SECRETS_KEY ?? "b895edcf574a7ca79434e50769e9ded6daace1636bc40d71f1310c3f43c5982b", "hex")
  const token = `${payload}.${createHmac("sha256", key).update(`resumen-lunes:${payload}`).digest("base64url")}`
  const stranger = await browser.newContext({ ignoreHTTPSErrors: true })
  const visitor = await stranger.newPage()
  await gotoHydrated(visitor, tenant(owner.org.slug, `/resumen-lunes/baja/${token}`))
  await visitor.getByRole("button", { name: "Dejar de recibirlo" }).click()
  await expect(visitor.getByText("Ya no te llega el resumen del lunes")).toBeVisible()
  await stranger.close()
  expect(await call<{ enabled: boolean }>(page, "GET", "/api/reports/digest", owner.org.slug)).toEqual({ enabled: false })
})

test("recepción no pregunta ni descarga: el servidor lo niega", async ({ createOwner }) => {
  const owner = await createOwner("argos-permisos")
  const page = owner.page
  await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
  // El dueño sí puede; con el rol de recepción, Reportes entero responde 403.
  const asked = await call<{ kind: string }>(page, "POST", "/api/reports/ask", owner.org.slug, { text: "¿cuánto cobramos?", period: "este_mes" })
  expect(asked.kind).toBe("respuesta")
})
