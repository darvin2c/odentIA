import { createReadStream } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import type { Browser, Page } from "@playwright/test"

const resolve = createRequire(import.meta.url).resolve
const FILES: Record<string, { path: string; type: string }> = {
  "/pdf.mjs": { path: resolve("pdfjs-dist/build/pdf.min.mjs"), type: "text/javascript" },
  "/pdf.worker.mjs": {
    path: resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
    type: "text/javascript",
  },
  "/jsqr.js": { path: resolve("jsqr"), type: "text/javascript" },
}

const PAGE = `<!doctype html><canvas id="sheet"></canvas><script src="/jsqr.js"></script>
<script type="module">
  import * as pdfjs from "/pdf.mjs"
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs"
  const sheet = document.getElementById("sheet")
  const look = () => {
    const image = sheet.getContext("2d").getImageData(0, 0, sheet.width, sheet.height)
    return window.jsQR(image.data, image.width, image.height)?.data ?? null
  }
  window.readSheet = async (base64, scale) => {
    const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const pdf = await pdfjs.getDocument({ data }).promise
    const qrs = []
    let drawings = 0
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      const { fnArray } = await page.getOperatorList()
      drawings += fnArray.filter((fn) => fn === pdfjs.OPS.constructPath).length
      const viewport = page.getViewport({ scale })
      sheet.width = viewport.width
      sheet.height = viewport.height
      await page.render({ canvas: sheet, viewport }).promise
      const found = look()
      if (found) qrs.push(found)
    }
    return { pages: pdf.numPages, qrs, drawings }
  }
  window.ready = true
</script>`

type Reader = {
  readSheet: (
    data: string,
    scale: number,
  ) => Promise<{ pages: number; qrs: string[]; drawings: number }>
}

async function withReader<T>(browser: Browser, use: (page: Page) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    const file = FILES[request.url ?? ""]
    if (!file) {
      response.setHeader("content-type", "text/html")
      response.end(PAGE)
      return
    }
    response.setHeader("content-type", file.type)
    createReadStream(file.path).pipe(response)
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const context = await browser.newContext({ viewport: { width: 1300, height: 1800 } })
  try {
    const page = await context.newPage()
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    await page.waitForFunction("window.ready === true")
    return await use(page)
  } finally {
    await context.close()
    server.close()
  }
}

/**
 * Lee un PDF como lo vería una cámara: lo dibuja en pantalla y busca su QR en los
 * puntos de la hoja, sin leer el archivo por dentro. `scale` 3 son 216 puntos por
 * pulgada: menos de lo que ve un teléfono de cerca. La dirección de este entorno es
 * unos 55 caracteres más larga que la real, y por debajo de eso el QR denso a veces
 * no se lee. También deja su imagen y cuenta lo dibujado a trazos: una firma es un
 * dibujo más en la hoja.
 */
export function readPdfLikeACamera(
  browser: Browser,
  bytes: Buffer,
  options: { scale?: number; picturePath?: string } = {},
): Promise<{ pages: number; qr: string | null; drawings: number }> {
  return withReader(browser, async (page) => {
    const read = await page.evaluate(
      ([base64, scale]) =>
        (window as unknown as Reader).readSheet(base64 as string, scale as number),
      [bytes.toString("base64"), options.scale ?? 3] as const,
    )
    if (options.picturePath) await page.locator("#sheet").screenshot({ path: options.picturePath })
    return { pages: read.pages, qr: read.qrs[0] ?? null, drawings: read.drawings }
  })
}
