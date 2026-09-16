import { expect, type Page, test } from "@playwright/test"
import { simulateTelegramInbound, simulateWhatsAppInbound } from "./channels"
import { latestLinkFor } from "./mailpit"

const API = "https://api.odentia.localhost"
const run = Date.now().toString(36)

const userX = { name: "Ximena Roe", email: `ximena-${run}@test.dev`, password: "secreto-123" }
const userY = { name: "Yuri Sol", email: `yuri-${run}@test.dev`, password: "secreto-123" }
const orgX = { name: "Clínica X", slug: `clinica-x-${run}` }
const orgY = { name: "Clínica Y", slug: `clinica-y-${run}` }

const tenant = (slug: string, path: string) => `https://${slug}.odentia.localhost${path}`
const FAKE_REPLY = "Gracias por escribir. Te atiendo enseguida."

// El ledger de dedupe (provider, evento) es global: ids únicos por corrida.
const uid = () => 5_000_000 + Math.floor(Math.random() * 1_000_000)

// Requiere el stack dev completo con:
// CHANNEL_VALIDATE_EXTERNAL=false, CHANNEL_SENDER_MODE=mock, LLM_MODEL=fake,
// SECRETS_KEY configurado y worker corriendo.

const hasFiber = () => {
  for (const el of [document.documentElement, document.body, ...document.body.children]) {
    if (el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))) return true
  }
  return false
}

async function waitForHydration(page: Page) {
  for (;;) {
    await page.waitForFunction(hasFiber, null, { timeout: 30_000 })
    await page.waitForTimeout(1_500)
    const stable = await page.evaluate(hasFiber).catch(() => false)
    if (stable) return
  }
}

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path)
  await waitForHydration(page)
}

async function register(page: Page, user: typeof userX) {
  await gotoHydrated(page, "/register")
  const [first, ...rest] = user.name.split(" ")
  await page.getByLabel("Nombre").fill(first)
  await page.getByLabel("Apellidos").fill(rest.join(" "))
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Registrarme" }).click()
  await expect(page).toHaveURL(/verify-email-sent/)
}

async function verifyEmail(page: Page, email: string) {
  const link = await latestLinkFor(email, "Verifica tu correo")
  await page.goto(link)
}

async function login(page: Page, user: typeof userX) {
  await gotoHydrated(page, "/login")
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Ingresar" }).click()
}

async function onboard(page: Page, org: typeof orgX) {
  await expect(page).toHaveURL(/onboarding/)
  await page.getByLabel("Nombre de la organización").fill(org.name)
  await page.getByLabel("Slug (subdominio)").fill(org.slug)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByLabel("Razón social").fill(`${org.name} S.A.C.`)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByLabel("Nombre de la sucursal").fill("Sede Central")
  await page.getByRole("button", { name: "Crear organización" }).click()
  await expect(page).toHaveURL(new RegExp(`^https://${org.slug}\\.odentia\\.localhost/branches`))
}

// Llamadas API desde el navegador (*.odentia.localhost no resuelve en Node/WSL).
async function api<T>(page: Page, method: string, path: string, slug: string, body?: unknown) {
  return page.evaluate(
    async ({ apiBase, method, path, slug, body }) => {
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-odentia-org": slug },
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json().catch(() => null)) as T }
    },
    { apiBase: API, method, path, slug, body },
  )
}

