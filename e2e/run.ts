/**
 * Supervisor del entorno E2E efímero (`pnpm e2e` → `node --import tsx run.ts`).
 *
 * Cada ejecución crea un entorno propio identificado por `runId`: puertos
 * libres de loopback, infraestructura en Testcontainers (`startStack`), proxy
 * Portless dedicado con su CA, builds y procesos propios. Al terminar —o ante
 * SIGINT/SIGTERM— cierra todo lo suyo (Playwright, apps, worker, proxy de su
 * state dir, clientes y contenedores) y conserva solo
 * `e2e/test-results/<runId>/` (logs, `runtime.json` e informes Playwright).
 *
 * Nunca usa ni toca el entorno dev: sin puertos fijos, sin `--force`, sin
 * matar listeners ajenos y sin degradar a HTTP. Los diagnósticos están en
 * español y nunca incluyen secretos.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lookup as dnsLookup } from "node:dns"
import type { LookupAddress, LookupOptions } from "node:dns"
import { createWriteStream, existsSync, readFileSync, type WriteStream } from "node:fs"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { and, eq } from "drizzle-orm"
import { Agent, request as httpRequest } from "undici"
import { sendDemoTask } from "@odentia/db"
import { auditEvent, member, organization, user } from "@odentia/db/schema/index"
import { openFixtureDb } from "./fixture-db"
import {
  E2E_SCRUB_ENV_KEYS,
  PORTLESS_CLI,
  ROOT,
  stackEnv,
  type HarnessRuntime,
} from "./harness-env"
import { initRuntimeMeta, runtimeMetaPath, updateRuntimeMeta } from "./runtime-meta"
import { dbSetupCommand, DB_SETUP_SCRIPTS, startStack, type DbSetupScript, type HarnessStack } from "./stack"

const E2E_DIR = import.meta.dirname
const require = createRequire(import.meta.url)

const BUILD_TIMEOUT_MS = 300_000
const DB_SCRIPT_TIMEOUT_MS = 300_000
const APPS_READY_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 5_000
const WORKER_READY_TIMEOUT_MS = 15_000
const STOP_GRACE_MS = 5_000
const PROXY_PID_RETRIES = 20

const SCRUB_KEYS: Record<string, true> = Object.fromEntries(
  E2E_SCRUB_ENV_KEYS.map((key) => [key, true] as const),
)

interface OwnedProcess {
  name: string
  proc: ChildProcess
  logPath: string
  /** Solo api/worker/previews abortan la suite al terminar antes del cierre. */
  watch: boolean
  stopPromise?: Promise<void>
}

interface WindowsTerminalMonitor {
  proc: ChildProcess
  stopPath: string
  reportPath: string
}

interface RunState {
  runId: string
  stateDir: string
  portlessDir: string
  tld: string
  baseDomain: string
  proxyPort: number
  metaPath: string
  logsDir: string
  log: SupervisorLog
  owned: OwnedProcess[]
  fileStreams: WriteStream[]
  shuttingDown: boolean
  failed: Error | null
  playwright: OwnedProcess | null
  stack: HarnessStack | null
  dispatcher: Agent | null
  fixtureClose: (() => Promise<void>) | null
  proxyStarted: boolean
  proxyPid: number | null
  outDirs: { panel: string; platform: string; admin: string }
  timings: Array<{ label: string; ms: number }>
  closePromise: Promise<string[]> | null
}

/** Consola + `supervisor.log` (nunca recibe secretos). */
class SupervisorLog {
  private stream: WriteStream | null = null
  private t0 = performance.now()

  open(path: string): void {
    this.stream = createWriteStream(path, { flags: "a" })
  }

  log(message: string): void {
    const line = `[+${((performance.now() - this.t0) / 1000).toFixed(1)}s] ${message}`
    console.log(line)
    this.stream?.write(`${line}\n`)
  }

  close(): Promise<void> {
    const stream = this.stream
    this.stream = null
    if (!stream) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    stream.end(() => resolve())
    return promise
  }
}

let activeState: RunState | null = null

process.on("SIGINT", () => onSignal("SIGINT"))
process.on("SIGTERM", () => onSignal("SIGTERM"))

/** Las señales matan los hijos vivos; el `finally` de `main` hace el cierre completo. */
function onSignal(signal: "SIGINT" | "SIGTERM"): void {
  const state = activeState
  if (!state || state.shuttingDown) return
  state.shuttingDown = true
  state.log.log(`Señal ${signal} recibida: deteniendo el entorno ${state.runId}…`)
  for (const owned of state.owned) {
    if (isLive(owned)) void stopOwned(owned).catch(error => { state.failed ??= error })
  }
}

function isLive(owned: OwnedProcess): boolean {
  return (
    owned.proc.exitCode === null && owned.proc.signalCode === null && owned.proc.pid !== undefined
  )
}

function waitForExit(proc: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    code: number | null
    signal: string | null
  }>()
  if (proc.exitCode !== null || proc.signalCode !== null) {
    resolve({ code: proc.exitCode, signal: proc.signalCode })
  } else {
    proc.once("exit", (code, signal) => resolve({ code, signal }))
    proc.once("error", reject)
  }
  return promise
}

async function waitForExitTimeout(
  proc: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: string | null } | "timeout"> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      waitForExit(proc),
      new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Ruta estable del host PowerShell clásico necesario para ocultar consolas. */
function windowsPowerShellPath(): string {
  return join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
}

