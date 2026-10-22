import type { Db } from "@odentia/db"
import { describe, expect, it, vi } from "vitest"

// Solo la ruta: el servicio del calendario se sustituye para ver qué token le llega.
const seen: string[] = []
vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  getBookingLinkCalendar: async (_tx: Db, _orgId: string, token: string) => {
    seen.push(token)
    return "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
  },
}))

const { createPublicBookingRoute } = await import("./public-booking.js")

/** Una base de mentira: encuentra la clínica por su dirección y abre la transacción. */
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "org_calendario" }] }) }) }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [] }),
} as unknown as Db

const TOKEN = "b".repeat(64)

describe("«Añadir al calendario» de «Su enlace» (issue 46)", () => {
  it("baja el .ics con el token en el cuerpo, sin caché ni Referer", async () => {
    const app = createPublicBookingRoute({ db, secretsKey: Buffer.alloc(32), remoteAddress: () => "203.0.113.10" })
    // Con el token en la dirección no sirve.
    expect((await app.request(`/clinica/calendar?token=${TOKEN}`)).status).toBe(404)
    expect(seen).toEqual([])

    const response = await app.request("/clinica/calendar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8")
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="cita.ics"')
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await response.text()).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
    expect(seen).toEqual([TOKEN])
  })
})
