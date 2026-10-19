import { member } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"
import { PANEL, tenant } from "./env"
import { api, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * «Conectar con Facebook» se abre siempre en el panel (issue 166): Meta solo
 * devuelve el resultado a los dominios de su lista, que no admite comodín. Sin
 * la app de odentIA en Meta (este entorno no llama a Meta) la ventana no se
 * abre: aquí se comprueba quién puede llegar a la página y qué dice, nunca que
 * Meta acepte la conexión.
 */

const connectPage = (slug: string) => `${PANEL}/whatsapp/conectar?org=${encodeURIComponent(slug)}`

test("whatsapp en el panel: la clínica sale de la membresía, y vuelve a la clínica", async ({ createOwner, fixtureDb }) => {
  // Dos cuentas con su clínica cada una.
  test.setTimeout(240_000)
  const mine = await createOwner("fbmine")
  const other = await createOwner("fbother")

  // La dueña llega a la página de su clínica; sin la app de Meta lo dice y ofrece volver.
  await gotoHydrated(mine.page, connectPage(mine.org.slug))
  await expect(mine.page.getByText(`Conectar el WhatsApp de ${mine.org.name}`)).toBeVisible()
  await expect(mine.page.getByRole("alert")).toContainText("«Conectar con Facebook» no está disponible en esta instalación")
  await expect(mine.page.getByRole("button", { name: "Abrir la ventana de Meta" })).toHaveCount(0)
  await expect(mine.page.getByRole("link", { name: `Volver a ${mine.org.name}` })).toHaveAttribute(
    "href",
    tenant(mine.org.slug, "/settings/integrations/whatsapp"),
  )

  // Otra persona con la dirección de esa clínica: no se dice si existe, y la API tampoco deja.
  await gotoHydrated(other.page, connectPage(mine.org.slug))
  await expect(other.page.getByRole("alert")).toHaveText("No encontramos esa clínica entre las tuyas.")
  await expect(other.page.getByText(mine.org.name)).toHaveCount(0)
  expect((await api(other.page, "GET", "/api/channels/whatsapp/signup", mine.org.slug)).status).toBe(403)
  const foreign = await api(other.page, "POST", "/api/channels/whatsapp/signup", mine.org.slug, { code: "c", wabaId: "1", phoneNumberId: "2" })
  expect(foreign.status).toBe(403)

  // Quien es de la clínica pero no administra su configuración no puede conectar.
  await fixtureDb
    .update(member)
    .set({ role: "reception" })
    .where(and(eq(member.organizationId, mine.org.id), eq(member.userId, mine.user.id)))
  await gotoHydrated(mine.page, connectPage(mine.org.slug))
  await expect(mine.page.getByRole("alert")).toHaveText(
    `No puedes conectar el WhatsApp de ${mine.org.name}. Lo hace quien administra la clínica.`,
  )
  const denied = await api(mine.page, "POST", "/api/channels/whatsapp/signup", mine.org.slug, { code: "c", wabaId: "1", phoneNumberId: "2" })
  expect(denied.status).toBe(403)
})

test("whatsapp en el panel: sin sesión, entrar vuelve a la misma página", async ({ owner, browser }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const page = await context.newPage()
    await gotoHydrated(page, connectPage(owner.org.slug))
    await expect(page).toHaveURL(/\/login\?/)
    expect(new URL(page.url()).searchParams.get("next")).toBe(connectPage(owner.org.slug))
    await expect(page.getByLabel("Contraseña")).toBeEditable({ timeout: 30_000 })
    await page.getByLabel("Correo").fill(owner.user.email)
    await page.getByLabel("Contraseña").fill(owner.user.password)
    await page.getByRole("button", { name: "Entrar", exact: true }).click()
    await expect(page).toHaveURL(connectPage(owner.org.slug))
    await expect(page.getByText(`Conectar el WhatsApp de ${owner.org.name}`)).toBeVisible()
  } finally {
    await context.close()
  }
})
