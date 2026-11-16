import { describe, expect, it } from "vitest"
import { CloudflareApiError, cloudflareHostsFirewall } from "./cloudflare-waf.js"

/**
 * El adaptador de Cloudflare de la lista de hosts permitidos (ADR 0193), con un `fetch`
 * falso: nunca se llama a la API real.
 */

const ZONE = "0123456789abcdef0123456789abcdef"
const ENTRY = `https://api.cloudflare.com/client/v4/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint`
const RULES = `https://api.cloudflare.com/client/v4/zones/${ZONE}/rulesets/rs-1/rules`
const RULE = {
  description: "Solo los hosts del sistema",
  expression: 'ends_with(http.host, ".odentia32.com") and not http.host in {"app.odentia32.com"}',
}
const ROBOT = {
  id: "regla-robot",
  description: "Bloquear robot de escaneo y rutas de archivos secretos",
  expression: "(ip.src eq 34.178.54.82)",
  action: "block",
  enabled: true,
}

/** Un `fetch` falso que guarda lo que se le pidió y responde lo dado, en orden. */
function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Headers }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    })
    const answer = answers.shift()
    if (!answer) throw new Error("llamada de más")
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

const entrypoint = (rules: unknown[]) => ({
  body: { success: true, result: { id: "rs-1", phase: "http_request_firewall_custom", rules } },
})
const ok = { body: { success: true, result: { id: "rs-1" } } }

describe("cloudflareHostsFirewall", () => {
  it("sin la regla, la agrega al final con Block y encendida, sin tocar la del robot", async () => {
    const { impl, calls } = fakeFetch([entrypoint([ROBOT]), ok])
    expect(await cloudflareHostsFirewall("secreto", impl).putRule(ZONE, RULE)).toBe("creada")
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${ENTRY}`,
      `POST ${RULES}`,
    ])
    expect(calls[1]?.body).toEqual({ action: "block", ...RULE, enabled: true })
    expect(calls.some((call) => call.url.includes(ROBOT.id) || call.method === "PUT")).toBe(false)
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer secreto")
  })

  it("con la misma lista, no escribe nada", async () => {
    const { impl, calls } = fakeFetch([
      entrypoint([ROBOT, { id: "mia", action: "block", enabled: true, ...RULE }]),
    ])
    expect(await cloudflareHostsFirewall("secreto", impl).putRule(ZONE, RULE)).toBe("igual")
    expect(calls).toHaveLength(1)
  })

  it("con otra lista, cambia solo su expresión: si el dueño la apagó, sigue apagada", async () => {
    const mine = {
      id: "mia",
      description: RULE.description,
      expression: "vieja",
      action: "block",
      enabled: false,
    }
    const { impl, calls } = fakeFetch([entrypoint([ROBOT, mine]), ok])
    expect(await cloudflareHostsFirewall("secreto", impl).putRule(ZONE, RULE)).toBe("cambiada")
    expect(calls[1]?.method).toBe("PATCH")
    expect(calls[1]?.url).toBe(`${RULES}/mia`)
    expect(calls[1]?.body).toEqual({ action: "block", ...RULE, enabled: false })
  })

  it("una zona sin reglas personalizadas nace con la entrada de la fase y esta regla", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 404,
        body: {
          success: false,
          errors: [{ code: 10003, message: "could not find entrypoint ruleset" }],
        },
      },
      ok,
    ])
    expect(await cloudflareHostsFirewall("secreto", impl).putRule(ZONE, RULE)).toBe("creada")
    expect(calls[1]?.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE}/rulesets`)
    expect(calls[1]?.body).toEqual({
      name: "default",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [{ action: "block", ...RULE, enabled: true }],
    })
  })

  it("lo que Cloudflare rechaza sube con su código y sin el token", async () => {
    const { impl } = fakeFetch([
      {
        status: 403,
        body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
      },
    ])
    const failure = await cloudflareHostsFirewall("secreto", impl)
      .putRule(ZONE, RULE)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CloudflareApiError)
    expect(String(failure)).toContain("403: Authentication error (10000)")
    expect(String(failure)).not.toContain("secreto")
  })

  it("una escritura rechazada también sube: la regla queda como estaba", async () => {
    const { impl } = fakeFetch([
      entrypoint([ROBOT]),
      {
        status: 400,
        body: {
          success: false,
          errors: [{ code: 20021, message: "exceeded maximum number of rules" }],
        },
      },
    ])
    await expect(cloudflareHostsFirewall("secreto", impl).putRule(ZONE, RULE)).rejects.toThrow(
      "exceeded maximum number of rules (20021)",
    )
  })
})
