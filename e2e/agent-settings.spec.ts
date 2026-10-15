import { tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

test("modelo del agente: la clínica elige entre los dos modelos de odentIA, y lo que ya no se muestra sigue guardado", async ({ owner }, info) => {
  const { page, org } = owner
  type Config = { llm: string; decisionProvider: string; maxTurns: number }
  const config = () => call<Config>(page, "GET", "/api/agent/config", org.slug)
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoHydrated(page, tenant(org.slug, "/settings/integrations"))
  // Ajustes que la pantalla no muestra: tienen que seguir como estaban después de guardar aquí.
  const hidden = await api(page, "PUT", "/api/agent/config", org.slug, { decisionProvider: "baseline", maxTurns: 7 })
  expect(hidden.status).toBe(200)

  // Se llega desde Integraciones, por su fila, que dice el modelo con su nombre simple.
  const row = page.getByRole("link", { name: "Cambiar Modelo del agente", exact: true })
  await expect(page.getByText("ChatGPT 6", { exact: true })).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/integrations/model"))
  await expect(page.getByRole("heading", { level: 1, name: "Modelo del agente" })).toBeVisible()
  const chatgpt = page.getByRole("radio", { name: "ChatGPT 6", exact: true })
  const claude = page.getByRole("radio", { name: "Claude 5.5", exact: true })
  const save = page.getByRole("button", { name: "Guardar", exact: true })
  // Solo dos opciones con su nombre: sin cuenta propia, direcciones, claves ni prueba de conexión.
  await expect(page.getByRole("radio")).toHaveCount(2)
  await expect(chatgpt).toBeChecked()
  await expect(page.getByText(/Cuenta propia|Dirección del proveedor|Probar conexión|Luna|Haiku/)).toHaveCount(0)
  await expect(page.getByRole("textbox")).toHaveCount(0)
  await expect(save).toBeDisabled()

  await claude.click()
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText("Modelo del agente guardado", { exact: true })).toBeVisible()
  await expect(claude).toBeChecked()
  await expect(save).toBeDisabled()
  await info.attach("modelo-guardado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
  await expect.poll(config).toMatchObject({ llm: "claude_5_5", decisionProvider: "baseline", maxTurns: 7 })

  // El servidor solo admite los dos modelos; la prueba de conexión ya no existe.
  expect((await api(page, "PUT", "/api/agent/config", org.slug, { llm: "gpt-6-luna" })).status).toBe(400)
  expect((await api(page, "POST", "/api/agent/config/llm/test", org.slug, {})).status).toBe(404)

  // Queda en «Actividad del equipo» quién lo cambió, dicho con palabras.
  const audit = await call<{ items: Array<{ action: string; actorName: string | null; what: string; who: string }> }>(
    page,
    "GET",
    "/api/workspace/audit?action=agent.config_updated",
    org.slug,
  )
  expect(audit.items.length).toBeGreaterThan(0)
  expect(audit.items[0]?.actorName).toBeTruthy()
  expect(audit.items[0]).toMatchObject({ what: "Cambió la configuración del agente", who: audit.items[0]?.actorName })
  await gotoHydrated(page, tenant(org.slug, "/settings/audit?area=agente"))
  const activity = page.getByRole("row").filter({ hasText: "Cambió la configuración del agente" })
  await expect(activity.first()).toContainText(audit.items[0]?.who ?? "")
  // El código de la acción no se muestra en ninguna parte.
  await expect(page.getByText("agent.config_updated")).toHaveCount(0)
  await expect(page.getByLabel("Área")).toHaveText("Agente")
})
