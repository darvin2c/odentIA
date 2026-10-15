#!/usr/bin/env node
// Entorno preview de OpenShip por PR: crear o actualizar (`up`) y retirar (`down`).
// Usa solo el CLI oficial; nunca imprime secretos. Requiere un contexto ya
// autenticado (`openship login`) con acceso al proyecto productivo y sus entornos.
//
//   node scripts/preview-environment.mjs up --pr 29 --branch feat/x --commit <sha>
//   node scripts/preview-environment.mjs down --pr 29
//
// Variables: OPENSHIP_PROJECT_ID (proyecto productivo, origen de los entornos) y
// OPENSHIP_PREVIEW_DOMAIN (p. ej. preview.example.com; cada PR usa pr-N.<dominio>).
import { randomBytes } from "node:crypto"
import { Resolver, resolve4, resolveNs } from "node:dns/promises"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { setTimeout as sleep } from "node:timers/promises"

const COMPOSE_PATH = "compose.preview.yaml"
const DEPLOY_TIMEOUT_MS = 1_800_000

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: { pr: { type: "string" }, branch: { type: "string" }, commit: { type: "string" } },
})
const [command] = positionals
const pr = Number(options.pr)
if (!["up", "down"].includes(command) || !Number.isInteger(pr) || pr <= 0) {
  fail("Uso: preview-environment.mjs up|down --pr <número> [--branch <rama> --commit <sha>]")
}
const sourceProject = requiredEnv("OPENSHIP_PROJECT_ID")
const slug = `pr-${pr}`

if (command === "up") await up()
else down()

async function up() {
  if (!options.branch || !options.commit) fail("up requiere --branch y --commit")
  const base = `${slug}.${requiredEnv("OPENSHIP_PREVIEW_DOMAIN")}`
  let project = findEnvironment()
  if (!project) {
    project = openship(["project", "environment", "create", sourceProject, `PR #${pr}`,
      "--slug", slug, "--type", "preview", "--branch", options.branch, "--source-mode", "branch"]).id
    log(`Entorno ${slug} creado: ${project}`)
  }
  const details = openship(["project", "get", project])
  // El entorno copia la receta de producción; el preview usa la suya, aislada.
  if (details.composePath !== COMPOSE_PATH) withJsonFile({ composePath: COMPOSE_PATH }, file => openship(["project", "update", project, file]))
  if (details.gitBranch !== options.branch) openship(["project", "git", "branch", project, options.branch])
  // Actions es el único disparador: evita un segundo despliegue por push.
  if (details.autoDeploy) openship(["project", "git", "auto-deploy", project, "--disable"])

  configureVariables(project, base)
  openship(["deploy", "--project", project, "--branch", options.branch, "--commit", options.commit,
    "--env", "production", "--smart-route", "--watch", "--timeout", String(DEPLOY_TIMEOUT_MS)], { json: false })
  await ensureDomains(project, base)

  const url = `https://app.${base}`
  log(`Preview disponible: ${url}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\nproject=${project}\n`)
}

function down() {
  const project = findEnvironment()
  if (!project) {
    log(`No existe el entorno ${slug}; nada que retirar.`)
    return
  }
  // Los volúmenes del preview (base, MinIO, semilla) forman una unidad desechable.
  openship(["project", "delete", project, "--force", "--wipe-volumes", "--yes"], { json: false })
  log(`Entorno ${slug} retirado.`)
}

function findEnvironment() {
  const environments = openship(["project", "environment", "list", sourceProject])
  const matches = environments.filter(environment => environment.slug === slug && environment.type === "preview")
  if (matches.length > 1) fail(`Hay varios entornos ${slug}; resolverlo en OpenShip antes de continuar.`)
  return matches[0]?.id
}

function configureVariables(project, base) {
  const existing = new Set(openship(["project", "env", "get", project]).map(variable => variable.key))
  // Configuración derivada del PR: se reaplica en cada despliegue.
  setVariables(project, {
    POSTGRES_DB: "dentalagent",
    POSTGRES_USER: "dentalagent",
    BETTER_AUTH_URL: `https://api.${base}`,
    WEB_URL: `https://app.${base}`,
    ADMIN_URL: `https://admin.${base}`,
    COOKIE_DOMAIN: base,
    TRUSTED_ORIGINS: `https://app.${base},https://api.${base},https://*.${base}`,
    SMTP_HOST: "mailpit",
    SMTP_PORT: "1025",
    SMTP_FROM: `Odentia32 preview <no-reply@${base}>`,
    S3_ENDPOINT: `https://storage.${base}`,
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY: "preview",
    S3_BUCKET: "avatars",
    S3_ATTACHMENTS_BUCKET: "attachments",
    S3_PUBLIC_URL: `https://storage.${base}/avatars`,
    CHANNEL_VALIDATE_EXTERNAL: "false",
    CHANNEL_SENDER_MODE: "mock",
    LLM_MODEL: "fake",
    VITE_API_URL: `https://api.${base}`,
    VITE_BASE_DOMAIN: base,
    PORT: "3001",
  }, false)
  // Secretos propios del entorno: se generan una vez y se conservan, porque
  // rotarlos invalidaría la base y los datos cifrados del preview.
  if (!existing.has("POSTGRES_PASSWORD")) {
    const owner = randomBytes(24).toString("hex")
    const app = randomBytes(24).toString("hex")
    setVariables(project, {
      POSTGRES_PASSWORD: owner,
      POSTGRES_APP_PASSWORD: app,
      DATABASE_URL: `postgres://dentalagent:${owner}@postgres:5432/dentalagent`,
      APP_DATABASE_URL: `postgres://dentalagent_app:${app}@postgres:5432/dentalagent`,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      SECRETS_KEY: randomBytes(32).toString("hex"),
      S3_SECRET_KEY: randomBytes(24).toString("hex"),
    }, true)
  }
}

