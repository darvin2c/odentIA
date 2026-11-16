import type { Db } from "@odentia/db"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  allowedHosts,
  type ClinicHosts,
  clinicHostsFromEnv,
  type HostsFirewall,
  hostsRuleExpression,
  planHostsRule,
  RULE_EXPRESSION_LIMIT,
  RULE_EXPRESSION_WARNING,
  SYSTEM_SUBDOMAINS,
  syncClinicHosts,
  zoneSlugs,
} from "./clinic-hosts.js"

/** Solo los subdominios de clínicas reales llegan a las pantallas (ADR 0193): la lista y su regla. */

const ODENTIA_ZONE = "0123456789abcdef0123456789abcdef"
const LATIDIA_ZONE = "fedcba9876543210fedcba9876543210"
const links = {
  webURL: "https://app.odentia32.com",
  cookieDomain: "odentia32.com",
  productDomains: { medical: "latidia72.com", optical: undefined },
}

afterEach(() => vi.restoreAllMocks())

describe("la lista de hosts permitidos", () => {
  it("lleva los hosts del sistema y uno por clínica, sin repetir y en orden", () => {
    expect(allowedHosts("odentia32.com", ["sonrisa", "dental-smile", "sonrisa"])).toEqual([
      "admin.odentia32.com",
      "api.odentia32.com",
      "app.odentia32.com",
      "dental-smile.odentia32.com",
      "media.odentia32.com",
      "sonrisa.odentia32.com",
      "www.odentia32.com",
    ])
  })

  it("deja fuera lo que no es un subdominio, sin que entre a la expresión", () => {
    const hosts = allowedHosts("odentia32.com", [
      'x" or true or "',
      "con espacio",
      "-guion",
      "Mayus",
    ])
    expect(
      hosts.filter((host) => !SYSTEM_SUBDOMAINS.some((label) => host === `${label}.odentia32.com`)),
    ).toEqual(["mayus.odentia32.com"])
  })

  it("la expresión bloquea todo subdominio que no está, y no toca el dominio mismo", () => {
    expect(
      hostsRuleExpression("odentia32.com", ["app.odentia32.com", "sonrisa.odentia32.com"]),
    ).toBe(
      'ends_with(http.host, ".odentia32.com") and not http.host in {"app.odentia32.com" "sonrisa.odentia32.com"}',
    )
  })

  it("nunca se publica sin clínicas: solo los del sistema bloquearía a todas", () => {
    expect(planHostsRule("odentia32.com", [])).toEqual({ ok: false, reason: "sin-clinicas" })
    expect(planHostsRule("odentia32.com", ["www", "app", "no es slug"])).toMatchObject({
      ok: false,
      reason: "sin-clinicas",
    })
  })

  it("con clínicas, la publica y cuenta cuántas lleva", () => {
    const plan = planHostsRule("odentia32.com", ["sonrisa", "sonrie"])
    expect(plan).toMatchObject({ ok: true, clinics: 2 })
    if (plan.ok) expect(plan.expression).toContain('"sonrie.odentia32.com" "sonrisa.odentia32.com"')
  })

  it("pasada del tope de 4000 caracteres no se publica ni se recorta", () => {
    const many = Array.from(
      { length: 200 },
      (_, index) => `clinica-${String(index).padStart(3, "0")}`,
    )
    const tooLong = planHostsRule("odentia32.com", many)
    expect(tooLong).toMatchObject({ ok: false, reason: "muy-larga" })
    if (!tooLong.ok && tooLong.reason === "muy-larga")
      expect(tooLong.length).toBeGreaterThan(RULE_EXPRESSION_LIMIT)

    // Cerca del tope se publica entera (y el registro avisa).
    const near = planHostsRule("odentia32.com", many.slice(0, 120))
    expect(near).toMatchObject({ ok: true, clinics: 120 })
    if (near.ok) {
      expect(near.expression.length).toBeGreaterThanOrEqual(RULE_EXPRESSION_WARNING)
      expect(near.expression.length).toBeLessThanOrEqual(RULE_EXPRESSION_LIMIT)
    }
  })

  it("cada dominio lleva sus clínicas, y la que aún no dice su producto va en todos", () => {
    const domains = { dental: "odentia32.com", medical: "latidia72.com", optical: "odentia32.com" }
    const clinics = [
      { slug: "sonrisa", product: "dental" as const },
      { slug: "sanmartin", product: "medical" as const },
      { slug: "claridad", product: "optical" as const },
      { slug: "recien-abierta", product: null },
    ]
    expect(zoneSlugs(domains, "odentia32.com", clinics)).toEqual([
      "sonrisa",
      "claridad",
      "recien-abierta",
    ])
    expect(zoneSlugs(domains, "latidia72.com", clinics)).toEqual(["sanmartin", "recien-abierta"])
  })
})

