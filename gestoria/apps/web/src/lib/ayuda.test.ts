import { describe, expect, it } from "vitest"
import { helpPanel, helpRequestWithPanel, questionStatus } from "./ayuda"

describe("las palabras de «Tus casos con soporte»", () => {
  it("cómo va cada caso", () => {
    expect(questionStatus("por_enviar")).toBe("Por enviar")
    expect(questionStatus("enviada")).toBe("Enviada")
    expect(questionStatus("esperando_clinica")).toBe("Te respondimos")
    expect(questionStatus("otro")).toBe("Recibida")
  })
})

describe("la Ayuda con «Probar como clienta» abierto", () => {
  it("manda el panel con la ruta: la pantalla y la pregunta hablan de él", () => {
    const screen = "/api/tiendas/t1/ayuda/screen?path=%2Ftiendas%2Ft1%2Fcatalogo%2Fp1"
    expect(helpRequestWithPanel(screen, undefined).path).toBe(screen)
    helpPanel.current = "probar-como-clienta"
    try {
      const sent = helpRequestWithPanel(screen, undefined)
      expect(new URLSearchParams(sent.path.split("?")[1]).get("path")).toBe(
        "/tiendas/t1/catalogo/p1#probar-como-clienta",
      )
      expect(
        helpRequestWithPanel("/api/tiendas/t1/ayuda/ask", {
          question: "¿Se mueve el stock?",
          screen: "/tiendas/t1/catalogo/p1",
        }).body,
      ).toEqual({
        question: "¿Se mueve el stock?",
        screen: "/tiendas/t1/catalogo/p1#probar-como-clienta",
      })
    } finally {
      helpPanel.current = null
    }
  })
})
