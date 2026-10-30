import { SUBMIT_ERROR_WORDS, submitErrorOf } from "@odentia/ui-patterns"
import { describe, expect, it } from "vitest"
import { authError } from "./auth-error"

describe("authError", () => {
  it("un código equivocado (401 de Better Auth) se dice en su campo, no como sesión vencida", () => {
    const error = authError(
      { status: 401, code: "INVALID_CODE", message: "Invalid code" },
      { fields: { INVALID_CODE: "code" }, messages: { INVALID_CODE: "Ese código no coincide." } },
    )
    expect(submitErrorOf(error)).toEqual({ form: null, fields: { code: "Ese código no coincide." } })
  })

  it("la sesión vencida sigue diciéndose como tal", () => {
    const error = authError({ status: 401, code: "SESSION_EXPIRED", message: "Session expired" })
    expect(submitErrorOf(error).form).toBe(SUBMIT_ERROR_WORDS.session)
  })
})
