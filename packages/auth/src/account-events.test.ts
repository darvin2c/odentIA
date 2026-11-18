import { describe, expect, it } from "vitest"
import { isAccountEventSecret, signAccountEvent, verifyAccountEvent } from "./account-events.js"

// El ejemplo de la especificación de Standard Webhooks (el mismo de sus bibliotecas oficiales).
const SPEC = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
}

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`
const body = JSON.stringify({
  type: "cuenta.cerrada",
  timestamp: "2026-11-17T20:00:00.000Z",
  data: { userId: "u-1" },
})

describe("los avisos de la cuenta, firmados (Standard Webhooks)", () => {
  it("firma igual que la especificación", () => {
    const headers = signAccountEvent({
      secret: SPEC.secret,
      id: SPEC.id,
      body: SPEC.body,
      timestamp: SPEC.timestamp,
    })
    expect(headers["webhook-signature"]).toBe(SPEC.signature)
  })

  it("la app reconoce un aviso de la cuenta y rechaza uno cambiado, viejo o con otro secreto", () => {
    const now = new Date("2026-11-17T20:00:30Z")
    const timestamp = Math.floor(now.getTime() / 1000) - 30
    const headers = new Headers(signAccountEvent({ secret: SECRET, id: "evt-1", body, timestamp }))
    expect(verifyAccountEvent({ secret: SECRET, headers, body, now })).toMatchObject({
      id: "evt-1",
      type: "cuenta.cerrada",
      data: { userId: "u-1" },
    })
    // Otro cuerpo con la misma firma.
    expect(
      verifyAccountEvent({ secret: SECRET, headers, body: body.replace("u-1", "u-2"), now }),
    ).toBeNull()
    // El mismo aviso, repetido una hora después.
    expect(
      verifyAccountEvent({
        secret: SECRET,
        headers,
        body,
        now: new Date(now.getTime() + 3_600_000),
      }),
    ).toBeNull()
    // Firmado con otro secreto.
    const other = `whsec_${Buffer.alloc(32, 9).toString("base64")}`
    expect(verifyAccountEvent({ secret: other, headers, body, now })).toBeNull()
    // Sin firma.
    expect(verifyAccountEvent({ secret: SECRET, headers: new Headers(), body, now })).toBeNull()
  })

  it("el secreto es whsec_ y al menos 24 bytes", () => {
    expect(isAccountEventSecret(SECRET)).toBe(true)
    expect(isAccountEventSecret("whsec_corto")).toBe(false)
    expect(isAccountEventSecret(Buffer.alloc(32).toString("base64"))).toBe(false)
  })
})
