import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, test } from "vitest"

// Vitest arregla por su cuenta cómo se importa un paquete CommonJS: dentro de una
// prueba, `dicom-parser` funciona de cualquier forma. La semilla corre con tsx sobre
// Node, que no lo arregla, y ahí `seed:dev` fallaba con «parseDicom is not a
// function». Por eso se prueba en un Node aparte, como corre la semilla.
test("dicom-parser lee un DICOM desde Node con tsx, como la semilla", () => {
  const module = pathToFileURL(fileURLToPath(new URL("./dicom-parser.ts", import.meta.url))).href
  const script = `
    import { encodeDemoDicom } from "@odentia/clinical"
    const { dicomParser } = await import(${JSON.stringify(module)})
    const bytes = encodeDemoDicom({ width: 4, height: 2, pixels: new Uint16Array(8) })
    const ds = dicomParser.parseDicom(bytes)
    console.log(JSON.stringify({ rows: ds.uint16("x00280010"), cols: ds.uint16("x00280011") }))
  `
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
    },
  )
  expect(JSON.parse(out.trim())).toEqual({ rows: 2, cols: 4 })
}, 60_000)
