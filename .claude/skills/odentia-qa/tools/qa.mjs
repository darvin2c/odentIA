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
//   node .claude/skills/odentia-qa/tools/qa.mjs ir    <voz> "<objetivo>" [pasos]  Jev elige cada clic hasta llegar (6 pasos por omisión)
//   node .claude/skills/odentia-qa/tools/qa.mjs stop  <voz>                  cierra el navegador de la voz
//
// `ir` solo navega: le da a Jev los enlaces, botones y pestañas que se ven y le pregunta cuál acerca
// al objetivo y si ya llegó. Nunca aprieta lo que hace algo (guardar, enviar, cobrar, firmar, anular,
// borrar…) ni escribe: eso lo decide la voz. Lee JEV_API_KEY (y QA_JEV_MODEL, jev-1.14.0 por omisión).
//
// El guion es el cuerpo de una función async con: page, context, shot(nombre) -> ruta, log(...) y
// ver(selector?, tope?) -> texto. La página, la sesión y lo escrito siguen ahí en la próxima llamada.
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

// Lo que `ir` nunca aprieta: hace algo, no lleva a ningún lado. La voz lo aprieta en su guion.
const HACE_ALGO =
  /\b(guardar|enviar|env[ií]a|cobrar|cobra|pagar|paga|firmar|firma|anular|anula|borrar|borra|eliminar|elimina|quitar|quita|cancelar|confirmar|confirma|registrar|registra|aceptar|acepta|rechazar|desactivar|activar|apagar|encender|conectar|desconectar|publicar|subir|descargar|imprimir|cerrar sesi[oó]n|salir|crear|agregar|añadir|reservar|reserva|marcar|deshacer|restablecer|volver a empezar|entrar|iniciar sesi[oó]n|continuar|siguiente|verificar|enviar c[oó]digo)\b/i

// Los enlaces, botones y pestañas que se ven, con su nombre y su lugar en la página.
async function opcionesDe(page) {
  return page.evaluate((haceAlgo) => {
    const re = new RegExp(haceAlgo, "i")
    const base = location.hostname.split(".").slice(-2).join(".")
    const sel = 'a[href], button, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"]'
    const vistos = new Set()
    const lista = []
    document.querySelectorAll("[data-qa-ir]").forEach((el) => el.removeAttribute("data-qa-ir"))
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect()
      const st = getComputedStyle(el)
      if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none" || el.closest("[aria-hidden='true'],[inert]")) continue
      if (el.matches(":disabled,[aria-disabled='true']")) continue
      const nombre = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.querySelector("img[alt]")?.alt || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140)
      const href = el.tagName === "A" ? el.getAttribute("href") : null
      // Un enlace solo lleva a otra página; un botón con nombre de acción hace algo.
      if (!nombre || (!href && re.test(nombre))) continue
      if (href) {
        if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue
        try {
          const u = new URL(href, location.href)
          if (!u.hostname.endsWith(base)) continue
          // Lo que solo baja dentro de la misma página no lleva a ningún lado.
          if (u.origin + u.pathname === location.origin + location.pathname) continue
        } catch {
          continue
        }
      }
      const lugar = el.closest("[role=dialog],dialog")
        ? "en la ventana abierta"
        : el.closest("header,[role=banner]")
          ? "en la cabecera"
          : el.closest("nav,[role=navigation]")
            ? "en el menú"
            : el.closest("footer,[role=contentinfo]")
              ? "en el pie"
              : "en la página"
      const tipo = el.getAttribute("role") || (el.tagName === "A" ? "enlace" : "botón")
      const clave = `${tipo}|${nombre}|${href ?? ""}`
      if (vistos.has(clave)) continue
      vistos.add(clave)
      el.setAttribute("data-qa-ir", String(lista.length))
      lista.push({ i: lista.length, texto: `${tipo} «${nombre}» ${lugar}` })
      if (lista.length >= 250) break
    }
    return lista
  }, HACE_ALGO.source)
}

async function preguntarAJev(state, questions) {
  const key = process.env.JEV_API_KEY
  if (!key) throw new Error("falta JEV_API_KEY")
  const r = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ model: process.env.QA_JEV_MODEL || "jev-1.14.0", state, questions }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`Jev respondió HTTP ${r.status}`)
  return r.json()
}

