import { describe, expect, it } from "vitest"
import { volumeFromSlices } from "./cbct-volume"
import { cbctWindows, ctWindows } from "./ct-windows"

const slices = [Int16Array.from([-1000, 0, 40, 1200]), Int16Array.from([-900, 30, 60, 1500])]
const geometry = { nx: 2, ny: 2, sx: 1, sy: 1, sz: 1 }

describe("ventanas de la tomografía", () => {
  it("la médica abre con la del archivo y ofrece las de HU", () => {
    const volume = volumeFromSlices(slices, geometry, { hounsfield: true, fileWindow: { center: 40, width: 300 } })
    expect(ctWindows(volume).map((w) => w.label)).toEqual(["Del archivo", "Pulmón", "Partes blandas", "Hueso", "Cerebro"])
    expect(ctWindows(volume)[0]!.window).toEqual({ center: 40, width: 300 })
    expect(ctWindows(volume).find((w) => w.key === "pulmon")!.window).toEqual({ center: -600, width: 1500 })
  })

  it("sin HU no ofrece ventanas fijas: solo la del archivo, o todo el rango", () => {
    const withWindow = volumeFromSlices(slices, geometry, { fileWindow: { center: 2048, width: 4096 } })
    expect(ctWindows(withWindow).map((w) => w.key)).toEqual(["archivo"])
    const bare = volumeFromSlices(slices, geometry)
    expect(ctWindows(bare)).toEqual([
      { key: "automatica", label: "Todo el rango", window: { center: 250, width: 2500 } },
    ])
  })

  it("la CBCT sigue con sus tres brillos del estudio", () => {
    const volume = volumeFromSlices(slices, geometry, { hounsfield: true })
    expect(cbctWindows(volume).map((w) => w.label)).toEqual(["Hueso", "Diente", "Tejido blando"])
    expect(cbctWindows(volume)[0]!.window).toEqual(volume.presets.hueso)
  })
})
