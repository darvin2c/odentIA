/**
 * Lo que se mira de un video antes de guardarlo (ADR 0236): que WhatsApp lo acepte tal cual.
 * Los videos de prueba se armaron con ffmpeg desde el video del prototipo (`v_calzado.mp4`).
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { checkVideo } from "./video.js"

const read = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)))

describe("el video para WhatsApp", () => {
  it("acepta H.264 Main sin cuadros B, con AAC y el índice al principio", () => {
    const checked = checkVideo(read("../semilla/video-calzado.mp4"))
    expect(checked).toEqual({
      ok: true,
      facts: { durationMs: expect.any(Number), width: 480, height: 480, audio: true },
    })
    if (checked.ok) expect(checked.facts.durationMs).toBeGreaterThan(5000)
  })

  it("rechaza el perfil High con cuadros B, que Android no muestra", () => {
    const checked = checkVideo(read("./__fixtures__/video-high.mp4"))
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.message).toMatch(/Android/)
  })

  it("rechaza el que tiene el índice al final", () => {
    const checked = checkVideo(read("./__fixtures__/video-moov-al-final.mp4"))
    expect(checked).toEqual({ ok: false, message: expect.stringMatching(/WhatsApp/) })
  })

  it("no lee fuera del archivo con uno cortado o inventado", () => {
    const good = read("../semilla/video-calzado.mp4")
    expect(checkVideo(good.subarray(0, 2000)).ok).toBe(false)
    expect(checkVideo(new TextEncoder().encode("<html>no es un video</html>")).ok).toBe(false)
    // Una caja que dice medir más que el archivo.
    const lie = new Uint8Array(64)
    new DataView(lie.buffer).setUint32(0, 0xffffff00)
    lie.set(new TextEncoder().encode("ftyp"), 4)
    expect(checkVideo(lie)).toEqual({ ok: false, message: expect.any(String) })
    expect(checkVideo(new Uint8Array(0)).ok).toBe(false)
  })
})