/** Vigila todo el run y registra cualquier ventana nueva de Windows Terminal. */
async function startWindowsTerminalMonitor(logsDir: string): Promise<WindowsTerminalMonitor | null> {
  if (process.platform !== "win32") return null
  const stopPath = join(logsDir, "windows-terminal-monitor.stop")
  const reportPath = join(logsDir, "windows-terminal-windows.json")
  const readyPath = join(logsDir, "windows-terminal-monitor.ready")
  const proc = spawn(
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(E2E_DIR, "windows-terminal-monitor.ps1"),
      stopPath,
      reportPath,
      readyPath,
    ],
    { stdio: "ignore", windowsHide: true },
  )
  for (let attempt = 0; attempt < 40; attempt++) {
    if (existsSync(readyPath)) return { proc, stopPath, reportPath }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error("El monitor de ventanas de Windows terminó antes de iniciar")
    }
    await sleep(50)
  }
  proc.kill()
  throw new Error("El monitor de ventanas de Windows no quedó listo en 2 s")
}

async function stopWindowsTerminalMonitor(monitor: WindowsTerminalMonitor | null): Promise<number[]> {
  if (!monitor) return []
  await writeFile(monitor.stopPath, "stop", "utf8")
  const result = await waitForExitTimeout(monitor.proc, STOP_GRACE_MS)
  if (result === "timeout") {
    monitor.proc.kill()
    throw new Error("El monitor de ventanas de Windows no terminó a tiempo")
  }
  if (result.code !== 0) throw new Error(`El monitor de ventanas de Windows terminó con código ${result.code}`)
  const raw: unknown = JSON.parse(readFileSync(monitor.reportPath, "utf8") || "[]")
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "number")) {
    throw new Error("El monitor de ventanas de Windows produjo un reporte inválido")
  }
  return raw
}

/** Últimas líneas del log de un hijo (marcador si aún no escribió nada). */
function tailLog(logPath: string, lines = 60): string {
  try {
    const content = readFileSync(logPath, "utf8").replace(/\s+$/, "")
    if (!content) return "(sin salida)"
    return content.split("\n").slice(-lines).join("\n")
  } catch {
    return "(sin salida)"
  }
}

/** Literal PowerShell seguro para rutas y argumentos generados por el supervisor. */
function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Registra un hijo desde su spawn (también builds o CLIs que luego fallen) y
 * vuelca su salida a `e2e/test-results/<runId>/logs/<name>.log`.
 */
