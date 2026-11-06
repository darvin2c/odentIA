import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

/**
 * Imágenes clínicas REALES para la demo (no de un paciente de odentIA): radiografías
 * y fotos de Wikimedia Commons, y una tomografía de los datos de muestra de 3D
 * Slicer. Cada una con su licencia, que permite el uso comercial (CC0, dominio
 * público, CC BY-SA) y, cuando la pide, su atribución en el «Origen» del
 * documento. Licencias verificadas en la página de cada archivo el 2026-11-06.
 *
 * No viven en el repositorio: la semilla las descarga la primera vez, comprueba
 * su SHA-256 y las guarda en `.cache/demo-imaging/`. Sin conexión no se inventa
 * nada: la semilla lo dice y deja la imagen fuera.
 */

export interface DemoImageSource {
  /** Nombre del archivo en la caché. */
  file: string
  url: string
  sha256: string
  /** Lo que va en «Origen»: autor, fuente y licencia (lo pide CC BY-SA). */
  credit: string
}

const COMMONS = "https://upload.wikimedia.org/wikipedia/commons"

export const DEMO_IMAGES = {
  /** Periapical de molares inferiores con amalgamas y cálculo. CC0, Jmarchn. */
  periapicalInferior: {
    file: "periapical-inferior.jpg",
    url: `${COMMONS}/8/83/X-ray_of_dental_calculus.jpg`,
    sha256: "486a157f63c794554c78bfaf044abbf571b21d7a394c52f341346115283f9539",
    credit: "Jmarchn · Wikimedia Commons · CC0",
  },
  /** Periapical superior con periodontitis apical crónica (la flecha es del original). CC BY-SA 3.0. */
  periapicalPeriodontitis: {
    file: "periapical-periodontitis.jpg",
    url: `${COMMONS}/4/4e/Chronic_apical_periodontitis.jpg`,
    sha256: "40ed8a6a6f1bc2e40ad479cf72033b08bda7462527c5a49459b5178522542cb5",
    credit: "Michele Gardini · Wikimedia Commons · CC BY-SA 3.0",
  },
  /** Periapical anterior superior con una radiolucidez apical. CC BY-SA 4.0. */
  periapicalRadiolucidez: {
    file: "periapical-radiolucidez.jpg",
    url: `${COMMONS}/5/5d/Periapical_radiolucency.jpg`,
    sha256: "e7e9bc78235e056d2e5be6aeda4e1781b5bbe01d8735d13dab60ce0cfffaadd5",
    credit: "Shaimaa Abdellatif · Wikimedia Commons · CC BY-SA 4.0",
  },
  /** Periapical de un niño: la 75 y las coronas en formación de 35, 36 y 37. CC BY-SA 4.0. */
  periapicalNino: {
    file: "periapical-nino.jpg",
    url: `${COMMONS}/3/3d/Intraoral_Periapical_Radiograph_%28IOPA%29_showing_Deciduous%28Milky_or_Primary%29_Tooth_75_and_developing_crown_of_Permanent_or_Secondary_Teeth_35%2C_36_and_37.jpg`,
    sha256: "6e96fce451a2bcd0fc41b7a62a81b865ea1aec2b7a51a4d16ea66ec169b7b099",
    credit: "Nizil Shah · Wikimedia Commons · CC BY-SA 4.0",
  },
  /** Panorámica de un adulto con restauraciones y ausencias. CC0, Fastsmiles. */
  panoramica: {
    file: "panoramica.jpg",
    url: `${COMMONS}/7/7a/Pano-GH21101912.jpg`,
    sha256: "5537c69d0cd450790350de5bf9e21e7adc690ad32b20d316bc1bac7860dc9334",
    credit: "Fastsmiles · Wikimedia Commons · CC0",
  },
  /** Cefalométrica lateral. CC BY-SA 4.0. */
  cefalometrica: {
    file: "cefalometrica.jpg",
    url: `${COMMONS}/6/66/Cephalometric_radiograph.JPG`,
    sha256: "ede247cdc573719cd25c928110543978f962f43e296adb1f875cdd45b3fc7ee6",
    credit: "ANUG · Wikimedia Commons · CC BY-SA 4.0",
  },
  /** Foto intraoral lateral derecha en oclusión. CC BY-SA 4.0. */
  fotoIntraoral: {
    file: "foto-intraoral.jpg",
    url: `${COMMONS}/9/90/Class_1_bimaxillary_protrusion.jpg`,
    sha256: "19ce85f319eaa9cdc148e9ed9b53d60b65278d7b033c6fdb3789ca0b43cbba45",
    credit: "Challiyan · Wikimedia Commons · CC BY-SA 4.0",
  },
} satisfies Record<string, DemoImageSource>

