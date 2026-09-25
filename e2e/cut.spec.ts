import { expect, type Page, test } from "@playwright/test"
import { API, PANEL, panelPattern, tenant, tenantPattern } from "./env"
import { gotoHydrated, waitForHydration } from "./hydration"
import { latestLinkFor } from "./mailpit"

const run = Date.now().toString(36)

const userA = { name: "Ana Norte", email: `ana-${run}@test.dev`, password: "secreto-123" }
const userB = { name: "Bruno Sur", email: `bruno-${run}@test.dev`, password: "secreto-123" }
const userC = { name: "Cora Lima", email: `cora-${run}@test.dev`, password: "secreto-123" }

const orgA = { name: "Clínica Norte", slug: `clinica-norte-${run}`, branch: "Sede Lima" }
const orgC = { name: "Clínica Sur", slug: `clinica-sur-${run}`, branch: "Sede Sur" }

// Navegaciones a un tenant: URLs absolutas (page.goto las acepta).
const tenantBranches = (slug: string) => tenantPattern(slug, "/branches")

async function register(page: Page, user: typeof userA) {
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

async function login(page: Page, user: typeof userA) {
  await gotoHydrated(page, "/login")
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Ingresar" }).click()
}

async function onboard(page: Page, org: typeof orgA) {
  await expect(page).toHaveURL(/onboarding/)
  // Tras el redirect del login la página vuelve a montarse: sin esperar la
  // hidratación, los campos del asistente se rellenan sin estado y no envía.
  await waitForHydration(page)
  await page.getByLabel("Nombre de la organización").fill(org.name)
  await page.getByLabel("Slug (subdominio)").fill(org.slug)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByLabel("Razón social").fill(`${org.name} S.A.C.`)
  await page.getByRole("button", { name: "Continuar" }).click()
  await page.getByLabel("Nombre de la sucursal").fill(org.branch)
  await page.getByRole("button", { name: "Crear organización" }).click()
  // El panel redirige al tenant con SSO por cookie compartida.
  await expect(page).toHaveURL(tenantBranches(org.slug))
  await expect(page.getByText(org.branch)).toBeVisible({ timeout: 30_000 })
}

test("corte de integración: auth, tenants, roles, cola y SSE", async ({ browser }) => {
  test.setTimeout(300_000)

  // (1-4) Usuario A: registro, verificación, login, onboarding.
  const contextA = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageA = await contextA.newPage()
  await register(pageA, userA)
  await verifyEmail(pageA, userA.email)
  await login(pageA, userA)
  await onboard(pageA, orgA)

  // (5) A invita a B como member.
  await gotoHydrated(pageA, tenant(orgA.slug, "/members"))
  await pageA.getByRole("button", { name: "Invitar miembro" }).click()
  await pageA.getByLabel("Invitar por correo").fill(userB.email)
  await pageA.getByRole("button", { name: "Invitar", exact: true }).click()
  await expect(pageA.getByText(userB.email)).toBeVisible()

  // (6) B acepta la invitación (el enlace apunta al panel) y aterriza en el tenant.
  const contextB = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageB = await contextB.newPage()
  await register(pageB, userB)
  await verifyEmail(pageB, userB.email)
  await login(pageB, userB)
  const invitationLink = await latestLinkFor(userB.email, `Invitación a ${orgA.name}`)
  expect(invitationLink.startsWith(`${PANEL}/accept-invitation/`)).toBe(true)
  await pageB.goto(invitationLink)
  await waitForHydration(pageB)
  await expect(pageB).toHaveURL(tenantBranches(orgA.slug), { timeout: 20_000 })
  await expect(pageB.getByText(orgA.branch)).toBeVisible({ timeout: 30_000 })

  // (7) Rol member: la API rechaza escritura y la UI oculta el alta.
  // El fetch va en el navegador: el request-context de Playwright corre en
  // Node y no resuelve *.odentia.localhost (hosts de portless) en WSL.
  const forbiddenStatus = await pageB.evaluate(
    async ({ api, slug }) => {
      const response = await fetch(`${api}/api/branches`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-odentia-org": slug },
        credentials: "include",
        body: JSON.stringify({ name: "Sede Prohibida" }),
      })
      return response.status
    },
    { api: API, slug: orgA.slug },
  )
  expect(forbiddenStatus).toBe(403)
  await gotoHydrated(pageB, tenant(orgA.slug, "/branches"))
  await expect(pageB.getByRole("button", { name: "Nueva sucursal" })).toHaveCount(0)

  // (8) Tenant C: su listado no contiene datos de la org A (UI y API).
  const contextC = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageC = await contextC.newPage()
  await register(pageC, userC)
  await verifyEmail(pageC, userC.email)
  await login(pageC, userC)
  await onboard(pageC, orgC)
  await expect(pageC.getByText(orgA.branch)).toHaveCount(0)
  const branchesCNames = await pageC.evaluate(
    async ({ api, slug }) => {
      const response = await fetch(`${api}/api/branches`, {
        headers: { "x-odentia-org": slug },
        credentials: "include",
      })
      const body = (await response.json()) as { data: { name: string }[] }
      return body.data.map((row) => row.name)
    },
    { api: API, slug: orgC.slug },
  )
  expect(branchesCNames).toEqual([orgC.branch])

  // (9) A publica una tarea demo y el feed SSE la muestra en < 15 s.
  await gotoHydrated(pageA, tenant(orgA.slug, "/demo"))
  await pageA.getByPlaceholder("Escribe un mensaje").fill("hola")
  await pageA.getByRole("button", { name: "Enviar tarea" }).click()
  await expect(pageA.getByText("demo_task.done").first()).toBeVisible({ timeout: 15_000 })

  // (10) Anónimo abre el tenant: va al login del panel y vuelve tras ingresar.
  const contextD = await browser.newContext({ ignoreHTTPSErrors: true })
  const pageD = await contextD.newPage()
  await gotoHydrated(pageD, tenant(orgA.slug, "/branches"))
  await expect(pageD).toHaveURL(panelPattern("/login?next="))
  await pageD.getByLabel("Correo").fill(userA.email)
  await pageD.getByLabel("Contraseña").fill(userA.password)
  await pageD.getByRole("button", { name: "Ingresar" }).click()
  await expect(pageD).toHaveURL(tenantBranches(orgA.slug), { timeout: 20_000 })
  await expect(pageD.getByText(orgA.branch)).toBeVisible({ timeout: 30_000 })

  // (11) No-miembro abre el tenant: aterriza en la lista del panel.
  await gotoHydrated(pageC, tenant(orgA.slug, "/branches"))
  await expect(pageC).toHaveURL(`${PANEL}/`)

  await contextA.close()
  await contextB.close()
  await contextC.close()
  await contextD.close()
})