function spawnOwned(
  state: RunState,
  name: string,
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; watch: boolean; tee: boolean; cleanup?: boolean },
): OwnedProcess {
  if (state.shuttingDown && !opts.cleanup) throw new Error("Cierre solicitado antes de iniciar otro proceso.")
  const logPath = join(state.logsDir, `${name}.log`)
  let proc: ChildProcess
  const isWindows = process.platform === "win32"
  try {
    let spawnCmd = cmd
    let spawnArgs = [...args]
    if (isWindows) {
      // Una consola propia oculta —sin `-NoNewWindow`— se hereda por todos
      // los nietos. Es la única combinación que evita la delegación de cada
      // CLI a Windows Terminal y conserva un árbol cerrable.
      const encoded = Buffer.from(
        JSON.stringify({ cmd, args, cwd: opts.cwd, logPath }),
        "utf8",
      ).toString("base64")
      const runner = join(E2E_DIR, "windows-child-runner.cjs")
      const ps = [
        '$ErrorActionPreference = "Stop"; try {',
        `$p = Start-Process -FilePath ${powershellLiteral(process.execPath)}`,
        `-ArgumentList @(${powershellLiteral(`"${runner}"`)}, ${powershellLiteral(encoded)})`,
        `-WorkingDirectory ${powershellLiteral(opts.cwd)}`,
        "-WindowStyle Hidden -PassThru",
        "; $p.WaitForExit(); exit $p.ExitCode",
        `} catch { [IO.File]::AppendAllText(${powershellLiteral(logPath)}, $_.Exception.Message + [Environment]::NewLine); exit 1 }`,
      ].join(" ")
      spawnCmd = windowsPowerShellPath()
      spawnArgs = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(ps, "utf16le").toString("base64"),
      ]
    }
    proc = spawn(spawnCmd, spawnArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: isWindows ? "ignore" : ["ignore", "pipe", "pipe"],
      detached: !isWindows,
      windowsHide: true,
    })
  } catch (err) {
    throw new Error(
      `No se pudo arrancar ${name}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const file = isWindows ? null : createWriteStream(logPath, { flags: "a" })
  if (file) {
    state.fileStreams.push(file)
    proc.stdout?.pipe(file, { end: false })
    proc.stderr?.pipe(file, { end: false })
    if (opts.tee) {
      proc.stdout?.pipe(process.stdout)
      proc.stderr?.pipe(process.stderr)
    }
  }
  const owned: OwnedProcess = { name, proc, logPath, watch: opts.watch }
  state.owned.push(owned)
  if (proc.pid !== undefined) {
    updateRuntimeMeta(state.metaPath, { processes: [{ name, pid: proc.pid }] })
  }
  proc.on("error", error => { state.failed ??= new Error(`No se pudo iniciar ${name}`, { cause: error }) })
  proc.on("close", () => file?.end())
  proc.on("exit", (code, signal) => {
    if (owned.watch && !state.shuttingDown) {
      noteUnexpectedExit(state, owned, code, signal)
    }
  })
  return owned
}

/**
 * Una salida inesperada de api/worker/preview aborta la suite con su log en
 * lugar de dejar que los tests esperen hasta sus timeouts.
 */
function noteUnexpectedExit(
  state: RunState,
  owned: OwnedProcess,
  code: number | null,
  signal: string | null,
): void {
  if (state.shuttingDown || state.failed) return
  state.failed = new Error(
    `${owned.name} terminó inesperadamente (código ${code ?? "nulo"}${signal ? `, señal ${signal}` : ""}); la suite no puede continuar.\nÚltimas líneas de ${owned.logPath}:\n${tailLog(owned.logPath)}`,
  )
  state.log.log(`E2E falló: ${state.failed.message}`)
  if (state.playwright && isLive(state.playwright)) void stopOwned(state.playwright)
}

/** Cierra el árbol del hijo: grupo propio + SIGTERM/gracia/SIGKILL en POSIX, taskkill en Windows. */
function stopOwned(owned: OwnedProcess): Promise<void> {
  owned.stopPromise ??= stopTree(owned)
  return owned.stopPromise
}

async function stopTree(owned: OwnedProcess): Promise<void> {
  const pid = owned.proc.pid
  if (!isLive(owned) || pid === undefined) return
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    const result = await waitForExit(killer)
    if (result.code !== 0 && isLive(owned)) throw new Error(`No se pudo cerrar ${owned.name} (PID ${pid})`)
    if (await waitForExitTimeout(owned.proc, STOP_GRACE_MS) === "timeout") {
      throw new Error(`${owned.name} sigue vivo (PID ${pid})`)
    }
    return
  }
  try { process.kill(-pid, "SIGTERM") } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
  }
  if (await waitForExitTimeout(owned.proc, STOP_GRACE_MS) === "timeout") {
    try { process.kill(-pid, "SIGKILL") } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
    if (await waitForExitTimeout(owned.proc, STOP_GRACE_MS) === "timeout") {
      throw new Error(`${owned.name} sigue vivo (PID ${pid})`)
    }
  }
}

interface PortLease {
  port: number
  release: () => Promise<void>
}

/** Reserva un puerto libre de loopback reteniéndolo hasta liberarlo justo antes de usarlo. */
async function reservePort(): Promise<PortLease> {
  const server = createServer()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject)
    resolve()
  })
  await promise
  const address = server.address()
  if (typeof address !== "object" || address === null || !Number.isInteger(address.port)) {
    server.close()
    throw new Error("No se pudo reservar un puerto libre de loopback.")
  }
  return {
    port: address.port,
    release: () => {
      const { promise: released, resolve: markReleased } = Promise.withResolvers<void>()
      server.close(() => markReleased())
      return released
    },
  }
}

async function reservePorts(count: number): Promise<PortLease[]> {
  const leases: PortLease[] = []
  try {
    while (leases.length < count) {
      const lease = await reservePort()
      if (lease.port < 1024 || leases.some((held) => held.port === lease.port)) {
        await lease.release()
        continue
      }
      leases.push(lease)
    }
    return leases
  } catch (err) {
    for (const lease of leases) await lease.release()
    throw err
  }
}


/** Env heredado sin credenciales opcionales (el env generado manda después). */
function cleanEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || SCRUB_KEYS[key]) continue
    out[key] = value
  }
  return out
}


function proxyEnv(state: RunState): Record<string, string> {
  return {
    ...cleanEnv(process.env),
    PORTLESS_STATE_DIR: state.portlessDir,
    PORTLESS_TLD: state.tld,
    PORTLESS_PORT: String(state.proxyPort),
    PORTLESS_HTTPS: "1",
    PORTLESS_WILDCARD: "1",
    PORTLESS_HTTP_REDIRECT: "0",
    // Node cancela IPv4 a los 250 ms antes de probar ::1, incluso en loopback.
    // Alinear la conexión con el plazo HTTP evita falsos 502 bajo carga.
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--network-family-autoselection-attempt-timeout=${REQUEST_TIMEOUT_MS}`,
    ].filter(Boolean).join(" "),
  }
}

/**
 * Proxy propio con estado nuevo: sin stop previo ni poda global, sin tocar CA
 * del SO ni proxy dev. Portless 0.15.6 puede devolver código 1 en Windows por
 * agotar su espera interna de 5 s aunque el daemon ya haya escrito `proxy.pid`
 * y esté arrancando; el PID propio es la evidencia para continuar y la
 * readiness funcional posterior comprueba que realmente escucha.
 */
async function startProxy(state: RunState): Promise<void> {
  const owned = spawnOwned(state, "proxy-start", process.execPath, [PORTLESS_CLI, "proxy", "start", "--skip-trust"], {
    cwd: ROOT, env: proxyEnv(state), watch: false, tee: false,
  })
  // El comando puede haber creado el daemon incluso si termina con error.
  state.proxyStarted = true
  const started = await waitForExitTimeout(owned.proc, APPS_READY_TIMEOUT_MS)
  for (let attempt = 0; attempt < PROXY_PID_RETRIES; attempt++) {
    const pid = readProxyPid(state.portlessDir)
    if (pid !== null) {
      state.proxyPid = pid
      updateRuntimeMeta(state.metaPath, { processes: [{ name: "proxy", pid }] })
      return
    }
    await sleep(250)
  }
  if (started === "timeout" || started.code !== 0) {
    throw new Error(`No se pudo arrancar el proxy propio: ${tailLog(owned.logPath)}`)
  }
  throw new Error(
    `El proxy arrancó pero no dejó su PID en ${join(state.portlessDir, "proxy.pid")}; no se puede garantizar su cierre.`,
  )
}

function readProxyPid(portlessDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(portlessDir, "proxy.pid"), "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function stopProxy(state: RunState): Promise<void> {
  if (!state.proxyStarted) return
  const owned = spawnOwned(state, "proxy-stop", process.execPath, [PORTLESS_CLI, "proxy", "stop"], {
    cwd: ROOT, env: proxyEnv(state), watch: false, tee: false, cleanup: true,
  })
  const result = await waitForExitTimeout(owned.proc, STOP_GRACE_MS)
  if (result === "timeout") await stopOwned(owned)
  if (result === "timeout" || result.code !== 0) throw new Error(`No se pudo detener el proxy propio (PID ${state.proxyPid}): ${tailLog(owned.logPath)}`)
  if (state.proxyPid) {
    try { process.kill(state.proxyPid, 0) } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return
      throw error
    }
    throw new Error(`El proxy sigue vivo (PID ${state.proxyPid})`)
  }
}

