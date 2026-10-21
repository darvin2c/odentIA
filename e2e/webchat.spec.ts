import { randomUUID } from "node:crypto"
import type { BrowserContext, Page } from "@playwright/test"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Chat web de la clínica (ADR 0076, fase 6 del pulido de la Bandeja): una
 * línea por clínica, el primer sitio queda solo y otro espera el sí de la
 * clínica, el visitante escribe sin dar su nombre, deja dónde avisarle cuando
 * hay un tema y la prueba de Configuración no se cobra y se borra.
 *
 * Los sitios de la clínica los sirve Playwright (`route`): una página con la
 * línea del chat, así el navegador dice de verdad desde dónde carga (`Origin`).
 */

type ClinicWebchat = {
  id: string
  active: boolean
  script: string | null
  installedOn: string | null
  sites: Array<{ id: string; origin: string; status: string }>
}
type Conversation = {
  id: string
  isTest?: boolean
  contact: { id: string; displayName: string }
  preview: { body: string | null } | null
  attention: { unreachable?: boolean }
}

// En `*.localhost`, como el entorno: Chrome no deja que una página pública cargue
// algo de una dirección local (Private Network Access); en producción ambos son públicos.
const SITE = "https://sonrisa-e2e.localhost"
const COPY = "https://copia-e2e.localhost"

