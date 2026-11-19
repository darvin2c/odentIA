/**
 * Un corte de la API no es «sin sesión» (QA del 18 nov, novato 5): con la API reiniciándose, la
 * app mandaba al login a mitad de la atención, porque `requireSession` trataba el error de red
 * igual que no tener sesión.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const getSession = vi.fn()
vi.mock("./auth-client", () => ({ authClient: { getSession } }))
vi.mock("@tanstack/react-start", () => ({
  createIsomorphicFn: () => ({ server: () => ({ client: (fn: () => unknown) => fn }) }),
}))
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }))
vi.mock("./host", () => ({
  orgSlugFromHostname: () => "dental-smile",
  panelUrl: (path: string) => `https://app.example.test${path}`,
  requestHostname: () => "dental-smile.example.test",
  tenantUrl: () => "https://dental-smile.example.test/",
}))

const { ApiUnavailableError, apiUnavailable, requireSession, sessionAnswer } = await import("./guards")

const USER = { id: "u1", email: "luis@example.test", name: "Luis", image: null, emailVerified: true }

describe("requireSession", () => {
  beforeEach(() => getSession.mockReset())

  it("sin sesión, al login", async () => {
    getSession.mockResolvedValue({ data: null, error: null })
    await expect(requireSession({ href: "/patients" })).rejects.toMatchObject({
      options: { href: expect.stringContaining("/login?next=") },
    })
  })

  it("si la API no responde, no manda al login: dice que no se pudo comprobar", async () => {
    getSession.mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(requireSession({ href: "/patients" })).rejects.toBeInstanceOf(ApiUnavailableError)
    getSession.mockResolvedValue({ data: null, error: { status: 502, statusText: "Bad Gateway" } })
    await expect(requireSession({ href: "/patients" })).rejects.toBeInstanceOf(ApiUnavailableError)
  })

  it("con sesión, la devuelve", async () => {
    getSession.mockResolvedValue({ data: { user: USER }, error: null })
    await expect(requireSession({ href: "/patients" })).resolves.toMatchObject({ userId: "u1", name: "Luis" })
  })
})

describe("lo que dice la API", () => {
  it("solo «no hay sesión» cuando lo responde", () => {
    expect(sessionAnswer({ data: null, error: null })).toBe("none")
    expect(sessionAnswer({ data: null, error: { status: 401 } })).toBe("none")
    expect(sessionAnswer({ data: null, error: { status: 500 } })).toBe("unavailable")
    expect(sessionAnswer({ data: null, error: { status: 404 } })).toBe("unavailable")
  })

  it("la clínica: un 403 es que no es de ella; un 5xx o sin respuesta, que no respondió", () => {
    expect(apiUnavailable(null)).toBe(false)
    expect(apiUnavailable({ status: 403 })).toBe(false)
    expect(apiUnavailable({ status: 503 })).toBe(true)
    expect(apiUnavailable({})).toBe(true)
  })
})
