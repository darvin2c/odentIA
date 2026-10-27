import { describe, expect, it } from "vitest"
import { MetaSignupError } from "./whatsapp-embedded-signup.js"
import { inspectOwnAppToken, OwnAppTokenError, readOwnAppNumber } from "./whatsapp-own-app.js"

/** Meta de prueba: responde por ruta con la forma que publica Meta. NO acredita que Meta responda así. */
function fakeMeta(routes: Record<string, { status?: number; json: unknown } | "red">) {
  const urls: string[] = []
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url))
    const path = new URL(String(url)).pathname.replace(/^\/v\d+\.\d+/, "")
    const answer = routes[path]
    if (answer === "red") throw new Error("sin red")
    if (!answer) return new Response(JSON.stringify({ error: { message: "no prevista", code: 100 } }), { status: 404 })
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 })
  }) as typeof globalThis.fetch
  return { fetch, urls }
}

const APP = { graphVersion: "v25.0" }
const debug = (data: Record<string, unknown>) => ({ json: { data: { is_valid: true, app_id: "APP9", ...data } } })

describe("inspectOwnAppToken", () => {
  it("dice de qué app es, su tipo, cuándo vence y sus permisos, preguntando con la clave de esa app", async () => {
    const meta = fakeMeta({
      "/app": { json: { id: "APP9" } },
      "/debug_token": debug({ type: "SYSTEM_USER", expires_at: 0, scopes: ["whatsapp_business_messaging", "whatsapp_business_management"] }),
    })
    const token = await inspectOwnAppToken(APP, "clave", "secreta", meta)
    expect(token).toEqual({
      appId: "APP9",
      type: "SYSTEM_USER",
      expiresAt: null,
      scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
    })
    const asked = new URL(meta.urls[1]!)
    expect(asked.searchParams.get("input_token")).toBe("clave")
    expect(asked.searchParams.get("access_token")).toBe("APP9|secreta")
  })

  it("una clave que vence trae su fecha", async () => {
    const meta = fakeMeta({ "/app": { json: { id: "APP9" } }, "/debug_token": debug({ type: "SYSTEM_USER", expires_at: 1_800_000_000 }) })
    expect((await inspectOwnAppToken(APP, "clave", "secreta", meta)).expiresAt?.toISOString()).toBe(new Date(1_800_000_000_000).toISOString())
  })

  it("si Meta no acepta la clave de la app, la clave secreta no es de esa app", async () => {
    const meta = fakeMeta({
      "/app": { json: { id: "APP9" } },
      "/debug_token": { status: 400, json: { error: { message: "Invalid OAuth access token signature.", code: 190 } } },
    })
    const error = await inspectOwnAppToken(APP, "clave", "otra", meta).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OwnAppTokenError)
    expect((error as OwnAppTokenError).problem).toBe("clave-secreta")
  })

  it("si no dice de qué app es la clave, o la clave no vale, el problema es la clave", async () => {
    const unknownApp = await inspectOwnAppToken(APP, "clave", "s", fakeMeta({ "/app": { status: 400, json: { error: { message: "no", code: 100 } } } })).catch(
      (e: unknown) => e,
    )
    expect((unknownApp as OwnAppTokenError).problem).toBe("clave")
    const invalid = await inspectOwnAppToken(
      APP,
      "clave",
      "s",
      fakeMeta({ "/app": { json: { id: "APP9" } }, "/debug_token": { json: { data: { is_valid: false } } } }),
    ).catch((e: unknown) => e)
    expect((invalid as OwnAppTokenError).problem).toBe("clave")
  })

  it("si Meta no responde, es pasajero: no se culpa a ninguna clave", async () => {
    const error = await inspectOwnAppToken(APP, "clave", "s", fakeMeta({ "/app": "red" })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MetaSignupError)
    expect((error as MetaSignupError).transient).toBe(true)
  })
})

describe("readOwnAppNumber", () => {
  it("lee si el número ya está registrado para la API de la nube", async () => {
    const meta = fakeMeta({ "/9001": { json: { id: "9001", platform_type: "CLOUD_API" } } })
    expect(await readOwnAppNumber(APP, "9001", "clave", meta)).toEqual({ platformType: "CLOUD_API" })
    expect(meta.urls[0]).toContain("fields=platform_type")
    expect(await readOwnAppNumber(APP, "9001", "clave", fakeMeta({ "/9001": { json: { id: "9001" } } }))).toEqual({ platformType: null })
  })
})
