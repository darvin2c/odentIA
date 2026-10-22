import { createRequire } from "node:module"
import { connect } from "node:net"
import { dirname, join } from "node:path"
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import {
  GenericContainer,
  Wait,
  getContainerRuntimeClient,
  type ContainerRuntimeClient,
  type StartedTestContainer,
} from "testcontainers"
import { runtimeMetaPath, updateRuntimeMeta } from "./runtime-meta"
import {
  ATTACHMENTS_BUCKET,
  AVATARS_BUCKET,
  E2E_LABEL,
  E2E_RUN_LABEL,
  MAILPIT_IMAGE,
  PG_IMAGE,
  ROOT,
  STORAGE_ACCESS_KEY,
  STORAGE_IMAGE,
  STORAGE_SECRET_KEY,
  ownerDatabaseUrl,
  type HarnessRuntime,
} from "./harness-env"

/**
 * Infraestructura efímera de una ejecución E2E: PostgreSQL, RustFS (S3) y Mailpit
 * en Testcontainers más los buckets. Este módulo solo posee contenedores;
 * los procesos (proxy, builds, apps, migraciones) los posee el supervisor
 * (`run.ts`), que también registra sus handles para el cierre por señales.
 *
 * Sin puertos fijos de host, sin reuse, sin volúmenes del dev, sin locks ni
 * marcadores globales y sin `DOCKER_HOST` cableado: cada ejecución usa sus
 * etiquetas exactas (`odentia.e2e.run=<runId>`).
 */

const require = createRequire(import.meta.url)
/** CLI de tsx, resuelto desde el paquete que lo declara (db). */
const TSX_CLI = join(
  dirname(require.resolve("tsx/package.json", { paths: [join(ROOT, "packages", "db")] })),
  "dist",
  "cli.mjs",
)

/** Scripts de catálogos: migraciones y seeds, en este orden, una vez por run. */
export const DB_SETUP_SCRIPTS = [
  "src/migrate.ts",
  "src/seed-diagnoses.ts",
  "src/seed-procedure-codes.ts",
] as const
export type DbSetupScript = (typeof DB_SETUP_SCRIPTS)[number]

/**
 * Comando para que el supervisor ejecute un script de catálogos como hijo
 * registrado: Node con el loader tsx, cwd `packages/db` y únicamente la DB
 * temporal del run. No se reducen catálogos para E2E.
 */
export function dbSetupCommand(
  runtime: HarnessRuntime,
  script: DbSetupScript,
): { cmd: string; args: string[]; cwd: string; env: Record<string, string> } {
  return {
    cmd: process.execPath,
    args: [TSX_CLI, script],
    cwd: join(ROOT, "packages", "db"),
    env: { DATABASE_URL: ownerDatabaseUrl(runtime) },
  }
}

/** Stack vivo de la ejecución: runtime con endpoints y cierre idempotente. */
export type HarnessStack = { runtime: HarnessRuntime; close(): Promise<void> }
const CONTAINER_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 10_000

/** Comprueba que un endpoint responde antes de crear contenedores. */
function probe(
  target: { path: string } | { host: string; port: number },
  timeoutMs: number,
): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const socket = "path" in target ? connect(target.path) : connect(target.port, target.host)
  const done = (error?: Error): void => {
    socket.destroy()
    if (error) reject(error)
    else resolve()
  }
  socket.once("connect", () => done())
  socket.once("error", done)
  socket.setTimeout(timeoutMs, () => done(new Error("tiempo de espera agotado (2 s)")))
  return promise
}

/** Runtime explícito que debe respetarse: sin fallback silencioso a otro. */
type ExpectedRuntime =
  | { kind: "socket"; label: string; path: string }
  | { kind: "tcp"; label: string; host: string; port: number }

/**
 * Normaliza un `DOCKER_HOST` npipe explícito a la forma que el parser de
 * Testcontainers 12 conserva (`npipe:////.\\pipe\\<nombre>` con backslashes):
 * su `new URL(dockerHost).pathname` elimina el segmento `.` de
 * `npipe:////./pipe/...` y conectaría a un pipe inexistente, cayendo en
 * silencio a otro runtime. Misma semántica de endpoint, sin fallback.
 */
function normalizeNpipeUri(raw: string): { uri: string; pipePath: string } {
  let resource = raw.slice("npipe://".length)
  try {
    resource = decodeURIComponent(resource)
  } catch {
    // sin decodificar: se valida tal cual
  }
  const name = /pipe[/\\]([^/\\]+)$/.exec(resource)?.[1]
  if (!name) throw new Error(`ruta de pipe inválida (${raw})`)
  return { uri: `npipe:////.\\pipe\\${name}`, pipePath: `\\\\.\\pipe\\${name}` }
}