describe("la sincronización", () => {
  it("si la consulta de las clínicas falla, no publica nada", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const putRule = vi.fn<HostsFirewall["putRule"]>()
    const config: ClinicHosts = {
      firewall: { putRule },
      domains: { dental: "odentia32.com", medical: "latidia72.com", optical: "odentia32.com" },
      zones: [{ zoneId: ODENTIA_ZONE, domain: "odentia32.com" }],
    }
    const brokenDb = {
      transaction: async () => Promise.reject(new Error("la base no responde")),
    } as unknown as Db
    expect(await syncClinicHosts(brokenDb, config)).toBeNull()
    expect(putRule).not.toHaveBeenCalled()
    expect(error.mock.calls.join(" ")).toContain("quedan como estaban")
  })

  it("sin configuración no hace nada", async () => {
    const brokenDb = { transaction: vi.fn() } as unknown as Db
    expect(await syncClinicHosts(brokenDb, null)).toBeNull()
    expect(brokenDb.transaction).not.toHaveBeenCalled()
  })
})

describe("la configuración del entorno", () => {
  it("sin token o sin zonas no hace nada y lo registra", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    expect(clinicHostsFromEnv({ CLOUDFLARE_ZONE_ID: ODENTIA_ZONE }, links)).toBeNull()
    expect(clinicHostsFromEnv({ CLOUDFLARE_WAF_TOKEN: "token" }, links)).toBeNull()
    expect(log.mock.calls.join(" ")).toContain("sin CLOUDFLARE_WAF_TOKEN")
    expect(log.mock.calls.join(" ")).toContain("el id de ninguna zona")
  })

  it("cada zona con el dominio de su producto; vistIA sin dominio propio no tiene zona aparte", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const config = clinicHostsFromEnv(
      {
        CLOUDFLARE_WAF_TOKEN: "token",
        CLOUDFLARE_ZONE_ID: ODENTIA_ZONE,
        MEDICAL_CLOUDFLARE_ZONE_ID: LATIDIA_ZONE.toUpperCase(),
        OPTICAL_CLOUDFLARE_ZONE_ID: "abababababababababababababababab",
      },
      links,
    )
    expect(config?.zones).toEqual([
      { zoneId: ODENTIA_ZONE, domain: "odentia32.com" },
      { zoneId: LATIDIA_ZONE, domain: "latidia72.com" },
    ])
    expect(config?.domains).toEqual({
      dental: "odentia32.com",
      medical: "latidia72.com",
      optical: "odentia32.com",
    })
    expect(error.mock.calls.join(" ")).toContain("OPTICAL_CLOUDFLARE_ZONE_ID es de odentia32.com")
  })

  it("un id de zona que no es de Cloudflare no se usa", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(
      clinicHostsFromEnv(
        { CLOUDFLARE_WAF_TOKEN: "token", CLOUDFLARE_ZONE_ID: "../../accounts" },
        links,
      ),
    ).toBeNull()
  })
})
