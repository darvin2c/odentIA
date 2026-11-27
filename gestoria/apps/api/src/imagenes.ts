import sharp from "sharp"

/**
 * Las copias de cada foto (ADR 0236). La pantalla ya la achica antes de subirla; el servidor
 * guarda la original como llegó y arma, con sharp (libvips), las copias que se muestran y se
 * mandan: sin los datos de la cámara (la ubicación del celular no sale de la tienda), girada como
 * se ve y del tamaño de cada uso.
 *
 * - `miniatura`: la lista y la cuadrícula (WebP, 400 px).
 * - `vitrina`: la ficha y la web de la tienda (WebP, 1600 px).
 * - `whatsapp`: la que manda Sofi. WhatsApp Cloud API acepta JPEG o PNG de 8 bits hasta 5 MB
 *   (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#supported-media-types):
 *   va en JPEG, 1600 px, sobre blanco si la foto es transparente (la de fondo quitado).
 */

// Un servidor chico (512 MB): una foto a la vez por proceso de libvips y sin su caché.
sharp.concurrency(1)
sharp.cache(false)

/** Lo más grande que se abre: 50 megapíxeles (un celular de hoy saca 12 a 48). */
const MAX_PIXELS = 50_000_000
const WHATSAPP_MAX_BYTES = 5 * 1024 * 1024

export const PHOTO_COPIES = ["miniatura", "vitrina", "whatsapp"] as const
export type PhotoCopy = (typeof PHOTO_COPIES)[number]

export const COPY_TYPE: Record<PhotoCopy, string> = {
  miniatura: "image/webp",
  vitrina: "image/webp",
  whatsapp: "image/jpeg",
}

export interface PhotoFacts {
  width: number
  height: number
  /** Si tiene partes transparentes posibles (PNG o WebP con canal alfa). */
  alpha: boolean
}

export class ImageError extends Error {}

/** Lo que se sabe de una foto al abrirla; falla si no se puede abrir o es demasiado grande. */
export async function photoFacts(bytes: Uint8Array): Promise<PhotoFacts> {
  try {
    const meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata()
    if (!meta.width || !meta.height) throw new ImageError("sin tamaño")
    if ((meta.pages ?? 1) > 1) throw new ImageError("animada")
    // Girada como se ve: el ancho y el alto de la foto derecha.
    const turned = (meta.orientation ?? 1) >= 5
    return {
      width: turned ? meta.height : meta.width,
      height: turned ? meta.width : meta.height,
      alpha: meta.hasAlpha === true,
    }
  } catch (error) {
    if (error instanceof ImageError) throw error
    throw new ImageError("no se pudo abrir")
  }
}

/** Arma las tres copias de una foto. */
export async function photoCopies(bytes: Uint8Array): Promise<Record<PhotoCopy, Uint8Array>> {
  const base = () => sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate()
  const fit = { width: 1600, height: 1600, fit: "inside", withoutEnlargement: true } as const
  const miniatura = await base()
    .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer()
  const vitrina = await base().resize(fit).webp({ quality: 82 }).toBuffer()
  let quality = 85
  let whatsapp = await base()
    .resize(fit)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer()
  // A 1600 px casi nunca pasa de 1 MB; si pasara, se baja la calidad hasta que entre.
  while (whatsapp.length > WHATSAPP_MAX_BYTES && quality > 40) {
    quality -= 15
    whatsapp = await base()
      .resize(fit)
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
  }
  return {
    miniatura: new Uint8Array(miniatura),
    vitrina: new Uint8Array(vitrina),
    whatsapp: new Uint8Array(whatsapp),
  }
}

/** El póster de un video: lo que se ve antes de darle play, en JPEG para WhatsApp y la web. */
export async function posterCopy(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" })
      .rotate()
      .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer(),
  )
}
