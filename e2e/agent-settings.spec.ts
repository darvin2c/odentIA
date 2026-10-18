import { tenant } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

test("modelo del agente: Integraciones dice con qué modelo trabaja y si responde, sin nada que elegir (ADR 0052)", async ({ owner }, info) => {
  const { page, org } = owner
  const config = () => call<Record<string, unknown>>(page, "GET", "/api/agent/config", org.slug)
  await page.setViewportSize({ width: 1440, height: 900 })
  // Ajustes que ninguna pantalla de modelo toca: siguen como estaban.
  const hidden = await api(page, "PUT", "/api/agent/config", org.slug, { decisionProvider: "baseline", maxTurns: 7 })
  expect(hidden.status).toBe(200)

  await gotoHydrated(page, tenant(org.slug, "/settings/integrations"))
  const block = page.getByRole("region", { name: "Inteligencia artificial" })
  await expect(block).toContainText("ChatGPT 6")
  // El modelo de demostración siempre responde.
  await expect(block).toContainText("Responde")
  // Ya no hay a dónde ir para cambiarlo: ni enlace, ni botón, ni otra opción.
  await expect(block.getByRole("link")).toHaveCount(0)
  await expect(block.getByRole("button")).toHaveCount(0)
  await expect(page.getByText(/Claude|Anthropic|Cuenta propia|Probar conexión/)).toHaveCount(0)
  await info.attach("modelo-en-integraciones", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

  // Un cliente viejo que mande el modelo no cambia nada, y la configuración no lo devuelve.
  expect((await api(page, "PUT", "/api/agent/config", org.slug, { llm: "claude_5_5" })).status).toBe(200)
  const saved = await config()
  expect(saved).toMatchObject({ decisionProvider: "baseline", maxTurns: 7 })
  expect(saved).not.toHaveProperty("llm")
  expect((await api(page, "POST", "/api/agent/config/llm/test", org.slug, {})).status).toBe(404)

  // Queda en «Actividad del equipo» quién cambió la configuración, dicho con palabras.
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
