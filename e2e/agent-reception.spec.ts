import { member } from "@odentia/db/schema/auth"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

const FAKE_REPLY = "Gracias por escribir. Te atiendo enseguida."

interface Overview {
  enabled: boolean
  level: string
  readiness: { channels: string[]; sandboxTurns: number }
}

interface Config {
  disabledFunctions: string[]
  functionNotes: Record<string, string>
  personaName: string | null
  activeFromMin: number | null
  activeUntilMin: number | null
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("agente: resumen, página de Recepción, probar y encender", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const overview = () => call<Overview>(page, "GET", "/api/agent/overview", org.slug)
  const config = () => call<Config>(page, "GET", "/api/agent/config", org.slug)

  // --- Resumen de una clínica que todavía no lo encendió ---
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(page.getByRole("heading", { level: 1, name: "Agente" })).toBeVisible()
  const agents = page.getByRole("region", { name: "Tus agentes" })
  const reception = agents.getByRole("listitem").filter({ hasText: "Recepción" })
  await expect(reception).toContainText("Apagado")
  // Ayuda viene con el sistema: no se enciende.
  await expect(agents.getByRole("listitem").filter({ hasText: "Ayuda a usar odentIA" })).toContainText("Siempre disponible")
  // El Asistente clínico y el Asesor ya existen y se encienden por separado.
  for (const name of ["Asistente clínico", "Asesor"]) {
    await expect(agents.getByRole("listitem").filter({ hasText: name })).toContainText("Apagado")
  }
  await expect(page.getByRole("region", { name: "Necesita de ti" }).getByRole("link", { name: /Preguntas básicas por responder/ })).toBeVisible()
  await expect(page.getByRole("region", { name: "Cómo le fue esta semana" })).toContainText("Está apagado")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-apagado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Encender sin canal: dice qué falta y a dónde ir; no deja encender ---
  await reception.getByRole("switch", { name: "Encender Recepción" }).click()
  const turnOn = sideSurface(page, { name: "Encender Recepción", exact: true })
  await expect(turnOn).toContainText("Sin un canal conectado no le llega ningún mensaje.")
  await expect(turnOn.getByRole("link", { name: "Conectar un canal" })).toBeVisible()
  await expect(turnOn.getByRole("button", { name: "Encender Recepción" })).toBeDisabled()
  await info.attach("encender-sin-canal", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await turnOn.getByRole("button", { name: "Ahora no" }).click()
  await expect(turnOn).toBeHidden()
  expect((await overview()).enabled).toBe(false)

  await call(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)

  // --- Página de Recepción ---
  await gotoHydrated(page, tenant(org.slug, "/agent/recepcion"))
  await expect(page.getByRole("heading", { level: 1, name: "Recepción" })).toBeVisible()
  const does = page.getByRole("region", { name: "Qué hace" })
  const reach = page.getByRole("region", { name: "Hasta dónde llega solo" })
  const behaves = page.getByRole("region", { name: "Cómo se comporta" })
  // Las dos funciones fijas se ven, sin interruptor.
  await expect(does.getByRole("listitem").filter({ hasText: "Ordenar el caso" })).toContainText("Siempre")
  await expect(does.getByRole("listitem").filter({ hasText: "Pasar a una persona" })).toContainText("Siempre")
  await expect(does.getByRole("switch")).toHaveCount(3)

  // Apagar una función: queda dicho qué hará cuando se la pidan.
  await does.getByRole("switch", { name: "Seguimiento comercial" }).click()
  await expect(does).toContainText("Apagada: no crea ni mueve oportunidades.")
  await expect.poll(async () => (await config()).disabledFunctions).toEqual(["seguimiento"])

  // Qué puede llenar sale de la misma declaración que usa la pantalla.
  const booking = does.getByRole("listitem").filter({ hasText: "Agendar, mover y cancelar citas" }).first()
  await booking.getByRole("button", { name: "Qué datos puede llenar" }).click()
  await expect(booking).toContainText("Reservar una cita:")
  await expect(booking).toContainText("Mover una cita:")

  // Indicación para una función.
  await booking.getByRole("button", { name: "Añadir una indicación" }).click()
  const noteForm = sideSurface(page, { name: "Indicación para «Agendar, mover y cancelar citas»", exact: true })
  await noteForm.getByLabel("Indicación", { exact: true }).fill("Ofrece primero las mañanas.")
  await noteForm.getByRole("button", { name: "Guardar" }).click()
  await expect(noteForm).toBeHidden()
  await expect(booking).toContainText("Tu indicación: Ofrece primero las mañanas.")

  // Niveles: bajar se aplica al momento; subir al máximo se confirma.
  await expect(reach.getByRole("button", { name: /^Equilibrado/ })).toHaveAttribute("aria-pressed", "true")
  await reach.getByRole("button", { name: /^Supervisado/ }).click()
  await expect(reach.getByRole("button", { name: /^Supervisado/ })).toHaveAttribute("aria-pressed", "true")
  await expect.poll(async () => (await overview()).level).toBe("supervisado")
  await reach.getByRole("button", { name: /^Autónomo/ }).click()
  const confirmLevel = page.getByRole("alertdialog", { name: "Pasar a Autónomo" })
  await expect(confirmLevel).toContainText("Solo para cancelar una cita pide el sí del paciente.")
  await confirmLevel.getByRole("button", { name: "Cancelar" }).click()
  await expect(confirmLevel).toBeHidden()
  expect((await overview()).level).toBe("supervisado")

  // Límites: horario en que responde.
  await reach.getByRole("button", { name: "Cambiar los límites" }).click()
  const limits = sideSurface(page, { name: "Límites de Recepción", exact: true })
  await limits.getByLabel("Pasa siempre a una persona si mencionan").fill("queja, reclamo")
  await limits.getByRole("checkbox", { name: "A toda hora" }).uncheck()
  await limits.getByLabel("Desde").fill("08:00")
  await limits.getByLabel("Hasta").fill("20:00")
  await limits.getByRole("button", { name: "Guardar" }).click()
  await expect(limits).toBeHidden()
  await expect(reach).toContainText("Telegram · De 08:00 a 20:00")
  await expect(reach).toContainText("o cuando mencionan: queja, reclamo.")
  expect(await config()).toMatchObject({ activeFromMin: 480, activeUntilMin: 1200 })

  // La base: lo fijo no se edita; la voz sí, con su muestra.
  await behaves.getByRole("button", { name: "Ver la base" }).click()
  const base = sideSurface(page, { name: "La base", exact: true })
  await expect(base).toContainText("No diagnostica, no receta y no decide por el profesional.")
  await base.getByLabel("Se presenta como").fill("Sofi")
  await base.getByRole("button", { name: "De usted" }).click()
  await expect(base).toContainText(`«¡Hola! Soy Sofi, asistente virtual de ${org.name}. ¿En qué le ayudo?»`)
  await info.attach("la-base", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await base.getByRole("button", { name: "Guardar" }).click()
  await expect(base).toBeHidden()
  await expect(behaves).toContainText("Se presenta como Sofi · de usted · tono cercano")
  expect((await config()).personaName).toBe("Sofi")

  // --- Probar: dos turnos, nada se envía ni se guarda ---
  const sandbox = page.getByRole("region", { name: "Probar" })
  await sandbox.getByRole("button", { name: "Pregunta un precio" }).click()
  await expect(sandbox.getByRole("listitem").filter({ hasText: FAKE_REPLY })).toHaveCount(1)
  // El modelo de las pruebas responde siempre lo mismo, y la pantalla lo dice.
  await expect(sandbox).toContainText("Modelo de demostración")
  await sandbox.getByLabel("Mensaje de prueba").fill("¿Y atienden los sábados?")
  await sandbox.getByRole("button", { name: "Enviar prueba" }).click()
  await expect(sandbox.getByText(FAKE_REPLY)).toHaveCount(2)
  await expect.poll(async () => (await overview()).readiness.sandboxTurns).toBe(2)
  expect(await call<unknown[]>(page, "GET", "/api/conversations", org.slug)).toHaveLength(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("recepcion", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await sandbox.getByRole("button", { name: "Empezar de nuevo" }).click()
  await expect(sandbox.getByRole("button", { name: "Quiere una cita" })).toBeVisible()

  // --- Encender: ya hay canal y ya se probó; empieza supervisado ---
  await page.getByRole("switch", { name: "Encender Recepción" }).click()
  await expect(turnOn).toContainText("Telegram")
  await expect(turnOn).toContainText("2 mensajes de prueba")
  await expect(turnOn.getByRole("button", { name: /^Supervisado/ })).toHaveAttribute("aria-pressed", "true")
  await info.attach("encender", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await turnOn.getByRole("button", { name: "Encender Recepción" }).click()
  await expect(turnOn).toBeHidden()
  await expect(page.getByRole("switch", { name: "Apagar Recepción" })).toBeChecked()
  expect(await overview()).toMatchObject({ enabled: true, level: "supervisado" })

  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(reception).toContainText("Encendido")
  await expect(reception).toContainText("Nivel Supervisado · Telegram")
  await info.attach("resumen-encendido", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Teléfono: lo mismo en una columna, sin desbordes y con controles tocables ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(reception).toContainText("Encendido")
  const configure = reception.getByRole("link", { name: "Configurar" })
  expect((await configure.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await configure.click()
  await expect(page.getByRole("heading", { level: 1, name: "Recepción" })).toBeVisible()
  await expect(does.getByRole("switch", { name: "Seguimiento comercial" })).not.toBeChecked()
  await expect(sandbox.getByRole("button", { name: "Quiere una cita" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("recepcion-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await reach.getByRole("button", { name: "Cambiar los límites" }).click()
  const mobileLimits = page.getByRole("dialog", { name: "Límites de Recepción" })
  await expect(mobileLimits.getByLabel("Desde")).toHaveValue("08:00")
  await info.attach("limites-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await mobileLimits.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileLimits).toBeHidden()

  // Apagar se confirma y dice qué pasa con lo que quedó a medias.
  await page.getByRole("switch", { name: "Apagar Recepción" }).click()
  const turnOff = page.getByRole("alertdialog", { name: "Apagar Recepción" })
  await expect(turnOff).toContainText("quedan para tu equipo")
  await turnOff.getByRole("button", { name: "Apagar" }).click()
  await expect(turnOff).toBeHidden()
  await expect.poll(async () => (await overview()).enabled).toBe(false)

  // Quien solo decide por el agente (recepción) no lo administra: lo decide el servidor.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "PUT", "/api/agent/level", org.slug, { level: "autonomo" })).status).toBe(403)
  expect((await api(page, "POST", "/api/agent/sandbox", org.slug, { message: "Hola" })).status).toBe(403)
  expect((await api(page, "PUT", "/api/agent/config", org.slug, { disabledFunctions: [] })).status).toBe(403)
})
