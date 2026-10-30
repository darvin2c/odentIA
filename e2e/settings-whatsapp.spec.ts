import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { channelConnection, conversation } from "@odentia/db/schema/crm"
import type { Page } from "@playwright/test"
import { and, eq } from "drizzle-orm"
import { simulateWhatsAppInbound } from "./channels"
import { API, tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/**
 * WhatsApp en Configuración y la Bandeja pasadas las 24 horas. Sin proveedor:
 * aquí no se llama a WhatsApp ni a Meta, así que nada de esto acredita que un
 * texto se apruebe ni que una clave funcione; se comprueba lo que hace odentIA.
 */

const PHONE_NUMBER_ID = "E2E-PNID"
const APP_SECRET = "e2e-secret"
/** Plantillas que el entorno da por aprobadas al declarar la conexión. */
const REMINDER = { name: "odentia_recordatorio_cita_v2", language: "es" }
const RESUME = { name: "odentia_retomar_conversacion_v1", language: "es" }

interface WhatsAppConnection {
  id: string
  webhookSecret: string
}

interface Conversation {
  id: string
  connection: { id: string }
}

interface MessageText {
  body: string
  status: string
}

interface ClinicMessage {
  id: string
  origin: string
  title: string
  current: MessageText
  pending: MessageText | null
}

interface ApprovedMessages {
  data: { id: string; title: string }[]
  none: { text: string; fixHref: string | null } | null
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

function createWhatsApp(page: Page, slug: string, templates: Array<{ name: string; language: string }>) {
  return call<WhatsAppConnection>(
    page,
    "POST",
    "/api/channels/connections",
    slug,
    {
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: "WA E2E",
      config: { phoneNumberId: PHONE_NUMBER_ID, wabaId: "E2E-WABA", accessToken: "e2e", appSecret: APP_SECRET, templates },
    },
    201,
  )
}

const messagesOf = (page: Page, slug: string, connectionId: string) =>
  call<ClinicMessage[]>(page, "GET", `/api/channels/connections/${connectionId}/messages`, slug)

/** Lo que hace Meta al guardar la dirección de avisos: preguntar con la clave de verificación. */
function verifyAddress(page: Page, connectionId: string, verifyToken: string): Promise<number> {
  return page.evaluate(
    async ({ apiBase, connectionId, verifyToken }) => {
      const query = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "e2e" })
      const response = await fetch(`${apiBase}/api/webhooks/channels/whatsapp_cloud_api/${connectionId}?${query}`)
      return response.status
    },
    { apiBase: API, connectionId, verifyToken },
  )
}

function writeToClinic(page: Page, connectionId: string, text: string): Promise<number> {
  return simulateWhatsAppInbound(page, API, connectionId, APP_SECRET, {
    from: "51911122233",
    phoneNumberId: PHONE_NUMBER_ID,
    text,
    wamid: `wamid.${randomUUID()}`,
  })
}

