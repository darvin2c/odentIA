import { describe, expect, it } from "vitest"
import { senderModeStartProblem } from "./sender-mode.js"

describe("senderModeStartProblem", () => {
  it("en producción, sin modo de envío, no arranca", () => {
    expect(senderModeStartProblem({ NODE_ENV: "production" })).toMatch(/CHANNEL_SENDER_MODE es obligatoria/)
  })

  it("en producción arranca con el modo elegido, aunque sea mock", () => {
    expect(senderModeStartProblem({ NODE_ENV: "production", CHANNEL_SENDER_MODE: "live" })).toBeNull()
    expect(senderModeStartProblem({ NODE_ENV: "production", CHANNEL_SENDER_MODE: "mock" })).toBeNull()
  })

  it("fuera de producción, sin modo, simula", () => {
    expect(senderModeStartProblem({})).toBeNull()
    expect(senderModeStartProblem({ NODE_ENV: "test" })).toBeNull()
  })
})
