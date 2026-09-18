process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"
// El harness gestiona el ciclo de vida de sus contenedores (etiqueta +
// teardown): el reaper automático de testcontainers los mata al cerrar la
// conexión de quien los creó (el proceso principal), dejando a las apps sin DB.
process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true"

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"
import { CreateBucketCommand, PutBucketPolicyCommand, S3Client } from "@aws-sdk/client-s3"
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from "testcontainers"
import {
  APP_PORTS,
  ATTACHMENTS_BUCKET,
  AVATARS_BUCKET,
  HARNESS_LABEL,
  HARNESS_PORT,
  HARNESS_TLD,
  MAILPIT_HTTP_PORT,
  MAILPIT_IMAGE,
  MAILPIT_SMTP_PORT,
  MINIO_IMAGE,
  MINIO_PORT,
  ownerDatabaseUrl,
  PG_IMAGE,
  PG_PORT,
  PORTLESS_CLI,
  ROOT,
  stackEnv,
  STATE_DIR,
} from "./harness-env"

const require = createRequire(import.meta.url)
/** Marcador de la corrida: id de los contenedores del harness. */
const MARKER = join(ROOT, ".e2e-stack.json")
/** Lock del arranque: sólo un proceso levanta la infraestructura. */
const LOCK_DIR = join(ROOT, ".e2e-stack.lock")
/** Puertos de la infraestructura: su liveness define si el stack está listo. */
const HARNESS_PORTS = [PG_PORT, MINIO_PORT, MAILPIT_HTTP_PORT]
/** CLI de tsx, resuelto desde el paquete que lo declara (db). */
const TSX_CLI = join(
  dirname(require.resolve("tsx/package.json", { paths: [join(ROOT, "packages", "db")] })),
  "dist",
  "cli.mjs",
)

/** Ejecuta portless con el CLI resuelto (sin shell: `pnpm.cmd` no aplica). */
function portless(args: string[], env: NodeJS.ProcessEnv): { status: number | null } {
  return spawnSync(process.execPath, [PORTLESS_CLI, ...args], { cwd: ROOT, env, stdio: "ignore" })
}

/**
 * Elimina contenedores del harness de corridas anteriores. Llevan su propia
 * etiqueta: el stack dev (compose) y las corridas de vitest quedan intactos.
 */
async function reapLeftovers(): Promise<void> {
  const { container } = await getContainerRuntimeClient()
  const leftovers = (await container.list()).filter(
    (info) => info.Labels?.[HARNESS_LABEL] === "1",
  )
  for (const info of leftovers) {
    await container
      .remove(container.getById(info.Id), { removeVolumes: true })
      .catch(() => undefined)
  }
}

/**
 * Mata procesos que escuchan en los puertos fijos de las apps del harness:
 * son restos de una corrida interrumpida (Playwright mata el wrapper de
 * portless, no siempre al `dev:app` hijo) y bloquean el re-registro del host.
 */
function killAppPortListeners(): void {
  const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? ""
  const pids = new Set<string>()
  for (const port of Object.values(APP_PORTS)) {
    for (const line of netstat.split("\n")) {
      if (line.includes(`:${port} `) && line.includes("LISTENING")) {
        const pid = line.trim().split(/\s+/).pop()
        if (pid) pids.add(pid)
      }
    }
  }
  for (const pid of pids) {
    spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" })
  }
}

/** Corre un script del paquete db (migrate/seeds) contra la base del harness. */
function runDbScript(script: string): void {
  const result = spawnSync(process.execPath, [TSX_CLI, script], {
    cwd: join(ROOT, "packages", "db"),
    env: { ...process.env, DATABASE_URL: ownerDatabaseUrl },
    stdio: "pipe",
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(
      `db ${script} falló (${result.status}): ${result.stdout ?? ""}${result.stderr ?? ""}`,
    )
  }
}

/** Buckets del harness: avatares públicos (los sirve el navegador) y adjuntos privados. */
async function prepareBuckets(endpoint: string): Promise<void> {
  const client = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
  })
  for (const bucket of [AVATARS_BUCKET, ATTACHMENTS_BUCKET]) {
    await client.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined)
  }
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: AVATARS_BUCKET,
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: ["*"] },
            Action: ["s3:GetObject"],
            Resource: [`arn:aws:s3:::${AVATARS_BUCKET}/avatars/*`],
          },
        ],
      }),
    }),
  )
}