/**
 * Valida el transporte de un `DOCKER_HOST` explícito antes de crear nada y
 * devuelve el endpoint esperado para verificarlo tras conectar. Sin variable
 * deja actuar a la autodetección normal de Testcontainers.
 */
async function checkExplicitDockerHost(): Promise<ExpectedRuntime | undefined> {
  const raw = process.env.DOCKER_HOST
  if (!raw) return undefined
  const hint = "Configura DOCKER_HOST para el runtime de contenedores; E2E no utiliza el entorno dev"
  if (raw.startsWith("ssh://")) {
    throw new Error(
      `DOCKER_HOST usa ssh (${raw}): no se traduce a un socket a ciegas, ` +
        `usa el socket/pipe local del runtime. ${hint}`,
    )
  }
  try {
    if (raw.startsWith("unix://")) {
      const path = raw.slice("unix://".length)
      if (!path) throw new Error("ruta vacía")
      await probe({ path }, 2_000)
      return { kind: "socket", label: raw, path }
    }
    if (raw.startsWith("npipe://")) {
      const { uri, pipePath } = normalizeNpipeUri(raw)
      process.env.DOCKER_HOST = uri
      await probe({ path: pipePath }, 2_000)
      return { kind: "socket", label: raw, path: pipePath }
    }
    if (raw.startsWith("tcp://") || raw.startsWith("http://") || raw.startsWith("https://")) {
      const url = new URL(raw)
      const port = Number(url.port) || (raw.startsWith("https://") ? 2376 : 2375)
      await probe({ host: url.hostname, port }, 2_000)
      return { kind: "tcp", label: raw, host: url.hostname, port }
    }
    throw new Error(`esquema no soportado (${raw})`)
  } catch (cause) {
    const detalle = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `No se puede alcanzar el runtime de contenedores en ${raw}: ${detalle}. ${hint}`,
      { cause },
    )
  }
}

/** Socket que docker-modem resolvió, si es observable en esta versión. */
function modemSocketPath(client: ContainerRuntimeClient): string | undefined {
  const modem: unknown = client.container.dockerode.modem
  if (modem && typeof modem === "object" && "socketPath" in modem) {
    return typeof modem.socketPath === "string" ? modem.socketPath : undefined
  }
  return undefined
}

/** Host/puerto que docker-modem resolvió, si son observables en esta versión. */
function modemHostPort(client: ContainerRuntimeClient): { host: string; port: number } | undefined {
  const modem: unknown = client.container.dockerode.modem
  if (!modem || typeof modem !== "object" || !("host" in modem) || !("port" in modem)) {
    return undefined
  }
  const { host, port } = modem
  if (typeof host !== "string") return undefined
  const resolved = typeof port === "string" ? Number(port) : port
  if (typeof resolved !== "number" || !Number.isInteger(resolved)) return undefined
  return { host, port: resolved }
}

/** En Windows los pipes son insensibles a mayúsculas y al tipo de barra. */
function samePipe(actual: string, expected: string): boolean {
  if (actual === expected) return true
  if (process.platform !== "win32") return false
  const normalize = (value: string): string => value.replace(/\//g, "\\").toLowerCase()
  return normalize(actual) === normalize(expected)
}

/**
 * Asegura que el cliente resolvió el runtime explícito: las estrategias de
 * Testcontainers pueden caer a otro runtime ante un endpoint mal parseado y
 * E2E nunca debe usarlo en silencio.
 */
function verifyResolvedRuntime(client: ContainerRuntimeClient, expected: ExpectedRuntime): void {
  if (expected.kind === "socket") {
    const actual = modemSocketPath(client)
    if (actual === undefined || !samePipe(actual, expected.path)) {
      throw new Error(
        `El runtime explícito ${expected.label} no es el que resolvió el cliente ` +
          `(${actual ?? "no observable"}): E2E no utiliza otro entorno; revisa DOCKER_HOST.`,
      )
    }
    return
  }
  const actual = modemHostPort(client)
  if (
    actual === undefined ||
    actual.host.toLowerCase() !== expected.host.toLowerCase() ||
    actual.port !== expected.port
  ) {
    throw new Error(
      `El runtime explícito ${expected.label} no es el que resolvió el cliente ` +
        `(${actual ? `${actual.host}:${actual.port}` : "no observable"}): ` +
        `E2E no utiliza otro entorno; revisa DOCKER_HOST.`,
    )
  }
}

/** Conecta con el runtime de contenedores conservando la causa original. */
async function connectRuntime(
  expected: ExpectedRuntime | undefined,
): Promise<ContainerRuntimeClient> {
  let client: ContainerRuntimeClient
  try {
    client = await getContainerRuntimeClient()
  } catch (cause) {
    const detalle = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `No se pudo conectar al runtime de contenedores: ${detalle}. ` +
        `Configura DOCKER_HOST para el runtime de contenedores; E2E no utiliza el entorno dev`,
      { cause },
    )
  }
  if (expected) verifyResolvedRuntime(client, expected)
  return client
}

