import { expect, type Page, test } from "@playwright/test"
import { API, PANEL, tenant, tenantPattern } from "./env"
import { gotoHydrated } from "./hydration"
import { latestLinkFor } from "./mailpit"

const run = Date.now().toString(36)

const userA = { name: "Agenda Ana", email: `agenda-a-${run}@test.dev`, password: "secreto-123" }
const userB = { name: "Agenda Beto", email: `agenda-b-${run}@test.dev`, password: "secreto-123" }
const orgA = { name: "Clínica Agenda A", slug: `clinica-ag-${run}` }
const orgB = { name: "Clínica Agenda B", slug: `clinica-bg-${run}` }

async function register(page: Page, user: typeof userA) {
  await gotoHydrated(page, `${PANEL}/register`)
  const [first, ...rest] = user.name.split(" ")
  await page.getByLabel("Nombre").fill(first ?? "")
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
  await gotoHydrated(page, `${PANEL}/login`)
  await page.getByLabel("Correo").fill(user.email)
  await page.getByLabel("Contraseña").fill(user.password)
  await page.getByRole("button", { name: "Ingresar" }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Alta de organización y sucursal por API; devuelve el id de la sucursal. */
async function onboard(page: Page, org: typeof orgA): Promise<string> {
  const result = await page.evaluate(
    async ({ apiBase, org }) => {
      const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(`${apiBase}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          credentials: "include",
          body: JSON.stringify(body),
        })
        return { status: response.status, data: (await response.json().catch(() => null)) as never }
      }
      const created = await post("/api/auth/organization/create", {
        name: org.name,
        slug: org.slug,
      })
      const createdData = created.data as { id?: string; data?: { id?: string } } | null
      const orgId = createdData?.id ?? createdData?.data?.id
      if (!orgId) return { error: `organization.create:${created.status}` }
      await post("/api/auth/organization/set-active", { organizationId: orgId })
      const orgHeader = { "x-odentia-org": org.slug }
      const profile = await fetch(`${apiBase}/api/org-profile`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...orgHeader },
        credentials: "include",
        body: JSON.stringify({ legalName: `${org.name} S.A.C.`, countryCode: "PE" }),
      })
      if (!profile.ok) return { error: `org-profile:${profile.status}` }
      const branch = await post("/api/branches", { name: "Sede Central" }, orgHeader)
      const branchData = branch.data as { data?: { id?: string }; id?: string } | null
      const branchId = branchData?.data?.id ?? branchData?.id
      if (branch.status !== 200 && branch.status !== 201) {
        return { error: `branches:${branch.status}:${JSON.stringify(branch.data)?.slice(0, 300)}` }
      }
      if (!branchId)
        return { error: `branches:shape:${JSON.stringify(branch.data)?.slice(0, 300)}` }
      return { branchId }
    },
    { apiBase: API, org },
  )
  if ("error" in result) throw new Error(result.error ?? "onboard")
  // Entrar al espacio del tenant fija la organización activa de la sesión.
  await gotoHydrated(page, tenant(org.slug, "/patients"))
  await expect(page).toHaveURL(tenantPattern(org.slug, "/patients"))
  return result.branchId
}

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

async function call<T>(
  page: Page,
  method: string,
  path: string,
  slug: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const result = await api<{ data: T }>(page, method, path, slug, body)
  expect(result.status, `${method} ${path} → ${JSON.stringify(result.body)}`).toBe(expected)
  return (result.body as { data: T }).data
}

/** Hoy en Lima como «yyyy-mm-dd» y un instante a las 18:00 Lima (UTC−5 fijo). */
function limaToday(): { date: string; startsAt: string; endsAt: string } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  return { date, startsAt: `${date}T23:00:00.000Z`, endsAt: `${date}T23:45:00.000Z` }
}

test("agenda: alta de sillón y cita, conflicto 409, vista en el tenant y aislamiento", async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000)
  await register(page, userA)
  await verifyEmail(page, userA.email)
  await login(page, userA)
  const branchId = await onboard(page, orgA)

  // Sillón de la sede y paciente de la org, todo por la API real.
  const chair = await call<{ id: string }>(
    page,
    "POST",
    "/api/agenda/chairs",
    orgA.slug,
    { branchId, name: "Sillón 1" },
    201,
  )
  const patient = await call<{ id: string }>(
    page,
    "POST",
    "/api/patients",
    orgA.slug,
    {
      submissionId: crypto.randomUUID(),
      answers: {
        demographics: { displayName: "Micaela Ríos", docType: "DNI", docNumber: "45678901" },
        respondent: "staff",
        privacyAccepted: false,
      },
    },
    201,
  )

  const resources = await call<{
    professionals: { id: string; label: string }[]
    chairs: { id: string; label: string }[]
    timeZone: string
  }>(page, "GET", "/api/agenda/resources", orgA.slug)
  expect(resources.chairs.map((item) => item.label)).toContain("Sillón 1")
  const professional = resources.professionals.find((item) => item.label.includes("Agenda Ana"))
  if (!professional) throw new Error("Profesional no listado en resources")

  const { date, startsAt, endsAt } = limaToday()
  const appointment = await call<{ id: string; version: number }>(
    page,
    "POST",
    "/api/appointments",
    orgA.slug,
    {
      patientId: patient.id,
      dentistUserId: professional.id,
      chairId: chair.id,
      startsAt,
      endsAt,
      reason: "Control de ortodoncia",
    },
    201,
  )

  // Solape en el mismo sillón/profesional: la exclusión de Postgres responde 409.
  const conflict = await api<{ error: { code: string } }>(
    page,
    "POST",
    "/api/appointments",
    orgA.slug,
    {
      patientId: patient.id,
      dentistUserId: professional.id,
      chairId: chair.id,
      startsAt,
      endsAt,
    },
  )
  expect(conflict.status).toBe(409)
  expect(conflict.body?.error.code).toBe("APPOINTMENT_CONFLICT")

  // Mover la cita con la versión correcta y luego cancelarla por estado.
  const moved = await call<{ version: number }>(
    page,
    "POST",
    `/api/appointments/${appointment.id}/move`,
    orgA.slug,
    { expectedVersion: appointment.version, startsAt, endsAt },
  )
  expect(moved.version).toBeGreaterThan(appointment.version)

  // Vista del tenant: la cita aparece en la agenda del día.
  await gotoHydrated(page, tenant(orgA.slug, `/agenda?date=${date}`))
  await expect(page).toHaveURL(tenantPattern(orgA.slug, "/agenda"))
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible()
  await expect(page.getByText("Micaela Ríos").first()).toBeVisible({ timeout: 20_000 })

  // Agrupación por sillón: la columna pasa a ser el sillón creado.
  await page.getByLabel("Ver por").selectOption("chairs")
  await expect(page.getByText("Sillón 1").first()).toBeVisible()

  // Aislamiento: otra organización no ve sillones ni citas ajenas.
  const contextB = await browser.newContext()
  const pageB = await contextB.newPage()
  await register(pageB, userB)
  await verifyEmail(pageB, userB.email)
  await login(pageB, userB)
  await onboard(pageB, orgB)
  const resourcesB = await call<{ chairs: { id: string }[] }>(
    pageB,
    "GET",
    "/api/agenda/resources",
    orgB.slug,
  )
  expect(resourcesB.chairs).toHaveLength(0)
  const listB = await call<{ length?: number }[] | { data?: unknown[] }>(
    pageB,
    "GET",
    `/api/appointments?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`,
    orgB.slug,
  )
  const rowsB = Array.isArray(listB) ? listB : (listB.data ?? [])
  expect(rowsB).toHaveLength(0)
  await contextB.close()
})
