import { describe, expect, it } from "vitest"
import { questionStatus, screenOf, whoLine } from "./ayuda"

const STORE = "6a1d6b52-6f73-4a5c-9b3a-5c0a1d0e2401"

describe("la pantalla desde la que se pide ayuda", () => {
  it("va su ruta dentro de la tienda, con lo que tiene abierto, y su nombre del menú", () => {
    expect(screenOf(`/tiendas/${STORE}/pedidos?pedido=p-1`, STORE)).toEqual({
      path: "/pedidos?pedido=p-1",
      name: "Pedidos",
    })
    expect(screenOf(`/tiendas/${STORE}/catalogo/prod-1`, STORE)).toEqual({
      path: "/catalogo/prod-1",
      name: "Catálogo",
    })
    expect(screenOf(`/tiendas/${STORE}/ayuda?pregunta=plan`, STORE).name).toBe("Ayuda")
    // Configuración: cada apartado con su nombre, y su entrada es «Datos de la tienda».
    expect(screenOf(`/tiendas/${STORE}/configuracion/marca`, STORE).name).toBe("Tu marca")
    expect(screenOf(`/tiendas/${STORE}/configuracion`, STORE).name).toBe("Datos de la tienda")
  })

  it("una sección que no conoce es el inicio de la tienda, y nunca pasa de 200 letras", () => {
    expect(screenOf(`/tiendas/${STORE}`, STORE)).toEqual({ path: "/", name: "Inicio de la tienda" })
    expect(screenOf(`/tiendas/${STORE}/pedidosx`, STORE).name).toBe("Inicio de la tienda")
    expect(screenOf(`/tiendas/${STORE}/pedidos?q=${"a".repeat(400)}`, STORE).path).toHaveLength(200)
  })
})

describe("las palabras de la Ayuda", () => {
  it("dice quién puede en singular o en plural", () => {
    expect(whoLine({ who: "Dueño", whoCount: 1 })).toBe("Lo puede hacer: Dueño.")
    expect(whoLine({ who: "Dueño y Administrador", whoCount: 2 })).toBe(
      "Lo pueden hacer: Dueño y Administrador.",
    )
  })

  it("cómo va cada pregunta", () => {
    expect(questionStatus("por_enviar")).toBe("Por enviar")
    expect(questionStatus("enviada")).toBe("Enviada")
    expect(questionStatus("esperando_clinica")).toBe("Te respondimos")
    expect(questionStatus("otro")).toBe("Recibida")
  })
})
