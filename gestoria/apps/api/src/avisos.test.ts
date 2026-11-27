/**
 * Los avisos al celular (tablero 15), sin base: a cada rol lo suyo, lo que dice cada aviso y que
 * solo se acepte la dirección de un servicio de push de verdad.
 */
import { describe, expect, it } from "vitest"
import {
  activeKinds,
  chatsPush,
  kindsFor,
  type OrderStep,
  orderPush,
  pushTopic,
  subscribeInput,
} from "./avisos.js"

const step = (over: Partial<OrderStep>): OrderStep => ({
  seq: 1,
  action: "comprobante",
  actorUserId: "agente:sofi",
  detail: {},
  orderId: "o-1",
  number: 142,
  customerName: "Carla Mendoza",
  totalCents: 8500,
  state: "por_confirmar",
  ...over,
})

describe("a cada rol lo suyo", () => {
  it("Ventas recibe lo que resuelve; el Dueño y el Administrador, además lo de dinero", () => {
    expect(kindsFor("sales")).toEqual(["pagos", "chats", "no_entregado", "sofi_pedido"])
    expect(kindsFor("admin")).toEqual(["pagos", "chats", "no_entregado", "sofi_pedido", "dinero"])
    expect(kindsFor("owner")).toEqual(kindsFor("admin"))
    // Soporte de gestorIA no es del equipo: no recibe nada.
    expect(kindsFor("support")).toEqual([])
  })

  it("sin elegir, a Ventas no le llegan los pedidos de Sofi; al Dueño, todo", () => {
    expect([...activeKinds("sales", null)]).toEqual(["pagos", "chats", "no_entregado"])
    expect([...activeKinds("owner", null)]).toEqual(kindsFor("owner"))
  })

  it("lo elegido vale solo dentro de lo que su rol puede", () => {
    expect([...activeKinds("sales", ["sofi_pedido", "dinero"])]).toEqual(["sofi_pedido"])
    expect([...activeKinds("admin", [])]).toEqual([])
  })
})

describe("lo que dice cada aviso", () => {
  it("una captura: quién, con qué y cuánto, y lleva a confirmarla", () => {
    const push = orderPush(step({ detail: { monto: 8500, medio: "Yape", moneda: "PEN" } }), "PEN")
    expect(push).toMatchObject({ kind: "pagos", urgency: "high" })
    expect(push?.title).toMatch(/^Carla Mendoza envió su Yape de S\/\s?85$/)
    expect(push?.body).toBe("Ver y confirmar · Pedido 0142")
  })

  it("un pago por link que entró es lo de dinero; el que no coincide espera a una persona", () => {
    expect(
      orderPush(step({ action: "pago_link", actorUserId: null, detail: { monto: 13900 } }), "PEN"),
    ).toMatchObject({ kind: "dinero", title: "Entró un pago por link", urgency: "normal" })
    expect(
      orderPush(
        step({ action: "pago_link", actorUserId: null, detail: { monto: 100, porRevisar: "x" } }),
        "PEN",
      ),
    ).toMatchObject({ kind: "pagos", title: "El pago por link de Carla Mendoza no coincide" })
  })

  it("lo que no se entregó dice el pedido, el motivo y cuándo vuelve a salir", () => {
    expect(
      orderPush(
        step({
          action: "no_entregado",
          actorUserId: "u-kevin",
          customerName: "Jorge Ramos",
          detail: { motivo: "No contestó", dia: "jue, 27 nov" },
        }),
        "PEN",
      ),
    ).toMatchObject({
      kind: "no_entregado",
      title: "No se entregó el 0142 de Jorge Ramos",
      body: "No contestó · vuelve a salir el jue, 27 nov",
    })
  })

  it("un pedido armado avisa solo si lo armó Sofi", () => {
    const sofi = orderPush(
      step({ action: "creado", state: "por_pagar", customerName: "Luis Gómez", totalCents: 9900 }),
      "PEN",
    )
    expect(sofi).toMatchObject({ kind: "sofi_pedido", title: "Sofi armó un pedido" })
    expect(sofi?.body).toMatch(/^Luis Gómez · S\/\s?99 · por pagar$/)
    expect(orderPush(step({ action: "creado", actorUserId: "u-lucia" }), "PEN")).toBeNull()
    expect(orderPush(step({ action: "salio" }), "PEN")).toBeNull()
  })

  it("los chats: el nombre y el motivo, o cuántos si son varios", () => {
    expect(chatsPush([])).toBeNull()
    expect(chatsPush([{ customerName: "Carla Mendoza", reason: "Un reclamo" }])).toEqual({
      title: "Carla Mendoza pide hablar con una persona",
      body: "Un reclamo",
    })
    expect(chatsPush([{ customerName: null, reason: null }])?.title).toBe(
      "Un cliente pide hablar con una persona",
    )
    expect(
      chatsPush([
        { customerName: "A", reason: null },
        { customerName: "B", reason: null },
      ])?.title,
    ).toBe("2 chats esperan a una persona")
  })

  it("el tipo de aviso en el servicio de push: base64url y hasta 32 caracteres", () => {
    const topic = pushTopic("no_entregado", "3f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")
    expect(topic).toBe("no-entregado-3f1c2b8e1d2a")
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })
})

describe("el celular", () => {
  const keys = { p256dh: `B${"a".repeat(86)}`, auth: "a".repeat(22) }

  it("acepta solo la dirección de un servicio de push de los navegadores", () => {
    expect(
      subscribeInput.safeParse({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })
        .success,
    ).toBe(true)
    expect(
      subscribeInput.safeParse({ endpoint: "https://web.push.apple.com/QGx", keys }).success,
    ).toBe(true)
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/x",
      "https://servidor-interno.local/x",
      "https://user:pass@fcm.googleapis.com/x",
    ])
      expect(subscribeInput.safeParse({ endpoint, keys }).success, endpoint).toBe(false)
  })

  it("las claves del navegador tienen su forma (RFC 8291)", () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc"
    expect(subscribeInput.safeParse({ endpoint, keys: { ...keys, auth: "corta" } }).success).toBe(
      false,
    )
  })
})
