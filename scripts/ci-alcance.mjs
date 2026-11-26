#!/usr/bin/env node
// Decide qué corre el CI de este cambio (job `alcance` de .github/workflows/ci.yml).
// Escribe las salidas en $GITHUB_OUTPUT; sin esa variable, las imprime (prueba local).
//
// Variables: BASE (commit contra el que se compara; vacío o sin conocer = todo) y
// SHA (commit probado, por defecto HEAD). Requiere `turbo` en el PATH o `pnpm exec turbo`.
//
// Reglas, de lo más seguro a lo más preciso:
// - Nada que probar (lista blanca abajo): documentación, skills y lo demás de Claude, lo del
//   editor, lo que solo usa el desarrollo local y este mismo script. No corre nada.
// - Este script se prueba a sí mismo cada vez que corre (`comprobarReglas`, abajo): si una
//   regla deja de dar lo esperado en sus ejemplos, falla el job `alcance` y con él todo el CI.
//   Por eso un cambio solo suyo no corre las apps: lo que lo prueba es esa comprobación.
// - Un archivo fuera de apps/, packages/, e2e/, admin/ y shared/ (CI, Dockerfile, compose,
//   infra, raíz, turbo.json, lockfile): corre todo. No se sabe qué toca.
// - Si no hay base comparable: corre todo.
// - Lo demás: solo los paquetes afectados según el grafo de turbo (el paquete cambiado
//   y todo lo que depende de él).
// - Los recorridos E2E: si todo lo que cambió está en la carpeta de la administración
//   (admin/), solo los suyos y los de las clínicas que abren sus pantallas (proyecto `admin`
//   de Playwright, `ALSO_ADMIN` en e2e/playwright.config.ts), en una parte; si no, todos,
//   en tres. El cobro y el soporte viven todavía en packages/ y apps/api, así que siguen
//   corriendo todo (lienzo A, paso 0).
// - gestorIA (gestoria/, ADR 0203) es otro sistema: sus paquetes no los usa nadie más, así que un
//   cambio solo suyo prueba lo suyo y no corre los recorridos E2E ni despliega las clínicas. Un
//   archivo suelto de gestoria/ (su Dockerfile, su compose, su infra) cuenta como cambio de su
//   servidor, no de todo.
// Las pruebas que leen el repositorio entero no van aquí: van en el job `arquitectura`.
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

const SHA = process.env.SHA || "HEAD"
const BASE = baseDelCambio()

// En un PR, GitHub prueba la unión del PR con la punta de main de ahora (SHA), pero
// `pull_request.base.sha` puede ser una punta anterior: todo lo que main sumó después
// contaba como cambio del PR (otro PR tocaba el lockfile y este corría todo). La base
// justa es el primer padre de esa unión: el main contra el que se unió de verdad.
function baseDelCambio() {
  const base = process.env.BASE ?? ""
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return base
  try {
    const padres = git(["rev-list", "--parents", "-n", "1", SHA]).trim().split(" ")
    if (padres.length === 3) {
      if (padres[1] !== base)
        console.log(`Base: ${padres[1]} (el main de la unión; el evento decía ${base})`)
      return padres[1]
    }
  } catch {}
  return base
}

// Nada que probar: no se compilan, no se prueban ni se despliegan. Documentación; skills, subagentes
// y configuración de Claude; lo del editor; `skills-lock.json` (lo lee solo Claude); `.gitignore`;
// el compose de desarrollo (el CI y E2E no lo usan; la base de pruebas sí, y por eso
// infra/dev/postgres no está aquí); y este script, que se prueba solo.
const SOLO_DOCS =
  /^(docs\/|\.agents\/|\.claude\/|\.vscode\/|AGENTS\.md$|README\.md$|skills-lock\.json$|\.gitignore$|infra\/dev\/compose\.yaml$|scripts\/ci-alcance\.mjs$|gestoria\/AGENTS\.md$|(apps|packages|admin\/apps|shared\/packages|gestoria\/apps|gestoria\/packages)\/[^/]+\/AGENTS\.md$)/
