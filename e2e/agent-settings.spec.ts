import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { tenant, tenantPattern } from "./env"
import { api, call, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/** Proveedor compatible con OpenAI controlado: responde "OK" y registra la clave recibida. */
async function fakeProvider() {
  const seen: string[] = []
  const server: Server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? "")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        created: 1,
        model: "modelo-controlado",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("El proveedor de prueba no abrió un puerto")
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test("modelo del agente: la clínica elige la cuenta, prueba la conexión, y lo que ya no se muestra sigue guardado", async ({ owner }, info) => {
  const { page, org } = owner
  const provider = await fakeProvider()
  type Config = { llmBaseUrl: string | null; hasLlmApiKey: boolean; model: string | null; decisionProvider: string; maxTurns: number }
  const config = () => call<Config>(page, "GET", "/api/agent/config", org.slug)
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoHydrated(page, tenant(org.slug, "/settings/integrations"))
    // Ajustes que la pantalla ya no muestra: tienen que seguir como estaban después de guardar aquí.
    const hidden = await api(page, "PUT", "/api/agent/config", org.slug, { decisionProvider: "baseline", maxTurns: 7 })
    expect(hidden.status).toBe(200)

    // Se llega desde Integraciones, por su fila.
    await page.getByRole("link", { name: "Cambiar Modelo del agente", exact: true }).click()
    await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/integrations/model"))
    await expect(page.getByRole("heading", { level: 1, name: "Modelo del agente" })).toBeVisible()
    const included = page.getByRole("radio", { name: /^Incluido con odentIA/ })
    const own = page.getByRole("radio", { name: /^Cuenta propia de la clínica/ })
    const save = page.getByRole("button", { name: "Guardar", exact: true })
    await expect(included).toBeChecked()
    // La clínica solo elige la cuenta: lo demás no está en esta pantalla, y sin cambios no hay nada que guardar.
    await expect(page.getByRole("radio")).toHaveCount(2)
    await expect(page.getByText("Modelo de decisión")).toHaveCount(0)
    await expect(page.getByText("Autonomía por acción")).toHaveCount(0)
    await expect(page.getByLabel("Dirección del proveedor")).toHaveCount(0)
    await expect(save).toBeDisabled()

    await own.click()
    // Con la cuenta propia a medias no se guarda ni se prueba: dice qué falta.
    await expect(page.getByText("Escribe la dirección del proveedor.", { exact: true })).toBeVisible()
    await expect(save).toBeDisabled()
    await page.getByLabel("Dirección del proveedor").fill(provider.baseUrl)
    await page.getByLabel("Clave", { exact: true }).fill("sk-e2e-secreta")
    await page.getByLabel("Modelo", { exact: true }).fill("modelo-controlado")
    await page.getByRole("button", { name: "Probar conexión" }).click()
    await expect(page.getByRole("status").filter({ hasText: "el proveedor respondió" })).toBeVisible()
    expect(provider.seen).toEqual(["Bearer sk-e2e-secreta"])
    await info.attach("proveedor-probado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
    await save.click()
    await expect(page.getByText("Modelo del agente guardado", { exact: true })).toBeVisible()
    await expect(own).toBeChecked()
    await expect(page.getByLabel("Clave", { exact: true })).toHaveAttribute("placeholder", /^Guardada/)
    await expect(save).toBeDisabled()
    await info.attach("proveedor-guardado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

    // La lectura nunca devuelve la clave; la prueba sin reescribirla usa la guardada. Lo oculto no cambió.
    const stored = await config()
    expect(stored).toMatchObject({
      llmBaseUrl: provider.baseUrl,
      hasLlmApiKey: true,
      model: "modelo-controlado",
      decisionProvider: "baseline",
      maxTurns: 7,
    })
    expect(JSON.stringify(stored)).not.toContain("sk-e2e")
    const retest = await call<{ ok: boolean }>(page, "POST", "/api/agent/config/llm/test", org.slug, {})
    expect(retest.ok).toBe(true)
    expect(provider.seen).toHaveLength(2)

    // Una clave sin URL, o cambiar la URL sin reescribir la clave, se rechazan en servidor.
    // (El rechazo de hosts privados no se ejercita aquí: el harness admite servidores locales.)
    const halfPair = await api(page, "PUT", "/api/agent/config", org.slug, { llmBaseUrl: null, llmApiKey: "sk-otra" })
    expect(halfPair.status).toBe(400)
    const moved = await api(page, "PUT", "/api/agent/config", org.slug, { llmBaseUrl: `${provider.baseUrl}/otro` })
    expect(moved.status).toBe(400)

    // Volver a la cuenta incluida retira la cuenta propia con su clave y su modelo; lo oculto sigue igual.
    await included.click()
    await save.click()
    await expect.poll(config).toMatchObject({
      llmBaseUrl: null,
      hasLlmApiKey: false,
      model: null,
      decisionProvider: "baseline",
      maxTurns: 7,
    })
    await expect(included).toBeChecked()
    await expect(page.getByLabel("Dirección del proveedor")).toHaveCount(0)

    // Queda en «Actividad del equipo» quién lo cambió, dicho con palabras y sin la clave.
    const audit = await call<{ items: Array<{ action: string; actorName: string | null; what: string; who: string }> }>(
      page,
      "GET",
      "/api/workspace/audit?action=agent.config_updated",
      org.slug,
    )
    expect(audit.items.length).toBeGreaterThan(0)
    expect(audit.items[0]?.actorName).toBeTruthy()
    expect(audit.items[0]).toMatchObject({ what: "Cambió la configuración del agente", who: audit.items[0]?.actorName })
    expect(JSON.stringify(audit)).not.toContain("sk-e2e")
    await gotoHydrated(page, tenant(org.slug, "/settings/audit?area=agente"))
    const activity = page.getByRole("row").filter({ hasText: "Cambió la configuración del agente" })
    await expect(activity.first()).toContainText(audit.items[0]?.who ?? "")
    // El código de la acción no se muestra en ninguna parte.
    await expect(page.getByText("agent.config_updated")).toHaveCount(0)
    await expect(page.getByLabel("Área")).toHaveText("Agente")
  } finally {
    await provider.close()
  }
})