/** 404 o ya detenido: idempotencia, no un fallo de limpieza. */
function isGone(error: unknown): boolean {
  if (error && typeof error === "object" && "statusCode" in error) {
    return error.statusCode === 404 || error.statusCode === 304
  }
  return false
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Nombres de volúmenes Docker montados en el contenedor (vacío si no hay). */
async function inspectVolumes(client: ContainerRuntimeClient, id: string): Promise<string[]> {
  const info = await client.container.dockerode.getContainer(id).inspect()
  const volumes: string[] = []
  for (const mount of info.Mounts ?? []) {
    if (mount.Name) volumes.push(mount.Name)
  }
  return volumes
}

/**
 * Buckets del run como en producción (`infra/dev/storage-init.sh`): avatares
 * públicos solo bajo `/avatars/*` y con versiones, adjuntos privados con la
 * regla CORS de R2 para el dominio del run. RustFS no da CORS por defecto y
 * sin ella el navegador no sube ni lee adjuntos firmados.
 */
async function prepareBuckets(endpoint: string, origin: string): Promise<void> {
  const client = new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId: STORAGE_ACCESS_KEY, secretAccessKey: STORAGE_SECRET_KEY },
  })
  try {
    for (const bucket of [AVATARS_BUCKET, ATTACHMENTS_BUCKET]) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      } catch (cause) {
        const code =
          cause && typeof cause === "object" && "name" in cause && typeof cause.name === "string"
            ? cause.name
            : undefined
        if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") {
          throw new Error(`S3: no se pudo crear el bucket ${bucket}: ${describe(cause)}`, {
            cause,
          })
        }
      }
    }
    try {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: AVATARS_BUCKET,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      )
    } catch (cause) {
      throw new Error(`S3: no se pudo activar versiones en ${AVATARS_BUCKET}: ${describe(cause)}`, {
        cause,
      })
    }
    try {
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
    } catch (cause) {
      throw new Error(`S3: no se pudo publicar /avatars/*: ${describe(cause)}`, { cause })
    }
    try {
      await client.send(
        new PutBucketCorsCommand({
          Bucket: ATTACHMENTS_BUCKET,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: [origin],
                AllowedMethods: ["GET", "PUT", "HEAD"],
                AllowedHeaders: ["content-type", "range"],
                ExposeHeaders: ["content-length", "content-range", "etag"],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      )
    } catch (cause) {
      throw new Error(`S3: no se pudo poner CORS en ${ATTACHMENTS_BUCKET}: ${describe(cause)}`, {
        cause,
      })
    }
  } finally {
    client.destroy()
  }
}

function startPostgres(labels: Record<string, string>): Promise<StartedTestContainer> {
  return new GenericContainer(PG_IMAGE)
    .withExposedPorts(5432)
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
    .withStartupTimeout(CONTAINER_TIMEOUT_MS)
    .start()
}

function startStorage(labels: Record<string, string>): Promise<StartedTestContainer> {
  return new GenericContainer(STORAGE_IMAGE)
    .withExposedPorts(9000)
    .withLabels(labels)
    .withEnvironment({ RUSTFS_ACCESS_KEY: STORAGE_ACCESS_KEY, RUSTFS_SECRET_KEY: STORAGE_SECRET_KEY })
    .withWaitStrategy(Wait.forHttp("/health", 9000))
    .withStartupTimeout(CONTAINER_TIMEOUT_MS)
    .start()
}

function startMailpit(labels: Record<string, string>): Promise<StartedTestContainer> {
  return new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(8025, 1025)
    .withLabels(labels)
    .withWaitStrategy(Wait.forHttp("/", 8025))
    .withStartupTimeout(CONTAINER_TIMEOUT_MS)
    .start()
}

/**
 * Retira los contenedores del run: handles conocidos más barrido por la
 * etiqueta exacta (cubre recursos creados cuyo handle se perdió). Detiene
 * antes de eliminar con sus volúmenes; 404 o ya detenido es idempotencia.
 * Intenta todas las limpiezas aunque una falle y comunica los pendientes.
 */
