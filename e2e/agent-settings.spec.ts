import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { tenant } from "./env"
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

test("configuración del agente: proveedor propio con clave cifrada, prueba de conexión y auditoría", async ({ owner }, info) => {
  const { page, org } = owner
  const provider = await fakeProvider()
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await gotoHydrated(page, tenant(org.slug, "/settings/agent"))
    const detail = page.getByRole("definition").filter({ hasText: /^odentIA$/ })
    await expect(detail).toBeVisible()
    await page.getByRole("button", { name: "Editar" }).click()
    await expect(page.getByRole("group", { name: "Proveedor del modelo" })).toBeVisible()
    await page.getByRole("checkbox", { name: "Usar la cuenta propia de la clínica" }).check()
    await page.getByLabel("URL base del proveedor").fill(provider.baseUrl)
    await page.getByLabel("Clave de API").fill("sk-e2e-secreta")
    await page.getByLabel(/^Modelo/).fill("modelo-controlado")
    await page.getByRole("button", { name: "Probar conexión" }).click()
    await expect(page.getByRole("status").filter({ hasText: "El proveedor respondió" })).toBeVisible()
    expect(provider.seen).toEqual(["Bearer sk-e2e-secreta"])
    await info.attach("proveedor-probado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })
    await page.getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible()
    await expect(page.getByText(`Cuenta propia · 127.0.0.1`, { exact: false })).toBeVisible()
    await expect(page.getByText("Clave guardada", { exact: true })).toBeVisible()
    await info.attach("proveedor-guardado", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" })

    // La lectura nunca devuelve la clave; la prueba sin reescribirla usa la guardada.
    const config = await call<{ llmBaseUrl: string | null; hasLlmApiKey: boolean; model: string | null }>(
      page,
      "GET",
      "/api/agent/config",
      org.slug,
    )
    expect(config).toMatchObject({ llmBaseUrl: provider.baseUrl, hasLlmApiKey: true, model: "modelo-controlado" })
    expect(JSON.stringify(config)).not.toContain("sk-e2e")
    const retest = await call<{ ok: boolean }>(page, "POST", "/api/agent/config/llm/test", org.slug, {})
    expect(retest.ok).toBe(true)
    expect(provider.seen).toHaveLength(2)

    // Una clave sin URL, o cambiar la URL sin reescribir la clave, se rechazan en servidor.
    // (El rechazo de hosts privados no se ejercita aquí: el harness admite servidores locales.)
    const halfPair = await api(page, "PUT", "/api/agent/config", org.slug, { llmBaseUrl: null, llmApiKey: "sk-otra" })
    expect(halfPair.status).toBe(400)
    const moved = await api(page, "PUT", "/api/agent/config", org.slug, { llmBaseUrl: `${provider.baseUrl}/otro` })
    expect(moved.status).toBe(400)

    // Desmarcar la cuenta propia vuelve al proveedor de odentIA.
    await page.getByRole("button", { name: "Editar" }).click()
    await page.getByRole("checkbox", { name: "Usar la cuenta propia de la clínica" }).uncheck()
    await page.getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible()
    await expect(detail).toBeVisible()
    const reset = await call<{ llmBaseUrl: string | null; hasLlmApiKey: boolean }>(page, "GET", "/api/agent/config", org.slug)
    expect(reset).toMatchObject({ llmBaseUrl: null, hasLlmApiKey: false })

    const audit = await call<{ items: Array<{ action: string; actorName: string | null }> }>(
      page,
      "GET",
      "/api/workspace/audit?action=agent.config_updated",
      org.slug,
    )
    expect(audit.items.length).toBeGreaterThan(0)
    expect(audit.items[0]?.actorName).toBeTruthy()
    expect(JSON.stringify(audit)).not.toContain("sk-e2e")
  } finally {
    await provider.close()
  }
})
