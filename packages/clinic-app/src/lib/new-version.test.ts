import { describe, expect, it } from "vitest"
import { isChunkLoadError } from "./new-version"

describe("versión nueva", () => {
  it("reconoce el archivo de la app que ya no está, en cada navegador", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a-1.js"))).toBe(true)
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true)
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true)
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/a.css"))).toBe(true)
  })

  it("no confunde un archivo dañado con una versión nueva", () => {
    expect(isChunkLoadError(new Error("No se pudo descomprimir la imagen"))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})
