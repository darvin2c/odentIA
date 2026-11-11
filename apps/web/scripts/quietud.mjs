// Comprueba la regla de movimiento de la web (apps/AGENTS.md): lo que se mueve solo no cambia el
// alto de su escena ni corre un enlace o un botón.
//
//   node apps/web/scripts/quietud.mjs <dirección> [ancho=390] [segundos=45] [ruta…]
//
// Abre cada página en un Chromium sin interfaz con todo a la vista a la vez (así todas las escenas se
// arman y corren), espera a que arranquen y durante `segundos` anota, sin tocar nada, el alto de cada
// escena y la posición de cada enlace, botón y campo. Sin rutas, recorre las que enlaza el inicio.
// Sale con 1 si algo se movió más de 2 px. Usa el Playwright de e2e (`pnpm --filter @odentia/e2e exec
// playwright install chromium` la primera vez). Mide lo que pasa solo: no reemplaza mirar la página.
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(fileURLToPath(new URL("../../../e2e/package.json", import.meta.url)))
const { chromium } = require("@playwright/test")

const [base, widthArg = "390", secondsArg = "45", ...asked] = process.argv.slice(2)
if (!base) {
  console.error("uso: node apps/web/scripts/quietud.mjs <dirección> [ancho] [segundos] [ruta…]")
  process.exit(2)
}
const width = Number(widthArg)
const seconds = Number(secondsArg)
const origin = base.replace(/\/+$/, "")
const browser = await chromium.launch()

/** Las páginas que enlaza el inicio (cabecera, pie y contenido), sin las legales. */
async function linkedRoutes() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${origin}/`, { waitUntil: "load" })
  const routes = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll("a[href]")]
        .map((a) => new URL(a.href))
        .filter((url) => url.origin === location.origin)
        .map((url) => url.pathname.replace(/\/+$/, "") || "/"),
    ),
  ])
  await page.close()
  const legal = /^\/(terminos|privacidad|cookies|encargo-de-tratamiento|subencargados|aviso-legal)$/
  return ["/", ...routes.filter((route) => route !== "/" && !legal.test(route))]
}

/** Lo que cambió en una página mientras nadie la tocaba. */
async function watch(route) {
  const narrow = width < 500
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: narrow, isMobile: narrow })
  const page = await context.newPage()
  try {
    await page.goto(origin + route, { waitUntil: "load", timeout: 120_000 })
    await page.waitForTimeout(1500)
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    await page.setViewportSize({ width, height: Math.min(height + 100, 30_000) })
    await page.waitForTimeout(6000)
    return await page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const name = (el) => {
            const scene = el.closest("astro-island")?.getAttribute("component-url")?.split("/").pop()?.split("?")[0]
            const text = (el.textContent || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 36)
            return `«${text}»${scene ? ` en ${scene}` : ""}`
          }
          const scenes = [...document.querySelectorAll("astro-island")].flatMap((island) =>
            [...island.children].map((el) => ({
              el,
              who: island.getAttribute("component-url")?.split("/").pop()?.split("?")[0] ?? "?",
              min: Number.POSITIVE_INFINITY,
              max: Number.NEGATIVE_INFINITY,
            })),
          )
          const controls = [...document.querySelectorAll("a[href], button, summary, input, select, textarea")]
            .filter((el) => el.offsetParent !== null)
            .map((el) => ({ el, top: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], left: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] }))
          const start = performance.now()
          const tick = () => {
            for (const scene of scenes) {
              const h = scene.el.offsetHeight
              scene.min = Math.min(scene.min, h)
              scene.max = Math.max(scene.max, h)
            }
            for (const control of controls) {
              if (!control.el.isConnected) continue
              const rect = control.el.getBoundingClientRect()
              if (rect.width === 0 && rect.height === 0) continue
              control.top = [Math.min(control.top[0], rect.top + scrollY), Math.max(control.top[1], rect.top + scrollY)]
              control.left = [Math.min(control.left[0], rect.left), Math.max(control.left[1], rect.left)]
            }
            if (performance.now() - start < ms) return setTimeout(tick, 120)
            resolve({
              controls: controls.length,
              scenes: scenes.filter((scene) => scene.max - scene.min > 1).map((scene) => `${scene.who}: alto ${scene.min}–${scene.max} px`),
              moved: controls
                .map((control) => ({ who: name(control.el), dy: Math.round(control.top[1] - control.top[0]), dx: Math.round(control.left[1] - control.left[0]) }))
                .filter((move) => move.dy > 2 || move.dx > 2),
            })
          }
          tick()
        }),
      seconds * 1000,
    )
  } finally {
    await context.close()
  }
}

const routes = asked.length ? asked : await linkedRoutes()
let failed = 0
const queue = [...routes]
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const route = queue.shift()
      try {
        const seen = await watch(route)
        if (!seen.scenes.length && !seen.moved.length) {
          console.log(`quieta   ${route} (${seen.controls} enlaces y botones)`)
          continue
        }
        failed += 1
        console.log(`SE MUEVE ${route}: ${seen.moved.length} de ${seen.controls} enlaces y botones`)
        for (const scene of seen.scenes) console.log(`           escena ${scene}`)
        for (const move of seen.moved.slice(0, 6)) console.log(`           ${move.who}: ${move.dy} px en vertical, ${move.dx} px en horizontal`)
      } catch (error) {
        failed += 1
        console.log(`NO SE PUDO ${route}: ${String(error).slice(0, 160)}`)
      }
    }
  }),
)
await browser.close()
console.log(failed ? `\n${failed} de ${routes.length} páginas con movimiento que corre algo a ${width} px.` : `\nLas ${routes.length} páginas, quietas a ${width} px.`)
process.exit(failed ? 1 : 0)
