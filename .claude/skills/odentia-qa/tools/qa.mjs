// El navegador de la QA: un Chromium sin interfaz por voz, que sigue abierto entre llamadas.
// Rápido y barato porque una llamada hace muchos pasos y devuelve solo lo que el guion anota,
// los errores de consola y de red, y las capturas que pidió; no un árbol de la página por clic.
//
// Uso (desde la raíz del repositorio):
//   node .claude/skills/odentia-qa/tools/qa.mjs start <voz> [ancho] [alto]   abre el navegador de la voz (1440x900 por omisión)
//   node .claude/skills/odentia-qa/tools/qa.mjs size  <voz> <ancho> <alto>   cambia el ancho (390x844 para el celular)
//   node .claude/skills/odentia-qa/tools/qa.mjs run   <voz> <guion.js>       corre un guion sobre la misma página
//   node .claude/skills/odentia-qa/tools/qa.mjs run   <voz> -e "<código>"    igual, con el código en línea
//   node .claude/skills/odentia-qa/tools/qa.mjs ver   <voz> [selector]       lo que se ve, en el árbol de accesibilidad compacto
//   node .claude/skills/odentia-qa/tools/qa.mjs stop  <voz>                  cierra el navegador de la voz
//
// El guion es el cuerpo de una función async con: page, context, shot(nombre) -> ruta, log(...) y
// ver(selector?, tope?) -> texto (ya lo imprime: no hace falta pasarlo por log). La página, la sesión
// y lo escrito siguen ahí en la próxima llamada.
// Variables: QA_CAPTURAS (carpeta de capturas, al hacer start), QA_PERFILES (perfiles, por omisión
// ~/odentia-qa/perfiles, fuera del repositorio porque guardan sesiones), QA_CHROME (otro Chromium).
import { spawn } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const ROOT = process.env.QA_PERFILES || path.join(os.homedir(), "odentia-qa", "perfiles")
const PORTS = { novato: 9341, clinica: 9342, desarrollo: 9343, auditor: 9344, ux: 9345, confirma: 9346, orquesta: 9347, comercial: 9348 }
const VER_TOPE = 6000

// El Playwright del repositorio (el de e2e/, con su versión fijada); si no está instalado, uno al lado.
function loadChromium() {
  const desde = [path.join(REPO, "e2e", "package.json"), fileURLToPath(import.meta.url)]
  for (const from of desde) {
    for (const name of ["@playwright/test", "playwright-core"]) {
      try {
        return createRequire(from)(name).chromium
      } catch {}
    }
  }
  console.error("no encontré Playwright: corre `pnpm install` en la raíz (lo trae e2e/)")
  process.exit(2)
}
const chromium = loadChromium()

const [cmd, voz, ...rest] = process.argv.slice(2)
if (!cmd || !voz) {
  console.error("uso: node qa.mjs start|size|run|ver|stop <voz> ...")
  process.exit(2)
}
// Un puerto por nombre: un hash del nombre entero, no su largo (dos voces de 9 letras chocaban).
const hashOf = (text) => [...text].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7)
const port = PORTS[voz] ?? 9400 + (hashOf(voz) % 500)
const dir = path.join(ROOT, voz)
const stateFile = path.join(dir, "estado.json")
fs.mkdirSync(dir, { recursive: true })
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"))
  } catch {
    return { width: 1440, height: 900, shots: 0, capturas: "" }
  }
}
const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2))

async function connect() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages().find((p) => !p.url().startsWith("devtools")) ?? (await context.newPage())
  return { browser, context, page }
}

// Lo que se ve, compacto: el árbol de accesibilidad de una parte de la página, con tope.
async function verDe(page, selector = "body", tope = VER_TOPE) {
  const texto = await page.locator(selector).first().ariaSnapshot({ timeout: 5000 })
  const corto = texto.length > tope ? `${texto.slice(0, tope)}\n… (${texto.length - tope} caracteres más: pide un selector más chico)` : texto
  return `página: ${page.url()} · «${await page.title()}»\n${corto}`
}

if (cmd === "start") {
  const s = readState()
  s.width = Number(rest[0] ?? s.width)
  s.height = Number(rest[1] ?? s.height)
  s.capturas = process.env.QA_CAPTURAS ?? s.capturas
  writeState(s)
  const chrome = process.env.QA_CHROME || chromium.executablePath()
  if (!fs.existsSync(chrome)) {
    console.error(`no está el Chromium de Playwright (${chrome}): pnpm --filter @odentia/e2e exec playwright install chromium`)
    process.exit(2)
  }
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(dir, "datos")}`,
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      `--window-size=${s.width},${s.height}`,
      "--lang=es-PE",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  )
  child.unref()
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) {
        console.log(`listo: ${voz} en el puerto ${port}, ${s.width}x${s.height}`)
        process.exit(0)
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  console.error("el navegador no respondió")
  process.exit(1)
}

if (cmd === "size") {
  const s = readState()
  s.width = Number(rest[0])
  s.height = Number(rest[1])
  writeState(s)
  const { page } = await connect()
  await page.setViewportSize({ width: s.width, height: s.height })
  console.log(`ancho ${s.width}x${s.height}`)
  process.exit(0)
}

if (cmd === "stop") {
  try {
    const { browser } = await connect()
    const cdp = await browser.newBrowserCDPSession()
    await cdp.send("Browser.close")
  } catch {}
  console.log("cerrado")
  process.exit(0)
}

if (cmd === "ver") {
  const { page } = await connect()
  console.log(await verDe(page, rest[0] ?? "body"))
  process.exit(0)
}

if (cmd === "run") {
  const s = readState()
  const code = rest[0] === "-e" ? rest.slice(1).join(" ") : fs.readFileSync(rest[0], "utf8")
  const { context, page } = await connect()
  await page.setViewportSize({ width: s.width, height: s.height })
  const problemas = []
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problemas.push(`consola ${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on("pageerror", (e) => problemas.push(`error de página: ${String(e).slice(0, 300)}`))
  page.on("response", (r) => {
    if (r.status() >= 400) problemas.push(`red ${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`)
  })
  page.on("dialog", (d) => {
    problemas.push(`diálogo nativo (${d.type()}): ${d.message()} → se cerró con «Cancelar»`)
    d.dismiss().catch(() => {})
  })
  const capturas = s.capturas || path.join(os.homedir(), "odentia-qa", "capturas-sueltas")
  fs.mkdirSync(capturas, { recursive: true })
  const shot = async (nombre, opts = {}) => {
    s.shots += 1
    writeState(s)
    const file = path.join(capturas, `${voz}-${String(s.shots).padStart(2, "0")}${nombre ? "-" + nombre : ""}.png`)
    await page.screenshot({ path: file, ...opts })
    console.log(`captura: ${file}`)
    return file
  }
  const log = (...a) => console.log(...a)
  const ver = async (selector, tope) => {
    const texto = await verDe(page, selector, tope)
    console.log(texto)
    return texto
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  let ok = true
  try {
    await new AsyncFunction("page", "context", "shot", "log", "ver", code)(page, context, shot, log, ver)
  } catch (e) {
    ok = false
    console.log(`el guion falló: ${String(e).split("\n").slice(0, 6).join("\n")}`)
    try {
      await shot("fallo")
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 300))
  console.log(`página: ${page.url()}`)
  if (problemas.length) console.log(`problemas durante el guion:\n- ${[...new Set(problemas)].join("\n- ")}`)
  process.exit(ok ? 0 : 1)
}

console.error(`orden desconocida: ${cmd}`)
process.exit(2)