function resolveViteCli(appDir: string): string {
  let pkgPath: string
  try {
    pkgPath = require.resolve("vite/package.json", { paths: [appDir] })
  } catch {
    throw new Error(
      `No se resolvió el CLI de Vite desde ${appDir}: instala dependencias con pnpm install.`,
    )
  }
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"))
  let bin: string | undefined
  if (pkg !== null && typeof pkg === "object" && "bin" in pkg) {
    const binRaw: unknown = pkg.bin
    if (typeof binRaw === "string") {
      bin = binRaw
    } else if (binRaw !== null && typeof binRaw === "object" && "vite" in binRaw) {
      const viteBin: unknown = binRaw.vite
      if (typeof viteBin === "string") bin = viteBin
    }
  }
  if (!bin) throw new Error(`El paquete Vite en ${pkgPath} no declara binario.`)
  return join(dirname(pkgPath), bin)
}


async function runBuild(
  state: RunState,
  app: "panel" | "dental-clinic" | "admin",
  viteCli: string,
  outDir: string,
  env: Record<string, string>,
): Promise<void> {
  state.log.log(`Compilando ${app} → ${outDir}…`)
  const owned = spawnOwned(
    state,
    `build-${app}`,
    process.execPath,
    [viteCli, "build", "--outDir", outDir],
    {
      cwd: join(ROOT, "apps", app),
      env: { ...env, NODE_ENV: "production" },
      watch: false,
      tee: false,
    },
  )
  const result = await waitForExitTimeout(owned.proc, BUILD_TIMEOUT_MS)
  if (result === "timeout") {
    await stopOwned(owned)
    throw new Error(`La compilación de ${app} superó 300 s y se abortó (log: ${owned.logPath}).`)
  }
  if (result.code !== 0) {
    throw new Error(
      `La compilación de ${app} falló (código ${result.code ?? "nulo"}${result.signal ? `, señal ${result.signal}` : ""}).\n${tailLog(owned.logPath)}`,
    )
  }
  state.log.log(`Compilación de ${app} lista.`)
}

/** Migraciones y catálogos en orden, como hijos registrados (medición y cierre propios). */
async function runDbScript(
  state: RunState,
  runtime: HarnessRuntime,
  script: DbSetupScript,
  baseEnv: Record<string, string>,
): Promise<void> {
  const setup: {
    cmd: string
    args: readonly string[]
    cwd: string
    env: Record<string, string | undefined>
  } = dbSetupCommand(runtime, script)
  const scriptEnv: Record<string, string> = { ...baseEnv }
  for (const [key, value] of Object.entries(setup.env)) {
    if (value !== undefined) scriptEnv[key] = value
  }
  state.log.log(`Base de datos: ${script}…`)
  const owned = spawnOwned(state, `db-${basename(script, ".ts")}`, setup.cmd, setup.args, {
    cwd: setup.cwd,
    env: scriptEnv,
    watch: false,
    tee: false,
  })
  const result = await waitForExitTimeout(owned.proc, DB_SCRIPT_TIMEOUT_MS)
  if (result === "timeout") {
    await stopOwned(owned)
    throw new Error(`La migración ${script} superó 300 s y se abortó (log: ${owned.logPath}).`)
  }
  if (result.code !== 0) {
    throw new Error(
      `La migración ${script} falló (código ${result.code ?? "nulo"}${result.signal ? `, señal ${result.signal}` : ""}).\n${tailLog(owned.logPath)}`,
    )
  }
}

async function registerAlias(state: RunState, name: string, port: number): Promise<void> {
  const owned = spawnOwned(state, `alias-${name}`, process.execPath, [PORTLESS_CLI, "alias", name, String(port)], {
    cwd: ROOT, env: proxyEnv(state), watch: false, tee: false,
  })
  const result = await waitForExitTimeout(owned.proc, REQUEST_TIMEOUT_MS)
  if (result === "timeout" || result.code !== 0) {
    throw new Error(`No se pudo registrar ${name} en el proxy propio: ${tailLog(owned.logPath)}`)
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family: number,
) => void

/** Lookup limitado a los hosts del run (TLD → 127.0.0.1); el resto al resolver del SO. */
function runHostsLookup(tld: string) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    if (hostname === tld || hostname.endsWith(`.${tld}`)) {
      if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }], 4)
      else callback(null, "127.0.0.1", 4)
      return
    }
    dnsLookup(hostname, options, (err, address, family) => {
      if (err) callback(err, "", 0)
      else if (typeof address === "string") callback(null, address, family)
      else callback(null, address, family)
    })
  }
}

/** Dispatcher propio con la CA del run (no toca el DNS global ni el trust del proceso). */
function createDispatcher(state: RunState): Agent {
  const ca = readFileSync(join(state.portlessDir, "ca.pem"))
  const dispatcher = new Agent({ connect: { ca, lookup: runHostsLookup(state.tld) } })
  state.dispatcher = dispatcher
  return dispatcher
}

interface HttpResult {
  status: number
  location: string | null
  text: string
}

