import type { Db } from "@odentia/db"
import { describe, expect, it, vi } from "vitest"

// Solo la ruta: los servicios se sustituyen para ver qué les llega.
const served: Array<{ orgId: string; token: string; userAgent: string | undefined }> = []
vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  findCalendarFeedOrg: async (_db: Db, token: string) => (token.startsWith("a") ? "org_calendario" : null),
  serveCalendarFeed: async (_tx: Db, orgId: string, token: string, userAgent: string | undefined) => {
    served.push({ orgId, token, userAgent })
    return "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
  },
}))

const { createPublicCalendarRoute } = await import("./calendar-feeds.js")

/** Una base de mentira: abre la transacción con el contexto de la clínica. */
const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [] }) } as unknown as Db

describe("La dirección del calendario (issue 46)", () => {
  it("entrega el .ics del enlace activo, sin caché ni Referer, y lo demás no existe", async () => {
    const app = createPublicCalendarRoute({ db, ownerDb: db })
    const token = "a".repeat(64)
    const response = await app.request(`/${token}.ics`, { headers: { "user-agent": "Google-Calendar-Importer" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await response.text()).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
    expect(served).toEqual([{ orgId: "org_calendario", token, userAgent: "Google-Calendar-Importer" }])

    // Un enlace apagado o que no existe responde igual, sin decir de qué clínica era.
    expect((await app.request(`/${"b".repeat(64)}.ics`)).status).toBe(404)
    expect((await app.request("/no-es-un-token.ics")).status).toBe(404)
    expect(served).toHaveLength(1)
  })

  it("quien prueba tokens al azar no deja sin calendario a los enlaces de verdad", async () => {
    let from = "198.51.100.7"
    const app = createPublicCalendarRoute({ db, ownerDb: db, remoteAddress: () => from })
    const statuses: number[] = []
    for (let i = 0; i < 121; i++) statuses.push((await app.request(`/${i.toString(16).padStart(64, "b")}.ics`)).status)
    expect(statuses.slice(0, 120).every((status) => status === 404)).toBe(true)
    expect(statuses[120]).toBe(429)
    // Google pide desde otra dirección: su enlace sigue sirviendo.
    from = "203.0.113.20"
    expect((await app.request(`/${"a".repeat(63)}d.ics`)).status).toBe(200)
  })

  it("limita las peticiones por enlace", async () => {
    const app = createPublicCalendarRoute({ db, ownerDb: db })
    const token = `a${"c".repeat(63)}`
    const statuses: number[] = []
    for (let i = 0; i < 61; i++) statuses.push((await app.request(`/${token}.ics`)).status)
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
  })
})
