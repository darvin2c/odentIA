import { describe, expect, it } from "vitest"
import { rateKeyOf } from "./rate-key.js"

describe("la llave de los topes por dirección", () => {
  it("una IPv4 cuenta sola, también escrita como IPv6", () => {
    expect(rateKeyOf("203.0.113.5")).toBe("203.0.113.5")
    expect(rateKeyOf("::ffff:203.0.113.5")).toBe("203.0.113.5")
  })

  it("una IPv6 cuenta por su red /64: cambiar de dirección dentro de ella no pasa el tope", () => {
    const key = "2001:db8:abcd:12::/64"
    expect(rateKeyOf("2001:db8:abcd:12:1:2:3:4")).toBe(key)
    expect(rateKeyOf("2001:0DB8:abcd:0012:ffff::1")).toBe(key)
    expect(rateKeyOf("2001:db8:abcd:12::99")).toBe(key)
    expect(rateKeyOf("2001:db8:abcd:13::1")).not.toBe(key)
    expect(rateKeyOf("2001:db8::1")).toBe("2001:db8:0:0::/64")
    expect(rateKeyOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64")
    expect(rateKeyOf("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64")
  })

  it("sin dirección, una llave común; lo que no es una dirección queda como llegó", () => {
    expect(rateKeyOf(undefined)).toBe("shared")
    expect(rateKeyOf("")).toBe("shared")
    expect(rateKeyOf("1:2:3")).toBe("1:2:3")
    expect(rateKeyOf("1::2::3")).toBe("1::2::3")
  })
})
