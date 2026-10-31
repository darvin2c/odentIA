import type { Db } from "@odentia/db"
import { describe, expect, it, vi } from "vitest"

// Solo la ruta: el servicio se sustituye para ver qué le llega y qué entrega.
const seen: Array<{ token: string; branchId: string }> = []
vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  listBookingLinkProfessionals: async (_tx: Db, _orgId: string, token: string, input: { branchId: string }) => {
    seen.push({ token, branchId: input.branchId })
    return {
      professionals: [{ id: "u-ana", name: "Dra. Ana Torres", next: { startsAt: "2026-11-03T14:00:00.000Z", endsAt: "2026-11-03T14:30:00.000Z" }, current: false }],
      first: { startsAt: "2026-11-03T14:00:00.000Z", professionalUserId: "u-ana" },
      until: "2026-12-24T00:00:00.000Z",
      timeZone: "America/Lima",
    }
  },
}))

const { createPublicBookingRoute } = await import("./public-booking.js")

/** Una base de mentira: encuentra la clínica por su dirección y abre la transacción. */
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "org_profesionales" }] }) }) }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [] }),
} as unknown as Db

const TOKEN = "c".repeat(64)
const BRANCH = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"

describe("«Su enlace»: con quién y su próximo horario", () => {
  it("entrega lo del servidor para la sede pedida, sin caché", async () => {
    const app = createPublicBookingRoute({ db, secretsKey: Buffer.alloc(32), remoteAddress: () => "203.0.113.20" })
    const response = await app.request(`/clinica/professionals?token=${TOKEN}&branchId=${BRANCH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = (await response.json()) as { data: { professionals: Array<{ name: string }>; first: { professionalUserId: string } } }
    expect(body.data.professionals.map((item) => item.name)).toEqual(["Dra. Ana Torres"])
    expect(body.data.first.professionalUserId).toBe("u-ana")
    expect(seen).toEqual([{ token: TOKEN, branchId: BRANCH }])
  })

  it("sin sede, con otra cosa en la dirección o con un enlace mal escrito, no pregunta nada", async () => {
    const app = createPublicBookingRoute({ db, secretsKey: Buffer.alloc(32), remoteAddress: () => "203.0.113.21" })
    seen.length = 0
    expect((await app.request(`/clinica/professionals?token=${TOKEN}`)).status).toBe(400)
    expect((await app.request(`/clinica/professionals?token=${TOKEN}&branchId=no-es-una-sede`)).status).toBe(400)
    expect((await app.request(`/clinica/professionals?token=${TOKEN}&branchId=${BRANCH}&from=2026-11-01`)).status).toBe(400)
    expect((await app.request(`/clinica/professionals?token=corto&branchId=${BRANCH}`)).status).toBe(400)
    expect(seen).toEqual([])
  })
})
