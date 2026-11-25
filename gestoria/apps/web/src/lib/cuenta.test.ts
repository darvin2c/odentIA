import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

// Las direcciones se leen al cargar los módulos: se ponen antes de importarlos.
vi.stubEnv("VITE_ACCOUNT_URL", "https://cuenta.example.com/api/auth")
vi.stubEnv("VITE_API_URL", "https://servidor.example.com")
// El cliente de la cuenta guarda `fetch` al cargar: se pone uno que responde lo que diga cada prueba.
let reply: () => Promise<Response> = async () => new Response("null", { status: 200 })
vi.stubGlobal(
  "fetch",
  vi.fn(() => reply()),
)
let mod: typeof import("./api") & typeof import("./cuenta")
beforeAll(async () => {
  mod = { ...(await import("./api")), ...(await import("./cuenta")) }
})

/** Un token con su vencimiento (solo se lee `exp`; la firma la comprueba el servidor). */
function token(expiresInSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds }))
  return `x.${payload.replace(/=+$/, "")}.y`
}

/** La cuenta responde con este estado y cuerpo a todo, o no responde (sin red). */
function account(status: number | "sin-red", body: unknown = null) {
  reply = async () => {
    if (status === "sin-red") throw new TypeError("Failed to fetch")
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }
}

afterEach(() => {
  mod.forgetToken()
})

describe("la cuenta caída no es «sin sesión»", () => {
  it("un 502 al pedir el token avisa que la cuenta no responde, no que no hay sesión", async () => {
    account(502, { message: "Bad Gateway" })
    await expect(mod.accountToken()).rejects.toBeInstanceOf(mod.AccountUnavailable)
  })

  it("sin red tampoco manda a entrar", async () => {
    account("sin-red")
    await expect(mod.accountToken()).rejects.toBeInstanceOf(mod.AccountUnavailable)
  })

  it("un 401 sí es «sin sesión»", async () => {
    account(401, { message: "Unauthorized" })
    await expect(mod.accountToken()).resolves.toBeNull()
  })

  it("quien ya entró sigue con su token mientras no venza", async () => {
    const vigente = token(10 * 60)
    account(200, { token: vigente })
    await expect(mod.accountToken()).resolves.toBe(vigente)
    account(502, { message: "Bad Gateway" })
    await expect(mod.accountToken(true)).resolves.toBe(vigente)
  })

  it("con el token vencido y la cuenta caída, avisa que no responde", async () => {
    account(200, { token: token(-5) })
    await mod.accountToken()
    account(502, { message: "Bad Gateway" })
    await expect(mod.accountToken(true)).rejects.toBeInstanceOf(mod.AccountUnavailable)
  })

  it("el servidor de gestorIA recibe un error que se reintenta, no un «entra otra vez»", async () => {
    account(503, { message: "Service Unavailable" })
    const error = await mod.api("/api/yo").catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(mod.SignedOut)
    expect(error).toBeInstanceOf(mod.ApiError)
    expect((error as InstanceType<typeof mod.ApiError>).code).toBe("ACCOUNT_UNAVAILABLE")
  })

  it("al abrir una página, la sesión caída no se confunde con no haber entrado", async () => {
    account("sin-red")
    await expect(mod.hasSession()).rejects.toBeInstanceOf(mod.AccountUnavailable)
    account(502, { message: "Bad Gateway" })
    await expect(mod.hasSession()).rejects.toBeInstanceOf(mod.AccountUnavailable)
    account(200, null)
    await expect(mod.hasSession()).resolves.toBe(false)
  })
})
