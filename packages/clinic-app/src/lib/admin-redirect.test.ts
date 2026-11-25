import { afterEach, describe, expect, it, vi } from "vitest"

/** La administración es una sola, en el dominio de odentIA (ADR 0091). */
describe("admin. en el dominio de otro producto", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("en latidIA lleva a la administración de odentIA con el pase; una clínica o el panel no se tocan", async () => {
    vi.stubEnv("VITE_BASE_DOMAIN", "latidia72.com")
    vi.stubEnv("VITE_DENTAL_DOMAIN", "odentia32.com")
    vi.stubEnv("VITE_BASE_PORT", "")
    const { adminRedirectFor } = await import("./host")
    // Otro dominio: pasa por el pase de la API de odentIA, que trae la sesión de latidIA (ADR 0215).
    const target = new URL(adminRedirectFor("admin.latidia72.com") ?? "")
    expect(`${target.origin}${target.pathname}`).toBe("https://api.odentia32.com/api/auth/pase/ir")
    expect(target.searchParams.get("desde")).toBe("latidia72.com")
    expect(target.searchParams.get("next")).toBe("https://admin.odentia32.com/")
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

/** Una clínica de otro producto se abre con el pase; la del mismo dominio, con su enlace de siempre. */
describe("la dirección de una clínica", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("solo pasa por el pase hacia otro dominio del grupo", async () => {
    vi.stubEnv("VITE_BASE_DOMAIN", "odentia32.com")
    vi.stubEnv("VITE_DENTAL_DOMAIN", "odentia32.com")
    vi.stubEnv("VITE_MEDICAL_DOMAIN", "latidia72.com")
    vi.stubEnv("VITE_BASE_PORT", "")
    const { tenantUrl, crossDomainHref } = await import("./host")
    expect(tenantUrl("dental-smile", "/home", "dental")).toBe("https://dental-smile.odentia32.com/home")
    const pase = new URL(tenantUrl("pediatria", "/home", "medical"))
    expect(pase.hostname).toBe("api.latidia72.com")
    expect(pase.searchParams.get("next")).toBe("https://pediatria.latidia72.com/home")
    expect(crossDomainHref("https://malo.example/x")).toBe("https://malo.example/x")
  })
})
