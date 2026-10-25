// Arma la presentación de Fundadores de latidIA en un solo archivo: dist/founders-latidia.html.
//
//   node assets/presentations/founders-latidia/build.mjs
//
// Es la de odentIA (../founders) pensada para un consultorio médico: el lila de la web de latidIA, su
// logotipo y la línea de pulso de la marca, la misma de la portada de la web, en la portada 3D.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "../../..")
const read = (path) => readFileSync(join(root, path), "utf8")

// La línea de pulso sale de la portada de la web, no de una copia: tres latidos a 72 por minuto.
const demo = read("apps/web/src/components/latidia/home/DictationDemo.tsx")
const ecg = demo.match(/const ECG =\s*"([^"]+)"/)?.[1]
if (!ecg) throw new Error("No encontré la línea de pulso (ECG) en DictationDemo.tsx")

// El logotipo de la web, sin su título para que no aparezca como globo al pasar el puntero.
const logo = read("apps/web/src/assets/latidia-logotipo-dark.svg")
  .replace(/<title>[^<]*<\/title>/, "")
  .replace("<svg ", '<svg aria-label="latidIA" role="img" ')

const html = readFileSync(join(here, "source.html"), "utf8")
  .replaceAll("%%ECG%%", ecg)
  .replace("%%LOGO%%", () => logo)
  .replace("%%LATIDO%%", () => readFileSync(join(here, "latido-3d.js"), "utf8"))
  .replace("%%COVER%%", () => readFileSync(join(here, "cover-3d.js"), "utf8"))
if (html.includes("%%")) throw new Error("Quedó un marcador sin reemplazar en source.html")

// Cada script tiene que poder leerse; un error aquí se ve antes de presentar.
for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code)
for (const [, code] of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g))
  new Function("THREE", code.replace(/^import .*$/gm, ""))

mkdirSync(join(here, "dist"), { recursive: true })
writeFileSync(join(here, "dist/founders-latidia.html"), `<!doctype html>\n<meta charset="utf-8">\n${html}`)
console.log(`dist/founders-latidia.html listo (${Math.round(html.length / 1024)} KB)`)
