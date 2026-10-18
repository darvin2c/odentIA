import { describe, expect, it } from "vitest"
import { countdown } from "./countdown"
import { creditText } from "./credit"

describe("crédito de prueba", () => {
  it("se escribe como en la web", () => {
    expect(creditText("USD", 10_000)).toBe("USD 100")
    expect(creditText("USD", 5_050)).toBe("USD 50,50")
    expect(creditText("PEN", 150_000)).toBe("PEN 1.500")
  })
})

describe("cuenta regresiva de reenviar", () => {
  it("minutos y segundos", () => {
    expect(countdown(60)).toBe("1:00")
    expect(countdown(45)).toBe("0:45")
    expect(countdown(0)).toBe("0:00")
  })
})