/** Levanta proxy + contenedores + migraciones (una vez por corrida). */
async function startStack(): Promise<void> {
  const containers: StartedTestContainer[] = []
  rmSync(STATE_DIR, { recursive: true, force: true })
  mkdirSync(STATE_DIR, { recursive: true })
  await reapLeftovers()

  // Proxy propio con `--skip-trust`: la CA vive en el state dir del harness y
  // se propaga a las apps por `NODE_EXTRA_CA_CERTS`; no se toca el trust store
  // del sistema (el navegador de Playwright ignora errores de certificado).
  const proxyEnv = { ...process.env, ...stackEnv() }
  portless(["proxy", "stop"], proxyEnv)
  const proxy = portless(["proxy", "start", "--skip-trust"], proxyEnv)
  if (proxy.status !== 0) {
    throw new Error("portless proxy start falló (revisa .e2e-portless/proxy.log)")
  }

  const labels = { [HARNESS_LABEL]: "1" }
  const postgres = await new GenericContainer(PG_IMAGE)
    .withExposedPorts({ container: 5432, host: Number(PG_PORT) })
    .withLabels(labels)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  containers.push(postgres)

  const minio = await new GenericContainer(MINIO_IMAGE)
    .withExposedPorts({ container: 9000, host: Number(MINIO_PORT) })
    .withLabels(labels)
    .withEnvironment({ MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" })
    .withWaitStrategy(Wait.forHttp("/minio/health/ready", 9000))
    .withCommand(["server", "/data"])
    .start()
  containers.push(minio)

  const mailpit = await new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(
      { container: 8025, host: Number(MAILPIT_HTTP_PORT) },
      { container: 1025, host: Number(MAILPIT_SMTP_PORT) },
    )
    .withLabels(labels)
    .withWaitStrategy(Wait.forHttp("/", 8025))
    .start()
  containers.push(mailpit)

  await prepareBuckets(`http://127.0.0.1:${MINIO_PORT}`)
  runDbScript("src/migrate.ts")
  runDbScript("src/seed-cie10.ts")
  runDbScript("src/seed-procedure-codes.ts")

  writeFileSync(MARKER, JSON.stringify({ containers: containers.map((c) => c.getId()) }))
}

/**
 * Garantiza la infraestructura del harness. Se invoca al cargar la config
 * porque Playwright arranca `webServer` ANTES del `globalSetup`: las apps
 * necesitan la base y el proxy ya vivos. Idempotente entre procesos (el
 * marcador evita que cada worker levante su propio stack).
 */
export async function ensureStack(): Promise<void> {
  // Procesos de apps de una corrida interrumpida retienen los puertos fijos:
  // se limpian siempre (la infraestructura puede seguir viva y no re-arranca).
  killAppPortListeners()
  // Liveness por puerto: es lo que consumen las apps. Se evita depender de la
  // forma del listado de contenedores y de un doble arranque entre procesos
  // (la config se carga en el proceso principal y en cada worker).
  const alive = await Promise.all(HARNESS_PORTS.map(isPortOpen))
  if (existsSync(MARKER) && alive.every(Boolean)) return
  // Lock: sólo un proceso levanta la infraestructura; el resto espera.
  try {
    mkdirSync(LOCK_DIR)
  } catch {
    for (let i = 0; i < 120; i++) {
      if (existsSync(MARKER) && (await Promise.all(HARNESS_PORTS.map(isPortOpen))).every(Boolean)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    throw new Error("El harness no quedó listo: revisa .e2e-portless/proxy.log")
  }
  try {
    await startStack()
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

/** ¿Hay algo escuchando en el puerto? (liveness de la infraestructura) */
function isPortOpen(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
    socket.setTimeout(2_000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/** Ids de contenedores del marcador de corrida (vacío si no hay/inválido). */
function readMarker(): string[] {
  if (!existsSync(MARKER)) return []
  const raw: unknown = JSON.parse(readFileSync(MARKER, "utf8"))
  if (raw && typeof raw === "object" && "containers" in raw && Array.isArray(raw.containers)) {
    return raw.containers.filter((id): id is string => typeof id === "string")
  }
  return []
}

/** Detiene contenedores, proxy y estado del harness. */
export async function stopStack(): Promise<void> {
  const { container } = await getContainerRuntimeClient()
  for (const id of readMarker()) {
    await container.stop(container.getById(id)).catch(() => undefined)
  }
  portless(["proxy", "stop"], {
    ...process.env,
    PORTLESS_STATE_DIR: STATE_DIR,
    PORTLESS_TLD: HARNESS_TLD,
    PORTLESS_PORT: HARNESS_PORT,
  })
  rmSync(STATE_DIR, { recursive: true, force: true })
  rmSync(MARKER, { force: true })
}