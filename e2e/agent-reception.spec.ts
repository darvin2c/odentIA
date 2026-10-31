import { agentLesson } from "@odentia/db/schema/agent"
import { member } from "@odentia/db/schema/auth"
import type { Locator, Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

const FAKE_REPLY = "Gracias por escribir. Te atiendo enseguida."

interface Overview {
  enabled: boolean
  readiness: { channels: string[]; sandboxTurns: number }
}

interface Config {
  disabledFunctions: string[]
  functionNotes: Record<string, string>
  personaName: string | null
  emojis: "no" | "pocos"
  handoffKeywords: string[]
}

/**
 * El control cabe entero en la ventana: no queda tapado ni fuera de la pantalla.
 * Reintenta: el cajón del teléfono entra con una animación.
 */
async function insideViewport(_page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeInViewport({ ratio: 1 })
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
  const reception = agents.getByRole("listitem").filter({ hasText: "Sofi" })
  await expect(reception).toContainText("Apagado")
  // Ayuda viene con el sistema: no se enciende ni aparece en esta lista.
  await expect(agents.getByRole("listitem")).toHaveCount(3)
  // El Asistente clínico y el Administrador ya existen y se encienden por separado.
  for (const name of ["Clío", "Argos"]) {
    await expect(agents.getByRole("listitem").filter({ hasText: name })).toContainText("Apagado")
  }
  // Lo básico que falta se dice en la ficha de las preguntas sin respuesta: se responde en el mismo sitio.
  await expect(page.getByRole("region", { name: "Necesita de ti" }).getByRole("link", { name: /Preguntas sin respuesta/ })).toContainText("preguntas básicas")
  await expect(page.getByRole("region", { name: "Cómo le fue esta semana" })).toContainText("Está apagado")
  // Un solo horario, el de recontacto (ADR 0084): para escribir primero; cuando la persona escribe, responde siempre.
  const recontact = page.getByRole("region", { name: "Horario de recontacto" })
  await expect(recontact).toContainText("Es el horario decente para volver a contactar.")
  await expect(recontact).toContainText("Cuando la persona escribe, Sofi responde siempre, a cualquier hora.")
  await expect(recontact.getByRole("link", { name: "A qué horas responde" })).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-apagado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Encender sin canal: dice qué falta y a dónde ir; no deja encender ---
  // Apagada, el Resumen lleva a su página: ahí se ve qué hace y se enciende.
  await reception.getByRole("link", { name: "Ver y encender" }).click()
  await expect(page.getByRole("heading", { level: 1, name: "Sofi, tu agente de recepción" })).toBeVisible()
  await page.getByRole("switch", { name: "Encender a Sofi" }).click()
  const turnOn = sideSurface(page, { name: "Encender a Sofi", exact: true })
  await expect(turnOn).toContainText("Sin un canal conectado no le llega ningún mensaje.")
  await expect(turnOn.getByRole("link", { name: "Conectar un canal" })).toBeVisible()
  await expect(turnOn.getByRole("button", { name: "Encender a Sofi" })).toBeDisabled()
  await info.attach("encender-sin-canal", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await turnOn.getByRole("button", { name: "Ahora no" }).click()
  await expect(turnOn).toBeHidden()
  expect((await overview()).enabled).toBe(false)

  await call(page, "POST", "/api/channels/connections", org.slug, {
    channel: "telegram", provider: "telegram_bot_api", displayName: "Bot E2E", config: { botToken: "e2e" },
  }, 201)

  // --- Página de Recepción ---
  await gotoHydrated(page, tenant(org.slug, "/agent/recepcion"))
  await expect(page.getByRole("heading", { level: 1, name: "Sofi, tu agente de recepción" })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "Agente" })).toBeVisible()
  const today = page.getByRole("region", { name: "Hoy" })
  const does = page.getByRole("region", { name: "Qué hace" })
  const reach = page.getByRole("region", { name: "Límites" })
  const knows = page.getByRole("region", { name: "Qué sabe" })
  const behaves = page.getByRole("region", { name: "Cómo se comporta" })

  // Hoy: las cifras del resumen, por conversación. «Ver qué hizo» abre la actividad del agente.
  await expect(today).toContainText("0 conversaciones atendidas")
  await expect(today).toContainText("0 citas reservadas")
  await expect(today).toContainText("0 pasadas a una persona")
  await today.getByRole("button", { name: "Ver qué hizo" }).click()
  await expect(page.getByRole("tab", { name: "Actividad" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("button", { name: "Cerrar el panel del agente" }).click()
  await expect(page.getByRole("tab", { name: "Actividad" })).toBeHidden()

  // Las dos funciones fijas se ven, sin interruptor.
  await expect(does.getByRole("listitem").filter({ hasText: "Ordenar el caso" })).toContainText("Siempre")
  await expect(does.getByRole("listitem").filter({ hasText: "Pasar a una persona" })).toContainText("Siempre")
  // Informar, agendar, oportunidades y presupuestos (fase 3, decisiones 4 y 5) se apagan.
  await expect(does.getByRole("switch")).toHaveCount(4)

  // Apagar una función: queda dicho qué hará cuando se la pidan.
  await does.getByRole("switch", { name: "Oportunidades" }).click()
  await expect(does).toContainText("Apagada: no crea ni mueve oportunidades.")
  await expect.poll(async () => (await config()).disabledFunctions).toEqual(["seguimiento"])

  // Cómo trabaja va plegado: los pasos y lo que puede llenar salen de la misma declaración que usa la pantalla.
  const booking = does.getByRole("listitem").filter({ hasText: "Agendar, mover y cancelar citas" }).first()
  await expect(booking).not.toContainText("Confirma la sede y el servicio.")
  await booking.getByRole("button", { name: /^Ver cómo trabaja/ }).click()
  await expect(booking.getByRole("button", { name: /^Ocultar cómo trabaja/ })).toBeVisible()
  await expect(booking).toContainText("Confirma la sede y el servicio.")
  await expect(booking).toContainText("Reservar una cita:")
  await expect(booking).toContainText("Mover una cita:")

  // Indicación para una función.
  await booking.getByRole("button", { name: "Agregar la indicación de «Agendar, mover y cancelar citas»" }).click()
  const noteForm = sideSurface(page, { name: "Indicación para «Agendar, mover y cancelar citas»", exact: true })
  await noteForm.getByLabel("Indicación", { exact: true }).fill("Ofrece primero las mañanas.")
  await noteForm.getByRole("button", { name: "Guardar" }).click()
  await expect(noteForm).toBeHidden()
  await expect(booking).toContainText("«Ofrece primero las mañanas.»")
  await expect(booking.getByRole("button", { name: "Editar la indicación de «Agendar, mover y cancelar citas»" })).toBeVisible()

  // Sin niveles (ADR 0021): cada función dice quién confirma; la cita, el paciente
  // (su pedido de esa misma hora ya es su sí).
  await expect(reach.getByRole("button", { name: "Supervisado", exact: true })).toHaveCount(0)
  await expect(booking).toContainText("le pide el «sí» al paciente")
  await expect(reach).toContainText("Siempre responde al momento.")

  // Cuándo pasa a una persona: lo fijo y lo que añade la clínica, con su entrada.
  await expect(reach).toContainText("Piden hablar con alguien")
  await reach.getByRole("button", { name: "Agregar" }).click()
  const handoffForm = sideSurface(page, { name: "Pasa a una persona cuando", exact: true })
  await handoffForm.getByLabel("Pasa siempre a una persona si mencionan").fill("queja, reclamo")
  await handoffForm.getByRole("button", { name: "Guardar" }).click()
  await expect(handoffForm).toBeHidden()
  await expect(reach).toContainText("Mencionan «queja»")
  await expect(reach).toContainText("Mencionan «reclamo»")

  // Límites: cada fila abre solo lo suyo y guardar una no pisa las otras. Sofi responde
  // siempre, a toda hora y en todos los canales (ADR 0084), sin tope de respuestas: el
  // único límite es el presupuesto del mes (ADR 0085).
  await expect(reach.getByRole("button", { name: /^Horario/ })).toHaveCount(0)
  await expect(reach.getByRole("button", { name: /^Canales/ })).toHaveCount(0)
  await expect(reach.getByRole("button", { name: /^Tope diario/ })).toHaveCount(0)
  expect(await config()).toMatchObject({ handoffKeywords: ["queja", "reclamo"] })
  await expect(reach).toContainText("Nunca, y no se puede cambiar")

  // Qué sabe: cuatro filas que llevan a donde se edita cada cosa, y lo que recuerda de cada persona.
  for (const [name, href] of [
    ["Respuestas oficiales", "/agent/knowledge"],
    ["Servicios y precios", "/services"],
    ["Sedes y horarios", "/settings/branches"],
    ["Lo que aprendió de tus correcciones", "/agent/learn"],
  ] as const) {
    await expect(knows.getByRole("link", { name: new RegExp(`^${name}`) })).toHaveAttribute("href", new RegExp(`${href}$`))
  }
  await expect(knows.getByRole("link", { name: /^Lo que aprendió de tus correcciones/ })).toContainText("Ninguna lección todavía")
  await expect(knows).toContainText("Lo que recuerda de cada persona")

  // «Lo que el agente debe saber» (decisión 24): una sola lista, cada línea con su origen; editar una no pierde las demás.
  const knowsMust = page.getByRole("region", { name: "Lo que Sofi debe saber" })
  await expect(knowsMust).toContainText("Todavía no hay nada aquí.")
  for (const text of ["No ofrezcas descuentos.", "Despídete recordando la dirección."]) {
    await knowsMust.getByRole("button", { name: "Agregar" }).first().click()
    const addForm = sideSurface(page, { name: "Agregar a lo que debe saber", exact: true })
    await addForm.getByLabel("Qué debe saber", { exact: true }).fill(text)
    await addForm.getByRole("button", { name: "Guardar" }).click()
    await expect(addForm).toBeHidden()
    await expect(knowsMust.getByRole("listitem").filter({ hasText: text })).toContainText("Escrita por la clínica")
  }
  await knowsMust.getByRole("button", { name: "Editar: No ofrezcas descuentos." }).click()
  const editForm = sideSurface(page, { name: "Editar", exact: true })
  await expect(editForm.getByLabel("Qué debe saber", { exact: true })).toHaveValue("No ofrezcas descuentos.")
  await editForm.getByLabel("Qué debe saber", { exact: true }).fill("No ofrezcas descuentos ni promociones.")
  await editForm.getByRole("button", { name: "Guardar" }).click()
  await expect(editForm).toBeHidden()
  await expect(knowsMust).toContainText("No ofrezcas descuentos ni promociones.")
  await expect(knowsMust).toContainText("Despídete recordando la dirección.")
  await expect(knowsMust.getByRole("tab", { name: /^Escritas por la clínica · 2/ })).toBeVisible()

  // Le llegan todas en cada mensaje: hay un tope y se dice cuánto falta (ADR 0118).
  await expect(knowsMust).toContainText("2 de 40 reglas.")
  for (let index = 0; index < 38; index++) {
    await call(page, "POST", "/api/agent/learning/guidance", org.slug, { body: `Regla de relleno ${index + 1}.` }, 201)
  }
  await gotoHydrated(page, tenant(org.slug, "/agent/recepcion"))
  await expect(knowsMust).toContainText("40 de 40 reglas: para agregar otra, quita o une una.")
  await knowsMust.getByRole("button", { name: "Agregar" }).first().click()
  const fullForm = sideSurface(page, { name: "Agregar a lo que debe saber", exact: true })
  await fullForm.getByLabel("Qué debe saber", { exact: true }).fill("Una más.")
  await fullForm.getByRole("button", { name: "Guardar" }).click()
  await expect(fullForm).toContainText("Ya hay 40 reglas: quita o une una antes de agregar otra")
  await fullForm.getByRole("button", { name: "Cancelar" }).click()
  await expect(fullForm).toBeHidden()
  // Aprobar una regla nueva con el tope lleno pide elegir cuál reemplaza.
  await fixtureDb.insert(agentLesson).values({
    organizationId: org.id, kind: "regla", scope: "recepcion", title: "Saluda con el nombre de la clínica",
    body: "Saluda con el nombre de la clínica.", failure: "otra_cosa", status: "propuesta", proposedBy: owner.user.id,
  })
  await gotoHydrated(page, tenant(org.slug, "/agent/learn"))
  await page.getByRole("region", { name: /^Lecciones por aprobar/ }).getByRole("button", { name: /^Ver y aprobar/ }).click()
  const proposedRule = sideSurface(page, { name: "Lección propuesta", exact: true })
  await proposedRule.getByRole("button", { name: "Aprobar y activar" }).click()
  const replace = page.getByRole("alertdialog", { name: "Ya hay 40 reglas" })
  await expect(replace.getByRole("radio")).toHaveCount(40)
  await replace.getByRole("radio", { name: "Regla de relleno 1." }).click()
  await info.attach("reemplazar-una-regla", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await replace.getByRole("button", { name: "Reemplazar" }).click()
  await expect(replace).toBeHidden()
  await gotoHydrated(page, tenant(org.slug, "/agent/recepcion"))
  await expect(knowsMust).toContainText("Saluda con el nombre de la clínica.")
  await expect(knowsMust.getByRole("listitem").filter({ hasText: "Regla de relleno 1." })).toHaveCount(0)
  await expect(knowsMust).toContainText("40 de 40 reglas")

  // La base: lo fijo no se edita; la voz sí, con su muestra.
  await behaves.getByRole("button", { name: "Editar la base" }).click()
  const base = sideSurface(page, { name: "La base", exact: true })
  await expect(base.getByRole("heading", { name: "Quién es y cómo decide" })).toBeVisible()
  await expect(base).toContainText("No diagnostica, no receta y no decide por el profesional.")
  await expect(base).toContainText("No se cambia")
  await expect(base).toContainText("La editas tú")
  await expect(base.getByRole("heading", { name: "Encima de la base, cada agente suma lo suyo" })).toBeVisible()
  await base.getByLabel("Se presenta como").fill("Sofi")
  await base.getByRole("button", { name: "De usted" }).click()
  await expect(base).toContainText(`«¡Hola! Soy Sofi, asistente virtual de ${org.name}. ¿En qué le ayudo?»`)
  // Cada tono se explica con una línea; los emojis empiezan en «No usar».
  await expect(base.getByRole("group", { name: "Tono" })).toHaveAccessibleDescription("Amable y con confianza, como habla tu recepción.")
  await expect(base.getByRole("button", { name: "No usar" })).toHaveAttribute("aria-pressed", "true")
  await base.getByRole("button", { name: "Pocos" }).click()
  await expect(base).toContainText(`«¡Hola! 😊 Soy Sofi, asistente virtual de ${org.name}. ¿En qué le ayudo?»`)
  await info.attach("la-base", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await base.getByRole("button", { name: "Guardar" }).click()
  await expect(base).toBeHidden()
  await expect(behaves).toContainText("Se presenta como Sofi · trata de usted · tono cercano · pocos emojis")
  await expect(behaves).toContainText(`«¡Hola! 😊 Soy Sofi, asistente virtual de ${org.name}. ¿En qué le ayudo?»`)
  expect(await config()).toMatchObject({ personaName: "Sofi", emojis: "pocos" })
  // Nada técnico que decidir: el modelo lo elige odentIA (ADR 0052).
  await expect(page.getByRole("link", { name: /^Modelo del agente/ })).toHaveCount(0)
  await expect(page.getByRole("link", { name: /^Ajustes técnicos/ })).toHaveCount(0)

  // --- Probar (ADR 0094): una conversación real con Sofi, en la columna de la derecha, con la caja al pie ---
  const sandbox = page.getByRole("complementary", { name: "Probar" })
  await expect(sandbox).toContainText("Prueba · Sofi es real, pero no se envía nada y se borra en 7 días")
  const sandboxField = sandbox.getByRole("textbox", { name: "Mensaje de prueba" })
  await insideViewport(page, sandboxField)
  // Con Sofi apagada, la prueba responde igual: se prueba antes de encenderla.
  await sandbox.getByRole("button", { name: "Pregunta un precio" }).click()
  await expect(sandbox.getByText(FAKE_REPLY)).toHaveCount(1)
  // Los ejemplos son para empezar: con la conversación en marcha ya no están.
  await expect(sandbox.getByRole("group", { name: "Ejemplos" })).toHaveCount(0)
  // «Lo que hizo» va plegado bajo cada respuesta, para seguir la conversación.
  const detail = sandbox.getByRole("button", { name: /^Lo que hizo/ }).first()
  await expect(detail).toHaveAttribute("aria-expanded", "false")
  await expect(sandbox).not.toContainText("Modelo de demostración")
  await detail.click()
  // El modelo de las pruebas responde siempre lo mismo, y la pantalla lo dice.
  await expect(sandbox).toContainText("Modelo de demostración")
  await sandboxField.fill("¿Y atienden los sábados?")
  await sandbox.getByRole("button", { name: "Enviar el mensaje de prueba" }).click()
  await expect(sandbox.getByText(FAKE_REPLY)).toHaveCount(2)
  await expect.poll(async () => (await overview()).readiness.sandboxTurns).toBe(2)
  // Es una conversación real, pero de prueba: no aparece en la Bandeja.
  expect(await call<unknown[]>(page, "GET", "/api/conversations", org.slug)).toHaveLength(0)
  // Con la conversación en marcha, la caja sigue al pie.
  await insideViewport(page, sandboxField)

  // Guardar la prueba como caso: queda la pregunta que la abrió con su respuesta, una sola vez.
  await sandbox.getByRole("button", { name: "Más opciones de Probar" }).click()
  await page.getByRole("menuitem", { name: "Guardar como caso de prueba" }).click()
  await expect(sandbox.getByRole("status").filter({ hasText: "Guardada como caso de prueba: «Hola, ¿cuánto cuesta una limpieza?»" })).toBeVisible()
  expect(await call<Array<{ question: string; expected: string; lessonId: string | null }>>(page, "GET", "/api/agent/learning/cases", org.slug)).toEqual([
    expect.objectContaining({ question: "Hola, ¿cuánto cuesta una limpieza?", expected: FAKE_REPLY, lessonId: null }),
  ])
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("recepcion", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  // «Empezar de nuevo» borra la prueba con lo que creó y vuelve a los ejemplos.
  await sandbox.getByRole("button", { name: "Empezar de nuevo" }).click()
  await expect(sandbox.getByText(FAKE_REPLY)).toHaveCount(0)
  await expect(sandbox.getByRole("button", { name: "Pregunta un precio" })).toBeVisible()
  await expect(sandboxField).toBeFocused()

  // --- Encender: ya hay canal y ya se probó; no hay nivel que elegir ---
  await page.getByRole("switch", { name: "Encender a Sofi" }).click()
  await expect(turnOn).toContainText("Telegram")
  await expect(turnOn).toContainText("Cinco comprobaciones.")
  // El modelo de demostración responde: la quinta comprobación lo dice y deja encender.
  await expect(turnOn).toContainText("Responde · ChatGPT 6")
  await expect(turnOn).toContainText("2 mensajes de prueba respondidos")
  await expect(turnOn).toContainText("El canal y el modelo impiden encender; lo demás avisa.")
  await expect(turnOn.getByRole("button", { name: "Probar otra" })).toBeVisible()
  await expect(turnOn.getByRole("radio")).toHaveCount(0)
  await expect(turnOn).toContainText("Responde siempre al momento.")
  await expect(turnOn).toContainText("lo que esté a medias pasa a tu equipo.")
  await info.attach("encender", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await turnOn.getByRole("button", { name: "Encender a Sofi" }).click()
  await expect(turnOn).toBeHidden()
  await expect(page.getByRole("switch", { name: "Apagar a Sofi" })).toBeChecked()
  expect(await overview()).toMatchObject({ enabled: true })

  await gotoHydrated(page, tenant(org.slug, "/agent"))
  await expect(reception).toContainText("Encendido")
  await expect(reception).toContainText("Responde por Telegram")
  await info.attach("resumen-encendido", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Teléfono: cada agente es una fila tocable que lleva a su página, sin desbordes ---
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/agent"))
  const configure = reception.getByRole("link")
  await expect(configure).toContainText("Encendido")
  expect((await configure.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("resumen-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await configure.click()
  await expect(page.getByRole("heading", { level: 1, name: "Sofi, tu agente de recepción" })).toBeVisible()
  // Versión compacta: el estado y las conversaciones de hoy van en la cabecera; la franja «Hoy» no ocupa sitio.
  await expect(page.getByText("Encendido · 0 conversaciones hoy")).toBeVisible()
  await expect(today).toBeHidden()
  await expect(does.getByRole("switch", { name: "Oportunidades" })).not.toBeChecked()
  await expect(does.getByText("Busca horarios reales, reserva con el sí del paciente, reprograma y cancela.")).toBeHidden()
  await expect(knows.getByRole("link", { name: /^Qué sabe/ })).toContainText("lo que recuerda de cada persona")
  await expect(knows.getByRole("link", { name: /^Respuestas oficiales/ })).toBeHidden()
  const behaveRow = behaves.getByRole("button", { name: /^Cómo se comporta/ })
  await expect(behaveRow).toContainText("Sofi · de usted · tono cercano · pocos emojis")
  await expect(behaveRow).toHaveAttribute("aria-expanded", "false")
  await expect(behaves.getByRole("button", { name: "Editar la base" })).toBeHidden()
  await behaveRow.click()
  await expect(behaves.getByRole("button", { name: "Editar la base" })).toBeVisible()
  await behaveRow.click()
  // «Probar» queda fijo al pie, dentro de la pantalla, y la conversación no ocupa la página.
  const testButton = page.getByRole("button", { name: "Probar", exact: true })
  await expect(sandbox).toBeHidden()
  await insideViewport(page, testButton)
  expect((await testButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("recepcion-movil", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await info.attach("recepcion-movil-pantalla", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await reach.getByRole("button", { name: "Límites y cuándo pasa a una persona" }).click()
  const mobileLimits = page.getByRole("dialog", { name: "Límites de Sofi" })
  // Sin horario ni canales: Sofi responde siempre (ADR 0084).
  await expect(mobileLimits.getByText("A qué horas responde")).toHaveCount(0)
  await expect(mobileLimits.getByText("En qué canales responde")).toHaveCount(0)
  await expect(mobileLimits.getByLabel("Tope diario de respuestas")).toHaveCount(0)
  await expect(mobileLimits.getByLabel("Pasa siempre a una persona si mencionan")).toHaveValue("queja, reclamo")
  await info.attach("limites-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await mobileLimits.getByRole("button", { name: "Cancelar" }).click()
  await expect(mobileLimits).toBeHidden()

  // Probar en teléfono es el cajón a todo el alto: la caja al pie y los ejemplos en una fila.
  await testButton.click()
  const phoneTest = page.getByRole("dialog", { name: "Probar" })
  await expect(phoneTest).toBeVisible()
  const close = phoneTest.getByRole("button", { name: "Cerrar Probar" })
  const field = phoneTest.getByRole("textbox", { name: "Mensaje de prueba" })
  const sendButton = phoneTest.getByRole("button", { name: "Enviar el mensaje de prueba" })
  await insideViewport(page, field)
  await insideViewport(page, sendButton)
  expect((await sendButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  expect((await close.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  // Los ejemplos van en una sola fila que se desplaza sin ensanchar la página.
  const examples = phoneTest.getByRole("group", { name: "Ejemplos" }).getByRole("button")
  const tops = await examples.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await phoneTest.getByRole("button", { name: "Pregunta un precio" }).click()
  await expect(phoneTest.getByText(FAKE_REPLY)).toHaveCount(1)
  await field.fill("¿Y cuánto demora?")
  await sendButton.click()
  await expect(phoneTest.getByText(FAKE_REPLY)).toHaveCount(2)
  // Con la conversación más larga que la pantalla, el campo sigue a la vista.
  await insideViewport(page, field)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("probar-movil", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await close.click()
  await expect(phoneTest).toBeHidden()
  await expect(testButton).toBeFocused()

  // Apagar se confirma y dice qué pasa con lo que quedó a medias.
  await page.getByRole("switch", { name: "Apagar a Sofi" }).click()
  const turnOff = page.getByRole("alertdialog", { name: "Apagar a Sofi" })
  await expect(turnOff).toContainText("quedan para tu equipo")
  await turnOff.getByRole("button", { name: "Apagar" }).click()
  await expect(turnOff).toBeHidden()
  await expect.poll(async () => (await overview()).enabled).toBe(false)

  // Quien solo decide por el agente (recepción) no lo administra: lo decide el servidor.
  await fixtureDb.update(member).set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  expect((await api(page, "POST", "/api/agent/probar/messages", org.slug, { text: "Hola", clientMessageId: crypto.randomUUID() })).status).toBe(403)
  expect((await api(page, "PUT", "/api/agent/config", org.slug, { disabledFunctions: [] })).status).toBe(403)
})