async function fetchVia(
  url: string,
  dispatcher: Agent | undefined,
  label: string,
): Promise<HttpResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await httpRequest(url, {
      dispatcher,
      method: "GET",
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
      signal: ctrl.signal,
    })
    const text = await res.body.text()
    const location = res.headers["location"]
    return {
      status: res.statusCode,
      location: Array.isArray(location) ? (location[0] ?? null) : (location ?? null),
      text,
    }
  } catch (err) {
    throw new Error(
      `${label} no respondió (${url}): ${err instanceof Error ? err.message : String(err)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

async function probeSmtp(host: string, port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const socket = connect({ host, port })
  socket.once("data", (chunk) => {
    const line = chunk.toString("utf8")
    socket.destroy()
    if (line.startsWith("220")) resolve()
    else reject(new Error(`SMTP saludó de forma inesperada (${host}:${port}): ${line.trim()}`))
  })
  socket.once("error", (err) => {
    socket.destroy()
    reject(new Error(`SMTP no respondió (${host}:${port}): ${err.message}`))
  })
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
    socket.destroy()
    reject(new Error(`SMTP no respondió (${host}:${port}): sin saludo 220 a tiempo`))
  })
  await promise
}

interface ReadinessTargets {
  apiOrigin: string
  panelOrigin: string
  adminOrigin: string
  apexOrigin: string
  tenantOrigin: string
  mailpitUrl: string
  smtpHost: string
  smtpPort: number
  storageUrl: string
}

/** Todas las sondas funcionales en paralelo; si alguna falla se recogen sus diagnósticos. */
async function probeAll(targets: ReadinessTargets, dispatcher: Agent): Promise<void> {
  const results = await Promise.allSettled([
    (async () => {
      const res = await fetchVia(`${targets.apiOrigin}/health`, dispatcher, "API /health")
      if (res.status !== 200) throw new Error(`API /health devolvió ${res.status}`)
      const body: unknown = JSON.parse(res.text)
      const ok = body !== null && typeof body === "object" && "ok" in body && body.ok === true
      if (!ok) throw new Error(`API /health devolvió ${res.text.slice(0, 200)}`)
    })(),
    (async () => {
      const res = await fetchVia(`${targets.panelOrigin}/login`, dispatcher, "panel /login")
      if (res.status !== 200) throw new Error(`panel /login devolvió ${res.status}`)
      if (!res.text.includes("<html")) throw new Error("panel /login no devolvió HTML")
    })(),
    (async () => {
      const res = await fetchVia(`${targets.adminOrigin}/login`, dispatcher, "admin /login")
      if (res.status < 300 || res.status >= 400 || !res.location || new URL(res.location, targets.adminOrigin).origin !== targets.panelOrigin) {
        throw new Error(`admin /login no redirigió al acceso de cuenta (${res.status})`)
      }
    })(),
    (async () => {
      // El apex redirige al panel por diseño; exigir el HTML final y no un banner.
      let url = `${targets.apexOrigin}/`
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetchVia(url, dispatcher, "plataforma /")
        if (res.status >= 300 && res.status < 400 && res.location) {
          const next = new URL(res.location, url)
          if (next.origin !== targets.panelOrigin) throw new Error("El apex redirigió fuera del panel del run")
          url = next.href
          continue
        }
        if (res.status === 200 && res.text.includes("<html")) return
        throw new Error(`plataforma / devolvió ${res.status} sin HTML`)
      }
      throw new Error("El apex superó cinco redirecciones")
    })(),
    (async () => {
      // Wildcard + SSR: el tenant técnico llega al login con `next` del mismo origen.
      let current = `${targets.tenantOrigin}/settings/branches`
      const chain: string[] = []
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetchVia(current, dispatcher, `tenant ${current}`)
        if (res.status >= 300 && res.status < 400 && res.location) {
          current = new URL(res.location, current).toString()
          chain.push(`${res.status} → ${current}`)
          continue
        }
        if (res.status === 200 && new URL(current).origin === targets.panelOrigin && new URL(current).pathname === "/login") {
          const next = new URL(current).searchParams.get("next")
          if (next && new URL(next).origin === targets.tenantOrigin && new URL(next).pathname === "/settings/branches") return
          throw new Error(
            `el tenant llegó al panel sin conservar el origen (next=${next ?? "ausente"}; cadena: ${chain.join(" | ") || "sin redirecciones"})`,
          )
        }
        throw new Error(
          `el tenant no llegó al login del panel (estado ${res.status} en ${current}; cadena: ${chain.join(" | ") || "sin redirecciones"})`,
        )
      }
      throw new Error(`el tenant superó 5 redirecciones (${chain.join(" | ")})`)
    })(),
    (async () => {
      const res = await fetchVia(targets.mailpitUrl, undefined, "Mailpit HTTP")
      if (res.status !== 200) throw new Error(`Mailpit HTTP devolvió ${res.status}`)
      const body: unknown = JSON.parse(res.text)
      if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) {
        throw new Error("Mailpit no devolvió JSON de mensajes")
      }
    })(),
    probeSmtp(targets.smtpHost, targets.smtpPort),
    (async () => {
      const res = await fetchVia(targets.storageUrl, undefined, "RustFS /health")
      if (res.status !== 200) throw new Error(`RustFS devolvió ${res.status}`)
    })(),
  ])
  const failures: string[] = []
  for (const result of results) {
    if (result.status === "rejected") failures.push(String(result.reason))
  }
  if (failures.length > 0) throw new Error(failures.join("\n"))
}

async function waitForApps(state: RunState, targets: ReadinessTargets): Promise<void> {
  const dispatcher = createDispatcher(state)
  const deadline = Date.now() + APPS_READY_TIMEOUT_MS
  let lastError = ""
  for (;;) {
    if (state.failed) throw state.failed
    if (state.shuttingDown) throw new Error("Cierre solicitado durante la espera de las apps.")
    try {
      await probeAll(targets, dispatcher)
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Las apps no quedaron listas en 120 s:\n${lastError}\nRevisa e2e/test-results/${state.runId}/logs/.`,
      )
    }
    await sleep(500)
  }
}

