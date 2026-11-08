import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { unzipSync } from "fflate"

/**
 * Una tomografía médica REAL para la demo de latidIA (no de un paciente del
 * consultorio): un abdomen con contraste de The Cancer Imaging Archive,
 * colección CPTAC-CCRCC, sujeto C3N-01905 (Siemens Sensation 40). Licencia
 * CC BY 4.0, que permite el uso comercial con atribución: va en el «Origen» del
 * documento. Licencia verificada en los metadatos de la serie el 2026-11-07.
 *
 * Tres de sus series, para recorrer el selector, en el orden en que se suben: la
 * fase venosa (la primera, que abre el visor), la arterial, de 5 mm, y el
 * topograma, que se ve y no se arma. No viven en el repositorio: la
 * semilla las descarga la primera vez de la API pública de TCIA y las guarda en
 * `.cache/demo-imaging/`. El ZIP que arma TCIA cambia con la hora, así que la
 * huella es la de sus archivos DICOM (cada nombre con su SHA-256, en orden).
 * Sin conexión o con otra huella no se inventa nada: la semilla lo dice y deja
 * la tomografía fuera.
 */

export interface DemoCtSeries {
  seriesUid: string
  /** SHA-256 de «nombre:sha256» por cada .dcm del ZIP, en orden de nombre. */
  contentSha256: string
}

export const DEMO_CT = {
  studyUid: "1.3.6.1.4.1.14519.5.2.1.3320.3273.163569599787073680852983912417",
  credit: "The Cancer Imaging Archive, CPTAC-CCRCC (C3N-01905) · CC BY 4.0",
  series: [
    {
      // Faza zylna 5.0 (fase venosa): 61 cortes.
      seriesUid: "1.3.6.1.4.1.14519.5.2.1.3320.3273.865562650966317615534062854390",
      contentSha256: "ccf0185d5216532b2c18dab5608b6e3b92f08a629ecd5e1a8ff1668e6aa3e3ba",
    },
    {
      // Faza tetnicza 5.0 (fase arterial): 61 cortes.
      seriesUid: "1.3.6.1.4.1.14519.5.2.1.3320.3273.268919275408368382579814996834",
      contentSha256: "c625a297e2f18d81ced58c49f9a47d72d3d994aba0fff47b9599d3f59bf70b75",
    },
    {
      // Topogram 0.6 T20s: 2 imágenes.
      seriesUid: "1.3.6.1.4.1.14519.5.2.1.3320.3273.847486010655151746931875626900",
      contentSha256: "b03ef74e9bc089e12c8b2e967edb9d59c00996ed2ad9348dacf75f543ad104ff",
    },
  ] satisfies DemoCtSeries[],
}

const TCIA = "https://services.cancerimagingarchive.net/nbia-api/services/v1/getImage?SeriesInstanceUID="

const CACHE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../.cache/demo-imaging")

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** Los DICOM del ZIP en orden de nombre, si su huella es la esperada. */
function dicomFiles(zip: Uint8Array, expected: string): Uint8Array[] | null {
  const files = unzipSync(zip)
  const names = Object.keys(files)
    .filter((name) => name.toLowerCase().endsWith(".dcm"))
    .sort()
  const hash = createHash("sha256")
  for (const name of names) hash.update(`${name}:${sha256(files[name]!)}\n`)
  return hash.digest("hex") === expected ? names.map((name) => files[name]!) : null
}

/** Los archivos DICOM de una serie: de la caché o de TCIA. null (y lo dice) si no se pudo. */
export async function demoCtSeries(series: DemoCtSeries): Promise<Uint8Array[] | null> {
  const cached = path.join(CACHE, `tcia-${series.seriesUid}.zip`)
  try {
    const found = dicomFiles(new Uint8Array(readFileSync(cached)), series.contentSha256)
    if (found) return found
  } catch {
    // No estaba en la caché.
  }
  try {
    const response = await fetch(`${TCIA}${series.seriesUid}`, {
      headers: { "User-Agent": "odentIA-demo-seed/1.0 (https://odentia32.com)" },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const zip = new Uint8Array(await response.arrayBuffer())
    const found = dicomFiles(zip, series.contentSha256)
    if (!found) throw new Error("la huella de sus archivos no coincide")
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(cached, zip)
    return found
  } catch (error) {
    console.warn(
      `[demo] No se pudo obtener la serie ${series.seriesUid} de TCIA: ${(error as Error).message}. La tomografía queda fuera de la demo de latidIA.`,
    )
    return null
  }
}