function setVariables(project, variables, secret) {
  const args = ["project", "env", "set", project, "--environment", "production"]
  for (const [key, value] of Object.entries(variables)) args.push("--set", `${key}=${value}`)
  if (secret) args.push("--secret")
  openship(args, { quiet: true })
}

async function ensureDomains(project, base) {
  const wanted = [
    { hostname: `app.${base}`, service: "panel", port: 3000, primary: true },
    { hostname: `admin.${base}`, service: "admin", port: 3000 },
    { hostname: `api.${base}`, service: "api", port: 3001 },
    { hostname: `storage.${base}`, service: "minio", port: 9000 },
    // Las clínicas se sirven por subdominio: el comodín usa DNS-01.
    { hostname: `*.${base}`, service: "platform", port: 3000 },
  ]
  const existing = () => openship(["domain", "list", "--project", project])
  // El dominio se crea y enruta al exponer el servicio; un POST /domains no lo
  // vincula a ningún servicio del stack.
  for (const domain of wanted) {
    const record = existing().find(item => item.hostname === domain.hostname)
    if (record?.serviceId && record.targetPort === domain.port) continue
    withJsonFile({
      exposed: true,
      exposedPort: String(domain.port),
      publicEndpoints: [{ port: domain.port, domainType: "custom", customDomain: domain.hostname }],
    }, file => openship(["service", "update", domain.service, file, "--project", project]))
    log(`Dominio ${domain.hostname} enrutado a ${domain.service}.`)
  }
  const records = existing()
  const primary = records.find(item => item.hostname === `app.${base}`)
  if (primary && !primary.isPrimary) openship(["domain", "primary", primary.id])

  const pending = records.filter(item => !item.verified)
  // Publicar todos los registros antes de cualquier verificación: una consulta
  // previa cachearía NXDOMAIN en el resolvedor de la autoridad certificadora.
  for (const record of pending) openship(["domain", "dns", "apply", record.id], { quiet: true })
  for (const record of pending) await waitForAuthoritativeDns(record.hostname.replace("*.", "comprobacion."))
  for (const record of pending) await verifyDomain(record)
}

async function waitForAuthoritativeDns(hostname) {
  const servers = await authoritativeServers(hostname)
  const resolver = new Resolver()
  resolver.setServers(servers)
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await resolver.resolve4(hostname).catch(() => [])).length > 0) return
    await sleep(10_000)
  }
  fail(`El DNS autoritativo no publicó ${hostname} a tiempo.`)
}

async function authoritativeServers(hostname) {
  const labels = hostname.split(".")
  for (let index = 1; index < labels.length - 1; index++) {
    const zone = labels.slice(index).join(".")
    const nameServers = await resolveNs(zone).catch(() => [])
    if (nameServers.length === 0) continue
    const addresses = await Promise.all(nameServers.map(server => resolve4(server).catch(() => [])))
    const servers = addresses.flat()
    if (servers.length > 0) return servers
  }
  fail(`No se encontraron servidores DNS autoritativos para ${hostname}.`)
}

async function verifyDomain(record) {
  // La validación ACME puede necesitar reintentos mientras se propagan los registros.
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (openship(["domain", "verify", record.id], { quiet: true, allowFailure: true })) {
      log(`Dominio ${record.hostname} verificado con HTTPS.`)
      return
    }
    log(`Verificación de ${record.hostname} pendiente (intento ${attempt}/10).`)
    await sleep(30_000)
  }
  fail(`No se pudo verificar ${record.hostname}; revisar \`openship project pending\`.`)
}

function openship(args, { json = true, quiet = false, allowFailure = false } = {}) {
  const fullArgs = json ? ["--json", ...args] : args
  const windows = process.platform === "win32"
  const result = spawnSync(windows ? "openship.cmd" : "openship",
    windows ? fullArgs.map(arg => `"${arg.replaceAll('"', '\\"')}"`) : fullArgs,
    { encoding: "utf8", shell: windows, stdio: json || quiet ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024 })
  if (allowFailure) return result.status === 0
  if (result.status !== 0) {
    // Sin eco del comando: puede contener secretos en sus argumentos.
    fail(`openship ${args.slice(0, 3).join(" ")} falló (${result.status}).${quiet ? "" : ` ${result.stderr?.trim() ?? ""}`}`)
  }
  return json && !quiet ? JSON.parse(result.stdout) : undefined
}

function withJsonFile(value, action) {
  const dir = mkdtempSync(join(tmpdir(), "preview-"))
  const file = join(dir, "patch.json")
  writeFileSync(file, JSON.stringify(value))
  try {
    return action(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function requiredEnv(name) {
  return process.env[name] || fail(`Falta la variable ${name}`)
}

function log(message) {
  console.log(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
