import { describe, expect, it } from "vitest"
import { greeting, initials } from "./welcome"

describe("saludo de entrar", () => {
  it("cambia con la hora del equipo", () => {
    expect(greeting(new Date(2026, 9, 17, 8, 50))).toBe("Buenos días")
    expect(greeting(new Date(2026, 9, 17, 12, 0))).toBe("Buenas tardes")
    expect(greeting(new Date(2026, 9, 17, 19, 0))).toBe("Buenas noches")
    expect(greeting(new Date(2026, 9, 17, 4, 59))).toBe("Buenas noches")
  })

  it("iniciales del nombre y del último apellido", () => {
    expect(initials("Carmen Ruiz Paredes")).toBe("CP")
    expect(initials("Carmen")).toBe("C")
  })
})
