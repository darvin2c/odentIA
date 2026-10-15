/**
 * Metadata sin secretos de la corrida E2E (`e2e/test-results/<runId>/runtime.json`).
 *
 * La escriben tanto el supervisor (`run.ts`: puertos, directorios, procesos)
 * como la infraestructura (`stack.ts`: contenedores y volúmenes) mediante
 * lectura-modificación-escritura atómica (tmp+rename). Todo ocurre en un único
 * proceso y en fases secuenciales (init → arranque → cierre), así que no hay
 * escrituras concurrentes entre procesos.
 *
 * Nunca registrar aquí secretos (env, passwords, tokens, cookies, claves CA):
 * es un artefacto de diagnóstico para verificar aislamiento y cierre.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface RuntimeContainerMeta {
  id: string
  volumes: string[]
}

export interface RuntimeProcessMeta {
  name: string
  pid: number
}

export interface RuntimeMeta {
  runId: string
  stateDir: string
  outDirs: { panel: string; platform: string; admin: string }
  ports: { proxy: number; api: number; panel: number; platform: number; admin: number }
  containers: RuntimeContainerMeta[]
  processes: RuntimeProcessMeta[]
}

export interface RuntimeMetaPatch {
  stateDir?: string
  outDirs?: Partial<RuntimeMeta["outDirs"]>
  ports?: Partial<RuntimeMeta["ports"]>
  containers?: RuntimeContainerMeta[]
  processes?: RuntimeProcessMeta[]
}

/** Ruta del metadata de la corrida (fuente única; no duplicar el path). */
export function runtimeMetaPath(runId: string): string {
  return join(import.meta.dirname, "test-results", runId, "runtime.json")
}

function emptyMeta(runId: string): RuntimeMeta {
  return {
    runId,
    stateDir: "",
    outDirs: { panel: "", platform: "", admin: "" },
    ports: { proxy: 0, api: 0, panel: 0, platform: 0, admin: 0 },
    containers: [],
    processes: [],
  }
}

function readMeta(path: string): RuntimeMeta {
  let raw: Partial<RuntimeMeta> = {}
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeMeta>
  } catch {
    raw = {}
  }
  const base = emptyMeta(typeof raw.runId === "string" ? raw.runId : "")
  return {
    ...base,
    ...raw,
    outDirs: { ...base.outDirs, ...raw.outDirs },
    ports: { ...base.ports, ...raw.ports },
    containers: Array.isArray(raw.containers) ? raw.containers : [],
    processes: Array.isArray(raw.processes) ? raw.processes : [],
  }
}

function writeAtomic(path: string, meta: RuntimeMeta): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8")
  renameSync(tmp, path)
}

/** Crea el metadata al inicio de la corrida (puertos y directorios ya conocidos). */
export function initRuntimeMeta(
  path: string,
  initial: Pick<RuntimeMeta, "runId" | "stateDir" | "ports" | "outDirs">,
): void {
  writeAtomic(path, { ...emptyMeta(initial.runId), ...initial })
}

/**
 * Fusiona un parche en el metadata existente: escalares y `ports`/`outDirs`
 * se sobrescriben, `containers` hace upsert por `id` y `processes` añade por
 * `pid` sin duplicar. Nunca borra entradas de la otra parte.
 */
export function updateRuntimeMeta(path: string, patch: RuntimeMetaPatch): void {
  const current = readMeta(path)
  if (patch.stateDir !== undefined) current.stateDir = patch.stateDir
  if (patch.ports) current.ports = { ...current.ports, ...patch.ports }
  if (patch.outDirs) current.outDirs = { ...current.outDirs, ...patch.outDirs }
  if (patch.containers) {
    for (const container of patch.containers) {
      const index = current.containers.findIndex((entry) => entry.id === container.id)
      if (index >= 0) current.containers[index] = { ...current.containers[index], ...container }
      else current.containers.push({ ...container })
    }
  }
  if (patch.processes) {
    for (const proc of patch.processes) {
      if (!current.processes.some((entry) => entry.pid === proc.pid)) {
        current.processes.push({ ...proc })
      }
    }
  }
  writeAtomic(path, current)
}