/** Sin endpoint de producción: encola la tarea de comprobación del worker y espera su `demo_task.done` hasta 15 s. */
async function waitForWorker(state: RunState, env: Record<string, string>): Promise<string> {
  const ownerUrl = env["DATABASE_URL"]
  if (!ownerUrl) throw new Error("Falta DATABASE_URL en el entorno generado.")
  const { db, close } = openFixtureDb(ownerUrl)
  state.fixtureClose = close
  try {
    const tag = `readiness-${state.runId}`
    const orgId = randomUUID()
    const userId = randomUUID()
    await db.insert(organization).values({
      id: orgId,
      name: `E2E Readiness ${state.runId}`,
      slug: tag,
      createdAt: new Date(),
    })
    await db.insert(user).values({
      id: userId,
      name: "E2E Readiness",
      email: `${tag}@e2e.local`,
      emailVerified: true,
    })
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    })
    const msgId = await sendDemoTask(db, {
      orgId,
      userId,
      message: "e2e-readiness",
      requestedAt: new Date().toISOString(),
    })
    const deadline = Date.now() + WORKER_READY_TIMEOUT_MS
    for (;;) {
      const rows = await db
        .select({ id: auditEvent.id })
        .from(auditEvent)
        .where(and(eq(auditEvent.action, "demo_task.done"), eq(auditEvent.entityId, msgId)))
        .limit(1)
      if (rows.length > 0) {
        state.log.log("Worker listo: procesó la tarea demo.")
        return tag
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `El worker no procesó la tarea demo en 15 s (msg ${msgId}); revisa worker.log en e2e/test-results/${state.runId}/logs/.`,
        )
      }
      if (state.failed) throw state.failed
      if (state.shuttingDown) throw new Error("Cierre solicitado durante la espera del worker.")
      await sleep(250)
    }
  } finally {
    await close()
    state.fixtureClose = null
  }
}

async function runPlaywright(
  state: RunState,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  let cli: string
  try {
    cli = require.resolve("@playwright/test/cli", { paths: [E2E_DIR] })
  } catch {
    throw new Error("No se resolvió @playwright/test/cli desde e2e: ejecuta pnpm install.")
  }
  const finalArgs = ["test"]
  if (!args.some((arg) => arg === "--output" || arg.startsWith("--output="))) {
    finalArgs.push("--output", join(dirname(state.metaPath), "playwright"))
  }
  finalArgs.push(...args)
  const owned = spawnOwned(state, "playwright", process.execPath, [cli, ...finalArgs], {
    cwd: E2E_DIR,
    env,
    watch: false,
    tee: true,
  })
  state.playwright = owned
  const result = await waitForExit(owned.proc)
  if (process.platform === "win32") {
    const output = readFileSync(owned.logPath, "utf8")
    if (output) process.stdout.write(output)
  }
  state.playwright = null
  if (state.failed) return 1
  if (state.shuttingDown) {
    state.log.log("Suite interrumpida antes de terminar.")
    return 1
  }
  if (result.signal) {
    state.log.log(`Playwright terminó por señal ${result.signal}.`)
    return 1
  }
  return result.code ?? 1
}

/** Cierre único (finally + señales convergen aquí): intenta todo aunque algo falle. */
function closeAll(state: RunState): Promise<string[]> {
  if (!state.closePromise) state.closePromise = doClose(state)
  return state.closePromise
}

