import type { Page, Route } from "@playwright/test"
import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"
import { surface as sideSurface } from "./surface"

// Solo se inyectan fallos de transporte; los datos y las recuperaciones usan la API real.
async function failResponse(page: Page, route: Route, status: number) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify({ error: { code: "INTERNAL_TEST", message: "postgres://secreto-interno", details: { stack: "detalle-interno" } } }),
  })
}

for (const section of [
  { tab: "productos", endpoint: "/api/inventory/products", loading: "Cargando productos…", empty: "Sin productos" },
  { tab: "compras", endpoint: "/api/inventory/purchase-orders", loading: "Cargando órdenes…", empty: "Sin órdenes de compra" },
  { tab: "alertas", endpoint: "/api/inventory/alerts", loading: "Cargando alertas…", empty: "Todo en orden" },
]) {
  test(`inventario: ${section.tab} distingue carga, error y vacío confirmado`, async ({ owner }) => {
    const { page, org } = owner
    const gate = Promise.withResolvers<void>()
    let failing = true
    let requests = 0
    await page.route(url => url.pathname === section.endpoint, async route => {
      if (route.request().method() !== "GET") return route.continue()
      requests++
      if (!failing) return route.continue()
      await gate.promise
      await failResponse(page, route, 500)
    })
    await gotoHydrated(page, tenant(org.slug, "/inventory"))
    if (section.tab !== "productos") await page.getByRole("tab", { name: section.tab, exact: true }).click()
    try {
      await expect(page.getByText(section.loading, { exact: true })).toBeVisible()
      await expect(page.getByText(section.empty, { exact: true })).toBeHidden()
    } finally {
      gate.resolve()
    }
    const alert = page.getByRole("alert")
    await expect(alert.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible()
    await expect(page.getByText(section.empty, { exact: true })).toBeHidden()
    await expect(page.getByText(/secreto-interno|detalle-interno/)).toBeHidden()
    expect(requests).toBe(1)
    failing = false
    await alert.getByRole("button", { name: "Reintentar", exact: true }).click()
    await expect(page.getByText(section.empty, { exact: true })).toBeVisible()
    expect(requests).toBe(2)
  })
}

test("conocimiento: error de consulta y de versiones se recuperan sin inventar un vacío", async ({ owner }) => {
  const { page, org } = owner
  const entry = await call<{ id: string }>(page, "POST", "/api/agent/knowledge", org.slug, {
    kind: "faq", title: "Horario de atención", body: "Atendemos de lunes a viernes.", branchId: null,
  }, 201)
  await call(page, "POST", `/api/agent/knowledge/${entry.id}/status`, org.slug, { status: "publicada" })
  let failEntries = true
  await page.route(url => url.pathname === "/api/agent/knowledge", async route => {
    if (route.request().method() === "GET" && failEntries) return failResponse(page, route, 500)
    await route.continue()
  })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  await expect(page.getByRole("alert").getByRole("button", { name: "Reintentar" })).toBeVisible()
  await expect(page.getByText(/^(Todavía no hay respuestas oficiales|Sin resultados)$/)).toBeHidden()
  failEntries = false
  await page.getByRole("button", { name: "Reintentar", exact: true }).click()
  await expect(page.getByText("Horario de atención", { exact: true })).toBeVisible()

  let failVersions = true
  await page.route(url => url.pathname === `/api/agent/knowledge/${entry.id}/revisions`, async route => {
    if (failVersions) return route.abort("failed")
    await route.continue()
  })
  await page.getByRole("button", { name: /^Ver versiones/ }).click()
  await expect(page.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible()
  await expect(page.getByText("Sin versiones", { exact: true })).toBeHidden()
  failVersions = false
  await page.getByRole("button", { name: "Reintentar", exact: true }).click()
  await expect(page.getByText("Atendemos de lunes a viernes.", { exact: true })).toHaveCount(2)
})

test("reportes: un fallo de red conserva el intervalo y permite consultar otra vez", async ({ owner }) => {
  const { page, org } = owner
  let failing = true
  const requested: string[] = []
  await page.route(url => url.pathname === "/api/workspace/reports", async route => {
    requested.push(new URL(route.request().url()).search)
    if (failing) return route.abort("failed")
    await route.continue()
  })
  await gotoHydrated(page, tenant(org.slug, "/reports"))
  await expect(page.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible()
  await expect(page.getByText(/intervalo válido/)).toBeHidden()
  const from = await page.getByLabel("Desde", { exact: true }).inputValue()
  const to = await page.getByLabel("Hasta", { exact: true }).inputValue()
  failing = false
  await page.getByRole("button", { name: "Reintentar", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Asistencia y cancelaciones" })).toBeVisible()
  await expect(page.getByLabel("Desde", { exact: true })).toHaveValue(from)
  await expect(page.getByLabel("Hasta", { exact: true })).toHaveValue(to)
  expect(requested).toEqual([requested[0], requested[0]])
})

for (const status of [500, 404, 403]) {
  test(`paciente: HTTP ${status} no expone detalles ni confunde infraestructura con ausencia`, async ({ owner }) => {
    const { page, org } = owner
    const patient = await call<{ id: string }>(page, "POST", "/api/patients", org.slug, {
      submissionId: crypto.randomUUID(),
      answers: { demographics: { displayName: "Paciente recuperable" }, respondent: "staff", privacyAccepted: false },
    }, 201)
    let failing = true
    let requests = 0
    await page.route(url => url.pathname === `/api/patients/${patient.id}`, async route => {
      requests++
      if (failing) return failResponse(page, route, status)
      await route.continue()
    })
    await gotoHydrated(page, tenant(org.slug, `/patients/${patient.id}`))
    const alert = page.getByRole("alert")
    await expect(alert).toBeVisible()
    await expect(page.getByRole("heading", { name: "Paciente recuperable", exact: true })).toBeHidden()
    await expect(page.getByText(/secreto-interno|detalle-interno/)).toBeHidden()
    expect(requests).toBe(1)
    if (status === 500) {
      await expect(alert.getByText("No encontrado", { exact: true })).toBeHidden()
      failing = false
      await alert.getByRole("button", { name: "Reintentar", exact: true }).click()
      await expect(page.getByRole("heading", { name: "Paciente recuperable", exact: true })).toBeVisible()
      expect(requests).toBe(2)
    } else {
      await expect(alert.getByText(status === 404 ? "No encontrado" : "Sin acceso", { exact: true })).toBeVisible()
      await expect(alert.getByRole("button", { name: "Reintentar", exact: true })).toBeHidden()
    }
  })
}

test("conocimiento: rechazo conserva campos y permite corregir sin filtrar el error interno", async ({ owner }) => {
  const { page, org } = owner
  let failing = true
  let writes = 0
  await page.route(url => url.pathname === "/api/agent/knowledge", async route => {
    if (route.request().method() !== "POST") return route.continue()
    writes++
    if (failing) return failResponse(page, route, 422)
    await route.continue()
  })
  await gotoHydrated(page, tenant(org.slug, "/agent/knowledge"))
  await page.getByRole("button", { name: "Nueva respuesta", exact: true }).click()
  const drawer = sideSurface(page, { name: "Nueva respuesta", exact: true })
  await drawer.getByLabel("La pregunta", { exact: true }).fill("Política de citas")
  await drawer.getByLabel("La respuesta", { exact: true }).fill("Confirma tu cita con recepción.")
  await drawer.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(drawer.getByRole("alert")).toBeVisible()
  await expect(drawer.getByLabel("La pregunta", { exact: true })).toHaveValue("Política de citas")
  await expect(drawer.getByLabel("La respuesta", { exact: true })).toHaveValue("Confirma tu cita con recepción.")
  await expect(drawer.getByText(/secreto-interno|detalle-interno/)).toBeHidden()
  failing = false
  await drawer.getByLabel("La pregunta", { exact: true }).fill("Política de confirmación")
  await drawer.getByRole("button", { name: "Guardar", exact: true }).click()
  await expect(drawer).toBeHidden()
  // Guardar publica por defecto: queda vigente sin un segundo paso.
  const entries = await call<Array<{ title: string; body: string; state: string }>>(page, "GET", "/api/agent/knowledge", org.slug)
  expect(entries.map(({ title, body, state }) => ({ title, body, state }))).toEqual([
    { title: "Política de confirmación", body: "Confirma tu cita con recepción.", state: "vigente" },
  ])
  expect(writes).toBe(2)
})

for (const surface of ["knowledge", "product"] as const) {
  test(`${surface}: respuesta perdida tras guardar conserva entrada y bloquea duplicación ambigua`, async ({ owner }) => {
    const { page, org } = owner
    const endpoint = surface === "knowledge" ? "/api/agent/knowledge" : "/api/inventory/products"
    let writes = 0
    let relaying = false
    await page.route(url => url.pathname === endpoint, async route => {
      if (route.request().method() !== "POST" || relaying) return route.continue()
      writes++
      // La operación sí se aplica (desde el navegador, con la misma sesión);
      // solo se pierde la respuesta de la petición original.
      relaying = true
      const applied = await api(page, "POST", endpoint, org.slug, route.request().postDataJSON())
      relaying = false
      expect(applied.status).toBe(201)
      await failResponse(page, route, 500)
    })
    await gotoHydrated(page, tenant(org.slug, surface === "knowledge" ? "/agent/knowledge" : "/inventory"))
    await page.getByRole("button", { name: surface === "knowledge" ? "Nueva respuesta" : "Producto", exact: true }).click()
    const drawer = sideSurface(page, { name: surface === "knowledge" ? "Nueva respuesta" : "Nuevo producto", exact: true })
    if (surface === "knowledge") {
      await drawer.getByLabel("La pregunta", { exact: true }).fill("Entrada confirmada en servidor")
      await drawer.getByLabel("La respuesta", { exact: true }).fill("No duplicar esta entrada.")
    } else {
      await drawer.getByLabel("SKU", { exact: true }).fill("PROD-UNICO")
      await drawer.getByLabel("Nombre", { exact: true }).fill("Producto confirmado en servidor")
    }
    await drawer.getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(drawer.getByRole("alert")).toBeVisible()
    await expect(drawer.getByRole("button", { name: "Guardar", exact: true })).toBeDisabled()
    const field = drawer.getByLabel(surface === "knowledge" ? "La pregunta" : "Nombre", { exact: true })
    await expect(field).toHaveValue(surface === "knowledge" ? "Entrada confirmada en servidor" : "Producto confirmado en servidor")
    await field.press("Enter")
    const saved = await call<Array<{ title?: string; sku?: string }>>(page, "GET", `${endpoint}${surface === "knowledge" ? "?status=borrador" : ""}`, org.slug)
    expect(saved.map(item => surface === "knowledge" ? item.title : item.sku)).toEqual([surface === "knowledge" ? "Entrada confirmada en servidor" : "PROD-UNICO"])
    expect(writes).toBe(1)
  })
}
