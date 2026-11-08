#!/usr/bin/env node
// Decide qué corre el CI de este cambio (job `alcance` de .github/workflows/ci.yml).
// Escribe las salidas en $GITHUB_OUTPUT; sin esa variable, las imprime (prueba local).
//
// Variables: BASE (commit contra el que se compara; vacío o sin conocer = todo) y
// SHA (commit probado, por defecto HEAD). Requiere `turbo` en el PATH o `pnpm exec turbo`.
//
// Reglas, de lo más seguro a lo más preciso:
// - Solo documentación o skills (lista blanca abajo): no corre nada.
// - Un archivo fuera de apps/, packages/ y e2e/ (CI, Dockerfile, compose, infra, raíz,
//   turbo.json, lockfile): corre todo. No se sabe qué toca.
// - Si no hay base comparable: corre todo.
// - Lo demás: solo los paquetes afectados según el grafo de turbo (el paquete cambiado
//   y todo lo que depende de él).
// Las pruebas que leen el repositorio entero no van aquí: van en el job `arquitectura`.
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"

const BASE = process.env.BASE ?? ""
const SHA = process.env.SHA || "HEAD"

// Solo documentación y skills: no se compilan, no se prueban ni se despliegan.
const SOLO_DOCS =
  /^(docs\/|\.agents\/|\.claude\/skills\/|AGENTS\.md$|README\.md$|(apps|packages)\/[^/]+\/AGENTS\.md$)/
// Donde turbo sabe qué paquete cambió.
const EN_PAQUETES = /^(apps|packages|e2e)\//

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
  "@odentia/dental-clinic",
  "@odentia/medical-clinic",
  "@odentia/optical-clinic",
  "@odentia/clinic-app",
  "@odentia/ui",
  "@odentia/ui-patterns",
  "@odentia/brand-scene",
]
// Apps que se publican en Cloudflare Workers (deploy-web).
const CLOUDFLARE = [
  "@odentia/web",
  "@odentia/panel",
  "@odentia/admin",
  "@odentia/dental-clinic",
  "@odentia/medical-clinic",
  "@odentia/optical-clinic",
]
// Apps del VPS: la imagen de producción sirve api y worker.
const VPS = ["@odentia/api", "@odentia/worker"]

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
  return git(["diff", "--name-only", BASE, SHA]).split("\n").filter(Boolean)
}

function decidir() {
  const todos = turbo(["ls"])
  if (!baseComparable()) {
    return { motivo: "sin base comparable: se prueba todo", soloDocs: false, afectados: todos }
  }
  const archivos = archivosCambiados()
  const codigo = archivos.filter((f) => !SOLO_DOCS.test(f))
  if (codigo.length === 0) {
    return { motivo: "solo documentación o skills", soloDocs: true, afectados: [] }
  }
  if (codigo.some((f) => !EN_PAQUETES.test(f))) {
    const fuera = codigo.find((f) => !EN_PAQUETES.test(f))
    return {
      motivo: `cambia ${fuera} fuera de los paquetes: se prueba todo`,
      soloDocs: false,
      afectados: todos,
    }
  }
  const afectados = turbo(["ls", `--filter=...[${BASE}]`])
  return { motivo: `${afectados.length} paquete(s) afectado(s)`, soloDocs: false, afectados }
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

const decision = decidir()
const { afectados } = decision
const partes = partesDeCheck(afectados)
const salidas = {
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
  // E2E prueba la app completa; el marketing (web) no la usa.
  e2e: String(afectados.some((n) => n !== "@odentia/web")),
  vps: String(afectados.some((n) => VPS.includes(n))),
  cloudflare: JSON.stringify(afectados.filter((n) => CLOUDFLARE.includes(n))),
  // Las pruebas que leen el repositorio entero corren en cada cambio de código.
  arquitectura: String(!decision.soloDocs),
}

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
