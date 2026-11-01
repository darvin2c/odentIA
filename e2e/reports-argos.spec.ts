import { createHmac, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Db } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { patient, patientPayment } from "@odentia/db/schema/clinical"
import { member } from "@odentia/db/schema/auth"
import { contact } from "@odentia/db/schema/crm"
import type { Page, TestInfo } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test, type OwnerFixture } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Argos sobre los datos de la clínica (ADR 0075) desde el buscador y desde
 * Reportes, con el periodo de cada respuesta (tableros 7 a 12), y la fase 6 de
 * Reportes (ADR 0071): metas, descargas y el resumen del lunes. El modelo es el de demostración (`demoArgosPlan` y la fila por
 * palabras): sirve para ver el recorrido, no acredita a ningún proveedor.
 */

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
  const roomId = randomUUID()
  await db.insert(scheduleRoom).values({ id: roomId, organizationId, branchId: owner.branchId, name: "Unidad dental de prueba" })
  const people: Record<string, string> = {}
  for (const [index, name] of ["Ana Paz", "Bruno Díaz", "Carla Soto", "Diego Ruiz"].entries()) {
    people[name] = randomUUID()
    const [person] = await db.insert(contact).values({ organizationId, displayName: name }).returning({ id: contact.id })
    await db.insert(patient).values({ id: people[name], organizationId, personId: person!.id, patientNumber: index + 1 })
  }
  const visit = (name: string, startsAt: Date, status: string) =>
    db.insert(appointment).values({
      organizationId, branchId: owner.branchId, patientId: people[name]!, roomId, professionalUserId: owner.user.id,
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

const dialogOf = (page: Page) => page.getByRole("dialog", { name: "Buscar en todo" })
/** El panel de Argos: la columna si cabe, el cajón si no (en el teléfono, la hoja de abajo). */
const panelOf = (page: Page) =>
  page.getByRole("region", { name: "Argos" }).or(page.getByRole("dialog", { name: "Argos" })).filter({ hasText: "Responde con los datos de la clínica" }).first()
/** Las preguntas y respuestas del panel: la frase también la dice el aviso para el lector de pantalla. */
const answersOf = (page: Page) => panelOf(page).getByRole("list", { name: "Preguntas y respuestas" })

async function setRole(db: Db, owner: OwnerFixture, role: string) {
  await db.update(member).set({ role }).where(and(eq(member.organizationId, owner.org.id), eq(member.userId, owner.user.id)))
}

async function openSearch(page: Page, width: number, text: string) {
  // La raíz marca la página como hidratada antes de que el layout escuche el teclado: se insiste mientras no abre.
  const button = page.getByRole("button", { name: "Buscar en todo" })
  await expect(async () => {
    if (!(await dialogOf(page).isVisible())) {
      if (width < 768) await button.click()
      else await page.keyboard.press("Control+K")
    }
    await expect(dialogOf(page)).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
  await page.getByRole("combobox", { name: "Buscar en todo" }).fill(text)
}

for (const width of [1440, 390]) {
  test.describe(`Argos a ${width}px`, () => {
    test("desde el buscador: la fila de Argos, la respuesta al lado, seguir y cambiar el periodo sin preguntar otra vez, descargar y fijar", async ({ owner, fixtureDb }, info) => {
      await lastMonth(fixtureDb, owner)
      const page = owner.page
      await page.setViewportSize({ width, height: 844 })
      await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
      await gotoHydrated(page, tenant(owner.org.slug, "/home"))

      // Una pregunta de los datos: la fila de Argos sale primero y queda elegida (D1).
      await openSearch(page, width, "¿cuánto cobramos este mes?")
      const row = dialogOf(page).getByRole("option", { name: /Preguntarle a Argos: «¿cuánto cobramos este mes\?»/ })
      await expect(row).toHaveAttribute("aria-selected", "true")
      await observe(page, info, "buscador")
      await row.click()

      const panel = panelOf(page)
      const answers = answersOf(page)
      // El periodo lo dice odentIA: en la frase y en el botón de arriba, con las palabras de Reportes.
      // El primer día del mes, «este mes» es solo hoy.
      await expect(answers.getByText(/^(Hoy|(Del|El) .+) se cobró S\/\s?400\.00\.$/)).toBeVisible()
      await expect(answers.getByText("Así lo calculé:")).toBeVisible()
      // De dónde sale (D21): el modelo de demostración consulta por su cuenta.
      await expect(answers.getByText("Cálculo de Argos")).toBeVisible()
      const period = panel.getByRole("button", { name: /^Periodo: .+, hasta hoy\. Cambiar$/ })
      await expect(period).toBeVisible()
      await observe(page, info, "respuesta")

      // El botón para seguir ya viene corrido: cambia lo que se ve sin volver a preguntar.
      const follow = panel.getByRole("button", { name: "Por medio de pago" })
      await follow.click()
      await expect(follow).toHaveAttribute("aria-pressed", "true")
      await expect(answers.getByText(/^(Hoy|(Del|El) .+), por medio de pago: Efectivo \(S\/\s?400\.00\)\.$/)).toBeVisible()
      await expect(panel.getByRole("status")).toHaveText(/, por medio de pago: Efectivo/)

      // Otro periodo: la misma consulta con otras fechas, sin preguntar otra vez. El mes pasado no tuvo cobros.
      await period.click()
      await page.getByRole("button", { name: /^Mes pasado/ }).click()
      await expect(answers.getByText(/^En .+ no se cobró nada\.$/)).toBeVisible()
      await expect(follow).toHaveAttribute("aria-pressed", "true")
      const lastMonthButton = panel.getByRole("button", { name: /^Periodo: .+\. Cambiar$/ })
      await expect(lastMonthButton).not.toHaveAccessibleName(/hasta hoy/)
      await observe(page, info, "otro periodo")
      await lastMonthButton.click()
      await page.getByRole("button", { name: /^Este mes/ }).click()
      await expect(answers.getByText(/^(Hoy|(Del|El) .+), por medio de pago: Efectivo \(S\/\s?400\.00\)\.$/)).toBeVisible()

      // Descargar trae esa misma respuesta, en CSV.
      const file = await csvOf(page, () => panel.getByRole("button", { name: "Descargar" }).click())
      expect(file.name).toMatch(/^lo-cobrado-por-medio-de-pago-\d{4}-\d{2}-\d{2}\.csv$/)
      expect(file.body.startsWith("﻿")).toBe(true)
      expect(file.body).toContain("Medio,Cobrado")
      expect(file.body).toContain("Efectivo,400")

      // Fijarla: el Resumen la vuelve a calcular cada vez.
      await panel.getByRole("button", { name: "Fijar en Resumen" }).click()
      await expect(panel.getByRole("button", { name: "Fijada en Resumen" })).toBeDisabled()
      await page.keyboard.press("Escape")
      await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
      const pinned = page.getByRole("region", { name: "Fijadas" })
      await expect(pinned.getByText("Lo cobrado · Por medio de pago")).toBeVisible()
      await expect(pinned.getByText(/Efectivo \(S\/\s?400\.00\)/)).toBeVisible()
      // Sigue el periodo de arriba (D11) y lo dice.
      await expect(pinned.getByText(/, hasta hoy$/)).toBeVisible()
      await expect(pinned.getByText("Así lo calculé:")).toBeVisible()
      await observe(page, info, "fijada")
      await pinned.getByRole("button", { name: "Quitar" }).click()
      await expect(pinned.getByText("Lo cobrado · Por medio de pago")).toHaveCount(0)
    })
  })
}

test("la fila la decide la pregunta: lo de cómo se usa va primero a la Ayuda y un nombre deja primero los resultados", async ({ owner, fixtureDb }) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  // Con Argos apagado el buscador no lo ofrece: la fila se decide con él encendido.
  await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, "/home"))
  await openSearch(page, 1440, "dónde configuro los horarios")
  await expect(dialogOf(page).getByRole("option", { name: /Preguntarle a Ayuda/ })).toHaveAttribute("aria-selected", "true")
  await expect(dialogOf(page).getByRole("option", { name: /Preguntarle a Argos/ })).toBeVisible()

  await page.getByRole("combobox", { name: "Buscar en todo" }).fill("Ana Paz")
  await expect(dialogOf(page).getByRole("option", { name: /Ana Paz/ }).first()).toHaveAttribute("aria-selected", "true")
  await expect(dialogOf(page).getByRole("option", { name: /Preguntarle a Argos: «Ana Paz»/ })).toBeVisible()
})

test("desde Reportes: apagado lo dice; encendido pregunta con su periodo y responde al lado", async ({ owner, fixtureDb }, info) => {
  await lastMonth(fixtureDb, owner)
  const page = owner.page
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  await expect(page.getByLabel("Pregúntale a Argos")).toBeDisabled()
  await expect(page.getByText(/Argos está apagado: enciéndelo para preguntarle/)).toBeVisible()
  await expect(page.getByRole("region", { name: "Las seis cifras" })).toBeVisible()

  await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
  await gotoHydrated(page, tenant(owner.org.slug, "/reports"))
  await page.getByLabel("Pregúntale a Argos").fill("¿cuántas citas hay mañana?")
  await page.getByLabel("Pregúntale a Argos").press("Enter")
  const panel = panelOf(page)
  const answers = answersOf(page)
  await expect(answers.getByText(/^Mañana hay \d+ citas\.$/)).toBeVisible()
  // Las citas por venir son de hoy: no llevan periodo que cambiar (D12).
  await expect(answers.getByText(/^A hoy, /)).toBeVisible()
  // El periodo de Reportes sigue puesto para lo que se escriba en el panel, a la vista y con «Quitar».
  await expect(panel.getByText(/^Con lo de Reportes/)).toBeVisible()
  // Lo que no sabe lo dice, sin inventar una cifra.
  await panel.getByLabel("Escribe otra pregunta").fill("¿cuántos pacientes tienen diabetes?")
  await panel.getByLabel("Escribe otra pregunta").press("Enter")
  await expect(answers.getByText("Con el modelo de demostración solo respondo lo cobrado, las citas y los pacientes nuevos.")).toBeVisible()
  await observe(page, info, "reportes")
  await panel.getByRole("button", { name: "Quitar" }).click()
  await expect(panel.getByText(/^Con lo de Reportes/)).toHaveCount(0)
})

test("recepción no ve a Argos en el buscador y el servidor se lo niega", async ({ owner, fixtureDb }) => {
  const page = owner.page
  await call(page, "PUT", "/api/agent/admin/settings", owner.org.slug, { enabled: true })
  await setRole(fixtureDb, owner, "reception")
  await gotoHydrated(page, tenant(owner.org.slug, "/home"))
  await openSearch(page, 1440, "¿cuánto cobramos este mes?")
  await expect(dialogOf(page).getByRole("option", { name: /Preguntarle a Ayuda/ })).toBeVisible()
  await expect(dialogOf(page).getByRole("option", { name: /Argos/ })).toHaveCount(0)
  expect((await api(page, "POST", "/api/reports/argos", owner.org.slug, { text: "¿cuánto cobramos?" })).status).toBe(403)
  expect((await api(page, "POST", "/api/reports/argos/route", owner.org.slug, { text: "¿cuánto cobramos?" })).status).toBe(403)
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
  await expect(list.getByRole("button", { name: "Diego Ruiz" })).toBeVisible()
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