// Donde turbo sabe qué paquete cambió.
// En admin/ y shared/, solo dentro de un paquete: lo suelto en esas carpetas corre todo.
const EN_PAQUETES =
  /^((apps|packages|e2e)\/|admin\/(apps\/[^/]+|e2e)\/|shared\/packages\/[^/]+\/|gestoria\/(apps|packages)\/[^/]+\/)/
// Lo suelto de gestorIA (Dockerfile, compose, infra): es de su servidor.
const GESTORIA_SUELTO = /^gestoria\//
const ES_GESTORIA = (nombre) => nombre.startsWith("@gestoria/")
// La administración: si todo lo cambiado está aquí, solo sus recorridos E2E.
const SOLO_ADMIN = /^admin\/(apps\/[^/]+|e2e)\//

const SERVICIOS_EN_PARTES = 3
const INTERFAZ = [
  "@odentia/ui-patterns",
  "@odentia/dental-clinic",
  "@odentia/medical-clinic",
  "@odentia/optical-clinic",
  "@odentia/clinic-app",
]
const API = ["@odentia/api"]
const SERVICIOS = ["@odentia/services"]
// Lo que la parte `general` no toma: lo tienen otras partes o E2E.
const FUERA_DE_GENERAL = ["@odentia/e2e", ...INTERFAZ, ...API, ...SERVICIOS]
// Superficies de pantalla sin base de datos en sus pruebas: no necesitan PostgreSQL.
const SIN_BASE_DE_DATOS = [
  "@odentia/web",
  "@odentia/panel",
  "@odentia/admin",
  "@odentia/admin-e2e",
  "@odentia/dental-clinic",
  "@odentia/medical-clinic",
  "@odentia/optical-clinic",
  "@odentia/clinic-app",
  "@odentia/ui",
  "@odentia/ui-patterns",
  "@odentia/brand-scene",
  "@gestoria/web",
  "@gestoria/sitio",
]
// Apps que se publican en Cloudflare Workers (deploy-web).
const CLOUDFLARE = [
  "@odentia/web",
  "@odentia/panel",
  "@odentia/admin",
  "@odentia/dental-clinic",
  "@odentia/medical-clinic",
  "@odentia/optical-clinic",
  "@gestoria/web",
  "@gestoria/sitio",
]
// Apps del VPS: la imagen de producción sirve api y worker.
const VPS = ["@odentia/api", "@odentia/worker"]
// El servidor de gestorIA: su propia imagen y su propio proyecto en OpenShip.
const VPS_GESTORIA = ["@gestoria/api", "@gestoria/db"]

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
}

function baseComparable() {
  if (!BASE || /^0+$/.test(BASE)) return false
  try {
    git(["cat-file", "-e", `${BASE}^{commit}`])
    return true
  } catch {
    return false
  }
}

function turbo(args) {
  // En Windows `turbo` es un shim .cmd que solo se lanza a través de cmd.exe.
  const orden = [...args, "--output=json"]
  const salida =
    process.platform === "win32"
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", "turbo", ...orden], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      : execFileSync(process.env.TURBO ?? "turbo", orden, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
  return JSON.parse(salida).packages.items.map((p) => p.name)
}

function archivosCambiados() {
  // Sin detectar renombres: un archivo que se muda a admin/ cuenta también por donde estaba.
  return git(["diff", "--name-only", "--no-renames", BASE, SHA]).split("\n").filter(Boolean)
}

// Qué clase de cambio es, solo por sus archivos (sin git ni turbo), para poder comprobarlo.
function clasificar(archivos) {
  const codigo = archivos.filter((f) => !SOLO_DOCS.test(f))
  if (codigo.length === 0) return { tipo: "nada" }
  const fuera = codigo.find((f) => !EN_PAQUETES.test(f) && !GESTORIA_SUELTO.test(f))
  if (fuera) return { tipo: "todo", fuera }
  return {
    tipo: "paquetes",
    gestoriaSuelto: codigo.some((f) => GESTORIA_SUELTO.test(f) && !EN_PAQUETES.test(f)),
    soloAdmin: codigo.every((f) => SOLO_ADMIN.test(f)),
  }
}