async function waitForConversation(page: Page, slug: string, connectionId: string): Promise<Conversation> {
  const find = async () =>
    (await call<Conversation[]>(page, "GET", "/api/conversations", slug)).find((item) => item.connection.id === connectionId)
  await expect.poll(async () => (await find())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const found = await find()
  if (!found) throw new Error("La conversación no apareció")
  return found
}

test("whatsapp: se conecta con los datos de la app de Meta en tres pasos que se comprueban solos y se retoma donde quedó", async ({ owner }, info) => {
  const { page, org } = owner
  const connections = () => call<Array<{ id: string; channel: string }>>(page, "GET", "/api/channels/connections", org.slug)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("WhatsApp")
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)

  // Sin conectar: los dos caminos en una pantalla. El botón de Facebook no existe sin la app de odentIA en Meta.
  const steps = page.getByRole("region", { name: "Conectar con los datos de mi app de Meta" })
  await expect(steps).toBeVisible()
  await expect(page.getByRole("button", { name: /Conectar con Facebook/ })).toHaveCount(0)
  await expect(steps.getByRole("listitem")).toHaveCount(3)
  // Los datos se piden con su nombre en palabras; el nombre técnico no llega a la pantalla.
  await expect(steps).not.toContainText(/phoneNumberId|wabaId|accessToken|appSecret/)
  await expect(steps).toContainText("En Meta se llama «Phone number ID».")

  // Sin los datos no conecta, lo dice en cada campo y el foco va al primero.
  await steps.getByRole("button", { name: "Comprobar", exact: true }).click()
  await expect(steps.getByText("Escribe este dato.", { exact: true })).toHaveCount(4)
  await expect(steps.getByLabel("Identificador del número", { exact: true })).toBeFocused()
  expect((await connections()).filter((item) => item.channel === "whatsapp")).toEqual([])

  await steps.getByLabel("Identificador del número", { exact: true }).fill(PHONE_NUMBER_ID)
  await steps.getByLabel("Identificador de la cuenta", { exact: true }).fill("E2E-WABA")
  const key = steps.getByLabel("Clave de acceso permanente", { exact: true })
  await expect(key).toHaveAttribute("type", "password")
  await key.fill("e2e")
  await steps.getByLabel("Clave secreta de la app", { exact: true }).fill(APP_SECRET)
  await steps.getByRole("button", { name: "Comprobar", exact: true }).click()

  // Paso 1 hecho: dice lo que encontró (aquí no se le pregunta a WhatsApp, así que solo que quedó guardada).
  const finishing = page.getByRole("region", { name: "Termina de conectar WhatsApp" })
  await expect(finishing).toContainText("La conexión quedó guardada")
  const [created] = (await connections()).filter((item) => item.channel === "whatsapp")
  if (!created) throw new Error("La conexión de WhatsApp no se creó")
  await finishing.getByRole("button", { name: "Continuar", exact: true }).click()

  // Paso 2: la dirección y su clave, siempre a la vista, con «Copiar».
  const address = finishing.getByLabel("Dirección de odentIA", { exact: true })
  const token = finishing.getByLabel("Clave de verificación", { exact: true })
  await expect(address).toHaveValue(new RegExp(`/api/webhooks/channels/whatsapp_cloud_api/${created.id}$`))
  await expect(token).toHaveValue(/\S+/)
  const verifyToken = await token.inputValue()
  await expect(finishing.getByRole("button", { name: "Copiar dirección de odentia", exact: true })).toBeVisible()
  await expect(finishing.getByRole("status").filter({ hasText: "Esperando a Meta." })).toBeVisible()
  await expect(page.getByRole("region", { name: "Conexión", exact: true })).toContainText("Falta un paso.")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-paso-2", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Se puede cerrar y volver: sigue en el paso que falta, con la misma clave.
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  await expect(token).toHaveValue(verifyToken)
  await expect(finishing.getByRole("status").filter({ hasText: "Esperando a Meta." })).toBeVisible()

  // La pantalla detecta sola que Meta verificó la dirección…
  expect(await verifyAddress(page, created.id, verifyToken)).toBe(200)
  await expect(finishing.getByRole("status").filter({ hasText: "Esperando el primer mensaje." })).toBeVisible({ timeout: 20_000 })
  await expect(finishing.getByRole("status").filter({ hasText: "Meta verificó la dirección." })).toBeVisible()

  // …y el primer mensaje. Al terminar dice lo que quedó y lo que falta fuera de odentIA.
  expect(await writeToClinic(page, created.id, "hola")).toBe(200)
  const connected = page.getByRole("region", { name: "WhatsApp quedó conectado" })
  await expect(connected).toBeVisible({ timeout: 30_000 })
  await expect(connected).toContainText("Ya recibe mensajes.")
  // Al conectar se piden los trece mensajes de odentIA: los diez del agente y los tres que envía el equipo
  // («Retomar la conversación», «Presupuesto listo» y «Su enlace»).
  await expect(connected).toContainText("16 mensajes están en revisión de WhatsApp.")
  await expect(connected).toContainText("WhatsApp pide una forma de pago en tu cuenta para enviar mensajes aprobados")
  await expect(connected.getByRole("link", { name: /Abrir mi cuenta de Meta/ })).toHaveAttribute("href", /^https:\/\/business\.facebook\.com\//)
  await expect(finishing).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Conexión", exact: true })).toContainText("Conectado.")
  await info.attach("whatsapp-conectado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await connected.getByRole("button", { name: "Ver mis mensajes", exact: true }).click()
  await expect(connected).toHaveCount(0)
  await expect(page.getByRole("heading", { level: 2, name: "Mensajes", exact: true })).toBeFocused()
})

test("whatsapp: con la propia app de Meta, los pasos se abren al elegirla, hay guía y lo que falta en Meta se arregla desde la tarjeta", async ({
  owner,
  fixtureDb,
}, info) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  // Aquí no existe la app de odentIA en Meta: se responde como si el botón estuviera, para ver los dos caminos.
  await page.route("**/api/channels/whatsapp/signup", (route) =>
    route.fulfill({ json: { data: { enabled: true, appId: "APP-E2E", configId: "CONFIG-E2E", graphVersion: "v25.0" } } }),
  )
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  await expect(page.getByRole("heading", { level: 3, name: "Con tu Facebook", exact: true })).toBeVisible()
  const steps = page.getByRole("region", { name: "Con tu propia app de Meta", exact: true })
  // Los tres pasos no se ofrecen hasta elegir ese camino: nadie empieza por el largo sin querer.
  await expect(steps).toHaveCount(0)
  await page.getByRole("button", { name: "Usar mi propia app", exact: true }).click()
  await expect(steps).toBeVisible()
  await expect(steps.getByRole("listitem")).toHaveCount(3)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-dos-caminos", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // La guía, de cero a la app publicada, con el enlace a cada página de Meta.
  await steps.getByRole("button", { name: "Ver la guía", exact: true }).click()
  const guide = page.getByRole("heading", { name: "Cómo crear tu app de Meta" })
  await expect(guide).toBeVisible()
  await expect(page.getByRole("heading", { level: 3, name: /Publicar la app/ })).toBeVisible()
  await expect(page.getByText("whatsapp_business_messaging", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: /Abrir Usuarios del sistema/ })).toHaveAttribute("href", /^https:\/\/business\.facebook\.com\//)
  await info.attach("whatsapp-guia", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Una conexión con la app propia cuyo número ya tenía PIN, como la dejaría Meta: lo dice la tarjeta y pide el PIN.
  const created = await createWhatsApp(page, org.slug, [])
  await fixtureDb
    .update(channelConnection)
    .set({
      webhookVerifiedAt: new Date(),
      ownApp: {
        registeredAt: null,
        subscribedAt: new Date().toISOString(),
        problems: { registrar: "Este número ya tiene un PIN de verificación en dos pasos. Escríbelo para registrarlo." },
        pinNeeded: true,
        tokenExpiresAt: null,
        keysCheckedAt: new Date().toISOString(),
      },
    })
    .where(eq(channelConnection.id, created.id))
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  const card = page.getByRole("region", { name: "Conexión", exact: true })
  await expect(card).toContainText("Necesita atención.")
  await expect(card).toContainText("Falta registrar el número en WhatsApp.")
  await expect(card).toContainText("Tu app recibe los avisos de esta cuenta.")
  await card.getByLabel("PIN de 6 dígitos del número", { exact: true }).fill("12")
  await card.getByRole("button", { name: "Registrar el número", exact: true }).click()
  await expect(card.getByText("El PIN tiene 6 dígitos.", { exact: true })).toBeVisible()
  await expect(card.getByLabel("PIN de 6 dígitos del número", { exact: true })).toBeFocused()
  // Aquí no se llama a Meta: «Volver a comprobar» lo dice y no afirma nada.
  await card.getByRole("button", { name: "Volver a comprobar", exact: true }).click()
  await expect(card.getByRole("status").filter({ hasText: "En este entorno no se llama a Meta" })).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-necesita-atencion", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(card).toContainText("Necesita atención.")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-necesita-atencion-telefono", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // «Pedir ayuda» abre la Ayuda con el mensaje a soporte ya escrito, sin claves; la persona lo envía.
  await card.getByRole("button", { name: /Pedir ayuda a/ }).click()
  const draft = page.getByLabel(/Tu mensaje para/)
  await expect(draft).toHaveValue(/Me trabé conectando WhatsApp con mi propia app de Meta/)
  await expect(draft).not.toHaveValue(new RegExp(APP_SECRET))
})

test("whatsapp: la lista de mensajes, abrir uno, cambiarle el texto y verlo en revisión, crear uno propio y eliminarlo", async ({ owner }, info) => {
  const { page, org } = owner
  const wa = await createWhatsApp(page, org.slug, [REMINDER, RESUME])
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))

  // --- La conexión: con qué cuenta, cómo está y qué se puede hacer ---
  const card = page.getByRole("region", { name: "Conexión", exact: true })
  await expect(card.getByRole("heading", { level: 2 })).toHaveText("WA E2E")
  await card.getByRole("button", { name: "Probar conexión", exact: true }).click()
  // Sin proveedor no se afirma que funcione: el servidor dice por qué no pudo probar.
  await expect(card.getByRole("status").filter({ hasText: "no se puede probar la conexión" })).toBeVisible()
  await card.getByRole("button", { name: "Desconectar", exact: true }).click()
  const disconnect = page.getByRole("alertdialog", { name: "Desconectar WhatsApp" })
  await expect(disconnect).toContainText("Los mensajes de WhatsApp dejarán de llegar a la Bandeja")
  await disconnect.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(disconnect).toBeHidden()
  // «Cambiar la clave» pide solo las claves y no crea otra conexión.
  await card.getByRole("button", { name: "Cambiar la clave", exact: true }).click()
  const keyForm = surface(page, { name: "Cambiar la clave de WhatsApp", exact: true })
  await expect(keyForm.getByLabel("Identificador del número", { exact: true })).toHaveCount(0)
  await keyForm.getByLabel("Clave de acceso permanente", { exact: true }).fill("e2e-nueva")
  await keyForm.getByRole("button", { name: "Guardar la clave", exact: true }).click()
  await expect(card.getByRole("status").filter({ hasText: "Clave cambiada." })).toBeVisible()
  const whatsapps = (await call<Array<{ id: string; channel: string }>>(page, "GET", "/api/channels/connections", org.slug)).filter(
    (item) => item.channel === "whatsapp",
  )
  expect(whatsapps.map((item) => item.id)).toEqual([wa.id])

  // --- Los mensajes, en dos grupos, con su estado en palabras ---
  const messages = page.getByRole("region", { name: "Mensajes", exact: true })
  const byAgent = messages.getByRole("group", { name: "Los envía Argos" })
  const byTeam = messages.getByRole("group", { name: "Los envía tu equipo desde la Bandeja" })
  // Uno por línea que escribe y los cuatro avisos de «Recordar la cita» (reservada, reservada con datos que
  // faltan, cambio de fecha, cancelada).
  await expect(byAgent.getByRole("listitem")).toHaveCount(12)
  // «Retomar una oportunidad» viene escrito como los demás del agente.
  await expect(byAgent.getByRole("listitem").filter({ hasText: "Retomar una oportunidad" })).toContainText("En revisión")
  await expect(byTeam.getByRole("listitem")).toHaveCount(4)
  await expect(messages).toContainText("2 aprobados · 14 en revisión")
  // Nadie lee ni escribe nombres técnicos.
  await expect(messages).not.toContainText(/odentia_|plantilla|template/i)
  const reminder = byAgent.getByRole("listitem").filter({ has: page.getByText("Recordar la cita", { exact: true }) })
  await expect(reminder).toContainText("Aprobado")
  // Recién creada la clínica, «Recordar la cita» ya viene prendida (ADR 0026); las demás líneas, apagadas.
  await expect(reminder).toContainText("Línea prendida")
  await expect(byAgent.getByRole("listitem").filter({ hasText: "Retomar una oportunidad" })).toContainText("Línea apagada")
  await expect(byTeam.getByRole("listitem").filter({ hasText: "Retomar la conversación" })).toContainText("Viene con odentIA")
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-mensajes", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // --- Abrir uno: cómo está, cómo le llega a la persona y qué hacen sus botones ---
  const openReminder = reminder.getByRole("button")
  await openReminder.click()
  const panel = surface(page, { name: "Recordar la cita", exact: true })
  await expect(panel).toContainText("Aprobado")
  await expect(panel.getByRole("region", { name: "Así le llega a la persona" })).toContainText("Te recordamos la cita en")
  await expect(panel.getByRole("region", { name: "Qué pasa cuando toca un botón" })).toContainText("La cita queda confirmada al momento.")
  // «Ver la línea» lleva a Agente: quien administra puede abrirla.
  await expect(panel.getByRole("link", { name: "Ver la línea", exact: true })).toHaveAttribute("href", /\/agent\/administrador\?linea=recordatorio_cita$/)

  // --- Editar: cada dato se ve como su nombre entre corchetes; las comprobaciones del servidor se dicen en su campo ---
  await panel.getByRole("button", { name: "Editar el texto", exact: true }).click()
  const editor = surface(page, { name: "Editar «Recordar la cita»", exact: true })
  const text = editor.getByLabel("Texto", { exact: true })
  await expect(text).toBeFocused()
  await expect(text).toHaveValue(/\[Nombre de la persona\]/)
  await expect(text).not.toHaveValue(/\{\{/)
  await expect(editor).toContainText("Al guardar, WhatsApp lo revisa de nuevo")
  await expect(editor).toContainText("Mientras tanto sigue saliendo el texto actual.")
  const original = await text.inputValue()
  const send = editor.getByRole("button", { name: "Enviar a revisión", exact: true })
  // Sin cambios no hay nada que enviar: el servidor lo dice junto al texto.
  await send.click()
  await expect(text).toHaveAttribute("aria-invalid", "true")
  await expect(editor).toContainText("Ese es el texto que ya tiene.")
  // Quitar un dato lo dice con la frase del servidor, junto al texto, y no lo envía.
  await text.fill(original.replace("[Clínica y sede]", "la clínica"))
  await expect(text).not.toHaveAttribute("aria-invalid", "true")
  await send.click()
  await expect(text).toHaveAttribute("aria-invalid", "true")
  await expect(editor).toContainText("Falta el dato «Clínica y sede».")
  // «Poner…» lo devuelve donde está el cursor.
  await editor.getByRole("button", { name: "Poner «Clínica y sede»", exact: true }).click()
  await expect(text).toBeFocused()
  await expect(text).toHaveValue(/\[Clínica y sede\]/)
  // Escribir (o poner el dato) borra el error del campo.
  await expect(text).not.toHaveAttribute("aria-invalid", "true")
  // Cancelar con cambios pregunta antes y, si se desiste, el borrador sigue ahí.
  await editor.getByRole("button", { name: "Cancelar", exact: true }).click()
  const leave = page.getByRole("alertdialog", { name: "¿Salir sin guardar?" })
  await leave.getByRole("button", { name: "Continuar editando", exact: true }).click()
  await expect(leave).toBeHidden()
  await expect(text).toHaveValue(/\[Clínica y sede\]/)

  const changed = original.replace("Te recordamos", "Le recordamos")
  await text.fill(changed)
  await expect(editor.getByRole("region", { name: "Así le llegará" })).toContainText("Le recordamos")
  await send.click()

  // Un cambio nunca deja a la clínica sin mensaje: el nuevo espera y el aprobado sigue saliendo.
  await expect(panel.getByRole("status").filter({ hasText: "Enviado a revisión de WhatsApp." })).toBeVisible()
  const change = panel.getByRole("region", { name: "Tu cambio de texto" })
  await expect(change).toContainText("En revisión")
  await expect(change).toContainText("Tu cambio de texto está en revisión; sigue saliendo el anterior.")
  await expect(reminder).toContainText("Aprobado")
  await expect(reminder).toContainText("Tu cambio de texto está en revisión; sigue saliendo el anterior.")
  const saved = (await messagesOf(page, org.slug, wa.id)).find((item) => item.id === "recordatorio_cita")
  expect(saved?.current.status).toBe("aprobada")
  expect(saved?.pending?.status).toBe("en_revision")
  // Al servidor viaja con los datos por nombre, no con los corchetes de la pantalla.
  expect(saved?.pending?.body).toContain("Le recordamos")
  expect(saved?.pending?.body).toContain("{{persona}}")
  expect(saved?.pending?.body).not.toContain("[")
  await info.attach("whatsapp-cambio-en-revision", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await panel.getByRole("button", { name: "Cerrar", exact: true }).click()
  await expect(panel).toBeHidden()
  // El foco vuelve a la fila que abrió el panel.
  await expect(openReminder).toBeFocused()

  // --- Crear uno propio: para qué sirve, el texto con sus dos datos y un botón de respuesta ---
  await messages.getByRole("button", { name: "Nuevo mensaje", exact: true }).click()
  const creator = surface(page, { name: "Nuevo mensaje", exact: true })
  await creator.getByLabel("Para qué sirve", { exact: true }).fill("Tu trabajo ya está listo")
  const ownText = creator.getByLabel("Texto", { exact: true })
  await ownText.fill("Hola, ")
  await creator.getByRole("button", { name: "Poner «Nombre de la persona»", exact: true }).click()
  await expect(ownText).toHaveValue("Hola, [Nombre de la persona]")
  // Solo se ofrecen los dos datos que el servidor entrega para un mensaje del equipo.
  await expect(creator.getByRole("group", { name: "Datos que pone el sistema" }).getByRole("button")).toHaveText([
    "Poner «Nombre de la persona»",
    "Poner «Nombre de la clínica»",
  ])
  await ownText.pressSequentially(". Tu trabajo ya llegó a la clínica. Escríbenos y coordinamos tu cita.")
  await creator.getByLabel("Botón de respuesta (opcional)", { exact: true }).fill("Quiero mi cita")
  await creator.getByRole("button", { name: "Enviar a revisión", exact: true }).click()

  const own = byTeam.getByRole("listitem").filter({ hasText: "Tu trabajo ya está listo" })
  await expect(own).toContainText("Lo creó la clínica")
  await expect(own).toContainText("En revisión")
  const ownPanel = surface(page, { name: "Tu trabajo ya está listo", exact: true })
  await expect(ownPanel.getByRole("region", { name: "Así le llega a la persona" })).toContainText("Quiero mi cita")
  const createdMessage = (await messagesOf(page, org.slug, wa.id)).find((item) => item.title === "Tu trabajo ya está listo")
  expect(createdMessage).toMatchObject({ origin: "clinica", current: { status: "en_revision" } })
  expect(createdMessage?.current.body).toContain("{{persona}}")

  // --- Eliminar: solo los propios, con confirmación ---
  await ownPanel.getByRole("button", { name: "Eliminar", exact: true }).click()
  const remove = page.getByRole("alertdialog", { name: "Eliminar este mensaje" })
  await expect(remove).toContainText("dejará de ofrecerse en la Bandeja")
  await remove.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(own).toHaveCount(1)
  await ownPanel.getByRole("button", { name: "Eliminar", exact: true }).click()
  await remove.getByRole("button", { name: "Eliminar", exact: true }).click()
  await expect(own).toHaveCount(0)
  await expect(ownPanel).toBeHidden()
  // La lista se oculta antes de que el servidor termine de eliminarlo: se espera a que deje de estar.
  await expect.poll(async () => (await messagesOf(page, org.slug, wa.id)).some((item) => item.title === "Tu trabajo ya está listo")).toBe(false)
  // Uno que viene con odentIA no ofrece eliminarse, y el servidor tampoco lo deja.
  await byTeam.getByRole("listitem").filter({ hasText: "Retomar la conversación" }).getByRole("button").click()
  const resumePanel = surface(page, { name: "Retomar la conversación", exact: true })
  await expect(resumePanel.getByRole("button", { name: "Editar el texto", exact: true })).toBeVisible()
  await expect(resumePanel.getByRole("button", { name: "Eliminar", exact: true })).toHaveCount(0)
  expect((await api(page, "DELETE", `/api/channels/connections/${wa.id}/messages/retomar_conversacion`, org.slug)).status).toBe(400)
  await resumePanel.getByRole("button", { name: "Cerrar", exact: true }).click()

  // --- Teléfono: una columna, filas que se tocan y «Nuevo mensaje» fijo al pie ---
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(messages).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  const rowBox = await reminder.getByRole("button").boundingBox()
  expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(44)
  const fixed = page.getByRole("button", { name: "Nuevo mensaje", exact: true })
  await expect(fixed).toHaveCount(1)
  const fixedBox = await fixed.boundingBox()
  expect(Math.round((fixedBox?.y ?? 0) + (fixedBox?.height ?? 0))).toBeGreaterThan(844 - 40)
  await info.attach("whatsapp-telefono", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
})

test("whatsapp: al desconectar el número se puede conectar otro y el anterior queda de historial", async ({ owner }, info) => {
  const { page, org } = owner
  const first = await createWhatsApp(page, org.slug, [REMINDER, RESUME])
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  const another = page.getByRole("heading", { name: "Conecta otro número de WhatsApp", exact: true })

  // Conectado: no se ofrece otro número.
  const card = page.getByRole("region", { name: "Conexión", exact: true })
  await expect(card.getByRole("button", { name: "Probar conexión", exact: true })).toBeVisible()
  await expect(another).toHaveCount(0)
  await info.attach("whatsapp-un-numero-conectado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Desconectado: la conexión sigue ahí con su «Volver a conectar» y ya se puede conectar otro número.
  await card.getByRole("button", { name: "Desconectar", exact: true }).click()
  await page.getByRole("alertdialog", { name: "Desconectar WhatsApp" }).getByRole("button", { name: "Desconectar", exact: true }).click()
  await expect(card).toContainText("Desconectado.")
  await expect(card.getByRole("button", { name: "Volver a conectar", exact: true })).toBeVisible()
  await expect(another).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-desconectado-conectar-otro", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(another).toBeVisible()
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-desconectado-conectar-otro-telefono", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 1440, height: 900 })

  // Con otro número conectado, el anterior queda desconectado, sin volver a conectarlo, y no se ofrece un tercero.
  const second = await call<WhatsAppConnection>(
    page,
    "POST",
    "/api/channels/connections",
    org.slug,
    {
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: "WA E2E nuevo",
      config: { phoneNumberId: `${PHONE_NUMBER_ID}-2`, wabaId: "E2E-WABA-2", accessToken: "e2e", appSecret: APP_SECRET, templates: [REMINDER, RESUME] },
    },
    201,
  )
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/whatsapp"))
  const current = page.getByRole("region", { name: "Conexión de WA E2E nuevo", exact: true })
  await expect(current.getByRole("button", { name: "Probar conexión", exact: true })).toBeVisible()
  await expect(current).not.toContainText("Desconectado.")
  const previous = page.getByRole("region", { name: "Conexión de WA E2E", exact: true })
  await expect(previous).toContainText("Desconectado.")
  await expect(previous).toContainText("Número anterior.")
  await expect(previous.getByRole("button", { name: "Volver a conectar", exact: true })).toHaveCount(0)
  await expect(another).toHaveCount(0)
  await info.attach("whatsapp-numero-anterior", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("whatsapp-numero-anterior-telefono", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Las dos conexiones se conservan: nada se borró.
  const whatsapps = (await call<Array<{ id: string; channel: string }>>(page, "GET", "/api/channels/connections", org.slug)).filter(
    (item) => item.channel === "whatsapp",
  )
  expect(whatsapps.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
})

test("bandeja: pasadas las 24 horas lo dice antes de escribir, ofrece el mensaje aprobado por lo que dice y lo envía", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  const wa = await createWhatsApp(page, org.slug, [RESUME])
  expect(await writeToClinic(page, wa.id, "Hola, ¿atienden los sábados por la tarde?")).toBe(200)
  const thread = await waitForConversation(page, org.slug, wa.id)
  const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 3_600_000)
  const age = () => fixtureDb.update(conversation).set({ lastInboundAt: twoDaysAgo() }).where(eq(conversation.id, thread.id))
  const approved = async () => {
    const result = await api<ApprovedMessages>(page, "GET", `/api/conversations/${thread.id}/approved-messages`, org.slug)
    expect(result.status).toBe(200)
    return result.body
  }
  await age()
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${thread.id}`))

  // Lo dice antes de escribir: no hay campo libre que falle al enviar.
  const notice = page.getByRole("status").filter({ hasText: "Pasaron 24 horas desde su último mensaje" })
  await expect(notice).toContainText("hace 2 días")
  await expect(notice).toContainText("WhatsApp solo deja enviarle un mensaje aprobado")
  await expect(page.getByLabel("Mensaje", { exact: true })).toHaveCount(0)

  // Los mensajes se eligen por lo que dicen, con los datos de esa persona ya puestos.
  const options = page.getByRole("radiogroup", { name: "Elige el mensaje" })
  const resume = options.getByRole("radio", { name: /Retomar la conversación/ })
  await expect(options.getByRole("radio")).toHaveCount(1)
  await expect(resume).toBeChecked()
  await expect(options).toContainText("para continuar con tu consulta. ¿Seguimos por aquí?")
  await expect(options).toContainText("Sí, continuemos")
  // Ni nombres técnicos ni «parámetros»: ningún dato se pide a quien envía.
  await expect(options).not.toContainText(/odentia_|\{\{|plantilla/i)
  await expect(page.getByPlaceholder(/parámetros/i)).toHaveCount(0)
  await expect(options.getByRole("textbox")).toHaveCount(0)
  expect(await overflow(page)).toBeLessThanOrEqual(0)
  await info.attach("bandeja-ventana-cerrada", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Los seis que envía el agente no se ofrecen aquí.
  expect((await approved()).data.map((item) => item.id)).toEqual(["retomar_conversacion"])

  await page.getByRole("button", { name: "Enviar mensaje", exact: true }).click()
  // Queda en el hilo con su texto armado, y la zona dice cuándo se le podrá escribir.
  const waiting = page.getByRole("status").filter({ hasText: "Ya se le envió un mensaje aprobado" })
  await expect(waiting).toContainText("Cuando responda podrás escribirle con libertad")
  await expect(options).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Enviar mensaje", exact: true })).toHaveCount(0)
  // La lista de opciones ya no está: lo que queda con ese texto es el mensaje enviado.
  await expect(page.getByText(/para continuar con tu consulta\. ¿Seguimos por aquí\?/).first()).toBeVisible()
  const after = await approved()
  expect(after.data).toEqual([])
  expect(after.none?.fixHref).toBeNull()
  // No se envía un segundo mensaje aprobado mientras no responda: el servidor lo rechaza con su frase.
  const second = await api<{ error: { code: string } }>(page, "POST", `/api/conversations/${thread.id}/messages/approved`, org.slug, {
    messageId: "retomar_conversacion",
  })
  expect(second.status).toBe(409)
  expect(second.body.error.code).toBe("APPROVED_MESSAGE_UNAVAILABLE")
  await info.attach("bandeja-mensaje-aprobado-enviado", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })

  // Cuando la persona responde, se le vuelve a escribir con libertad.
  expect(await writeToClinic(page, wa.id, "Sí, continuemos")).toBe(200)
  const composer = page.getByLabel("Mensaje", { exact: true })
  await expect(composer).toBeVisible({ timeout: 30_000 })

  // Si la ventana se cierra mientras se escribe, lo escrito no se pierde.
  await composer.fill("Sí atendemos los sábados, hasta las 6.")
  await age()
  await composer.press("Enter")
  await expect(page.getByRole("status").filter({ hasText: "WhatsApp solo deja enviarle un mensaje aprobado" })).toBeVisible()
  await expect(page.getByText("Lo que habías escrito se conserva", { exact: true })).toBeVisible()
  await expect(page.getByText("Sí atendemos los sábados, hasta las 6.", { exact: true })).toBeVisible()
})

test("bandeja: sin ningún mensaje aprobado dice por qué, y solo quien puede abrir Configuración ve «Ver los mensajes»", async ({ owner, fixtureDb }, info) => {
  const { page, org } = owner
  // Sin plantillas aprobadas: «Retomar la conversación» queda en revisión al conectar.
  const wa = await createWhatsApp(page, org.slug, [])
  expect(await writeToClinic(page, wa.id, "Hola, quiero una cita")).toBe(200)
  const thread = await waitForConversation(page, org.slug, wa.id)
  await fixtureDb
    .update(conversation)
    .set({ lastInboundAt: new Date(Date.now() - 2 * 24 * 3_600_000) })
    .where(eq(conversation.id, thread.id))
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${thread.id}`))

  const none = page.getByRole("status").filter({ hasText: "Aún no se le puede escribir" })
  await expect(none).toContainText("«Retomar la conversación» está en revisión")
  await expect(page.getByRole("radiogroup", { name: "Elige el mensaje" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Enviar mensaje", exact: true })).toHaveCount(0)
  await info.attach("bandeja-sin-mensaje-aprobado", { body: await page.screenshot({ fullPage: false }), contentType: "image/png" })
  await none.getByRole("link", { name: "Ver los mensajes", exact: true }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/integrations/whatsapp"))
  await expect(page.getByRole("region", { name: "Mensajes", exact: true })).toContainText("16 en revisión")

  // Recepción atiende conversaciones pero no abre Configuración: lee a quién avisar, sin enlace.
  await fixtureDb
    .update(member)
    .set({ role: "reception" })
    .where(and(eq(member.organizationId, org.id), eq(member.userId, owner.user.id)))
  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${thread.id}`))
  // Dice a quién pedírselo: por su nombre, o quien administra la clínica si ya no queda nadie con ese rol.
  await expect(none).toContainText(/Pídeselo a .+ administran? la clínica\./)
  await expect(none.getByRole("link")).toHaveCount(0)
  // Ocultar el enlace no es lo que protege: el servidor tampoco le entrega los mensajes de Configuración.
  expect((await api(page, "GET", `/api/channels/connections/${wa.id}/messages`, org.slug)).status).toBe(403)
})