/** Abre el sitio de la clínica con la línea del chat pegada, como lo vería un visitante. */
async function openSite(context: BrowserContext, site: string, script: string): Promise<Page> {
  await context.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Sitio</title></head><body><h1>Sitio de la clínica</h1>${script}</body></html>`,
    }),
  )
  const page = await context.newPage()
  await page.goto(`${site}/`)
  return page
}

async function conversationWith(page: Page, slug: string, text: string): Promise<Conversation> {
  const find = async () =>
    (await call<Conversation[]>(page, "GET", "/api/conversations", slug)).find(
      (item) => item.preview?.body === text,
    )
  await expect.poll(async () => (await find())?.id ?? "", { timeout: 30_000 }).not.toBe("")
  const found = await find()
  if (!found) throw new Error(`No apareció la conversación «${text}»`)
  return found
}

const unreachable = async (page: Page, slug: string, id: string) =>
  (await call<Conversation>(page, "GET", `/api/conversations/${id}`, slug)).attention.unreachable

test("chat web: una línea, el primer sitio queda solo, otro espera tu sí y el visitante deja dónde avisarle", async ({
  owner,
  browser,
}) => {
  const { page, org } = owner
  // La línea vive en la dirección de la clínica y no lleva identificadores.
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/webchat"))
  const chat = await call<ClinicWebchat>(page, "GET", "/api/channels/webchat", org.slug)
  expect(chat.active).toBe(true)
  const script = chat.script ?? ""
  expect(script).toBe(`<script src="${tenant(org.slug, "")}/chat.js" async></script>`)
  await expect(page.getByText(script, { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copiar código" })).toBeVisible()

  const visitor = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    // El primer sitio donde carga queda registrado solo y el chat responde ahí.
    const site = await openSite(visitor, SITE, script)
    const launcher = site.getByRole("button", { name: /^Abrir el chat de / })
    await expect(launcher).toBeVisible({ timeout: 30_000 })
    // En otro sitio dice «No disponible» hasta que la clínica lo permite.
    const copy = await openSite(visitor, COPY, script)
    await copy.getByRole("button", { name: /^Abrir el chat de / }).click()
    await expect(copy.getByText("No disponible")).toBeVisible()
    await gotoHydrated(page, tenant(org.slug, "/settings/integrations/webchat"))
    const pending = page.getByRole("listitem").filter({ hasText: "copia-e2e.localhost" })
    await expect(pending.getByText("¿Es tuyo?")).toBeVisible()
    await pending.getByRole("button", { name: "Permitir" }).click()
    await expect(pending.getByText("¿Es tuyo?")).toHaveCount(0)
    await copy.reload()
    await copy.getByRole("button", { name: /^Abrir el chat de / }).click()
    await expect(
      copy.frameLocator("iframe").getByRole("textbox", { name: "Tu mensaje" }),
    ).toBeVisible({ timeout: 30_000 })

    // Abrir la ventana del chat desde otra página, sin el ticket del sitio, no abre conversación.
    const forged = await visitor.newPage()
    await gotoHydrated(forged, tenant(org.slug, `/embed?site=${encodeURIComponent(SITE)}`))
    await forged.getByRole("textbox", { name: "Tu mensaje" }).fill("Hola")
    await forged.getByRole("button", { name: "Enviar" }).click()
    await expect(forged.getByRole("alert")).toBeVisible()
    await forged.close()

    // El visitante escribe sin dar su nombre; llega a la Bandeja como «Visitante del chat web».
    await launcher.click()
    const window = site.frameLocator("iframe")
    await expect(window.getByRole("textbox", { name: "Tu nombre" })).toHaveCount(0)
    await window.getByRole("textbox", { name: "Tu mensaje" }).fill("¿Atienden niños?")
    await window.getByRole("button", { name: "Enviar" }).click()
    await expect(
      window.getByRole("list", { name: "Conversación" }).getByText("¿Atienden niños?"),
    ).toBeVisible()
    const thread = await conversationWith(page, org.slug, "¿Atienden niños?")
    expect(thread.contact.displayName).toBe("Visitante del chat web")
    expect(thread.isTest).toBe(false)

    // Con un tema para el equipo: sin WhatsApp ni buzón en la clínica no hay por dónde avisarle, y la Bandeja lo dice.
    await call(
      page,
      "POST",
      "/api/agent/handoffs",
      org.slug,
      {
        conversationId: thread.id,
        reason: "Pregunta por ortodoncia invisible",
        summary: "Quiere el precio.",
        priority: "media",
      },
      201,
    )
    await expect.poll(() => unreachable(page, org.slug, thread.id)).toBe(true)
    await expect(window.getByRole("form", { name: "Dónde te avisamos" })).toHaveCount(0)

    // Con WhatsApp conectado el chat pide dónde avisarle; con su número, ya hay por dónde.
    await call(
      page,
      "POST",
      "/api/channels/connections",
      org.slug,
      {
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA E2E",
        config: {
          phoneNumberId: `E2E-PNID-CHAT-${randomUUID().slice(0, 8)}`,
          wabaId: "E2E-WABA",
          accessToken: "e2e",
          appSecret: "e2e-secret",
          templates: [],
        },
      },
      201,
    )
    const where = window.getByRole("form", { name: "Dónde te avisamos" })
    await expect(where).toBeVisible({ timeout: 15_000 })
    await expect(where.getByText("Solo lo usamos para responderte.")).toBeVisible()
    await where.getByRole("textbox", { name: "Tu WhatsApp" }).fill("987654321")
    await where.getByRole("button", { name: "Avisarme ahí" }).click()
    await expect(where).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => unreachable(page, org.slug, thread.id)).toBe(false)
  } finally {
    await visitor.close()
  }
})

test("chat web: la prueba de Configuración dice «Prueba», no cuenta y se borra con «Borrar esta prueba»", async ({
  owner,
}) => {
  const { page, org } = owner
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/webchat"))
  const opened = await call<{ sessionId: string; token: string }>(
    page,
    "POST",
    "/api/channels/webchat/test",
    org.slug,
    undefined,
    201,
  )
  // Lo que escribe quien prueba, como lo envía la ventana del chat (sin cookies, con su sesión).
  const sent = await page.evaluate(
    async ({ url, token }) =>
      (
        await fetch(url, {
          method: "POST",
          credentials: "omit",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId: "e2e-prueba-1", text: "Hola, es una prueba" }),
        })
      ).status,
    { url: `${API}/api/webchat/${org.slug}/messages`, token: opened.token },
  )
  expect(sent).toBe(202)
  const thread = await conversationWith(page, org.slug, "Hola, es una prueba")
  expect(thread.isTest).toBe(true)
  // No es una persona de la clínica: no sale en Pacientes.
  const people = await call<Array<{ id: string }>>(page, "GET", "/api/people?ver=todos", org.slug)
  expect(people.some((person) => person.id === thread.contact.id)).toBe(false)

  await gotoHydrated(page, tenant(org.slug, `/inbox?conversation=${thread.id}`))
  await expect(page.getByText("Prueba · no se cobra")).toBeVisible()
  await page.getByRole("button", { name: "Más acciones de la conversación" }).click()
  await page.getByRole("menuitem", { name: "Borrar esta prueba" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Borrar esta prueba" }).click()
  await expect(page.getByText("Prueba borrada.")).toBeVisible()
  expect((await api(page, "GET", `/api/conversations/${thread.id}`, org.slug)).status).toBe(404)
})
