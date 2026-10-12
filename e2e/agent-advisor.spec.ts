import { member } from "@odentia/db/schema/auth"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

interface View {
  enabled: boolean
  recommendations: Array<{ key: string; total: number; title: string }>
  more: number
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("asesor: vista previa, encenderlo, recomendación en Inicio con su lista y su acción", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const advisor = () => call<View>(page, "GET", "/api/agent/advisor", org.slug)

  // Un control vencido de un paciente sin cita y un seguimiento que nadie lleva.
  const contact = await call<{ id: string }>(page, "POST", "/api/contacts", org.slug, { displayName: "Interesada sin dueño" }, 201)
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Mariana Soto", docType: "DNI", docNumber: "87654321" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  await fixtureDb.insert(clinicalFollowUp).values({
    organizationId: org.id, patientId: patient.id, kind: "mantenimiento", title: "Control de ortodoncia",
    dueAt: new Date(Date.now() - 10 * 86_400_000),
  })
  await call(page, "POST", "/api/opportunities", org.slug, { contactId: contact.id, title: "Blanqueamiento" }, 201)

  // --- Apagado: Inicio no muestra nada y la página del Asesor enseña lo que recomendaría ---
  expect(await advisor()).toEqual({ enabled: false, recommendations: [], more: 0 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Para atender hoy" })).toHaveCount(0)

  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const row = page.getByRole("region", { name: "Tus agentes" }).getByRole("listitem").filter({ hasText: "Asesor" })
  await expect(row).toContainText("Apagado")
  await row.getByRole("link", { name: "Ver y encender" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Asesor" })).toBeVisible()
  // El mismo marco de seis apartados que los otros agentes.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Qué hace", "Hasta dónde llega solo", "Qué sabe", "Cómo se comporta", "Cómo se prueba", "Qué aprende, y de quién es"])
  await expect(page.getByRole("region", { name: "Qué sabe" })).toContainText("Los números salen de la base de datos, no del modelo.")
  await expect(page.getByRole("region", { name: "Cómo se comporta" })).toContainText("cada recomendación es una consulta a los datos de la clínica")
  await expect(page.getByRole("region", { name: "Qué aprende, y de quién es" })).toContainText("«No me interesa» oculta esa detección una semana.")
  const detects = page.getByRole("region", { name: "Qué hace" })
  await expect(detects.getByRole("switch")).toHaveCount(5)
  const preview = page.getByRole("region", { name: "Cómo se prueba" })
  await expect(preview).toContainText("Con una vista previa de lo que recomendaría hoy, antes de encenderlo.")
  await expect(preview).toContainText("1 control vencido de un paciente sin cita")
  await expect(preview).toContainText("1 seguimiento abierto sin responsable")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("asesor-apagado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  // Teléfono: la misma página, sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(preview.getByRole("button", { name: "Ver la lista" }).first()).toBeVisible()
  // El alto cambia con una transición al estrechar la ventana: se espera a que termine.
  await expect.poll(async () => (await preview.getByRole("button", { name: "Ver la lista" }).first().boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("asesor-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // Apagar una detección la quita de la vista previa; encender el Asesor la lleva a Inicio.
  await detects.getByRole("switch", { name: "Seguimientos sin responsable" }).click()
  await expect(preview).not.toContainText("seguimiento abierto sin responsable")
  await detects.getByRole("switch", { name: "Seguimientos sin responsable" }).click()
  await page.getByRole("switch", { name: "Encender el Asesor" }).click()
  await expect(page.getByRole("switch", { name: "Apagar el Asesor" })).toBeChecked()
  await expect.poll(async () => (await advisor()).recommendations.map((item) => item.key)).toEqual([
    "controles_vencidos", "seguimientos_sin_responsable",
  ])

  // --- Inicio: la recomendación con su lista, cómo se calculó y la acción preparada ---
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const today = page.getByRole("region", { name: "Para atender hoy" })
  await expect(today).toContainText("2 recomendaciones del asesor")
  const card = today.getByRole("listitem").filter({ hasText: "1 control vencido de un paciente sin cita" })
  await expect(card).toContainText("Controles")
  // La tarjeta dice el estado real de la automatización, sin haber tocado nada.
  await expect(card).toContainText("El recordatorio de control está apagado.")
  const rules = () => call<Array<{ kind: string; enabled: boolean; name: string }>>(page, "GET", "/api/automations/rules", org.slug)
  expect(await rules()).toEqual([])
  await info.attach("inicio-asesor", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await card.getByRole("button", { name: "Revisar y decidir" }).click()
  const drawer = sideSurface(page, { name: "Recomendación del asesor", exact: true })
  await expect(drawer).toContainText("Controles pendientes con fecha vencida")
  await expect(drawer).toContainText("Los números salen de la base de datos, no de un modelo.")
  await expect(drawer.getByRole("link", { name: "Mariana Soto" })).toBeVisible()
  await expect(drawer).toContainText("Control de ortodoncia · venció el")
  // Acción principal: encender la automatización; crear tareas queda como secundaria.
  await expect(drawer).toContainText("Encender el recordatorio de control")
  await expect(drawer).toContainText("No escribe a quienes ya se les pasó la fecha")
  await expect(drawer).toContainText("Nada se envía hasta que lo enciendas. Podrás ver cada mensaje en Automatizaciones.")
  await expect(drawer.getByRole("button", { name: "Encender recordatorio" })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "No volver a mostrar" })).toBeVisible()
  await info.attach("recomendacion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Nada se crea hasta que alguien lo pide y lo confirma.
  const tasks = () => call<Array<{ title: string }>>(page, "GET", "/api/tasks?status=open", org.slug)
  expect(await tasks()).toEqual([])
  await drawer.getByRole("button", { name: "Solo crear 1 tarea de llamada" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Crear 1 tarea de llamada" })
  await confirm.getByRole("button", { name: "Crear las tareas" }).click()
  await expect(drawer.getByRole("status")).toContainText("1 tarea creada")
  expect((await tasks()).map((task) => task.title)).toEqual(["Llamar a Mariana Soto para agendar su control"])
  // Repetirlo el mismo día no duplica.
  await drawer.getByRole("button", { name: "Solo crear 1 tarea de llamada" }).click()
  await page.getByRole("alertdialog", { name: "Crear 1 tarea de llamada" }).getByRole("button", { name: "Crear las tareas" }).click()
  await expect(drawer.getByRole("status")).toContainText("ya estaban creadas hoy")
  expect(await tasks()).toHaveLength(1)
  // Crear tareas no enciende nada.
  expect(await rules()).toEqual([])
  await drawer.getByRole("button", { name: "Cerrar" }).click()
  await expect(drawer).toBeHidden()

  // --- Teléfono (390 px): tarjetas, detalle y encender el recordatorio, sin desbordes ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const review = card.getByRole("button", { name: "Revisar y decidir" })
  expect((await review.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await card.getByRole("button", { name: "No me interesa" }).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("inicio-asesor-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await review.click()
  const turnOn = drawer.getByRole("button", { name: "Encender recordatorio" })
  await expect(turnOn).toBeVisible()
  for (const button of [turnOn, drawer.getByRole("button", { name: "Solo crear 1 tarea de llamada" }), drawer.getByRole("button", { name: "No volver a mostrar" })]) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  expect(await drawer.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(0)
  await info.attach("recomendacion-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // Encender es un acto de la persona y se confirma: hasta entonces no hay regla.
  await turnOn.click()
  const confirmOn = page.getByRole("alertdialog", { name: "Encender el recordatorio de control" })
  await expect(confirmOn).toContainText("Avisa por WhatsApp a quien tiene un control en las próximas 48 horas")
  expect(await rules()).toEqual([])
  await confirmOn.getByRole("button", { name: "Encender recordatorio" }).click()
  await expect(drawer.getByRole("status")).toContainText("Recordatorio de control encendido")
  expect((await rules()).map((rule) => ({ kind: rule.kind, enabled: rule.enabled }))).toEqual([{ kind: "recordatorio_control", enabled: true }])
  // Encendido, crear las tareas pasa a ser la acción principal.
  await expect(drawer).toContainText("El recordatorio de control ya está encendido.")
  await expect(drawer.getByRole("button", { name: "Encender recordatorio" })).toHaveCount(0)
  await expect(drawer.getByRole("button", { name: "Crear 1 tarea de llamada", exact: true })).toBeVisible()
  await info.attach("recomendacion-encendido-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await drawer.getByRole("button", { name: "Cerrar" }).click()
  await expect(drawer).toBeHidden()
  await expect(card).not.toContainText("está apagado")

  // Pausada desde Automatizaciones (misma regla), el detalle vuelve a ofrecer encenderla.
  const [rule] = await call<Array<{ id: string }>>(page, "GET", "/api/automations/rules", org.slug)
  await call(page, "PATCH", `/api/automations/rules/${rule?.id}`, org.slug, { enabled: false })

  // Recepción no administra el agente: ve la tarjeta completa, sin «No me interesa» ni huecos.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(card).toContainText("El recordatorio de control está apagado.")
  await expect(today.getByRole("button", { name: "No me interesa" })).toHaveCount(0)
  const alone = card.getByRole("button", { name: "Revisar y decidir" })
  const [aloneBox, cardBox] = [await alone.boundingBox(), await card.boundingBox()]
  // El botón ocupa el ancho útil de la tarjeta (su relleno es de 16 px por lado).
  expect(aloneBox?.width ?? 0).toBeGreaterThanOrEqual((cardBox?.width ?? 0) - 36)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("inicio-recepcion-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await alone.click()
  await expect(drawer.getByRole("button", { name: "Encender recordatorio" })).toBeVisible()
  await expect(drawer.getByRole("button", { name: "No volver a mostrar" })).toHaveCount(0)
  await expect(drawer).not.toContainText("¿No te sirve esta recomendación?")
  await info.attach("recomendacion-recepcion-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await drawer.getByRole("button", { name: "Cerrar" }).click()
  await expect(drawer).toBeHidden()
  await fixtureDb.update(member).set({ role: "owner" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))

  // «No me interesa»: se oculta una semana para toda la clínica.
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await card.getByRole("button", { name: "No me interesa" }).click()
  await page.getByRole("alertdialog", { name: "Ocultarla una semana" }).getByRole("button", { name: "Ocultar 7 días" }).click()
  await expect(today).toContainText("1 recomendación del asesor")
  await expect(today).not.toContainText("control vencido")
  // Sin automatización equivalente, la acción principal es crear las tareas.
  await today.getByRole("button", { name: "Revisar y decidir" }).click()
  await expect(drawer).toContainText("Oportunidades abiertas que no tienen a nadie del equipo asignado.")
  await expect(drawer.getByRole("button", { name: "Crear 1 tarea", exact: true })).toBeVisible()
  await expect(drawer.getByRole("button", { name: /Encender/ })).toHaveCount(0)
  await drawer.getByRole("button", { name: "Cerrar" }).click()
  await expect(drawer).toBeHidden()

  // Cada rol ve solo lo que ya puede ver, y solo quien administra cambia los ajustes.
  await fixtureDb.update(member).set({ role: "cashier" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await advisor()).recommendations).toEqual([])
  expect((await api(page, "GET", "/api/agent/advisor/seguimientos_sin_responsable", org.slug)).status).toBe(403)
  expect((await api(page, "PUT", "/api/agent/advisor/settings", org.slug, { enabled: false })).status).toBe(403)
  // Quien no supervisa al agente no llega a su página: el layout lo devuelve a Inicio.
  await gotoHydrated(page, tenant(org.slug, "/agent/asesor"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
})
