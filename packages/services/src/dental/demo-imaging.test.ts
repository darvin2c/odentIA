import { createHash } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { DEMO_CBCT, DEMO_IMAGES, demoImage, readGipl } from "./demo-imaging.js"

/** Un GIPL mínimo: cabecera de 256 bytes en big endian y vóxeles de 16 bits. */
function gipl(nx: number, ny: number, nz: number, values: number[]): Buffer {
  const out = Buffer.alloc(256 + values.length * 2)
  out.writeUInt16BE(nx, 0)
  out.writeUInt16BE(ny, 2)
  out.writeUInt16BE(nz, 4)
  out.writeUInt16BE(1, 6)
  out.writeUInt16BE(15, 8)
  out.writeFloatBE(0.5, 10)
  out.writeUInt32BE(0x2ae389b8, 252)
  values.forEach((v, i) => out.writeInt16BE(v, 256 + i * 2))
  return gzipSync(out)
}

describe("imágenes reales de la demo", () => {
  it("cada imagen dice su autor y una licencia que permite la demo comercial", () => {
    for (const source of [...Object.values(DEMO_IMAGES), DEMO_CBCT]) {
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(source.url).toMatch(/^https:\/\/(upload\.wikimedia\.org|github\.com\/Slicer)\//)
      expect(source.credit).toMatch(/CC0|CC BY-SA|uso libre/)
      expect(source.credit).not.toMatch(/NC|ND/)
    }
  })
  it("lee la tomografía GIPL y deja los vóxeles en 12 bits", () => {
    const volume = readGipl(gipl(2, 2, 2, [0, 100, 3874, 5000, -20, 7, 8, 9]))
    expect(volume).toMatchObject({ nx: 2, ny: 2, nz: 2, voxelMm: 0.5 })
    expect(Array.from(volume.data)).toEqual([0, 100, 3874, 4095, 0, 7, 8, 9])
  })
  it("rechaza lo que no es un GIPL o está incompleto", () => {
    expect(() => readGipl(gzipSync(Buffer.alloc(300)))).toThrow(/GIPL/)
    const short = gunzipCut(gipl(4, 4, 4, Array(64).fill(1)))
    expect(() => readGipl(short)).toThrow(/incompleto/)
  })
  it("solo usa el archivo si su huella coincide; si no, lo deja fuera y no inventa otro", async () => {
    const bytes = Buffer.from("radiografía de prueba")
    const url = `data:application/octet-stream;base64,${bytes.toString("base64")}`
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const name = `prueba-${sha256.slice(0, 8)}.bin`
    expect(await demoImage({ file: name, url, sha256, credit: "prueba · CC0" })).toEqual(bytes)
    expect(
      await demoImage({
        file: `otra-${name}`,
        url,
        sha256: "0".repeat(64),
        credit: "prueba · CC0",
      }),
    ).toBeNull()
  })
})

/** El mismo GIPL sin los últimos vóxeles, comprimido otra vez. */
function gunzipCut(gz: Buffer): Buffer {
  const raw = gunzipSync(gz)
  return gzipSync(raw.subarray(0, raw.length - 10))
}
