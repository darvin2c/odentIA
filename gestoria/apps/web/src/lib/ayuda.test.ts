import { describe, expect, it } from "vitest"
import { questionStatus } from "./ayuda"

describe("las palabras de «Tus casos con soporte»", () => {
  it("cómo va cada caso", () => {
    expect(questionStatus("por_enviar")).toBe("Por enviar")
    expect(questionStatus("enviada")).toBe("Enviada")
    expect(questionStatus("esperando_clinica")).toBe("Te respondimos")
    expect(questionStatus("otro")).toBe("Recibida")
  })
})