if (cmd === "ir") {
  const objetivo = rest[0]
  const tope = Number(rest[1] ?? 6)
  if (!objetivo) {
    console.error('uso: node qa.mjs ir <voz> "<objetivo>" [pasos]')
    process.exit(2)
  }
  const s = readState()
  const { page } = await connect()
  await page.setViewportSize({ width: s.width, height: s.height })
  const inicio = Date.now()
  let tokens = 0
  const camino = []
  // Lo ya pulsado en cada página: Jev no vuelve a pulsarlo (un botón que abre y cierra lo mismo).
  const pulsados = new Set()
  let llego = false
  for (let paso = 1; paso <= tope; paso++) {
    const aqui = page.url()
    const opciones = (await opcionesDe(page)).filter((o) => !pulsados.has(`${aqui}|${o.texto}`))
    const titulos = await page
      .locator("h1, h2, [role=dialog] [role=heading]")
      .allInnerTexts()
      .then((t) => t.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8))
    const texto = await page
      .locator("main, [role=dialog], body")
      .first()
      .innerText()
      .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 700))
      .catch(() => "")
    const state = {
      objetivo,
      pagina: { direccion: aqui, titulo: await page.title(), encabezados: titulos, comienzo_del_texto: texto },
      ya_visitadas: [...new Set(camino.map((c) => c.direccion))],
    }
    const questions = {
      llego: {
        type: "noul",
        instructions: "¿La página actual ya es donde se cumple el objetivo de la persona (lo que busca está aquí, a la vista)?",
      },
      siguiente: {
        type: "choice",
        instructions:
          "¿Qué hace la persona ahora para cumplir su objetivo? Si esta página ya es la que busca, elige «aquí». Si no, el elemento que, al pulsarlo, más la acerca. Evita volver a una página ya visitada.",
        criteria: {
          aqui: "aquí: esta página ya es la del objetivo",
          ...Object.fromEntries(opciones.map((o) => [String(o.i), o.texto])),
        },
      },
    }
    const res = await preguntarAJev(state, questions)
    tokens += res.usage?.input_tokens ?? 0
    const pLlego = res.answers?.llego?.noul ?? 0
    const sig = res.answers?.siguiente
    if (pLlego >= 0.7 || (sig?.choice === "aqui" && (sig.confidence ?? 0) >= 0.5)) {
      llego = true
      camino.push({ paso, direccion: aqui, hecho: `llegó (${pLlego.toFixed(2)}${sig?.choice === "aqui" ? `, «aquí» ${(sig.confidence ?? 0).toFixed(2)}` : ""})` })
      break
    }
    if (!sig || sig.choice === "aqui") {
      camino.push({ paso, direccion: aqui, hecho: "Jev no ve adónde ir: lo decide la voz" })
      break
    }
    const elegido = opciones.find((o) => String(o.i) === sig.choice)
    pulsados.add(`${aqui}|${elegido?.texto}`)
    const seguridad = sig.confidence ?? Math.max(...Object.values(sig.probabilities ?? { x: 0 }))
    camino.push({ paso, direccion: page.url(), hecho: `pulsa ${elegido?.texto ?? sig.choice} (${seguridad.toFixed(2)})` })
    if (seguridad < 0.4) {
      camino.push({ paso, direccion: page.url(), hecho: "Jev duda: lo decide la voz" })
      break
    }
    try {
      await page.locator(`[data-qa-ir="${sig.choice}"]`).first().click({ timeout: 5000 })
    } catch (e) {
      camino.push({ paso, direccion: page.url(), hecho: `no se pudo pulsar: ${String(e).split("\n")[0].slice(0, 120)}` })
      break
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {})
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {})
  }
  for (const c of camino) console.log(`${c.paso}. ${c.hecho} — ${c.direccion}`)
  console.log(`${llego ? "llegó" : "no llegó"} en ${camino.length} pasos, ${((Date.now() - inicio) / 1000).toFixed(1)} s, ${tokens} tokens de Jev`)
  console.log(`página: ${page.url()} · «${await page.title()}»`)
  process.exit(llego ? 0 : 1)
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
