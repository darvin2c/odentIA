import { randomUUID } from "node:crypto"
import type { Page } from "@playwright/test"
import { PANEL, panelPattern, tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated, waitForHydration } from "./hydration"
import { latestLinkFor } from "./mailpit"

type UiUser = { name: string; email: string; password: string }
type UiOrg = { name: string; slug: string; branch: string }

async function register(page: Page, user: UiUser): Promise<void> {
  await gotoHydrated(page, "/register")
  const [first, ...rest] = user.name.split(" ")
  await page.getByLabel("Nombre").fill(first ?? "")
  await page.getByLabel("Apellidos").fill(rest.join(" "))
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("checkbox", { name: /Acepto los Términos/ }).check()
  await page.getByRole("button", { name: /^(Obtén .+ de crédito|Crear mi cuenta)$/ }).click()
  await expect(page).toHaveURL(/verify-email-sent/)
}

async function verifyEmail(page: Page, email: string): Promise<void> {
  const link = await latestLinkFor(email, "Verifica tu correo")
  await page.goto(link)
}

async function login(page: Page, user: UiUser): Promise<void> {
  await gotoHydrated(page, "/login")
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Entrar", exact: true }).click()
}

async function onboard(page: Page, org: UiOrg): Promise<void> {
  await expect(page).toHaveURL(/onboarding/)
  await page.getByLabel("Nombre de tu clínica").fill(org.name)
  await page.getByLabel("Dirección de tu clínica en odentIA").fill(org.slug)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByLabel("Razón social").fill(`${org.name} S.A.C.`)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByLabel("Nombre de la sede").fill(org.branch)
  await page.getByRole("button", { name: "Crear organización" }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/home"))
  const branches = await call<{ name: string }[]>(page, "GET", "/api/branches", org.slug)
  expect(branches.map(branch => branch.name)).toContain(org.branch)
}

test("auth: registro, verificación y onboarding", async ({ browser }) => {
  const id = randomUUID()
  const user: UiUser = { name: "Ana Pruebas", email: `registro-${id}@test.dev`, password: "secreto-123" }
  const org: UiOrg = { name: `Clínica Registro ${id}`, slug: `clinica-reg-${id}`, branch: `Sede Registro ${id}` }
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const page = await context.newPage()
    await register(page, user)
    await verifyEmail(page, user.email)
    await login(page, user)
    await onboard(page, org)
  } finally {
    await context.close()
  }
})

test("auth: la dirección sigue al nombre, avisa si está en uso y el teléfono sigue al país", async ({
  browser,
  createOwner,
}) => {
  // Una clínica que ya existe: su dirección está tomada.
  const taken = await createOwner("direccion")
  const id = randomUUID()
  const user: UiUser = { name: "Carmen Pruebas", email: `direccion-${id}@test.dev`, password: "secreto-123" }
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const page = await context.newPage()
    await register(page, user)
    await verifyEmail(page, user.email)
    await login(page, user)
    await expect(page).toHaveURL(/onboarding/)
    // Se escribe tecla por tecla: lo tecleado antes de hidratar se perdería.
    await waitForHydration(page)

    // Issue 106: la dirección sigue cada tecla del nombre, sin lo genérico.
    const address = page.getByLabel("Dirección de tu clínica en odentIA")
    await page.getByLabel("Nombre de tu clínica").pressSequentially("Clínica Dental Sonrisa")
    await expect(address).toHaveValue("sonrisa")
    await expect(page.getByText(/^✓ sonrisa\..+ está libre\.$/)).toBeVisible()

    // Escrita a mano deja de seguir al nombre y dice al momento si está en uso.
    await address.fill(taken.org.slug)
    await page.getByLabel("Nombre de tu clínica").fill("Clínica Dental Sonrisa Miraflores")
    await expect(address).toHaveValue(taken.org.slug)
    await expect(page.getByText("Ya está en uso.")).toBeVisible()
    await page.getByRole("button", { name: "Continuar", exact: true }).click()
    await expect(page.getByText("Esa dirección ya está en uso. Elige otra.")).toBeVisible()
    await page.getByRole("button", { name: `Usar ${taken.org.slug}-2` }).click()
    await expect(address).toHaveValue(`${taken.org.slug}-2`)
    await expect(page.getByText(`${taken.org.slug}-2.`, { exact: false })).toContainText("está libre")
    await page.getByRole("button", { name: "Continuar", exact: true }).click()

    // Issue 107: el país del paso 2 manda en el teléfono del paso 3, aunque el campo ya exista.
    await page.getByLabel("Razón social").fill("Sonrisa S.A.C.")
    // Los nombres siguen el idioma del navegador de la prueba.
    await page.getByRole("combobox", { name: "País" }).click()
    await page.getByRole("option", { name: /^M[ée]xico \(\+52\)$/ }).click()
    await page.getByRole("combobox", { name: "País" }).click()
    await page.getByRole("option", { name: /^Per[úu] \(\+51\)$/ }).click()
    await page.getByRole("button", { name: "Continuar", exact: true }).click()
    await expect(page.getByLabel("Nombre de la sede")).toBeVisible()
    await expect(page.getByRole("combobox", { name: "País" })).toHaveText("PE +51")

    // Llegar al paso no lo marca en rojo: solo intentar crear la clínica sin el dato.
    const branch = page.getByLabel("Nombre de la sede")
    await expect(branch).not.toHaveAttribute("aria-invalid", "true")
    await page.getByRole("button", { name: "Crear organización" }).click()
    await expect(branch).toHaveAttribute("aria-invalid", "true")
  } finally {
    await context.close()
  }
})

