// Genera `src/logos.ts`: el logotipo y el isotipo en PNG, a tres veces su tamaño
// en el correo, para adjuntarlos por `cid`. Gmail y Outlook no muestran SVG y una
// imagen remota se bloquea hasta que la persona la permite. Se corre a mano al
// cambiar la marca: `pnpm --filter @odentia/mail logos`.
import { readFile, writeFile } from "node:fs/promises"
import sharp from "sharp"

const ASSETS = new URL("../assets/", import.meta.url)
const OUT = new URL("../src/logos.ts", import.meta.url)

/** Alto en el correo (px CSS); el PNG se dibuja al triple para pantallas densas. */
const IMAGES = [
  { name: "logotipoClaro", file: "logotipo-claro.svg", height: 32 },
  { name: "logotipoOscuro", file: "logotipo-oscuro.svg", height: 32 },
  { name: "isotipoClaro", file: "isotipo-claro.svg", height: 32 },
  { name: "isotipoOscuro", file: "isotipo-oscuro.svg", height: 32 },
]

const entries = []
for (const image of IMAGES) {
  const svg = await readFile(new URL(image.file, ASSETS))
  const png = await sharp(svg, { density: 600 }).resize({ height: image.height * 3 }).png({ compressionLevel: 9 }).toBuffer()
  const { width, height } = await sharp(png).metadata()
  entries.push(
    `  ${image.name}: {\n` +
      `    /** ${image.file}, ${width}×${height} px. */\n` +
      `    width: ${Math.round(width / 3)},\n` +
      `    height: ${Math.round(height / 3)},\n` +
      `    base64:\n      "${png.toString("base64")}",\n` +
      `  },`,
  )
}

await writeFile(
  OUT,
  `// Generado por scripts/logos.mjs a partir de assets/: no editar a mano.\n\n` +
    `export const LOGOS = {\n${entries.join("\n")}\n} as const\n`,
)
console.log(`logos: ${IMAGES.length} imágenes en src/logos.ts`)
