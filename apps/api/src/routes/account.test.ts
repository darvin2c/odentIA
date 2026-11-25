import type { Db } from "@odentia/db"
import { describe, expect, it, vi } from "vitest"
import type { AppDeps } from "../app.js"

vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  getMyTwoFactor: async () => ({
    enabled: true,
    staff: false,
    hasPassword: true,
    requiredBy: ["Dental Smile", "Pediatría Los Olivos"],
    trustedBrowsers: 0,
  }),
}))

const { createAccountRoute } = await import("./account.js")

const auth = {
  api: { getSession: async () => ({ user: { id: "u-rosa", email: "rosa@x.test" } }) },
} as unknown as AppDeps["auth"]

const twoFactorOf = async (personOnly: boolean) =>
  (
    (await (
      await createAccountRoute({ auth, ownerDb: {} as Db, personOnly }).request("/two-factor")
    ).json()) as { data: { requiredBy: string[] } }
  ).data.requiredBy

describe("los dos pasos en el dominio de una app que es otro sistema (ADR 0218)", () => {
  it("no nombra las clínicas que la piden: dice cuántas", async () => {
    expect(await twoFactorOf(true)).toEqual(["2 de tus clínicas"])
    expect(await twoFactorOf(false)).toEqual(["Dental Smile", "Pediatría Los Olivos"])
  })
})