test("crm omnicanal: bandeja, agente, pipeline, plantillas y aislamiento", async ({ browser }) => {
  test.setTimeout(600_000)
  const contextA = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageA = await contextA.newPage()
  await register(pageA, userX)
  await verifyEmail(pageA, userX.email)
  await login(pageA, userX)
  await onboard(pageA, orgX)

  // (1) Conexión Telegram + inbound → bandeja y contacto en "Nuevo".
  const tgConn = await api<{ data: { id: string; webhookSecret: string } }>(
    pageA,
    "POST",
    "/api/channels/connections",
    orgX.slug,
    {
      channel: "telegram",
      provider: "telegram_bot_api",
      displayName: "Bot E2E",
      config: { botToken: "e2e" },
    },
  )
  expect(tgConn.status).toBe(201)
  const tgId = tgConn.body.data.id
  const tgSecret = tgConn.body.data.webhookSecret

  expect(
    await simulateTelegramInbound(pageA, API, tgId, tgSecret, {
      fromId: 1001,
      chatId: 1001,
      text: "Hola, quiero una cita",
      updateId: uid(),
    }),
  ).toBe(200)
  let tgReady = false
  for (let i = 0; i < 15 && !tgReady; i++) {
    const current = await api<{ data: unknown[] }>(pageA, "GET", "/api/conversations", orgX.slug)
    tgReady = current.body.data.length >= 1
    if (!tgReady) await pageA.waitForTimeout(2_000)
  }
  expect(tgReady).toBe(true)
  await gotoHydrated(pageA, tenant(orgX.slug, "/inbox"))
  await expect(pageA.getByText("E2E Paciente").first()).toBeVisible({ timeout: 30_000 })
  await expect(pageA.getByText("Hola, quiero una cita").first()).toBeVisible()

  const convs = await api<{ data: { id: string; contact: { id: string } }[] }>(
    pageA,
    "GET",
    "/api/conversations",
    orgX.slug,
  )
  const conversationId = convs.body.data[0]?.id ?? ""
  const contactId = convs.body.data[0]?.contact.id ?? ""
  expect(conversationId).not.toBe("")

  await gotoHydrated(pageA, tenant(orgX.slug, "/contacts"))
  await expect(pageA.getByText("E2E Paciente")).toBeVisible({ timeout: 15_000 })

  // (2) Agente activado responde al segundo inbound.
  expect((await api(pageA, "PUT", "/api/agent/config", orgX.slug, { enabled: true })).status).toBe(
    200,
  )
  expect(
    (
      await api(pageA, "POST", `/api/conversations/${conversationId}/agent`, orgX.slug, {
        enabled: true,
      })
    ).status,
  ).toBe(200)
  expect(
    await simulateTelegramInbound(pageA, API, tgId, tgSecret, {
      fromId: 1001,
      chatId: 1001,
      text: "¿Cuánto cuesta la limpieza?",
      updateId: uid(),
    }),
  ).toBe(200)
  await gotoHydrated(pageA, tenant(orgX.slug, "/inbox"))
  await expect(pageA.getByText(FAKE_REPLY).first()).toBeVisible({ timeout: 60_000 })

  // (3) El operador responde desde la UI → out enviado y agente en OFF.
  await pageA.getByText("E2E Paciente").first().click()
  await pageA.getByLabel("Mensaje").fill("Te ayudo por aquí mismo")
  await pageA.getByLabel("Mensaje").press("Enter")
  await expect(pageA.getByText("Te ayudo por aquí mismo")).toBeVisible({ timeout: 15_000 })
  await expect(pageA.getByRole("button", { name: "OFF" })).toBeVisible()

  // (4) Pipeline: tarjeta en Nuevo → mover a Contactado desde el detalle.
  await gotoHydrated(pageA, tenant(orgX.slug, "/pipeline"))
  await expect(pageA.getByText("E2E Paciente").first()).toBeVisible({ timeout: 15_000 })
  await gotoHydrated(pageA, tenant(orgX.slug, `/contacts/${contactId}`))
  const pipes = await api<{ data: { stages: { id: string; name: string }[] }[] }>(
    pageA,
    "GET",
    "/api/pipelines",
    orgX.slug,
  )
  const contactado = pipes.body.data.flatMap((p) => p.stages).find((s) => s.name === "Contactado")
  expect(contactado).toBeDefined()
  await pageA.getByLabel("Etapa").selectOption(contactado?.id ?? "")
  await gotoHydrated(pageA, tenant(orgX.slug, "/pipeline"))
  const contactadoCol = pageA.locator("section", { hasText: "Contactado" }).first()
  await expect(contactadoCol.getByText("E2E Paciente")).toBeVisible({ timeout: 15_000 })

  // (5) WhatsApp: firma válida encola; firma inválida da 401.
  const waConn = await api<{ data: { id: string } }>(
    pageA,
    "POST",
    "/api/channels/connections",
    orgX.slug,
    {
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: "WA E2E",
      config: {
        phoneNumberId: "E2E-PNID",
        wabaId: "E2E-WABA",
        accessToken: "e2e",
        appSecret: "e2e-secret",
        templates: [],
      },
    },
  )
  expect(waConn.status).toBe(201)
  const before = await api<{ data: unknown[] }>(pageA, "GET", "/api/conversations", orgX.slug)
  const beforeCount = before.body.data.length
  expect(
    await simulateWhatsAppInbound(pageA, API, waConn.body.data.id, "e2e-secret", {
      from: "51911122233",
      phoneNumberId: "E2E-PNID",
      text: "Buenos días",
      wamid: `wamid.e2e-${run}`,
    }),
  ).toBe(200)
  // Esperar el hilo por API antes de abrir la UI: evita la carrera entre
  // el fetch inicial y la ingesta del worker.
  let waReady = false
  for (let i = 0; i < 15 && !waReady; i++) {
    const current = await api<{ data: unknown[] }>(pageA, "GET", "/api/conversations", orgX.slug)
    waReady = current.body.data.length === beforeCount + 1
    if (!waReady) await pageA.waitForTimeout(2_000)
  }
  expect(waReady).toBe(true)
  await gotoHydrated(pageA, tenant(orgX.slug, "/inbox"))
  await expect(pageA.getByText("Buenos días").first()).toBeVisible({ timeout: 30_000 })

  const badSig = await pageA.evaluate(
    async ({ apiBase, connectionId }) => {
      const response = await fetch(
        `${apiBase}/api/webhooks/channels/whatsapp_cloud_api/${connectionId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
          body: "{}",
        },
      )
      return response.status
    },
    { apiBase: API, connectionId: waConn.body.data.id },
  )
  expect(badSig).toBe(401)
  const after = await api<{ data: unknown[] }>(pageA, "GET", "/api/conversations", orgX.slug)
  expect(after.body.data.length).toBe(beforeCount + 1)

  // (6) Aislamiento: org B no ve nada de A (UI + API).
  const contextB = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageB = await contextB.newPage()
  await register(pageB, userY)
  await verifyEmail(pageB, userY.email)
  await login(pageB, userY)
  await onboard(pageB, orgY)
  await gotoHydrated(pageB, tenant(orgY.slug, "/inbox"))
  await expect(pageB.getByText("Sin conversaciones")).toBeVisible()
  await expect(pageB.getByText("E2E Paciente")).toHaveCount(0)
  const convsB = await api<{ data: unknown[] }>(pageB, "GET", "/api/conversations", orgY.slug)
  expect(convsB.body.data).toEqual([])
  const contactsB = await api<{ data: unknown[] }>(pageB, "GET", "/api/contacts", orgY.slug)
  expect(contactsB.body.data).toEqual([])

  await contextA.close()
  await contextB.close()
})
