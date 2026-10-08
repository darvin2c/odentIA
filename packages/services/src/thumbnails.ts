import sharp from "sharp"

/** Lado mayor de la miniatura de galería, en píxeles. */
export const THUMBNAIL_MAX_SIDE = 320

/**
 * Miniatura WebP de una imagen clínica para la galería, el resumen y la
 * historia por pieza: respeta la orientación EXIF, nunca amplía y limita los
 * píxeles de entrada. Si la imagen no se puede decodificar devuelve null: la
 * subida no se bloquea por la miniatura (la galería usa entonces el original).
 */
export async function makeImageThumbnail(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const out = await sharp(bytes, { failOn: "error", limitInputPixels: 80_000_000 })
      .rotate()
      .resize(THUMBNAIL_MAX_SIDE, THUMBNAIL_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
    return new Uint8Array(out)
  } catch {
    return null
  }
}
