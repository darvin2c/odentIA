import type { Browser, Locator, Page, Route } from "@playwright/test"
import { tenant, tenantPattern } from "./env"
import { call, expect, type OwnerFixture, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface } from "./surface"

/** Los quince apartados de quien es dueña: el nombre de la lista es el título de su página. */
const SECTIONS: Array<[string, string]> = [
  ["Datos de la clínica", "/settings"],
  ["Sedes", "/settings/branches"],
  ["Equipo", "/settings/team"],
  ["Horarios y ausencias", "/settings/availability"],
  ["Protección de datos", "/settings/data-protection"],
  ["Especialidades", "/settings/specialties"],
  ["Consentimientos", "/settings/forms"],
  ["Registro de pacientes", "/settings/patient-registration"],
  ["Portal del paciente", "/settings/patient-access"],
  ["Medios de pago y ticket", "/settings/payment-methods"],
  ["Etapas de venta", "/settings/pipelines"],
  // Solo para quien ve Facturación (ADR 0065); la dueña la ve.
  ["Plan y pagos", "/settings/plan"],
  ["Integraciones", "/settings/integrations"],
  ["Actividad del equipo", "/settings/audit"],
]

type Connection = { id: string; channel: string; status: string }

/** Respuesta simulada del servidor para una petición de la página, con su mismo CORS. */
async function reply(page: Page, route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify(body),
  })
}

/** La fila de una integración dentro de su bloque, por su nombre. */
function rowOf(block: Locator, name: string): Locator {
  return block.getByRole("listitem").filter({ has: block.page().getByRole("heading", { name, exact: true }) })
}

async function withTouchPage(browser: Browser, owner: OwnerFixture, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({
    storageState: await owner.context.storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    ignoreHTTPSErrors: true,
  })
  try {
    await run(await context.newPage())
  } finally {
    await context.close()
  }
}