function decidir() {
  const todos = turbo(["ls"])
  if (!baseComparable()) {
    return { motivo: "sin base comparable: se prueba todo", soloDocs: false, afectados: todos }
  }
  const clase = clasificar(archivosCambiados())
  if (clase.tipo === "nada") {
    return {
      motivo: "nada que probar (documentación, skills o configuración local)",
      soloDocs: true,
      afectados: [],
    }
  }
  if (clase.tipo === "todo") {
    return {
      motivo: `cambia ${clase.fuera} fuera de los paquetes: se prueba todo`,
      soloDocs: false,
      afectados: todos,
    }
  }
  const afectados = turbo(["ls", `--filter=...[${BASE}]`])
  if (clase.gestoriaSuelto)
    for (const nombre of VPS_GESTORIA) if (!afectados.includes(nombre)) afectados.push(nombre)
  const motivo = `${afectados.length} paquete(s) afectado(s)${clase.soloAdmin ? ", solo de la administración" : ""}`
  return { motivo, soloDocs: false, afectados, soloAdmin: clase.soloAdmin }
}

function filtros(nombres) {
  return nombres.map((n) => `--filter=${n}`).join(" ")
}

// Las partes de `check` que corren, cada una con lo que le toca de los afectados.
function partesDeCheck(afectados) {
  const en = (lista) => lista.filter((n) => afectados.includes(n))
  const partes = []
  const general = en(afectados.filter((n) => !FUERA_DE_GENERAL.includes(n)))
  // La parte general hace los tipos de todo lo afectado: un cambio puede romper otro paquete.
  if (afectados.length > 0) {
    partes.push({
      parte: "general",
      tipos: filtros(afectados),
      pruebas: filtros(general),
      // Solo las superficies sin lógica de base de datos se salvan de PostgreSQL.
      postgres: afectados.some((n) => !SIN_BASE_DE_DATOS.includes(n)),
      opciones: "",
    })
  }
  if (en(INTERFAZ).length > 0) {
    partes.push({
      parte: "interfaz",
      tipos: "",
      pruebas: filtros(en(INTERFAZ)),
      postgres: false,
      opciones: "--only",
    })
  }
  if (en(API).length > 0) {
    partes.push({
      parte: "api",
      tipos: "",
      pruebas: filtros(en(API)),
      postgres: true,
      opciones: "--only",
    })
  }
  if (en(SERVICIOS).length > 0) {
    for (let k = 1; k <= SERVICIOS_EN_PARTES; k++) {
      partes.push({
        parte: `services-${k}`,
        tipos: "",
        pruebas: filtros(SERVICIOS),
        postgres: true,
        opciones: `--only -- --shard=${k}/${SERVICIOS_EN_PARTES}`,
      })
    }
  }
  return partes
}

/** Las partes del job E2E (su matriz): solo la administración en una, o todo en tres. */
function partesDeE2e(soloAdmin) {
  if (soloAdmin) return [{ parte: "administración", nombre: "admin", opciones: "--project=admin" }]
  return [1, 2, 3].map((k) => ({ parte: `${k}/3`, nombre: String(k), opciones: `--shard=${k}/3` }))
}

// Lo que leen los demás jobs, según lo decidido.
function salidasDe(decision) {
  const { afectados } = decision
  const partes = partesDeCheck(afectados)
  return {
    solo_docs: String(decision.soloDocs),
    afectados: JSON.stringify(afectados),
    hay_check: String(partes.length > 0),
    // GitHub no acepta una matriz vacía: sin partes, una entrada neutra que los pasos ignoran.
    check: JSON.stringify({
      include:
        partes.length > 0
          ? partes
          : [{ parte: "ninguna", tipos: "", pruebas: "", postgres: false, opciones: "" }],
    }),
    // E2E prueba la app completa de las clínicas; el marketing (web) y gestorIA no la usan.
    e2e: String(afectados.some((n) => n !== "@odentia/web" && !ES_GESTORIA(n))),
    // Las partes de E2E: los de la administración solos, o todos en tres partes.
    e2e_partes: JSON.stringify(partesDeE2e(decision.soloAdmin === true)),
    vps: String(afectados.some((n) => VPS.includes(n))),
    gestoria_vps: String(afectados.some((n) => VPS_GESTORIA.includes(n))),
    cloudflare: JSON.stringify(afectados.filter((n) => CLOUDFLARE.includes(n))),
    // Las pruebas que leen el repositorio entero corren en cada cambio de código.
    arquitectura: String(!decision.soloDocs),
  }
}

