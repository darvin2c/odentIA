import { randomUUID } from "node:crypto"
import { LEGAL } from "@odentia/auth/legal"
import { account, user as users } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import type { Page } from "@playwright/test"
import { eq } from "drizzle-orm"
import { hostUrl, latidiaUrl, tenant } from "./env"
import { expect, PASSWORD, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * latidIA abre (entregas 3 y 4 del issue 229): la misma instalación sirve su
 * dominio con su sesión, su panel y su app; la clínica que nace ahí es médica,
 * se ve con su marca y dice sus palabras.
 */

/** Una llamada a la API desde la página, con la sesión de su dominio. */
async function request<T>(
  page: Page,
  apiBase: string,
  method: string,
  path: string,
  slug?: string,
  body?: unknown,
) {
  return page.evaluate(
    async ({ apiBase, method, path, slug, body }) => {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (slug) headers["x-odentia-org"] = slug
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers,
        credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as T }
    },
    { apiBase, method, path, slug, body },
  )
}

test("latidIA: su dominio, su sesión, un consultorio médico con su marca y sus palabras", async ({
  browser,
  fixtureDb,
  passwordHash,
}, testInfo) => {
  const id = randomUUID()
  const email = `latidia-${id}@test.dev`
  await fixtureDb.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      name: "Elena Vela",
      firstName: "Elena",
      lastName: "Vela",
      email,
      emailVerified: true,
      termsVersion: LEGAL.terms.version,
      termsAcceptedAt: new Date(),
      processingAgreementVersion: LEGAL.agreement.version,
      processingAgreementAcceptedAt: new Date(),
    })
    await tx.insert(account).values({
      id: randomUUID(),
      accountId: id,
      userId: id,
      providerId: "credential",
      password: passwordHash,
      updatedAt: new Date(),
    })
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`) })

  // El acceso de latidIA: su marca, su título y su voz («Entra a tu consultorio»).
  await gotoHydrated(page, latidiaUrl("app", "/login"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "latidia")
  await expect(page).toHaveTitle("latidIA")
  await expect(page.getByRole("img", { name: "latidIA" }).first()).toBeVisible()
  await expect(page.getByText("Qué bueno verte. Entra a tu consultorio.")).toBeVisible()
  await shot("acceso")

  // La sesión vive en su dominio: entra por la API de latidIA.
  const api = latidiaUrl("api")
  const signedIn = await request<{ user: { id: string } }>(
    page,
    api,
    "POST",
    "/api/auth/sign-in/email",
    undefined,
    {
      email,
      password: PASSWORD,
    },
  )
  expect(signedIn.status).toBe(200)
  const slug = `sanmartin-${id.slice(0, 8)}`
  const created = await request<{ id: string }>(
    page,
    api,
    "POST",
    "/api/auth/organization/create",
    undefined,
    {
      name: "Consultorio San Martín",
      slug,
    },
  )
  expect(created.status).toBe(200)
  expect(
    (
      await request(page, api, "POST", "/api/auth/organization/set-active", undefined, {
        organizationId: created.body.id,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(page, api, "PUT", "/api/org-profile", slug, {
        legalName: "Consultorio San Martín S.A.C.",
        countryCode: "PE",
      })
    ).status,
  ).toBe(200)
  expect(
    (await request(page, api, "POST", "/api/branches", slug, { name: "Sede Central" })).status,
  ).toBe(201)

  // Nació en el dominio de latidIA: es un consultorio médico.
  const [profile] = await fixtureDb
    .select({ product: orgProfile.product })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, created.body.id))
  expect(profile?.product).toBe("medical")

  // La app de latidIA: el lila, el [72] y «sala» donde odentIA dice «unidad dental».
  await gotoHydrated(page, latidiaUrl(slug, "/agenda"))
  await expect(page.locator("html")).toHaveAttribute("data-brand", "latidia")
  await expect(page).toHaveTitle("latidIA")
  await expect(page.getByRole("img", { name: "latidIA" }).first()).toBeVisible()
  await expect(page.getByText("Esta sede aún no tiene salas")).toBeVisible()
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
  )
  expect(primary.toLowerCase()).toBe("#6d3fc0")
  await shot("agenda")
  await page.setViewportSize({ width: 390, height: 844 })
  await shot("agenda-telefono")
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await shot("agenda-oscuro")
  await page.evaluate(() => document.documentElement.classList.remove("dark"))

  // En el dominio de odentIA, con su propia sesión, el consultorio se abre en el suyo.
  await gotoHydrated(page, hostUrl("app", "/login"))
  expect(
    (
      await request(page, hostUrl("api"), "POST", "/api/auth/sign-in/email", undefined, {
        email,
        password: PASSWORD,
      })
    ).status,
  ).toBe(200)
  await page.goto(tenant(slug, "/home"))
  await expect(page).toHaveURL(
    new RegExp(`^${latidiaUrl(slug, "/home").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  )
  await context.close()
})
