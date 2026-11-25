import type { Db } from "@odentia/db"
import type { Storage } from "@odentia/services"
import { describe, expect, it, vi } from "vitest"
import type { ApiDeps } from "../lib/context.js"

/** Dos casos de la misma persona: uno de su cuenta y otro abierto en una clínica. */
const CASES = [
  { id: "caso-cuenta", organizationId: null, organizationName: null },
  { id: "caso-clinica", organizationId: "org-sonrisa", organizationName: "Dental Smile" },
]
const opened: Array<{ screen?: string }> = []

vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  listAccountSupportCases: async () => CASES,
  getAccountSupportCase: async (_db: Db, _userId: string, id: string) => {
    const kase = CASES.find((item) => item.id === id)
    if (!kase) throw new Error("no existe")
    return { ...kase, messages: [], attachments: [], grants: [] }
  },
  markAccountSupportCaseSeen: async () => undefined,
  createAccessSupportCase: async (_db: Db, _userId: string, input: { screen?: string }) => {
    opened.push(input)
    return { id: "caso-nuevo", organizationId: null }
  },
}))

const { createAccountSupportRoute } = await import("./account-support.js")

const auth = {
  api: {
    getSession: async () => ({ user: { id: "u-rosa", image: null }, session: { id: "s-1" } }),
  },
} as unknown as ApiDeps["auth"]

const routeOf = (accountCasesOnly: boolean) =>
  createAccountSupportRoute({
    ownerDb: {} as Db,
    auth,
    storage: {} as Storage,
    ...(accountCasesOnly ? { accountCasesOnly, screen: "/gestoria" } : {}),
  })

describe("soporte de la cuenta en el dominio de una app que es otro sistema (ADR 0216)", () => {
  it("solo ve los casos de la cuenta: los de una clínica no existen ahí", async () => {
    const route = routeOf(true)
    const list = (await (await route.request("/cases")).json()) as { data: Array<{ id: string }> }
    expect(list.data.map((kase) => kase.id)).toEqual(["caso-cuenta"])
    expect((await route.request("/cases/caso-cuenta")).status).toBe(200)
    expect((await route.request("/cases/caso-clinica")).status).toBe(404)
    expect((await route.request("/cases/caso-clinica/seen", { method: "POST" })).status).toBe(404)
    // El acceso diagnóstico es a una clínica: ahí no existe.
    const grant = await route.request("/cases/caso-cuenta/grants", {
      method: "POST",
      body: JSON.stringify({ organizationId: "org-sonrisa" }),
    })
    expect(grant.status).toBe(404)
  })

  it("el caso nuevo dice desde qué app se pidió ayuda", async () => {
    opened.length = 0
    const response = await routeOf(true).request("/cases", {
      method: "POST",
      body: JSON.stringify({ question: "No me llega el código" }),
    })
    expect(response.status).toBe(201)
    expect(opened).toEqual([expect.objectContaining({ screen: "/gestoria" })])
  })

  it("en el panel sigue viendo todos sus casos", async () => {
    const list = (await (await routeOf(false).request("/cases")).json()) as {
      data: Array<{ id: string }>
    }
    expect(list.data.map((kase) => kase.id)).toEqual(["caso-cuenta", "caso-clinica"])
    expect((await routeOf(false).request("/cases/caso-clinica")).status).toBe(200)
  })
})
