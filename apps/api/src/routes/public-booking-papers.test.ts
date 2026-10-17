import type { Db } from "@odentia/db"
import { describe, expect, it, vi } from "vitest"

// Solo la ruta: el servicio del papel se sustituye para ver qué token le llega.
const seen: Array<{ token: string; kind: string; id: string }> = []
vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  getPersonalLinkPaper: async (_tx: Db, _orgId: string, token: string, paper: { kind: string; id: string }) => {
    seen.push({ token, ...paper })
    return { bytes: new Uint8Array([37, 80, 68, 70]), filename: "Receta 1.pdf" }
  },
}))

const { createPublicBookingRoute } = await import("./public-booking.js")

/** Una base de mentira: encuentra la clínica por su dirección y abre la transacción. */
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "org_papeles" }] }) }) }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [] }),
} as unknown as Db

const TOKEN = "a".repeat(64)
const PAPER = "6f1c2f0e-8a4b-4c2d-9e1f-0a1b2c3d4e5f"

describe("«Tus papeles»", () => {
  it("se descargan con el token en el cuerpo, nunca en la dirección, y sin Referer", async () => {
    const app = createPublicBookingRoute({ db, secretsKey: Buffer.alloc(32), remoteAddress: () => "203.0.113.9" })
    // Con el token en la dirección ya no sirve.
    const byQuery = await app.request(`/clinica/papers/${PAPER}?token=${TOKEN}&kind=receta`)
    expect(byQuery.status).toBe(404)
    expect(seen).toEqual([])

    const response = await app.request(`/clinica/papers/${PAPER}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, kind: "receta" }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(seen).toEqual([{ token: TOKEN, kind: "receta", id: PAPER }])

    // Sin token en el cuerpo no se busca nada.
    const missing = await app.request(`/clinica/papers/${PAPER}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "receta" }),
    })
    expect(missing.status).toBe(404)
    expect(missing.headers.get("referrer-policy")).toBe("no-referrer")
    expect(seen).toHaveLength(1)
  })
})
