import type { CbctVolume } from "./cbct-volume"

/**
 * El volumen de la tomografía como un NIfTI-1 en memoria (cabecera de 348
 * bytes, 4 de extensión vacía y los vóxeles en enteros de 16 bits), para que
 * el visor 3D lo lea sin otro archivo. Para mostrar alcanza una copia
 * reducida: el lado mayor queda en `maxSide` vóxeles, tomando uno de cada
 * `factor`; así no se duplica la memoria de un volumen grande.
 *
 * Ejes como `CbctVolume` (x hacia la izquierda del paciente, y hacia atrás, z
 * hacia arriba); la matriz `sform` los lleva a RAS, la convención de NIfTI.
 */
export function cbctNifti(
  volume: CbctVolume,
  maxSide = 256,
): { buffer: ArrayBuffer; factor: number } {
  const factor = Math.max(1, Math.ceil(Math.max(volume.nx, volume.ny, volume.nz) / maxSide))
  const ox = Math.max(1, Math.floor(volume.nx / factor))
  const oy = Math.max(1, Math.floor(volume.ny / factor))
  const oz = Math.max(1, Math.floor(volume.nz / factor))
  const header = 352
  const buffer = new ArrayBuffer(header + ox * oy * oz * 2)
  const view = new DataView(buffer)
  view.setInt32(0, 348, true)
  const dims = [3, ox, oy, oz, 1, 1, 1, 1]
  for (const [i, d] of dims.entries()) view.setInt16(40 + i * 2, d, true)
  view.setInt16(70, 4, true) // DT_SIGNED_SHORT
  view.setInt16(72, 16, true)
  const mm = [volume.sx * factor, volume.sy * factor, volume.sz * factor]
  const pixdim = [1, mm[0]!, mm[1]!, mm[2]!, 0, 0, 0, 0]
  for (const [i, d] of pixdim.entries()) view.setFloat32(76 + i * 4, d, true)
  view.setFloat32(108, header, true)
  view.setFloat32(112, 1, true)
  view.setFloat32(116, 0, true)
  view.setUint8(123, 2) // mm
  view.setInt16(252, 0, true)
  view.setInt16(254, 1, true) // sform: coordenadas del paciente
  const rows = [
    [-mm[0]!, 0, 0, 0],
    [0, -mm[1]!, 0, 0],
    [0, 0, mm[2]!, 0],
  ]
  for (const [r, row] of rows.entries()) {
    for (const [c, v] of row.entries()) view.setFloat32(280 + r * 16 + c * 4, v, true)
  }
  // "n+1\0": NIfTI-1 con la cabecera y los datos en el mismo archivo.
  for (const [i, b] of [0x6e, 0x2b, 0x31, 0x00].entries()) view.setUint8(344 + i, b)
  const out = new Int16Array(buffer, header)
  const { nx, ny, data } = volume
  let i = 0
  for (let z = 0; z < oz; z++) {
    for (let y = 0; y < oy; y++) {
      const base = (z * factor * ny + y * factor) * nx
      for (let x = 0; x < ox; x++) out[i++] = data[base + x * factor]!
    }
  }
  return { buffer, factor }
}