test("auth: invitación, permisos y aislamiento", async ({ browser, createOwner }) => {
  const owner = await createOwner("invita")
  const id = randomUUID()
  const member: UiUser = { name: "Beto Pruebas", email: `invitado-${id}@test.dev`, password: "secreto-123" }

  await gotoHydrated(owner.page, tenant(owner.org.slug, "/settings/team"))
  await owner.page.getByRole("button", { name: "Invitar al equipo" }).click()
  await owner.page.getByLabel("Invitar por correo").fill(member.email)
  await owner.page.getByRole("button", { name: "Invitar", exact: true }).click()
  // El aviso también nombra el correo: se mira la lista de invitaciones.
  await expect(
    owner.page.getByRole("region", { name: "Invitaciones pendientes" }).getByText(member.email),
  ).toBeVisible()

  const memberContext = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const memberPage = await memberContext.newPage()
    await register(memberPage, member)
    await verifyEmail(memberPage, member.email)
    await login(memberPage, member)
    const invitationLink = await latestLinkFor(member.email, `Te invitaron a ${owner.org.name}`)
    expect(invitationLink.startsWith(`${PANEL}/accept-invitation/`)).toBe(true)
    await gotoHydrated(memberPage, invitationLink)
    await expect(memberPage).toHaveURL(tenantPattern(owner.org.slug, "/home"))
    await expect(memberPage.getByRole("link", { name: "Tareas", exact: true })).toBeVisible()

    const forbidden = await api(memberPage, "POST", "/api/branches", owner.org.slug, { name: "Sede Prohibida" })
    expect(forbidden.status).toBe(403)
    await gotoHydrated(memberPage, tenant(owner.org.slug, "/settings/branches"))
    await expect(memberPage.getByRole("button", { name: "Nueva sede" })).toHaveCount(0)
  } finally {
    await memberContext.close()
  }

  const other = await createOwner("aisla")
  const branches = await call<{ name: string }[]>(other.page, "GET", "/api/branches", other.org.slug)
  expect(branches.map((branch) => branch.name)).toEqual(["Sede Central"])
  const extraName = `Sede Extra ${id}`
  await call<{ id: string }>(owner.page, "POST", "/api/branches", owner.org.slug, { name: extraName }, 201)
  await gotoHydrated(other.page, tenant(other.org.slug, "/settings/branches"))
  await expect(other.page.getByText(extraName)).toHaveCount(0)
  await expect(other.page.getByText("Sede Central")).toBeVisible()
})

test("auth: retorno al tenant conserva origen", async ({ browser, createOwner }, testInfo) => {
  const owner = await createOwner("retorno")
  const expectedOrigin = new URL(tenant(owner.org.slug, "/")).origin
  expect(new URL(expectedOrigin).port, "el proxy usa un puerto no estándar").not.toBe("")

  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const page = await context.newPage()
    await gotoHydrated(page, tenant(owner.org.slug, "/settings/branches"))
    await expect(page).toHaveURL(panelPattern("/login?next="))
    const nextRaw = new URL(page.url()).searchParams.get("next")
    expect(nextRaw).toBeTruthy()
    const nextUrl = new URL(nextRaw as string)
    expect(nextUrl.origin).toBe(expectedOrigin)
    expect(nextUrl.pathname).toBe("/settings/branches")
    await page.getByLabel("Correo").fill(owner.user.email)
    await page.getByLabel("Contraseña").fill(owner.user.password)
    await page.getByRole("button", { name: "Entrar", exact: true }).click()
    await expect(page).toHaveURL(tenantPattern(owner.org.slug, "/settings/branches"))
    expect(new URL(page.url()).origin).toBe(expectedOrigin)
    await expect(page.getByText("Sede Central")).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("retorno-tenant.png"), fullPage: true })
  } finally {
    await context.close()
  }
})

test("auth: un no-miembro no entra en otro tenant", async ({ createOwner }) => {
  const first = await createOwner("tenant-a")
  const second = await createOwner("tenant-b")
  await gotoHydrated(second.page, tenant(first.org.slug, "/settings/branches"))
  // Vuelve a «Elige tu clínica» sin entrar sola a la suya (`?cambiar=1`, issue 114).
  await expect(second.page).toHaveURL(`${PANEL}/?cambiar=1`)
  await expect(second.page.getByText(first.org.name)).toHaveCount(0)
})