test("configuración: lista por grupos, cada apartado con su nombre y direcciones antiguas que redirigen", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/settings"))
  const nav = page.getByRole("navigation", { name: "Configuración" })
  const title = page.getByRole("heading", { level: 1 })

  await expect(nav.getByRole("link")).toHaveText(SECTIONS.map(([name]) => name))
  await expect(nav.getByRole("group", { name: "La clínica", exact: true }).getByRole("link")).toHaveText([
    "Datos de la clínica",
    "Sedes",
    "Equipo",
    "Horarios y ausencias",
    "Protección de datos",
  ])
  await expect(nav.getByRole("group", { name: "Ventas y cobros", exact: true }).getByRole("link")).toHaveText([
    "Medios de pago y ticket",
    "Etapas de venta",
  ])

  // El nombre de la lista es el título de la página, y la lista sigue ahí al entrar
  // (Sedes y Equipo ya no salen del marco de Configuración).
  for (const [name, path] of SECTIONS) {
    const link = nav.getByRole("link", { name, exact: true })
    await link.click()
    await expect(page).toHaveURL(tenantPattern(org.slug, path))
    await expect(title).toHaveText(name)
    await expect(title).toHaveCount(1)
    await expect(link).toHaveAttribute("aria-current", "page")
    await expect(nav.locator("[aria-current='page']")).toHaveCount(1)
  }

  // Las direcciones antiguas redirigen conservando la búsqueda.
  await gotoHydrated(page, tenant(org.slug, "/branches?q=Central&estado=activa"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/branches?q=Central&estado=activa"))
  await expect(title).toHaveText("Sedes")
  await expect(page.getByText("Sede Central")).toBeVisible()
  await gotoHydrated(page, tenant(org.slug, "/members?rol=owner"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/team?rol=owner"))
  await expect(title).toHaveText("Equipo")
  for (const [from, to, name] of [
    ["/settings/channels", "/settings/integrations", "Integraciones"],
    ["/settings/webchat", "/settings/integrations/webchat", "Chat web"],
    ["/settings/agent", "/settings/integrations", "Integraciones"],
  ] as const) {
    await gotoHydrated(page, tenant(org.slug, from))
    await expect(page).toHaveURL(tenantPattern(org.slug, to))
    await expect(title).toHaveText(name)
    // Lo que se abre desde Integraciones la deja marcada en la lista.
    await expect(nav.getByRole("link", { name: "Integraciones", exact: true })).toHaveAttribute("aria-current", "page")
  }

  // El servidor vuelve a la dirección antigua de Correo tras autorizar un buzón: el aviso se dice en Integraciones.
  await gotoHydrated(page, tenant(org.slug, "/settings/mail?ok=1&buzon=gmail"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/integrations?ok=1&buzon=gmail"))
  await expect(page.getByRole("alert").filter({ hasText: "Gmail quedó conectado" })).toBeVisible()
  await gotoHydrated(page, tenant(org.slug, "/settings/mail?error=oauth-denegado"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/integrations?error=oauth-denegado"))
  await expect(page.getByRole("alert").filter({ hasText: "No se conectó el correo: cancelaste la autorización." })).toBeVisible()
})

test("integraciones: fallo de carga con reintento, conectar un canal con sus datos en palabras, probar, cambiar la clave y desconectar", async ({ owner }, info) => {
  const { page, org } = owner
  const connections = () => call<Connection[]>(page, "GET", "/api/channels/connections", org.slug)
  await page.setViewportSize({ width: 1440, height: 900 })

  // Si la carga falla se dice, con «Reintentar»: ya no se ve como una lista vacía.
  let failing = true
  await page.route("**/api/channels/connections", async (route) => {
    if (!failing || route.request().method() !== "GET") return route.continue()
    await reply(page, route, 503, { error: { code: "UNAVAILABLE", message: "No disponible" } })
  })
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations"))
  await expect(page.getByRole("heading", { level: 1, name: "Integraciones" })).toBeVisible()
  const failure = page.getByRole("alert").filter({ hasText: "No pudimos cargar las integraciones" })
  await expect(failure).toBeVisible()
  const messaging = page.getByRole("region", { name: "Mensajería" })
  const mail = page.getByRole("region", { name: "Correo de la clínica" })
  await expect(messaging).toHaveCount(0)
  // Lo que sí cargó sigue en pantalla.
  await expect(rowOf(mail, "Gmail")).toBeVisible()
  await expect(rowOf(mail, "Microsoft 365")).toBeVisible()
  failing = false
  await failure.getByRole("button", { name: "Reintentar" }).click()
  await expect(messaging.getByRole("listitem")).toHaveCount(4)
  await expect(failure).toBeHidden()
  await page.unroute("**/api/channels/connections")

  // Una fila por integración: su estado en palabras, para qué sirve y qué hace falta.
  for (const [name, needs] of [
    ["WhatsApp", "Para conectar:"],
    ["Instagram", "Para conectar: la cuenta profesional de Instagram de la clínica."],
    ["Messenger", "Para conectar: la página de Facebook de la clínica."],
    ["Telegram", "Para conectar: la clave del bot, que da @BotFather."],
  ] as const) {
    await expect(rowOf(messaging, name)).toContainText("Sin conectar")
    await expect(rowOf(messaging, name)).toContainText(needs)
  }
  await expect(messaging).toContainText("Instagram, Messenger y Telegram solo responden a quien escribió primero.")
  await expect(page.getByRole("region", { name: "Tu sitio web" }).getByRole("listitem")).toHaveCount(1)
  await expect(page.getByRole("region", { name: "Inteligencia artificial" })).toContainText("ChatGPT 6")
  // La misma comprobación que el encendido: el modelo de demostración responde.
  await expect(page.getByRole("region", { name: "Inteligencia artificial" })).toContainText("Responde")
  await info.attach("integraciones", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Conectar Telegram: un dato, con su nombre en palabras; al conectar dice qué pasó.
  const telegram = rowOf(messaging, "Telegram")
  await telegram.getByRole("button", { name: "Conectar Telegram", exact: true }).click()
  const connect = surface(page, { name: "Conectar Telegram", exact: true })
  await expect(connect).toBeVisible()
  const key = connect.getByLabel("Clave del bot", { exact: true })
  await expect(key).toHaveAttribute("type", "password")
  await connect.getByRole("button", { name: "Ver clave del bot", exact: true }).click()
  await expect(key).toHaveAttribute("type", "text")
  await expect(connect).not.toContainText(/botToken|accessToken|appSecret|pageId/)
  // Sin la clave no conecta, y lo dice en el campo.
  await connect.getByRole("button", { name: "Conectar", exact: true }).click()
  await expect(connect.getByText("Escribe este dato.", { exact: true })).toBeVisible()
  expect((await connections()).filter((item) => item.channel === "telegram")).toEqual([])
  await key.fill("123456:e2e-clave")
  await connect.getByRole("button", { name: "Conectar", exact: true }).click()

  // La misma superficie pasa a administrar la conexión, sin cerrarse.
  const panel = surface(page, { name: "Telegram", exact: true })
  await expect(panel).toContainText("Conectado")
  await expect(panel).toContainText("No hay nada que copiar ni pegar")
  await expect(telegram).toContainText("Conectado")
  await expect(telegram.getByRole("button", { name: "Administrar Telegram", exact: true })).toBeVisible()
  const [created] = (await connections()).filter((item) => item.channel === "telegram")
  expect(created).toMatchObject({ status: "active" })
  await info.attach("telegram-conectado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // «Probar» dice qué cuenta respondió (la cuenta la entrega el proveedor: aquí, simulada).
  await page.route("**/api/channels/connections/*/test", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await reply(page, route, 200, {
      data: { ok: true, checkedAt: new Date().toISOString(), account: { name: "Clínica E2E", number: "@clinica_e2e_bot" } },
    })
  })
  await panel.getByRole("button", { name: "Probar", exact: true }).click()
  await expect(panel.getByRole("status").filter({ hasText: "Funciona" })).toHaveText("Funciona. Respondió Clínica E2E · @clinica_e2e_bot.")
  await page.unroute("**/api/channels/connections/*/test")

  // «Cambiar la clave» no crea otra conexión.
  await panel.getByRole("button", { name: "Cambiar la clave", exact: true }).click()
  const keyForm = surface(page, { name: "Cambiar la clave de Telegram", exact: true })
  await keyForm.getByLabel("Clave del bot", { exact: true }).fill("123456:e2e-clave-nueva")
  await keyForm.getByRole("button", { name: "Guardar la clave", exact: true }).click()
  await expect(panel).toContainText("Clave cambiada")
  const afterKey = (await connections()).filter((item) => item.channel === "telegram")
  expect(afterKey.map((item) => item.id)).toEqual([created?.id])

  // «Desconectar» pregunta antes y dice qué deja de funcionar.
  await panel.getByRole("button", { name: "Desconectar", exact: true }).click()
  const confirm = page.getByRole("alertdialog", { name: "Desconectar Telegram" })
  await expect(confirm).toContainText("Lo que le escriban al bot dejará de llegar a la Bandeja")
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(confirm).toBeHidden()
  expect((await connections()).find((item) => item.id === created?.id)?.status).toBe("active")
  await panel.getByRole("button", { name: "Desconectar", exact: true }).click()
  await confirm.getByRole("button", { name: "Desconectar", exact: true }).click()
  await expect(telegram).toContainText("Desconectado")
  await expect(panel.getByRole("button", { name: "Volver a conectar", exact: true })).toBeVisible()
  expect((await connections()).find((item) => item.id === created?.id)?.status).toBe("disabled")
  await panel.getByRole("button", { name: "Cerrar", exact: true }).click()
  await expect(panel).toBeHidden()
  // El foco vuelve al control de la fila que abrió el panel.
  await expect(telegram.getByRole("button", { name: "Administrar Telegram", exact: true })).toBeFocused()
})

test("integraciones: Messenger muestra siempre la dirección de avisos y su clave; el correo pide confirmar antes de desconectar", async ({ owner }) => {
  const { page, org } = owner
  await page.setViewportSize({ width: 1440, height: 900 })
  const messenger = await call<{ id: string }>(page, "POST", "/api/channels/connections", org.slug, {
    channel: "messenger",
    provider: "messenger",
    displayName: "Página E2E",
    config: { pageId: "E2E-PAGE", pageAccessToken: "e2e", appSecret: "e2e-secret" },
  }, 201)

  // Un buzón que perdió la autorización y otro sin conectar: el estado del correo, simulado.
  await page.route("**/api/mail/connections", async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    const at = new Date().toISOString()
    await reply(page, route, 200, {
      data: {
        providers: [
          { provider: "gmail", label: "Gmail", channel: "email", configured: true },
          { provider: "microsoft365", label: "Microsoft 365", channel: "email", configured: true },
        ],
        connections: [
          { id: "00000000-0000-4000-8000-0000000000e2", provider: "gmail", email: "clinica@example.test", displayName: "clinica@example.test", status: "disabled", synced: true, createdAt: at, updatedAt: at },
        ],
      },
    })
  })
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations"))
  const messaging = page.getByRole("region", { name: "Mensajería" })
  const mail = page.getByRole("region", { name: "Correo de la clínica" })

  // Messenger: la dirección y la clave se pueden volver a ver cuando haga falta.
  const row = rowOf(messaging, "Messenger")
  await expect(row).toContainText("Página E2E")
  const openMessenger = row.getByRole("button", { name: /^(Administrar|Terminar de conectar) Messenger$/ })
  await openMessenger.click()
  const panel = surface(page, { name: "Messenger", exact: true })
  const address = panel.getByLabel("Dirección de avisos", { exact: true })
  const token = panel.getByLabel("Clave de verificación", { exact: true })
  await expect(address).toHaveValue(new RegExp(`/api/webhooks/channels/messenger/${messenger.id}$`))
  await expect(token).toHaveValue(/\S+/)
  const tokenValue = await token.inputValue()
  await expect(panel.getByRole("button", { name: "Copiar dirección de avisos", exact: true })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Copiar clave de verificación", exact: true })).toBeVisible()
  await expect(panel).toContainText("En Meta se llama «Callback URL».")
  await expect(panel).toContainText("En Meta se llama «Verify token».")
  await panel.getByRole("button", { name: "Cerrar", exact: true }).click()
  await expect(panel).toBeHidden()
  await openMessenger.click()
  await expect(token).toHaveValue(tokenValue)
  // «Cambiar la clave» pide solo las claves, con su nombre en palabras.
  await panel.getByRole("button", { name: "Cambiar la clave", exact: true }).click()
  const keyForm = surface(page, { name: "Cambiar la clave de Messenger", exact: true })
  await expect(keyForm.getByLabel("Clave de acceso", { exact: true })).toBeVisible()
  await expect(keyForm.getByLabel("Clave secreta de la app", { exact: true })).toBeVisible()
  await expect(keyForm.getByLabel("Identificador de la página", { exact: true })).toHaveCount(0)
  await keyForm.getByRole("button", { name: "Cancelar", exact: true }).click()
  await panel.getByRole("button", { name: "Cerrar", exact: true }).click()
  await expect(panel).toBeHidden()

  // Correo: con problema se dice el motivo y se ofrece volver a conectar; sin conectar, qué hace falta.
  const gmail = rowOf(mail, "Gmail")
  await expect(gmail).toContainText("Necesita atención")
  await expect(gmail).toContainText("clinica@example.test")
  await expect(gmail).toContainText("Google pide volver a autorizar el buzón.")
  await expect(gmail.getByRole("button", { name: "Volver a conectar Gmail", exact: true })).toBeVisible()
  const microsoft = rowOf(mail, "Microsoft 365")
  await expect(microsoft).toContainText("Sin conectar")
  await expect(microsoft).toContainText("Para conectar: entrar con la cuenta de Microsoft de la clínica.")
  await expect(microsoft.getByRole("button", { name: "Conectar Microsoft 365", exact: true })).toBeVisible()

  // «Desconectar» pregunta antes y dice la consecuencia; cancelar no desconecta nada.
  let disconnects = 0
  await page.route("**/api/mail/*/disconnect", async (route) => {
    if (route.request().method() === "POST") disconnects += 1
    await route.continue()
  })
  await gmail.getByRole("button", { name: "Administrar Gmail", exact: true }).click()
  const mailPanel = surface(page, { name: "Gmail", exact: true })
  await mailPanel.getByRole("button", { name: "Desconectar", exact: true }).click()
  const confirm = page.getByRole("alertdialog", { name: "Desconectar Gmail" })
  await expect(confirm).toContainText("La clínica dejará de recibir correos en este buzón")
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click()
  await expect(confirm).toBeHidden()
  expect(disconnects).toBe(0)
})

test("integraciones en el teléfono: filas cortas que se tocan enteras; WhatsApp abre su página y las demás su detalle", async ({ owner, browser }) => {
  await withTouchPage(browser, owner, async (page) => {
    await gotoHydrated(page, tenant(owner.org.slug, "/settings/integrations"))
    const messaging = page.getByRole("region", { name: "Mensajería" })
    const telegram = rowOf(messaging, "Telegram")
    await expect(messaging.getByRole("listitem")).toHaveCount(4)

    // En corto: para qué sirve en breve y, a la derecha, qué hacer.
    await expect(telegram.getByText("Responder lo que le escriben al bot", { exact: true })).toBeVisible()
    await expect(telegram.getByText("Responder en la Bandeja lo que le escriben al bot de la clínica.", { exact: true })).toBeHidden()
    const tap = telegram.getByRole("button", { name: "Conectar Telegram", exact: true })
    await expect(tap).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0)

    // La fila se toca entera, no solo la palabra: el detalle se abre en el cajón.
    const box = await telegram.boundingBox()
    if (!box) throw new Error("La fila de Telegram no está en pantalla")
    expect(box.height).toBeGreaterThanOrEqual(44)
    await page.touchscreen.tap(box.x + 24, box.y + box.height / 2)
    const drawer = page.getByRole("dialog", { name: "Conectar Telegram" })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByLabel("Clave del bot", { exact: true })).toBeVisible()
    await drawer.getByRole("button", { name: "Cancelar", exact: true }).tap()
    await expect(drawer).toBeHidden()

    // WhatsApp abre su página, con el camino de vuelta a Integraciones.
    const whatsapp = rowOf(messaging, "WhatsApp")
    const whatsappBox = await whatsapp.boundingBox()
    if (!whatsappBox) throw new Error("La fila de WhatsApp no está en pantalla")
    await page.touchscreen.tap(whatsappBox.x + 24, whatsappBox.y + whatsappBox.height / 2)
    await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/integrations/whatsapp"))
    await expect(page.getByRole("heading", { level: 1, name: "WhatsApp" })).toBeVisible()
    await page.getByRole("navigation", { name: "breadcrumb" }).getByRole("link", { name: "Integraciones", exact: true }).tap()
    await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/integrations"))
    await expect(page.getByRole("heading", { level: 1, name: "Integraciones" })).toBeVisible()
  })
})
