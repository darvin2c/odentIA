import { describe, expect, it } from "vitest"
import { weekdaysLabel } from "./branch-hours"

describe("los días que atiende alguien, en corto", () => {
  it("los días seguidos van juntos y la semana empieza en lunes", () => {
    expect(weekdaysLabel([1, 2, 3, 4, 5, 6])).toBe("Lun a sáb")
    expect(weekdaysLabel([1, 3, 5])).toBe("Lun, mié y vie")
    expect(weekdaysLabel([1, 2, 4, 5])).toBe("Lun a mar y jue a vie")
    // El domingo es el último de la semana, aunque su número sea 0.
    expect(weekdaysLabel([6, 0])).toBe("Sáb a dom")
    expect(weekdaysLabel([2])).toBe("Mar")
    expect(weekdaysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Todos los días")
  })
})