// Los ejemplos que deben seguir dando lo mismo. Si una regla cambia a propósito, se cambia su ejemplo.
function comprobarReglas() {
  const fallos = []
  const espera = (nombre, obtenido, esperado) => {
    if (JSON.stringify(obtenido) !== JSON.stringify(esperado))
      fallos.push(
        `${nombre}: da ${JSON.stringify(obtenido)}, se esperaba ${JSON.stringify(esperado)}`,
      )
  }
  const tipo = (archivos) => clasificar(archivos).tipo
  espera(
    "skills, subagentes y docs",
    tipo([".claude/skills/odentia-qa/SKILL.md", ".claude/agents/voz-ux.md", "docs/development.md"]),
    "nada",
  )
  espera("este script con docs", tipo(["scripts/ci-alcance.mjs", "gestoria/AGENTS.md"]), "nada")
  espera(
    "configuración local",
    tipo([
      "apps/api/AGENTS.md",
      "skills-lock.json",
      ".gitignore",
      ".vscode/settings.json",
      "infra/dev/compose.yaml",
    ]),
    "nada",
  )
  espera("una app", tipo(["apps/panel/src/main.tsx"]), "paquetes")
  espera(
    "este script con una app",
    tipo(["scripts/ci-alcance.mjs", "apps/api/src/index.ts"]),
    "paquetes",
  )
  espera("lo suelto de gestorIA", clasificar(["gestoria/Dockerfile"]), {
    tipo: "paquetes",
    gestoriaSuelto: true,
    soloAdmin: false,
  })
  espera(
    "solo la administración",
    clasificar(["admin/apps/web/src/x.ts", "admin/e2e/x.spec.ts"]).soloAdmin,
    true,
  )
  espera(
    "administración y API",
    clasificar(["admin/apps/web/src/x.ts", "apps/api/src/x.ts"]).soloAdmin,
    false,
  )
  for (const f of [
    "Dockerfile",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "package.json",
    "turbo.json",
    "biome.json",
    "patches/portless@0.15.6.patch",
    "scripts/local-network.mjs",
    "scripts/static-files.mjs",
    "infra/dev/postgres/Dockerfile",
    "infra/dev/storage-init.sh",
    "compose.prod.yaml",
    "portless.json",
    "assets/brand/logo.svg",
  ])
    espera(f, tipo([f, "docs/x.md"]), "todo")
  const salidas = (afectados) => salidasDe({ soloDocs: false, afectados })
  espera("la web no corre E2E", salidas(["@odentia/web"]).e2e, "false")
  espera("el panel corre E2E", salidas(["@odentia/panel"]).e2e, "true")
  espera("gestorIA no corre E2E", salidas(["@gestoria/api"]).e2e, "false")
  espera("la API va al VPS", salidas(["@odentia/api"]).vps, "true")
  espera(
    "el panel va a Cloudflare",
    salidas(["@odentia/panel"]).cloudflare,
    JSON.stringify(["@odentia/panel"]),
  )
  espera("nada que probar", salidasDe({ soloDocs: true, afectados: [] }), {
    solo_docs: "true",
    afectados: "[]",
    hay_check: "false",
    check: JSON.stringify({
      include: [{ parte: "ninguna", tipos: "", pruebas: "", postgres: false, opciones: "" }],
    }),
    e2e: "false",
    e2e_partes: JSON.stringify(partesDeE2e(false)),
    vps: "false",
    gestoria_vps: "false",
    cloudflare: "[]",
    arquitectura: "false",
  })
  if (fallos.length > 0) {
    console.error(`Las reglas del alcance no dan lo esperado:\n- ${fallos.join("\n- ")}`)
    process.exit(1)
  }
}

comprobarReglas()
const decision = decidir()
const salidas = salidasDe(decision)

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(salidas)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
  )
}
console.log(`Alcance: ${decision.motivo}`)
console.log(JSON.stringify(salidas, null, 2))
