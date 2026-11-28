#!/usr/bin/env node
// Después de armar la web: comprueba que existe cada página que enlazan los correos de la cuenta
// (/terminos, /privacidad, /contacto), la portada, la 404, el mapa del sitio, robots, el ícono y la
// imagen al compartir; que lo que tiene marcas va con noindex y fuera del mapa, y que ninguna página
// enlaza a otra que no existe. Si algo falla, el armado falla y no se publica.
import { existsSync, readFileSync } from "node:fs"

const dist = new URL("../dist/", import.meta.url)
const read = (file) => readFileSync(new URL(file, dist), "utf8")
const fallos = []

const PAGINAS = [
  "index.html",
  "sofi.html",
  "como-funciona.html",
  "cobros.html",
  "entregas.html",
  "clientes.html",
  "catalogo.html",
  "inventario.html",
  "argos.html",
  "rubros.html",
  "precios.html",
  "preguntas.html",
  "terminos.html",
  "privacidad.html",
  "contacto.html",
  "arm.html",
  "arm-vs-crm.html",
  "arm-vs-chatbot.html",
  "404.html",
]
for (const file of [
  ...PAGINAS,
  "sitemap-index.xml",
  "sitemap-0.xml",
  "robots.txt",
  "favicon.svg",
  "og.png",
])
  if (!existsSync(new URL(file, dist))) fallos.push(`falta ${file}`)

if (fallos.length === 0) {
  const mapa = read("sitemap-0.xml")
  // El dominio con que se armó, el mismo del mapa del sitio.
  const site = new URL(read("robots.txt").match(/Sitemap: (\S+)/)?.[1] ?? "").origin
  for (const file of PAGINAS) {
    const html = read(file)
    const marcas = /\[Por (completar|confirmar)/.test(html)
    const noindex = html.includes('name="robots" content="noindex')
    const path = file === "index.html" ? "/" : `/${file.replace(/\.html$/, "")}`
    const enMapa = mapa.includes(`<loc>${site}${path}</loc>`)
    if (marcas && !noindex) fallos.push(`${file} tiene marcas «[Por completar]» y no lleva noindex`)
    if (marcas && enMapa) fallos.push(`${file} tiene marcas y está en el mapa del sitio`)
    if (file === "404.html" && enMapa) fallos.push("la 404 está en el mapa del sitio")
    if (!marcas && file !== "404.html" && !enMapa)
      fallos.push(`${file} no está en el mapa del sitio`)
    // Cada enlace interno lleva a una página armada.
    for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) {
      if (href.startsWith("/_astro/")) continue
      const destino = href === "/" ? "index.html" : href.slice(1).replace(/\/$/, "")
      const existe = [destino, `${destino}.html`].some((f) => existsSync(new URL(f, dist)))
      if (!existe) fallos.push(`${file} enlaza a ${href}, que no existe`)
    }
  }
  if (!read("index.html").includes("gestorIA es una marca del Grupo Sallca"))
    fallos.push("la portada no lleva la firma")
  // El enlace del logo ya dice «gestorIA, inicio»: el dibujo no se lee otra vez.
  if (!/aria-label="gestorIA, inicio"><svg aria-hidden="true"/.test(read("index.html")))
    fallos.push("el logo de la cabecera no está oculto a los lectores de pantalla")
}

if (fallos.length > 0) {
  console.error(`El armado de la web de gestorIA no está listo:\n- ${fallos.join("\n- ")}`)
  process.exit(1)
}
console.log(
  `Web de gestorIA: ${PAGINAS.length} páginas, mapa del sitio, robots e imagen al compartir.`,
)