/**
 * CBCT de un adulto antes de una cirugía ortognática (PreDentalSurgery), de los
 * datos de muestra de 3D Slicer: sus autores los dan de uso libre, sin
 * restricciones. GIPL comprimido, 360 × 360 × 330 vóxeles de 0,5 mm.
 */
export const DEMO_CBCT: DemoImageSource = {
  file: "PreDentalSurgery.gipl.gz",
  url: "https://github.com/Slicer/SlicerTestingData/releases/download/SHA256/7bfa16945629c319a439f414cfb7edddd2a97ba97753e12eede3b56a0eb09968",
  sha256: "7bfa16945629c319a439f414cfb7edddd2a97ba97753e12eede3b56a0eb09968",
  credit: "3D Slicer, datos de muestra (PreDentalSurgery) · uso libre",
}

const CACHE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.cache/demo-imaging",
)

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Los bytes del archivo: de la caché si ya está y su huella coincide; si no, de su
 * fuente. Devuelve null (y lo dice) si no se puede bajar o la huella no coincide.
 */
export async function demoImage(source: DemoImageSource): Promise<Buffer | null> {
  const cached = path.join(CACHE, source.file)
  try {
    const bytes = readFileSync(cached)
    if (sha256(bytes) === source.sha256) return bytes
  } catch {
    // No estaba en la caché.
  }
  try {
    const response = await fetch(source.url, {
      headers: { "User-Agent": "odentIA-demo-seed/1.0 (https://odentia32.com)" },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (sha256(bytes) !== source.sha256) throw new Error("la huella SHA-256 no coincide")
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(cached, bytes)
    return bytes
  } catch (error) {
    console.warn(
      `[demo] No se pudo obtener ${source.file} (${source.url}): ${(error as Error).message}. Queda fuera de la demo.`,
    )
    return null
  }
}

export interface DemoVolume {
  nx: number
  ny: number
  nz: number
  voxelMm: number
  /** Vóxeles de 12 bits, x más rápido, luego y y z. */
  data: Uint16Array
}

/**
 * Lee un GIPL (Guys Image Processing Lab): cabecera de 256 bytes en big endian
 * con las dimensiones (0), el tipo (8; 15 = entero de 16 bits) y el tamaño del
 * vóxel (10), y luego los vóxeles en big endian.
 */
export function readGipl(gz: Buffer): DemoVolume {
  const bytes = gunzipSync(gz)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(252)
  if (magic !== 0x2ae389b8 && magic !== 0xefffe9b0) throw new Error("No es un archivo GIPL")
  const [nx, ny, nz] = [view.getUint16(0), view.getUint16(2), view.getUint16(4)]
  const type = view.getUint16(8)
  if (type !== 15 && type !== 16)
    throw new Error(`GIPL de tipo ${type}: se esperaba un entero de 16 bits`)
  const voxelMm = view.getFloat32(10)
  const count = nx * ny * nz
  if (bytes.byteLength < 256 + count * 2) throw new Error("El GIPL está incompleto")
  const data = new Uint16Array(count)
  for (let i = 0; i < count; i++) {
    const v = type === 15 ? view.getInt16(256 + i * 2) : view.getUint16(256 + i * 2)
    data[i] = Math.max(0, Math.min(4095, v))
  }
  return { nx, ny, nz, voxelMm, data }
}