async function cleanupContainers(
  client: ContainerRuntimeClient,
  runId: string,
  known: StartedTestContainer[],
  recordVolumes: boolean,
): Promise<void> {
  const failures: string[] = []
  const seen = new Set<string>()
  const entries: Array<{ id: string; volumes: string[] }> = []

  for (const container of known) {
    const id = container.getId()
    seen.add(id)
    let volumes: string[] = []
    try {
      volumes = await inspectVolumes(client, id)
    } catch (cause) {
      if (!isGone(cause)) failures.push(`${id} (inspección: ${describe(cause)})`)
    }
    entries.push({ id, volumes })
    try {
      await container.stop({ timeout: STOP_TIMEOUT_MS, remove: true, removeVolumes: true })
    } catch (cause) {
      if (!isGone(cause)) failures.push(`${id} (cierre: ${describe(cause)})`)
    }
  }

  let swept: string[] = []
  try {
    const list = await client.container.dockerode.listContainers({
      all: true,
      filters: { label: [`${E2E_RUN_LABEL}=${runId}`] },
    })
    swept = list.map((info) => info.Id).filter((id) => !seen.has(id))
  } catch (cause) {
    failures.push(`barrido por etiqueta (listado: ${describe(cause)})`)
  }
  for (const id of swept) {
    const handle = client.container.dockerode.getContainer(id)
    let volumes: string[] = []
    try {
      volumes = await inspectVolumes(client, id)
    } catch (cause) {
      if (!isGone(cause)) failures.push(`${id} (inspección: ${describe(cause)})`)
    }
    entries.push({ id, volumes })
    try {
      await handle.stop({ t: 10 })
    } catch (cause) {
      if (!isGone(cause)) failures.push(`${id} (detención: ${describe(cause)})`)
    }
    try {
      await handle.remove({ v: true })
    } catch (cause) {
      if (!isGone(cause)) failures.push(`${id} (eliminación: ${describe(cause)})`)
    }
  }

  if (recordVolumes && entries.length > 0) {
    try {
      await updateRuntimeMeta(runtimeMetaPath(runId), { containers: entries })
    } catch (cause) {
      failures.push(`metadata (runtime.json: ${describe(cause)})`)
    }
  }
  if (failures.length > 0) {
    const pendientes = [...seen, ...swept].join(", ")
    throw new Error(
      `No se pudo limpiar por completo la infraestructura E2E del run ${runId} ` +
        `(pendientes: ${pendientes || "sin identificar"}): ${failures.join("; ")}. ` +
        `Revisa runtime.json para los IDs.`,
    )
  }
}

/**
 * Arranca la infraestructura del run: valida el runtime, crea los tres
 * contenedores en paralelo, rellena los endpoints en el runtime, registra la
 * metadata y prepara los buckets. Un fallo parcial revierte todo lo iniciado
 * (handles más barrido por etiqueta exacta), conservando el error original.
 */
export async function startStack(runtime: HarnessRuntime): Promise<HarnessStack> {
  const expected = await checkExplicitDockerHost()
  const client = await connectRuntime(expected)
  const labels = { [E2E_LABEL]: "1", [E2E_RUN_LABEL]: runtime.runId }
  const started: StartedTestContainer[] = []

  const fail = async (error: unknown): Promise<never> => {
    let limpieza: string | undefined
    try {
      await cleanupContainers(client, runtime.runId, started, true)
    } catch (cause) {
      limpieza = describe(cause)
    }
    const original = describe(error)
    throw new Error(
      `No se pudo arrancar la infraestructura E2E: ${original}` +
        (limpieza ? `; la limpieza parcial también falló: ${limpieza}` : ""),
      { cause: error },
    )
  }

  try {
    const pending = [startPostgres(labels), startStorage(labels), startMailpit(labels)].map(
      async promise => {
        const container = await promise
        started.push(container)
        updateRuntimeMeta(runtimeMetaPath(runtime.runId), {
          containers: [{ id: container.getId(), volumes: [] }],
        })
        return container
      },
    )
    const results = await Promise.allSettled(pending)
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    if (rejected.length > 0) {
      throw new Error(rejected.map((result) => describe(result.reason)).join("; "), {
        cause: rejected[0]?.reason,
      })
    }
    const [postgres, storage, mailpit] = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    )
    const pgHost = postgres.getHost()
    const storageHost = storage.getHost()
    const mailHost = mailpit.getHost()
    runtime.postgres = { host: pgHost, port: postgres.getMappedPort(5432) }
    runtime.storage = { host: storageHost, port: storage.getMappedPort(9000) }
    runtime.mailpit = {
      host: mailHost,
      httpPort: mailpit.getMappedPort(8025),
      smtpPort: mailpit.getMappedPort(1025),
    }

    await updateRuntimeMeta(runtimeMetaPath(runtime.runId), {
      containers: started.map((container) => ({ id: container.getId(), volumes: [] })),
    })
    await prepareBuckets(
      `http://${runtime.storage.host}:${runtime.storage.port}`,
      `https://*.${runtime.baseDomain}:${runtime.proxyPort}`,
    )
  } catch (error) {
    await fail(error)
  }

  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= cleanupContainers(client, runtime.runId, started, true)
    return closePromise
  }
  return { runtime, close }
}
