import { member } from "@odentia/db/schema/auth"
import { helpAsk, helpRequest } from "@odentia/db/schema/workspace"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

const UNKNOWN = "¿Cómo exporto mis pacientes a Excel?"

test("ayuda: dónde está cada cosa, por qué no puedo, y lo que no sabe se envía a odentIA", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agenda"))
  await page.getByRole("button", { name: "Ayuda", exact: true }).click()
  const help = sideSurface(page, { name: "Ayuda", exact: true })
  await expect(help).toContainText("Estás en Agenda")
  await expect(help.getByRole("region", { name: "En esta pantalla suelen preguntar" }).getByRole("button", { name: "¿Cómo bloqueo un horario?" })).toBeVisible()

  const ask = async (question: string) => {
    await help.getByLabel("Tu pregunta").fill(question)
    await help.getByRole("button", { name: "Preguntar" }).click()
    await expect(help.getByRole("listitem").filter({ hasText: question }).last()).toBeVisible()
  }

  // --- Dónde está: responde con el nombre del sistema y lleva hasta ahí ---
  await ask("¿Dónde configuro los horarios?")
  const first = help.getByRole("listitem").filter({ hasText: "¿Dónde configuro los horarios?" })
  await expect(first).toContainText("En Configuración › Disponibilidad. Ahí defines, por profesional y sede, los días y las horas de atención.")
  await expect(first).toContainText("En qué se basó: El mapa del sistema: Configuración › Disponibilidad.")
  await first.getByRole("button", { name: "Sí" }).click()
  await expect(first).toContainText("Gracias. Lo anotamos.")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("ayuda-respuesta", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- Por qué no puedo: lo que falta de verdad en esta clínica, que aún no tiene sillones ni horarios ---
  await ask("¿Por qué no puedo reservar una cita?")
  const why = help.getByRole("listitem").filter({ hasText: "¿Por qué no puedo reservar una cita?" })
  await expect(why).toContainText("Esto es lo que falta ahora:")
  await expect(why).toContainText("No hay ningún sillón creado. Sin sillón no se puede reservar una cita.")
  await expect(why).toContainText("Ningún profesional tiene horario de atención.")

  // --- No sabe: lo dice, y la persona decide si lo envía a odentIA ---
  await ask(UNKNOWN)
  const unknown = help.getByRole("listitem").filter({ hasText: UNKNOWN })
  await expect(unknown).toContainText("Esto no está en la guía, y no quiero inventarlo.")
  expect(await call<unknown[]>(page, "GET", "/api/help/requests", org.slug)).toEqual([])
  await unknown.getByRole("button", { name: "Enviarlo a odentIA para que te respondan" }).click()
  await expect(unknown.getByLabel("Tu pregunta · puedes cambiarla")).toHaveValue(UNKNOWN)
  await expect(unknown).toContainText("No escribas nombres ni datos de pacientes.")
  await info.attach("ayuda-no-sabe", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await unknown.getByRole("button", { name: "Enviar a odentIA" }).click()
  await expect(unknown.getByRole("status")).toContainText("Enviado a odentIA.")
  const sent = await call<Array<{ question: string; status: string }>>(page, "GET", "/api/help/requests", org.slug)
  expect(sent).toEqual([expect.objectContaining({ question: UNKNOWN, status: "abierta" })])
  // La Ayuda no guarda lo que se le pregunta: solo la pantalla, el tema y si sirvió.
  const logged = await fixtureDb.select().from(helpAsk).where(eq(helpAsk.organizationId, org.id))
  expect(logged.map((row) => [row.screen, row.topicId, row.helpful])).toEqual([
    ["/agenda", "disponibilidad", true], ["/agenda", "agenda", null], ["/agenda", null, null],
  ])

  // «Llévame» abre la pantalla.
  await first.getByRole("link", { name: "Llévame a Configuración › Disponibilidad" }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/availability"))

  // --- odentIA responde el caso: el aviso llega al mismo botón ---
  await fixtureDb.update(helpRequest)
    .set({ status: "respondida", answer: "Todavía no se puede exportar a Excel. Lo anotamos para una próxima versión.", answeredAt: new Date() })
    .where(eq(helpRequest.organizationId, org.id))
  await gotoHydrated(page, tenant(org.slug, "/patients"))
  const button = page.getByRole("button", { name: "Ayuda, 1 respuesta nueva" })
  await button.click()
  const answered = help.getByRole("region", { name: "Respuestas de odentIA" })
  await expect(answered).toContainText(`odentIA respondió tu pregunta «${UNKNOWN}»`)
  await expect(answered).toContainText("Todavía no se puede exportar a Excel.")
  await answered.getByRole("button", { name: "Entendido" }).click()
  await expect(answered).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Ayuda", exact: true })).toBeVisible()

  // --- Teléfono: el mismo botón y la hoja de ayuda, sin desbordes ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agenda"))
  const mobileButton = page.getByRole("button", { name: "Ayuda", exact: true })
  expect((await mobileButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  await mobileButton.click()
  const sheet = page.getByRole("dialog", { name: "Ayuda" })
  await sheet.getByRole("button", { name: "¿Cómo bloqueo un horario?" }).click()
  await expect(sheet).toContainText("registra una ausencia del profesional")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("ayuda-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- Otro rol: la misma pregunta dice que no puede entrar ahí, y no ofrece llevarlo ---
  await fixtureDb.update(member).set({ role: "dentist" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  const reply = await call<{ answers: Array<{ path: string | null; restriction: string | null }> }>(page, "POST", "/api/help/ask", org.slug, {
    question: "¿Cómo invito a alguien a mi equipo?", screen: "/agenda",
  })
  expect(reply.answers[0]).toMatchObject({ path: null, restriction: expect.stringContaining("Tu rol (Odontólogo) no tiene acceso") })
  expect((await api(page, "POST", "/api/help/ask", org.slug, { question: "x", screen: "/agenda" })).status).toBe(400)
})
