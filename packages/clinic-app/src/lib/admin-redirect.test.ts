import { afterEach, describe, expect, it, vi } from "vitest"

/** La administración es una sola, en el dominio de odentIA (ADR 0091). */
describe("admin. en el dominio de otro producto", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("en latidIA lleva a la administración de odentIA; una clínica o el panel no se tocan", async () => {
    vi.stubEnv("VITE_BASE_DOMAIN", "latidia72.com")
    vi.stubEnv("VITE_DENTAL_DOMAIN", "odentia32.com")
    vi.stubEnv("VITE_BASE_PORT", "")
    const { adminRedirectFor } = await import("./host")
    expect(adminRedirectFor("admin.latidia72.com")).toBe("https://admin.odentia32.com/")
    expect(adminRedirectFor("sanmartin.latidia72.com")).toBeNull()
    expect(adminRedirectFor("app.latidia72.com")).toBeNull()
  })

  it("con un solo dominio (en local) no redirige a sí misma", async () => {
    vi.stubEnv("VITE_BASE_DOMAIN", "latidia.localhost")
    vi.stubEnv("VITE_DENTAL_DOMAIN", "")
    const { adminRedirectFor } = await import("./host")
    expect(adminRedirectFor("admin.latidia.localhost")).toBeNull()
  })
})
