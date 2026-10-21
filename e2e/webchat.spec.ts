import type { Page } from "@playwright/test"
import { API, tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Chat web de la clínica (ADR 0076, fase 6 del pulido de la Bandeja): una
 * línea por clínica, el primer sitio queda solo y otro espera el sí de la
 * clínica, el visitante escribe sin dar su nombre, deja dónde avisarle cuando
 * hay un tema y la prueba de Configuración no se cobra y se borra.
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

const SITE = "https://sonrisa-e2e.example"
const COPY = "https://copia-e2e.example"

/** Lo que pregunta `chat.js` al cargar en un sitio (el navegador dice cuál en `Origin`): si responde ahí, con su ticket. */
async function siteCheck(
  page: Page,
  slug: string,
  site: string,
): Promise<{ available: boolean; ticket?: string }> {
  const response = await page.request.post(`${API}/api/webchat/${slug}/site`, {
    headers: { origin: site },
  })
  expect(response.status()).toBe(200)
  return ((await response.json()) as { data: { available: boolean; ticket?: string } }).data
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

test("chat web: una línea, el primer sitio queda solo, otro espera tu sí y el visitante deja dónde avisarle", async ({
  owner,
  browser,
}) => {
  const { page, org } = owner
  // La línea vive en la dirección de la clínica y no lleva identificadores.
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations/webchat"))
  const chat = await call<ClinicWebchat>(page, "GET", "/api/channels/webchat", org.slug)
  expect(chat.active).toBe(true)
  expect(chat.script).toBe(`<script src="${tenant(org.slug, "")}/chat.js" async></script>`)
  await expect(page.getByText(chat.script ?? "", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Copiar código" })).toBeVisible()

  // El primer sitio donde carga queda registrado solo; en otro dice «No disponible» hasta que la clínica lo permite.
  const first = await siteCheck(page, org.slug, SITE)
  expect(first.available).toBe(true)
  expect(await siteCheck(page, org.slug, COPY)).toEqual({
    available: false,
    color: expect.any(String),
    clinicName: expect.any(String),
  })
  await page.reload()
  const pending = page.getByRole("listitem").filter({ hasText: "copia-e2e.example" })
  await expect(pending.getByText("¿Es tuyo?")).toBeVisible()
  await pending.getByRole("button", { name: "Permitir" }).click()
  await expect.poll(async () => (await siteCheck(page, org.slug, COPY)).available).toBe(true)

  // El visitante escribe sin dar su nombre; llega a la Bandeja como «Visitante del chat web».
  const visitor = await browser.newContext({ ignoreHTTPSErrors: true })
  try {
    // Sin el ticket que da la API al cargar `chat.js` en el sitio, la ventana no abre conversación.
    const forged = await visitor.newPage()
    await gotoHydrated(forged, tenant(org.slug, `/embed?site=${encodeURIComponent(SITE)}`))
    await forged.getByRole("textbox", { name: "Tu mensaje" }).fill("Hola")
    await forged.getByRole("button", { name: "Enviar" }).click()
    await expect(forged.getByRole("alert")).toBeVisible()
    await forged.close()
    const embed = await visitor.newPage()
    await gotoHydrated(
      embed,
      tenant(
        org.slug,
        `/embed?site=${encodeURIComponent(SITE)}&ticket=${encodeURIComponent(first.ticket ?? "")}`,
      ),
    )
    await expect(embed.getByRole("textbox", { name: "Tu nombre" })).toHaveCount(0)
    await embed.getByRole("textbox", { name: "Tu mensaje" }).fill("¿Atienden niños?")
    await embed.getByRole("button", { name: "Enviar" }).click()
    await expect(
      embed.getByRole("list", { name: "Conversación" }).getByText("¿Atienden niños?"),
    ).toBeVisible()
    const thread = await conversationWith(page, org.slug, "¿Atienden niños?")
    expect(thread.contact.displayName).toBe("Visitante del chat web")
    expect(thread.isTest).toBe(false)

    // Con un tema para el equipo el chat pide dónde avisarle; mientras no lo deja, la Bandeja lo dice.
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
    await expect
      .poll(
        async () =>
          (await call<Conversation>(page, "GET", `/api/conversations/${thread.id}`, org.slug))
            .attention.unreachable,
      )
      .toBe(true)
    const where = embed.getByRole("form", { name: "Dónde te avisamos" })
    await expect(where).toBeVisible({ timeout: 15_000 })
    await expect(where.getByText("Solo lo usamos para responderte.")).toBeVisible()
    await where.getByRole("textbox", { name: "Tu WhatsApp" }).fill("987654321")
    await where.getByRole("button", { name: "Avisarme ahí" }).click()
    await expect(where).toHaveCount(0, { timeout: 15_000 })
    await expect
      .poll(
        async () =>
          (await call<Conversation>(page, "GET", `/api/conversations/${thread.id}`, org.slug))
            .attention.unreachable,
      )
      .toBe(false)
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
  const sent = await page.request.post(`${API}/api/webchat/${org.slug}/messages`, {
    headers: { authorization: `Bearer ${opened.token}`, "content-type": "application/json" },
    data: { text: "Hola, es una prueba" },
  })
  expect(sent.status()).toBe(202)
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
