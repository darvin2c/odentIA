import { describe, expect, it } from "vitest"
import { buildPagesLoginUrl, exchangePagesCode, listSharedPages, subscribeAppToPage, unsubscribeAppFromPage } from "./meta-pages-login.js"

const APP = { appId: "APP1", appSecret: "secreto", graphVersion: "v25.0" }

function fakeFetch(answer: (url: URL, init?: RequestInit) => { status?: number; json: unknown }) {
  const calls: Array<{ url: URL; method: string; auth: string | null }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, method: init?.method ?? "GET", auth: headers["Authorization"] ?? null })
    const { status = 200, json } = answer(url, init)
    return new Response(JSON.stringify(json), { status })
  }) as typeof fetch
  return { calls, fetch: impl }
}

describe("Conectar con Facebook: páginas e Instagram", () => {
  it("la ventana lleva la app, la configuración de páginas, la vuelta fija y el state", () => {
    const url = new URL(buildPagesLoginUrl(APP, { configId: "CFG-PAG", redirectUri: "https://api.example.com/api/oauth/meta-pages/callback", state: "abc.def" }))
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "APP1",
      config_id: "CFG-PAG",
      redirect_uri: "https://api.example.com/api/oauth/meta-pages/callback",
      state: "abc.def",
      response_type: "code",
    })
  })

  it("el código se cambia por la clave corta y esa por la de larga duración", async () => {
    const meta = fakeFetch((url) =>
      url.searchParams.get("grant_type") === "fb_exchange_token"
        ? { json: { access_token: "LARGA", token_type: "bearer" } }
        : { json: { access_token: "CORTA", token_type: "bearer", expires_in: 3600 } },
    )
    const token = await exchangePagesCode(APP, { code: "COD", redirectUri: "https://api.example.com/cb" }, { fetch: meta.fetch })
    expect(token).toBe("LARGA")
    expect(meta.calls[0]!.url.searchParams.get("code")).toBe("COD")
    expect(meta.calls[0]!.url.searchParams.get("redirect_uri")).toBe("https://api.example.com/cb")
    expect(meta.calls[1]!.url.searchParams.get("fb_exchange_token")).toBe("CORTA")
    // Un código vencido o ajeno: lo dice Meta y no se sigue.
    const refused = fakeFetch(() => ({ status: 400, json: { error: { message: "This authorization code has expired.", code: 100 } } }))
    await expect(exchangePagesCode(APP, { code: "X", redirectUri: "r" }, { fetch: refused.fetch })).rejects.toThrow("expired")
  })

  it("lee las páginas marcadas con su clave y el Instagram unido, si tiene", async () => {
    const meta = fakeFetch(() => ({
      json: {
        data: [
          { id: "P1", name: "Clínica Sonrisa", access_token: "TP1", instagram_business_account: { id: "IG1", username: "sonrisadental" } },
          { id: "P2", name: "Dr. Pérez", access_token: "TP2" },
          { id: "P3", name: "Sin clave" },
        ],
      },
    }))
    const pages = await listSharedPages(APP, "LARGA", { fetch: meta.fetch })
    expect(pages).toEqual([
      { id: "P1", name: "Clínica Sonrisa", accessToken: "TP1", instagram: { id: "IG1", username: "sonrisadental" } },
      { id: "P2", name: "Dr. Pérez", accessToken: "TP2", instagram: null },
    ])
    expect(meta.calls[0]!.auth).toBe("Bearer LARGA")
  })

  it("suscribe y quita la app de la página con su clave", async () => {
    const meta = fakeFetch(() => ({ json: { success: true } }))
    await subscribeAppToPage(APP, "P1", "TP1", { fetch: meta.fetch })
    await unsubscribeAppFromPage(APP, "P1", "TP1", { fetch: meta.fetch })
    expect(meta.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["POST /v25.0/P1/subscribed_apps", "DELETE /v25.0/P1/subscribed_apps"])
    expect(meta.calls[0]!.url.searchParams.get("subscribed_fields")).toContain("message_echoes")
    expect(meta.calls[0]!.auth).toBe("Bearer TP1")
  })
})