async function doClose(state: RunState): Promise<string[]> {
  state.shuttingDown = true
  const errors: string[] = []
  if (state.playwright && isLive(state.playwright)) {
    try {
      await stopOwned(state.playwright)
    } catch (err) {
      errors.push(`playwright: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  for (const owned of [...state.owned].reverse()) {
    if (owned === state.playwright || !isLive(owned)) continue
    try {
      await stopOwned(owned)
    } catch (err) {
      errors.push(`${owned.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    await stopProxy(state)
  } catch (err) {
    errors.push(`proxy: ${err instanceof Error ? err.message : String(err)}`)
  }
  const proxyLog = join(state.portlessDir, "proxy.log")
  if (existsSync(proxyLog)) {
    try {
      await copyFile(proxyLog, join(state.logsDir, "proxy.log"))
    } catch (err) {
      errors.push(`log del proxy: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (state.dispatcher) {
    try {
      await state.dispatcher.close()
    } catch (err) {
      errors.push(`dispatcher: ${err instanceof Error ? err.message : String(err)}`)
    }
    state.dispatcher = null
  }
  if (state.fixtureClose) {
    try {
      await state.fixtureClose()
    } catch (err) {
      errors.push(`fixture-db: ${err instanceof Error ? err.message : String(err)}`)
    }
    state.fixtureClose = null
  }
  if (state.stack) {
    try {
      await state.stack.close()
    } catch (err) {
      errors.push(`contenedores: ${err instanceof Error ? err.message : String(err)}`)
    }
    state.stack = null
  }
  if (errors.length === 0) {
    for (const path of [state.stateDir, ...Object.values(state.outDirs)]) {
      try { await rm(path, { recursive: true, force: true }) } catch (err) {
        errors.push(`Directorio ${path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  for (const stream of state.fileStreams) {
    try {
      if (!stream.closed) stream.end()
    } catch {
      // El cierre ya se intentó al salir cada hijo; no oculta el error original.
    }
  }
  return errors
}

/**
 * Entrada del supervisor. Propaga el exit code de Playwright; un fallo de
 * arranque o cierre devuelve 1 con diagnóstico en español.
 */
export async function main(args: string[]): Promise<number> {
  const startedAt = performance.now()
  const runId = randomUUID()
  const tld = `e2e-${runId}.localhost`
  const baseDomain = `odentia.${tld}`
  const stateDir = await mkdtemp(join(tmpdir(), "odentia-e2e-"))
  const portlessDir = join(stateDir, "portless")
  const metaPath = runtimeMetaPath(runId)
  const outDirs = {
    panel: join(ROOT, "apps", "panel", ".cache", "e2e", runId),
    platform: join(ROOT, "apps", "dental-clinic", ".cache", "e2e", runId),
    admin: join(ROOT, "apps", "admin", ".cache", "e2e", runId),
  }
  const logsDir = join(dirname(metaPath), "logs")
  const state: RunState = {
    runId,
    stateDir,
    portlessDir,
    tld,
    baseDomain,
    proxyPort: 0,
    metaPath,
    logsDir,
    log: new SupervisorLog(),
    owned: [],
    fileStreams: [],
    shuttingDown: false,
    failed: null,
    playwright: null,
    stack: null,
    dispatcher: null,
    fixtureClose: null,
    proxyStarted: false,
    proxyPid: null,
    outDirs,
    timings: [],
    closePromise: null,
  }
  activeState = state
  await mkdir(logsDir, { recursive: true })
  state.log.open(join(dirname(metaPath), "supervisor.log"))
  state.log.log(`Entorno E2E ${runId} (dominio ${baseDomain}).`)

  const mark = (label: string, started: number) => {
    const ms = performance.now() - started
    state.timings.push({ label, ms })
    state.log.log(`${label}: ${(ms / 1000).toFixed(1)}s.`)
  }

  let code = 1
  const leases: PortLease[] = []
  let terminalMonitor: WindowsTerminalMonitor | null = null
  try {
    terminalMonitor = await startWindowsTerminalMonitor(logsDir)
    if (!existsSync(PORTLESS_CLI)) {
      throw new Error(`No existe el CLI de Portless en ${PORTLESS_CLI}: ejecuta pnpm install.`)
    }
    if (!existsSync(join(ROOT, "scripts", "local-network.mjs"))) {
      throw new Error(
        "Falta scripts/local-network.mjs (resolución DNS local para el SSR de los previews).",
      )
    }
    const tPorts = performance.now()
    leases.push(...(await reservePorts(5)))
    const [proxyLease, apiLease, panelLease, platformLease, adminLease] = leases
    if (!proxyLease || !apiLease || !panelLease || !platformLease || !adminLease) {
      throw new Error("No se pudieron reservar los 5 puertos del run.")
    }
    state.proxyPort = proxyLease.port
    const appPorts = { api: apiLease.port, panel: panelLease.port, platform: platformLease.port, admin: adminLease.port }
    initRuntimeMeta(metaPath, {
      runId,
      stateDir,
      ports: { proxy: state.proxyPort, ...appPorts },
      outDirs,
    })
    mark("Puertos reservados y metadata iniciada", tPorts)


    const tInfra = performance.now()
    const skeleton: HarnessRuntime = {
      runId,
      stateDir,
      baseDomain,
      proxyPort: state.proxyPort,
      appPorts,
    }
    let stack: HarnessStack
    try {
      stack = await startStack(skeleton)
    } catch (err) {
      throw new Error(
        `No se pudo arrancar la infraestructura efímera: ${err instanceof Error ? err.message : String(err)}. Configura DOCKER_HOST para el runtime de contenedores; E2E no utiliza el entorno dev.`,
      )
    }
    state.stack = stack
    const runtime = stack.runtime
    mark("Infraestructura (contenedores)", tInfra)

    const childEnv: Record<string, string> = { ...cleanEnv(process.env), ...stackEnv(runtime), NODE_ENV: "test" }

    const tDb = performance.now()
    for (const script of DB_SETUP_SCRIPTS) {
      if (state.shuttingDown) throw new Error("Cierre solicitado antes de las migraciones.")
      await runDbScript(state, runtime, script, childEnv)
    }
    mark("Migraciones y catálogos", tDb)

    const tProxy = performance.now()
    await proxyLease.release()
    await startProxy(state)
    mark("Proxy propio", tProxy)

    const tBuilds = performance.now()
    const vitePanel = resolveViteCli(join(ROOT, "apps", "panel"))
    const vitePlatform = resolveViteCli(join(ROOT, "apps", "dental-clinic"))
    const viteAdmin = resolveViteCli(join(ROOT, "apps", "admin"))
    const builds = await Promise.allSettled([
      runBuild(state, "panel", vitePanel, outDirs.panel, childEnv),
      runBuild(state, "dental-clinic", vitePlatform, outDirs.platform, childEnv),
      runBuild(state, "admin", viteAdmin, outDirs.admin, childEnv),
    ])
    for (const build of builds) {
      if (build.status === "rejected") throw build.reason
    }
    mark("Builds (panel+platform+admin en paralelo)", tBuilds)

    const tApps = performance.now()
    const tsxLoader = pathToFileURL(require.resolve("tsx")).href
    const bootstrapUrl = pathToFileURL(join(ROOT, "scripts", "local-network.mjs")).href
    const apiDir = join(ROOT, "apps", "api")
    const workerDir = join(ROOT, "apps", "worker")
    const spawnListening = async (
      name: string,
      lease: PortLease,
      port: number,
      argv: string[],
      cwd: string,
      env: Record<string, string>,
    ): Promise<void> => {
      await lease.release()
      const owned = spawnOwned(state, name, process.execPath, argv, {
        cwd,
        env,
        watch: true,
        tee: false,
      })
      state.log.log(`${name} arrancado (pid ${owned.proc.pid ?? "?"}; log: ${owned.logPath}).`)
    }
    await spawnListening(
      "api",
      apiLease,
      appPorts.api,
      ["--import", tsxLoader, join(apiDir, "src", "index.ts")],
      apiDir,
      { ...childEnv, NODE_ENV: "test", PORT: String(appPorts.api) },
    )
    // El worker solo consume colas: sin puerto HTTP, sin lease, sin ruta en el proxy.
    const workerOwned = spawnOwned(
      state,
      "worker",
      process.execPath,
      ["--import", tsxLoader, join(workerDir, "src", "index.ts")],
      { cwd: workerDir, env: { ...childEnv, NODE_ENV: "test" }, watch: true, tee: false },
    )
    state.log.log(
      `worker arrancado (pid ${workerOwned.proc.pid ?? "?"}; log: ${workerOwned.logPath}).`,
    )
    await spawnListening(
      "panel",
      panelLease,
      appPorts.panel,
      [
        "--import",
        bootstrapUrl,
        vitePanel,
        "preview",
        "--outDir",
        outDirs.panel,
        "--host",
        "127.0.0.1",
        "--port",
        String(appPorts.panel),
        "--strictPort",
      ],
      join(ROOT, "apps", "panel"),
      { ...childEnv, NODE_ENV: "production" },
    )
    await spawnListening(
      "platform",
      platformLease,
      appPorts.platform,
      [
        "--import",
        bootstrapUrl,
        vitePlatform,
        "preview",
        "--outDir",
        outDirs.platform,
        "--host",
        "127.0.0.1",
        "--port",
        String(appPorts.platform),
        "--strictPort",
      ],
      join(ROOT, "apps", "dental-clinic"),
      { ...childEnv, NODE_ENV: "production" },
    )
    await spawnListening(
      "admin",
      adminLease,
      appPorts.admin,
      ["--import", bootstrapUrl, viteAdmin, "preview", "--outDir", outDirs.admin, "--host", "127.0.0.1", "--port", String(appPorts.admin), "--strictPort"],
      join(ROOT, "apps", "admin"),
      { ...childEnv, NODE_ENV: "production" },
    )
    await registerAlias(state, "api.odentia", appPorts.api)
    await registerAlias(state, "app.odentia", appPorts.panel)
    await registerAlias(state, "admin.odentia", appPorts.admin)
    await registerAlias(state, "odentia", appPorts.platform)
    mark("Apps y rutas del proxy", tApps)

    const tReady = performance.now()
    const apiOrigin = childEnv["BETTER_AUTH_URL"]
    const panelOrigin = childEnv["WEB_URL"]
    const adminOrigin = childEnv["ADMIN_URL"]
    if (!apiOrigin || !panelOrigin || !adminOrigin) {
      throw new Error("Faltan BETTER_AUTH_URL/WEB_URL/ADMIN_URL en el entorno generado.")
    }
    const storage = runtime.storage
    const mailpit = runtime.mailpit
    if (!storage || !mailpit) {
      throw new Error("La infraestructura no devolvió endpoints de RustFS/Mailpit.")
    }
    const readinessSlug = await waitForWorker(state, childEnv)
    await waitForApps(state, {
      apiOrigin,
      panelOrigin,
      adminOrigin,
      apexOrigin: `https://${baseDomain}:${state.proxyPort}`,
      tenantOrigin: `https://${readinessSlug}.${baseDomain}:${state.proxyPort}`,
      mailpitUrl: `http://${mailpit.host}:${mailpit.httpPort}/api/v1/messages`,
      smtpHost: mailpit.host,
      smtpPort: mailpit.smtpPort,
      storageUrl: `http://${storage.host}:${storage.port}/health`,
    })
    mark("Readiness funcional", tReady)

    const tTests = performance.now()
    code = await runPlaywright(state, args, childEnv)
    mark("Tests Playwright", tTests)
    if (state.failed) code = 1
  } catch (err) {
    state.log.log(`E2E falló: ${err instanceof Error ? err.message : String(err)}`)
    code = 1
  } finally {
    const tClose = performance.now()
    const cleanupErrors = await closeAll(state)
    for (const lease of leases) {
      try {
        await lease.release()
      } catch {
        // Liberar una reserva ya liberada no es error.
      }
    }
    try {
      const terminalWindows = await stopWindowsTerminalMonitor(terminalMonitor)
      if (terminalWindows.length > 0) {
        state.log.log(
          `E2E abrió ${terminalWindows.length} ventana(s) de Windows Terminal: ${terminalWindows.join(", ")}`,
        )
        code = 1
      }
    } catch (err) {
      state.log.log(
        `No se pudo validar la ausencia de ventanas de Windows Terminal: ${err instanceof Error ? err.message : String(err)}`,
      )
      code = 1
    }
    mark("Cierre", tClose)
    if (cleanupErrors.length > 0) {
      state.log.log(`Limpieza incompleta (IDs pendientes):\n${cleanupErrors.join("\n")}`)
      code = 1
    }
    const total = performance.now() - startedAt
    state.log.log(
      `Entorno E2E ${runId} terminado en ${(total / 1000).toFixed(1)}s con código ${code}. Artefactos en e2e/test-results/${runId}/.`,
    )
    activeState = null
    await state.log.close()
  }
  return code
}

const isEntry = (() => {
  try {
    return pathToFileURL(resolve(process.argv[1] ?? "")).href === import.meta.url
  } catch {
    return false
  }
})()

if (isEntry) {
  const code = await main(process.argv.slice(2)).catch((err) => {
    console.error(`E2E falló: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  })
  process.exit(code)
}
