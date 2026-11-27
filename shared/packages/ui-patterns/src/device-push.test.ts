import { describe, expect, it, vi } from "vitest"
import { applicationServerKey, createDevicePush, isInternalPath } from "./device-push"

describe("los avisos en este equipo, de uso general", () => {
  it("un aviso solo abre rutas de la misma app", () => {
    expect(isInternalPath("/tiendas/1/pedidos?pedido=2")).toBe(true)
    expect(isInternalPath("//otra.com/x")).toBe(false)
    expect(isInternalPath("https://otra.com")).toBe(false)
  })

  it("la clave pública llega en base64url y se entrega en bytes", () => {
    expect([...applicationServerKey("AQID_-8")]).toEqual([1, 2, 3, 255, 239])
  })

  it("pide la clave al servidor una vez por pestaña y, si falla, la vuelve a pedir", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("sin red"))
      .mockResolvedValue({ publicKey: "AQID" })
    const device = createDevicePush({
      request,
      paths: { key: "/clave", subscriptions: "/celular", state: "/celular/estado" },
      readKey: (response) => (response as { publicKey: string | null }).publicKey,
      readActive: () => false,
    })
    await expect(device.available()).rejects.toThrow("sin red")
    expect(await device.available()).toBe(true)
    expect(await device.available()).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith("/clave")
  })

  it("sin clave en el servidor, no están disponibles", async () => {
    const device = createDevicePush({
      request: async () => ({ publicKey: null }),
      paths: { key: "/clave", subscriptions: "/celular", state: "/celular/estado" },
      readKey: (response) => (response as { publicKey: string | null }).publicKey,
      readActive: () => false,
    })
    expect(await device.available()).toBe(false)
    expect(await device.enable()).toBe("no-disponible")
  })
})
