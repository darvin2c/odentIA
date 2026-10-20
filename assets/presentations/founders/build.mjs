// Arma la presentación de Fundadores en un solo archivo: dist/founders.html.
//
//   node assets/presentations/founders/build.mjs
//
// La portada usa la escena real de las 32 piezas (packages/brand-scene), así que se arma desde su fuente
// y no desde una copia: Node quita los tipos de TypeScript (module.stripTypeScriptTypes) y los dos módulos
// quedan dentro de una función que expone `BrandScene`. No hace falta ningún empaquetador.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "../../..")
const read = (path) => readFileSync(join(root, path), "utf8")

// La escena: hero-data.ts y tooth-scene.ts, sin tipos, sin import/export, en un solo ámbito.
const plain = (path) =>
  stripTypeScriptTypes(read(path), { mode: "strip" })
    .replace(/^import .*$/gm, "")
    .replace(/^export (?=const|function|class|let)/gm, "")
const scene = `var BrandScene = (() => {
${plain("packages/brand-scene/src/hero-data.ts")}
${plain("packages/brand-scene/src/tooth-scene.ts")}
return { AGENTS, CHANS, DAY, dir, via, ToothScene };
})();`

// El logotipo de la web, sin su título para que no aparezca como globo al pasar el puntero.
const logo = read("apps/web/src/assets/logotipo-dark.svg")
  .replace(/<title>[^<]*<\/title>/, "")
  .replace("<svg ", '<svg aria-label="odentIA" role="img" ')

const html = readFileSync(join(here, "source.html"), "utf8")
  .replace("%%LOGO%%", () => logo)
  .replace("%%SCENE%%", () => scene)
  .replace("%%BRACKETS%%", () => readFileSync(join(here, "brackets-3d.js"), "utf8"))
if (html.includes("%%")) throw new Error("Quedó un marcador sin reemplazar en source.html")

// Cada script tiene que poder leerse; un error aquí se ve antes de presentar.
for (const [, code] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(code)
const module3d = html.match(/<script type="module">([\s\S]*?)<\/script>/)
if (module3d) new Function("THREE", module3d[1].replace(/^import .*$/gm, ""))

mkdirSync(join(here, "dist"), { recursive: true })
writeFileSync(join(here, "dist/founders.html"), `<!doctype html>\n<meta charset="utf-8">\n${html}`)
console.log(`dist/founders.html listo (${Math.round(html.length / 1024)} KB)`)
