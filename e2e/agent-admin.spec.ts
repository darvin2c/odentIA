import { member, user } from "@odentia/db/schema/auth"
import { automationJob, automationRule } from "@odentia/db/schema/automation"
import { clinicalFollowUp, encounter } from "@odentia/db/schema/clinical"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

interface Advice {
  enabled: boolean
  recommendations: Array<{ key: string; total: number; title: string; actor: string }>
  more: number
}

interface PageData {
  enabled: boolean
  lines: Array<{ key: string; enabled: boolean; actor: string; agentPart: boolean; teamPart: boolean; hour: number | null; taskNote: string | null }>
  permissionGaps: unknown[]
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test("administrador: apagado, encenderlo, una línea con su flujo, recomendación en Inicio y lo que deja en Tareas", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const advice = () => call<Advice>(page, "GET", "/api/agent/admin/recommendations", org.slug)
  const admin = () => call<PageData>(page, "GET", "/api/agent/admin", org.slug)
  const lineOf = async (key: string) => (await admin()).lines.find((line) => line.key === key)

  // Un control vencido de un paciente sin cita (lo haría el agente) y una atención sin firmar (le toca a una persona).
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Mariana Soto", docType: "DNI", docNumber: "87654321" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  await fixtureDb.insert(clinicalFollowUp).values({
    organizationId: org.id, patientId: patient.id, kind: "mantenimiento", title: "Control de ortodoncia",
    dueAt: new Date(Date.now() - 10 * 86_400_000),
  })
  // La lleva alguien que ya no está en la clínica: quien sigue atendiendo la ve en
  // su «Te espera» y la línea solo cuenta las que nadie más verá.
  const formerDentist = crypto.randomUUID()
  await fixtureDb.insert(user).values({ id: formerDentist, name: "Dr. Ya No Atiende", email: `${formerDentist}@admin.test`, emailVerified: true })
  await fixtureDb.insert(encounter).values({
    organizationId: org.id, patientId: patient.id, dentistUserId: formerDentist,
    startedAt: new Date(Date.now() - 3 * 86_400_000),
  })

  // --- Apagado: Inicio no muestra nada y su página enseña lo que recomendaría ---
  expect(await advice()).toEqual({ enabled: false, recommendations: [], more: 0 })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Te espera" })).not.toContainText("Lo recomienda el administrador")

  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const row = page.getByRole("region", { name: "Tus agentes" }).getByRole("listitem").filter({ hasText: "Administrador" })
  await expect(row).toContainText("Apagado")
  await row.getByRole("link", { name: "Ver y encender" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Administrador" })).toBeVisible()
  const preview = page.getByRole("region", { name: "Con tus datos de hoy, esto te recomendaría" })
  await expect(preview).toContainText("1 control vencido de un paciente sin cita")
  await expect(preview).toContainText("1 atención lleva más de 2 días sin firmar")
  // «Recordar la cita» viene prendida en toda clínica nueva (ADR 0026): se ve y se puede apagar aunque él esté apagado.
  const onWhileOff = page.getByRole("region", { name: "Prendidas" })
  await expect(onWhileOff.getByRole("switch")).toHaveCount(1)
  await expect(onWhileOff.getByRole("switch", { name: "Apagar: Recordar la cita" })).toBeEnabled()
  await expect(onWhileOff).toContainText("Empiezan a hacerse solas cuando enciendas al administrador.")
  // Sin ellos no sale nada: el aviso lo dice con sus botones (fase 2.1, decisión 3).
  const missing = page.getByRole("status").filter({ hasText: "«Recordar la cita» está prendida, pero el Administrador y Recepción están apagados" })
  await expect(missing.getByRole("button", { name: "Encender al administrador" })).toBeVisible()
  await expect(missing.getByRole("link", { name: "Encender Recepción" })).toBeVisible()
  await expect(preview).toContainText("Al encenderlo solo hace lo que ya está prendido.")
  // Con una línea prendida ya no dice que al encenderlo no hace nada.
  await expect(preview).not.toContainText("Al encenderlo no hace nada por su cuenta.")
  // Las otras siete, apagadas y sin poder prenderse mientras él esté apagado.
  const ready = page.getByRole("region", { name: "Listas para activar" })
  await expect(ready.getByRole("switch")).toHaveCount(7)
  for (const item of await ready.getByRole("switch").all()) await expect(item).toBeDisabled()
  // Cada línea dice quién lo hace, con palabras. «Seguimiento sin responsable» ya no existe: la oportunidad sin responsable es de Recepción.
  await expect(ready.getByText("Lo hace el agente")).toHaveCount(4)
  await expect(ready.getByText("Le toca a una persona")).toHaveCount(3)
  await expect(ready).not.toContainText("Seguimiento sin responsable")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("administrador-apagado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Encenderlo no prende nada más ---
  await preview.getByRole("button", { name: "Encender al administrador" }).click()
  await expect(page.getByRole("switch", { name: "Apagar al Administrador" })).toBeChecked()
  const on = page.getByRole("region", { name: "Prendidas" })
  await expect(on).toContainText("Una persona tiene una cita")
  expect((await admin()).lines.filter((line) => line.enabled).map((line) => line.key)).toEqual(["recordatorio_cita"])
  await expect.poll(async () => (await advice()).recommendations.map((item) => [item.key, item.actor])).toEqual([
    ["recordatorio_control", "agente"],
    ["atenciones_sin_firmar", "persona"],
  ])

  // --- Una línea abierta: su flujo, entero mientras está apagada ---
  // Las filas de la lista son hijas directas: dentro de una línea abierta hay más listas (su flujo, sus personas).
  const control = ready.locator(":scope > ul > li").filter({ hasText: "Un control se acerca" })
  await expect(control).toContainText("Hoy sería 1 caso · el administrador te la recomienda")
  await control.getByRole("button", { name: /Un control se acerca/ }).click()
  const flow = control.getByRole("list", { name: "Avisar un control", exact: true })
  await expect(flow.getByRole("listitem")).toHaveText([/Un control se acerca/, /Dos días antes/, /¿Puede escribirle el agente\?/, /Le avisa/, /Lo resuelve el agente/])
  const otherwise = control.getByRole("list", { name: /Avisar un control: si la respuesta es «no»/ })
  await expect(otherwise.getByRole("listitem")).toHaveText([/Avisa por qué y cómo habilitarlo/, /Tarea de llamada/, /Le toca a una persona/])
  await expect(otherwise).toContainText("Sin interruptor: nunca termina en blanco.")
  await expect(control).toContainText("Está apagada: así se ejecutaría.")
  await expect(control.getByRole("region", { name: "Lo que recibe la persona" })).toContainText("tienes pendiente este control")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("linea-abierta-apagada", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Prenderla la pasa a «Prendidas», en presente, y el flujo se queda con lo que se ejecuta.
  await control.getByRole("switch", { name: "Prender: Avisar un control" }).click()
  const controlOn = on.locator(":scope > ul > li").filter({ hasText: "Un control se acerca" })
  await expect(controlOn).toContainText("El agente Recepción le avisa para agendarlo.")
  // Recepción, que es quien escribe, está apagada en esta clínica: la línea lo dice y la página ofrece encenderla.
  await expect(controlOn).toContainText("En pausa: Recepción está apagada y es quien escribe.")
  await expect(page.getByRole("status").filter({ hasText: "Recepción está apagada" }).getByRole("link", { name: "Encender Recepción" })).toBeVisible()
  expect(await lineOf("recordatorio_control")).toMatchObject({ enabled: true, agentPart: true, teamPart: true })
  // Sin la tarea de respaldo, el camino del «no» termina en el aviso, que no se puede apagar.
  await controlOn.getByRole("switch", { name: "Tarea para el equipo de recepción" }).click()
  await expect(controlOn.getByRole("list", { name: /si la respuesta es «no»/ }).getByRole("listitem")).toHaveText([/Avisa por qué y cómo habilitarlo/, /Queda avisado/])
  await expect(controlOn).toContainText("Si no puede, avisa por qué y cómo habilitarlo.")
  expect(await lineOf("recordatorio_control")).toMatchObject({ teamPart: false })
  await controlOn.getByRole("button", { name: "Ver todo el flujo" }).click()
  await expect(controlOn.getByRole("list", { name: /si la respuesta es «no»/ }).getByRole("listitem")).toHaveCount(3)
  await expect(controlOn).toContainText("Últimos cambios:")
  await info.attach("linea-abierta-prendida", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Teléfono: la misma línea, con el flujo hacia abajo y sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(controlOn.getByRole("switch", { name: "Apagar: Avisar un control" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("linea-abierta-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // --- Inicio: la recomendación es una línea apagada con casos; dice quién lo haría ---
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const today = page.getByRole("region", { name: "Te espera" })
  // La del control ya está prendida: no se recomienda.
  await expect(today.getByRole("listitem").filter({ hasText: "Lo recomienda el administrador" })).toHaveCount(1)
  const card = today.getByRole("listitem").filter({ hasText: "1 atención lleva más de 2 días sin firmar" })
  await expect(card).toContainText("le tocaría a tu equipo")
  await info.attach("inicio-administrador", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await card.getByRole("button", { name: /Ver la lista$/ }).click()
  const drawer = sideSurface(page, { name: "Recomendación del administrador", exact: true })
  await expect(drawer).toContainText("Atenciones que siguen en borrador, se abrieron hace más de 2 días y no le salen a nadie en «Te espera»")
  await expect(drawer).toContainText("Los números salen de la base de datos, no de un modelo.")
  await expect(drawer.getByRole("link", { name: "Mariana Soto" })).toBeVisible()
  await expect(drawer).toContainText("Le toca a una persona")
  await info.attach("recomendacion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // «Solo esta vez»: nada se crea hasta que alguien lo pide y lo confirma, y la línea sigue apagada.
  const tasks = () => call<Array<{ title: string; createdBy: string; area: string | null; reason: string | null; patientId: string | null; contactId: string | null }>>(page, "GET", "/api/tasks?view=abiertas&scope=clinica", org.slug)
  expect(await tasks()).toEqual([])
  await drawer.getByRole("button", { name: "Crear 1 tarea" }).click()
  await page.getByRole("alertdialog", { name: "Crear 1 tarea" }).getByRole("button", { name: "Crear las tareas" }).click()
  await expect(drawer.getByRole("status")).toContainText("1 tarea creada")
  // La tarea dice de quién es: el paciente y su propia persona.
  expect(await tasks()).toMatchObject([
    { title: "Revisar y firmar la atención de Mariana Soto", createdBy: "admin", area: "clinico", patientId: patient.id, contactId: expect.any(String) },
  ])
  // Repetirlo el mismo día no duplica.
  await drawer.getByRole("button", { name: "Crear 1 tarea" }).click()
  await page.getByRole("alertdialog", { name: "Crear 1 tarea" }).getByRole("button", { name: "Crear las tareas" }).click()
  await expect(drawer.getByRole("status")).toContainText("ya se pidió hoy")
  expect(await tasks()).toHaveLength(1)
  expect(await lineOf("atenciones_sin_firmar")).toMatchObject({ enabled: false })

  // «Ver su flujo y prender» lleva a su página con esa línea abierta.
  await drawer.getByRole("link", { name: "Ver su flujo y prender" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Administrador" })).toBeVisible()
  const unsigned = page.getByRole("region", { name: "Listas para activar" }).locator(":scope > ul > li").filter({ hasText: "Una atención lleva 2 días sin firmar" })
  await expect(unsigned.getByRole("list", { name: "Atención sin firmar", exact: true }).getByRole("listitem")).toHaveText([
    /Una atención lleva 2 días sin firmar/, /Espera 2 días/, /Tarea para firmar/, /Le toca a una persona/,
  ])

  // --- Tareas: lo que deja el administrador se reconoce por su origen y por qué, y lleva a la persona ---
  await gotoHydrated(page, tenant(org.slug, "/tasks"))
  // Va al equipo clínico: la dueña (área administración) la ve en «Toda la clínica».
  await page.getByRole("button", { name: "Toda la clínica" }).click()
  const task = page.getByRole("row").filter({ hasText: "Revisar y firmar la atención de Mariana Soto" })
  await expect(task).toContainText("La dejó el Administrador")
  await expect(task.getByRole("link", { name: "Mariana Soto" })).toBeVisible()
  await info.attach("tareas-administrador", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // --- Cada rol ve solo lo suyo, y solo quien administra el agente cambia una línea ---
  await fixtureDb.update(member).set({ role: "cashier" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await advice()).recommendations).toEqual([])
  expect((await api(page, "GET", "/api/agent/admin/recommendations/atenciones_sin_firmar", org.slug)).status).toBe(403)
  expect((await api(page, "PATCH", "/api/agent/admin/lines/cobranza_vencida", org.slug, { enabled: true })).status).toBe(403)
  expect((await api(page, "PUT", "/api/agent/admin/settings", org.slug, { enabled: false })).status).toBe(403)
  // Quien no supervisa al agente no llega a su página: el layout lo devuelve a Inicio.
  await gotoHydrated(page, tenant(org.slug, "/agent/administrador"))
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible()
})

test("administrador: pedirle algo con palabras deja un borrador que una persona prende, cambia o elimina", async ({ owner }, info) => {
  const { page, org } = owner
  const admin = () => call<PageData>(page, "GET", "/api/agent/admin", org.slug)
  await call(page, "PUT", "/api/agent/admin/settings", org.slug, { enabled: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/agent/administrador"))
  await expect(page.getByRole("heading", { level: 1, name: "Administrador" })).toBeVisible()
  const ask = page.getByRole("textbox", { name: "Dile qué quieres que haga" })
  const send = page.getByRole("button", { name: "Armar el cambio" })
  await expect(send).toBeDisabled()

  // Lo que no reconoce lo dice, y no arma nada.
  await ask.fill("Felicita a quien cumple años")
  await send.click()
  const unknown = page.getByRole("status").filter({ hasText: "No reconocí una línea" })
  await expect(unknown).toContainText("envíala como pedido desde Ayuda")
  expect((await admin()).lines).toHaveLength(8)
  // Y se puede enviar a odentIA tal cual, diciendo qué viaja con el pedido.
  await expect(unknown).toContainText("Se envía lo que escribiste, con el nombre de tu clínica, tu rol, esta pantalla y la versión de odentIA.")
  await unknown.getByRole("button", { name: "Enviarlo a odentIA como pedido" }).click()
  await expect(unknown).toContainText("Enviado a odentIA. La respuesta te llega en Ayuda.")
  expect(await call<Array<{ question: string; status: string }>>(page, "GET", "/api/help/cases", org.slug)).toMatchObject([
    { question: "Felicita a quien cumple años", status: "abierto" },
  ])

  // --- Si el modelo no responde: lo dice, el campo se desactiva y se puede reintentar ---
  await page.route("**/api/agent/admin/request", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          understood: false, key: null, draft: false, confirmDelete: false, model: null, usage: null, unavailable: true,
          message: "Ahora no puedo leer pedidos con palabras. Lo que tienes prendido sigue funcionando y los interruptores también: puedes hacer el cambio a mano.",
        },
      }),
    }),
  )
  await ask.fill("Cuando alguien cancele su cita, que el agente le ofrezca otra fecha")
  await send.click()
  const down = page.getByRole("status").filter({ hasText: "Ahora no puedo leer pedidos con palabras" })
  await expect(down).toContainText("El campo vuelve a activarse solo en medio minuto.")
  await expect(ask).toBeDisabled()
  await expect(send).toBeDisabled()
  await expect(page.getByRole("region", { name: "Listas para activar" }).getByRole("switch").first()).toBeEnabled()
  await info.attach("modelo-no-responde", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // El modelo vuelve: «Reintentar» manda el mismo pedido, sin escribirlo otra vez.
  await page.unroute("**/api/agent/admin/request")
  await down.getByRole("button", { name: "Reintentar" }).click()

  // --- Crear: aparece como borrador, con su flujo, su prueba y lo que se revisó ---
  const ready = page.getByRole("region", { name: "Listas para activar" })
  const created = ready.locator(":scope > ul > li").filter({ hasText: "Una persona cancela su cita" })
  await expect(created).toContainText("Borrador: todavía no hace nada.")
  await expect(created).toContainText("Creada por tu clínica")
  const draft = created.getByRole("region", { name: /Línea nueva/ })
  await expect(draft).toContainText("Pediste: «Cuando alguien cancele su cita, que el agente le ofrezca otra fecha»")
  await expect(draft).toContainText("La armé así: el agente Recepción le escribe una hora después para ofrecerle otra fecha.")
  await expect(draft.getByRole("list", { name: /como quedaría$/ }).getByRole("listitem")).toHaveText([
    /Una persona cancela su cita/, /Espera una hora/, /¿Puede escribirle el agente\?/, /Le escribe/, /Lo resuelve el agente/,
  ])
  await expect(draft).toContainText("La probé con tus últimos 30 días: 0 cancelaciones")
  await expect(draft).toContainText("Lo que revisé")
  await expect(draft).toContainText("Recepción está apagada: mientras siga así, esta línea no le escribe a nadie.")
  await expect(draft).toContainText("Se canceló la cita del lunes 12 de octubre en Clínica Sonríe. ¿Te buscamos otra fecha?")
  expect((await admin()).lines.find((line) => line.key === "cita_cancelada")).toMatchObject({ enabled: false })
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("borrador-linea-nueva", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("borrador-linea-nueva-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // Prender es la misma operación del interruptor: pasa a «Prendidas».
  await draft.getByRole("button", { name: "Prender" }).click()
  const on = page.getByRole("region", { name: "Prendidas" })
  const live = on.locator(":scope > ul > li").filter({ hasText: "Una persona cancela su cita" })
  await expect(live).toContainText("El agente Recepción le escribe una hora después para ofrecerle otra fecha.")
  expect((await admin()).lines.find((line) => line.key === "cita_cancelada")).toMatchObject({ enabled: true, agentPart: true })

  // --- Editar: dice qué cambia y lo que no se puede; sin guardar, sigue como estaba ---
  await ask.fill("Cuando alguien cancele su cita, que espere 3 horas, sin tareas, y que les ofrezca un descuento")
  await send.click()
  const editing = live.getByRole("region", { name: /Lo que pediste cambiar/ })
  await expect(editing).toContainText("Así quedaría. Mientras no guardes, sigue funcionando como estaba.")
  await expect(editing).toContainText("Antes: Espera una hora")
  await expect(editing).toContainText("Ahora: Espera 3 horas")
  await expect(editing).toContainText("Se quita: Ya no queda una tarea para el equipo cuando el agente no puede.")
  await expect(editing).toContainText("Lo que pediste y no se puede")
  await expect(editing).toContainText("el agente Recepción no ofrece descuentos")
  await expect(live).toContainText("Tiene un cambio sin guardar: sigue funcionando como estaba.")
  expect((await admin()).lines.find((line) => line.key === "cita_cancelada")).toMatchObject({ teamPart: true })
  // Lo que el agente no hace puede quedar como indicación para la persona que reciba la tarea.
  const note = editing.getByRole("textbox", { name: "Lo que sí puedo: dejarlo como indicación en la tarea" })
  await expect(editing.getByRole("button", { name: "Sí, ponlo en la tarea" })).toBeDisabled()
  await note.fill("Ofrecer 10 % si reprograma")
  await editing.getByRole("button", { name: "Sí, ponlo en la tarea" }).click()
  await expect(editing).toContainText("Nueva: La tarea para el equipo de recepción dirá: «Ofrecer 10 % si reprograma». El agente no lo dice: lo hace una persona.")
  // Una indicación sin tarea no sirve: la tarea de respaldo se queda.
  await expect(editing).not.toContainText("Se quita: Ya no queda una tarea")
  await info.attach("borrador-cambio", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await editing.getByRole("button", { name: "Guardar el cambio" }).click()
  await expect(live).toContainText("El agente Recepción le escribe 3 horas después para ofrecerle otra fecha. Si no puede, avisa por qué y cómo habilitarlo, y queda una tarea para el equipo de recepción.")
  await expect(live.getByRole("spinbutton", { name: "Horas de espera" })).toHaveValue("3")
  await expect(live.getByRole("textbox", { name: "Indicación para quien reciba la tarea" })).toHaveValue("Ofrecer 10 % si reprograma")
  expect((await admin()).lines.find((line) => line.key === "cita_cancelada")).toMatchObject({ teamPart: true, taskNote: "Ofrecer 10 % si reprograma" })

  // --- Eliminar: solo las que creó la clínica, y con confirmación ---
  await ask.fill("Elimina la de cancelaciones")
  await send.click()
  const dialog = page.getByRole("alertdialog", { name: "Eliminar esta línea" })
  await expect(dialog).toContainText("Lo ya hecho se conserva")
  await dialog.getByRole("button", { name: "Eliminar" }).click()
  await expect(page.getByText("Una persona cancela su cita")).toHaveCount(0)
  expect((await admin()).lines).toHaveLength(8)
  // Una que viene armada no se elimina.
  expect((await api(page, "DELETE", "/api/agent/admin/lines/cobranza_vencida", org.slug)).status).toBe(400)
})

test("administrador: permisos en el registro y en la ficha, mensajes aprobados, ajustes a mano y «casi no escribe»", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const admin = () => call<PageData>(page, "GET", "/api/agent/admin", org.slug)
  await call(page, "PUT", "/api/agent/admin/settings", org.slug, { enabled: true })
  await call(page, "POST", "/api/channels/connections", org.slug, {
    channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA E2E",
    config: { phoneNumberId: "E2E-PNID", wabaId: "E2E-WABA", accessToken: "e2e", appSecret: "e2e-secret", templates: [{ name: "odentia_recordatorio_cita_v2", language: "es" }] },
  }, 201)
  const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
    submissionId: crypto.randomUUID(),
    answers: { demographics: { displayName: "Tomás Rivas", docType: "DNI", docNumber: "45678912" }, respondent: "staff", privacyAccepted: false },
    contacts: [],
  }, 201)
  await page.setViewportSize({ width: 1440, height: 900 })

  // --- WhatsApp (Integraciones): los trece mensajes de la clínica con su estado; nadie escribe nombres de plantilla ---
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  const approved = page.getByRole("region", { name: "Mensajes", exact: true })
  // Al conectar se piden todos: el que la cuenta ya tenía aprobado y los demás, en revisión.
  await expect(approved.getByRole("listitem")).toHaveCount(14)
  await expect(approved.getByRole("listitem").filter({ has: page.getByText("Recordar la cita", { exact: true }) })).toContainText("Aprobado")
  await expect(approved).toContainText("1 aprobado · 12 en revisión")
  await expect(approved).not.toContainText("odentia_recordatorio_cita_v2")
  await expect(approved).toContainText("WhatsApp revisa cada mensaje y cada cambio de texto")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("canales-mensajes-aprobados", { body: await approved.screenshot(), contentType: "image/png" })

  // --- Registro: solo pregunta por novedades y promociones; lo de su atención es parte del servicio ---
  const config = () => call<{ askReminders: boolean; askMessages: boolean }>(page, "GET", "/api/patient-registration/config", org.slug)
  expect(await config()).toMatchObject({ askMessages: true })
  await gotoHydrated(page, tenant(org.slug, "/settings/patient-registration"))
  // Son casillas del formulario: valen al pulsar «Guardar», que está al final de la página.
  await expect(page.getByRole("checkbox", { name: /Recordatorios/ })).toHaveCount(0)
  const others = page.getByRole("checkbox", { name: /Novedades y promociones de la clínica/ })
  await expect(others).toBeChecked()
  await others.click()
  await page.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(page.getByText("Registro de pacientes guardado", { exact: true })).toBeVisible()
  await expect.poll(config).toMatchObject({ askMessages: false })

  // --- Ficha: los tres interruptores de «Tus mensajes»; cada cambio pregunta antes cómo lo dijo (ADR 0040) ---
  await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}?tab=filiacion`))
  const consent = page.getByRole("region", { name: "Datos y consentimiento" })
  await expect(consent).toContainText("Mensajes de la clínica")
  await expect(consent).toContainText("Avisos de sus citas y papeles")
  await expect(consent.getByRole("switch", { name: "Recordatorios de sus citas" })).toBeChecked()
  await expect(consent.getByRole("switch", { name: "Controles y seguimiento" })).toBeChecked()
  await expect(consent.getByText("Apagado: aún no lo aceptó")).toHaveCount(1)
  const general = consent.getByRole("switch", { name: "Novedades y promociones" })
  await expect(general).not.toBeChecked()
  await general.click()
  await expect(consent).toContainText("¿Cómo lo pidió?")
  const contacts = await call<{ contacts: Array<{ contactId: string }> }>(page, "GET", `/api/patients/${patient.id}`, org.slug)
  const permissions = () => call<Array<{ purpose: string; granted: boolean | null; source: string | null }>>(page, "GET", `/api/agent/admin/people/${contacts.contacts[0]!.contactId}/permissions`, org.slug)
  // Hasta confirmarlo no se guarda nada.
  expect((await permissions()).find((row) => row.purpose === "novedades")).toMatchObject({ granted: null })
  await consent.getByRole("radio", { name: "Por teléfono" }).click()
  await consent.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(consent).toContainText("Encendido · lo dijo por teléfono")
  await expect(general).toBeChecked()
  expect((await permissions()).find((row) => row.purpose === "novedades")).toMatchObject({ granted: true, source: "telefono" })
  await info.attach("ficha-mensajes-de-la-clinica", { body: await consent.screenshot(), contentType: "image/png" })

  // --- Una línea se ajusta a mano, sin pedírselo con palabras ---
  await call(page, "PATCH", "/api/agent/admin/lines/seguimiento_no_asistencia", org.slug, { enabled: true })
  await gotoHydrated(page, tenant(org.slug, "/agent/administrador?linea=seguimiento_no_asistencia"))
  const line = page.getByRole("region", { name: "Prendidas" }).locator(":scope > ul > li").filter({ hasText: "Una persona falta a su cita" })
  await line.getByRole("combobox", { name: "A qué hora sale" }).click()
  await page.getByRole("option", { name: "10:00", exact: true }).click()
  await expect(line).toContainText("El agente Recepción le escribe al día siguiente, a las 10:00, para reprogramar.")
  await expect(line.getByRole("list", { name: "Reprogramar tras una inasistencia", exact: true })).toContainText("Espera al día siguiente, 10:00")
  const noteField = line.getByRole("textbox", { name: "Indicación para quien reciba la tarea" })
  await noteField.fill("Ofrecerle el horario de la tarde")
  await noteField.blur()
  await expect.poll(async () => (await admin()).lines.find((item) => item.key === "seguimiento_no_asistencia")).toMatchObject({ hour: 10, taskNote: "Ofrecerle el horario de la tarde" })
  await info.attach("linea-ajustes-a-mano", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- «Prendida, pero casi no escribe» ya no aplica a lo que es parte del servicio (ADR 0030) ---
  const [rule] = await fixtureDb.select({ id: automationRule.id }).from(automationRule)
    .where(and(eq(automationRule.organizationId, org.id), eq(automationRule.kind, "seguimiento_no_asistencia")))
  await fixtureDb.insert(automationJob).values(
    Array.from({ length: 6 }, (_, index) => ({
      organizationId: org.id, ruleId: rule!.id, kind: "seguimiento_no_asistencia", dedupeKey: `seguimiento_no_asistencia:e2e-${index}`,
      scheduledFor: new Date(), status: "omitido", cause: "sin_permiso",
    })),
  )
  await gotoHydrated(page, tenant(org.slug, "/agent/administrador"))
  await expect(page.getByRole("heading", { level: 1, name: "Administrador" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "Prendida, pero casi no escribe" })).toHaveCount(0)
  expect((await admin()).permissionGaps).toEqual([])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  // Teléfono: la lista completa, con sus avisos, sin desbordes.
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("lista-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })
})
