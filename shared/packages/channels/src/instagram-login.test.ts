import { describe, expect, it, vi } from "vitest"
import { buildInstagramLoginUrl, completeInstagramLoginCode, subscribeAppToInstagram } from "./instagram-login.js"

const APP = { appId: "IGAPP", appSecret: "secreto-ig", graphVersion: "v25.0" }

function fake(answer: (url: URL, init?: RequestInit) => { status?: number; json: unknown }) {
  const calls: Array<{ url: URL; method: string; body: string | null; auth: string | null }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      auth: ((init?.headers ?? {}) as Record<string, string>)["Authorization"] ?? null,
    })
    const { status = 200, json } = answer(url, init)
    return new Response(JSON.stringify(json), { status })
  }) as typeof fetch
  return { calls, fetch: impl }
}

describe("Conectar con Instagram", () => {
  it("la ventana es la de Instagram, con la app de Instagram, sus permisos y la vuelta fija", () => {
    const url = new URL(buildInstagramLoginUrl(APP, { redirectUri: "https://api.example.com/api/meta-pages/instagram/callback", state: "s.f" }))
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "IGAPP",
      redirect_uri: "https://api.example.com/api/meta-pages/instagram/callback",
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_manage_messages",
      state: "s.f",
    })
  })

  it("canjea el código (sin el «#_»), pide la clave larga y lee la cuenta", async () => {
    const meta = fake((url) => {
      if (url.hostname === "api.instagram.com") return { json: { data: [{ access_token: "CORTA", user_id: "17841", permissions: "instagram_business_basic" }] } }
      if (url.pathname === "/access_token") return { json: { access_token: "LARGA", token_type: "bearer", expires_in: 5183944 } }
      return { json: { user_id: "17841400000", username: "sonrisadental", id: "otro" } }
    })
    const account = await completeInstagramLoginCode(APP, { code: "COD#_", redirectUri: "https://r" }, { fetch: meta.fetch })
    expect(account).toEqual({ userId: "17841400000", username: "sonrisadental", accessToken: "LARGA", expiresInSeconds: 5183944 })
    expect(new URLSearchParams(meta.calls[0]!.body ?? "").get("code")).toBe("COD")
    expect(new URLSearchParams(meta.calls[0]!.body ?? "").get("grant_type")).toBe("authorization_code")
    expect(meta.calls[1]!.url.searchParams.get("access_token")).toBe("CORTA")
    expect(meta.calls[2]!.auth).toBe("Bearer LARGA")
    const refused = fake(() => ({ status: 400, json: { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" } }))
    await expect(completeInstagramLoginCode(APP, { code: "X", redirectUri: "r" }, { fetch: refused.fetch })).rejects.toThrow()
  })

  it("suscribe la app a los avisos de la cuenta", async () => {
    const meta = fake(() => ({ json: { success: true } }))
    await subscribeAppToInstagram(APP, "LARGA", { fetch: meta.fetch })
    expect(`${meta.calls[0]!.method} ${meta.calls[0]!.url.pathname}`).toBe("POST /v25.0/me/subscribed_apps")
    expect(meta.calls[0]!.url.searchParams.get("subscribed_fields")).toBe("messages,messaging_postbacks,messaging_seen")
  })
})

it("si Instagram no acepta la clave larga sin versión, la pide con la versión del Graph", async () => {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    if (url.hostname === "api.instagram.com") return new Response(JSON.stringify({ access_token: "IGAA-CORTA", user_id: "1" }))
    if (url.pathname === "/access_token") return new Response(JSON.stringify({ error: { message: "Unsupported request - method type: get", code: 100 } }), { status: 400 })
    if (url.pathname === "/v25.0/access_token") return new Response(JSON.stringify({ access_token: "LARGA", expires_in: 5184000 }))
    return new Response(JSON.stringify({ user_id: "1", username: "u" }))
  }) as unknown as typeof fetch
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const account = await completeInstagramLoginCode({ appId: "A", appSecret: "S", graphVersion: "v25.0" }, { code: "C", redirectUri: "r" }, { fetch: impl })
  expect(account.accessToken).toBe("LARGA")
  expect(calls).toEqual(["/oauth/access_token", "/access_token", "/v25.0/access_token", "/v25.0/me"])
  // El registro dice el tipo de clave, nunca la clave.
  expect(String(warn.mock.calls[0]?.[0])).toContain("IGAA…")
  expect(String(warn.mock.calls[0]?.[0])).not.toContain("IGAA-CORTA")
  warn.mockRestore()
})
