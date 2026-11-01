// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ImageAdjust } from "./image-adjust.js"

function stubCamera(getUserMedia: () => Promise<unknown>) {
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } })
}

function openCamera() {
  fireEvent.click(screen.getByRole("button", { name: "Tomar la foto" }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ImageAdjust: la cámara", () => {
  // Sin cámara el navegador falla sin preguntar nada: hablar del permiso
  // mandaría a buscar en un ajuste que está bien.
  it("sin cámara conectada no culpa al permiso", async () => {
    stubCamera(() => Promise.reject(new DOMException("no hay", "NotFoundError")))
    render(<ImageAdjust shape="person" name="Rosa Quispe" onChange={() => {}} />)
    openCamera()
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/conectada y encendida/)
    expect(alert.textContent).not.toMatch(/permi/i)
  })

  it("con la cámara bloqueada dice dónde permitirla", async () => {
    stubCamera(() => Promise.reject(new DOMException("denegado", "NotAllowedError")))
    render(<ImageAdjust shape="person" name="Rosa Quispe" onChange={() => {}} />)
    openCamera()
    expect((await screen.findByRole("alert")).textContent).toMatch(/junto a la dirección/)
  })

  it("en un navegador sin cámara disponible ofrece elegir un archivo", async () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: undefined })
    render(<ImageAdjust shape="person" name="Rosa Quispe" onChange={() => {}} />)
    openCamera()
    expect((await screen.findByRole("alert")).textContent).toMatch(/elige un archivo/i)
  })

  // Quien enciende la cámara y vuelve a intentar no debe seguir viendo el error.
  it("al volver a intentar se va el error anterior", async () => {
    const getUserMedia = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new DOMException("no hay", "NotFoundError"))
      .mockResolvedValue({ getTracks: () => [] })
    stubCamera(getUserMedia)
    render(<ImageAdjust shape="person" name="Rosa Quispe" onChange={() => {}} />)
    openCamera()
    await screen.findByRole("alert")
    openCamera()
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2))
    expect(screen.getByLabelText("Vista de la cámara")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
