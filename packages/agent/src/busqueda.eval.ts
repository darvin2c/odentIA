/**
 * `pnpm --filter @odentia/agent eval:search` — mide la búsqueda en la clínica
 * (ADR 0021) con el banco `eval/busqueda-clinica.json`: cuántas preguntas
 * encuentran lo correcto primero (y entre los tres primeros) buscando solo por
 * palabras, con el doble `fake` y con el proveedor real de `EMBEDDINGS_*`.
 * Después repite con 3 000 servicios de relleno, para ver si encuentra lo
 * mismo y cuánto texto recibe el modelo.
 *
 * Usa una base efímera (necesita el runtime de contenedores, como las pruebas)
 * y nunca datos de pacientes. No forma parte de `pnpm test`.
 */
import { readFileSync } from "node:fs"
import { env } from "node:process"
import { createAppDb, createOwnerDb, type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { orgSpecialty, professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { branch } from "@odentia/db/schema/org"
import {
  createKnowledgeEntry,
  createPromotion,
  formatClinicSearch,
  type MeaningRank,
  rankByMeaning,
  refreshAgentSearch,
  type SearchEmbedder,
  SEARCH_MAX_DISTANCE,
  searchClinic,
  searchPublishedKnowledge,
  setKnowledgeStatus,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, it } from "vitest"
import { embedderFromEnv, fakeEmbedder } from "./embeddings.js"

const IMAGE = "dentalagent-postgres:18.6"
const ORG = "org_busqueda"
const ZONE = { locale: "es-PE", timezone: "America/Lima" }
const RELLENO = 3000

interface Bank {
  servicios: Array<{ nombre: string; especialidad: string; precio: number; dice: "exacto" | "desde" | "evaluacion" }>
  promociones: Array<{ nombre: string; condiciones: string; items: Array<[string, number]> }>
  profesionales: Array<{ nombre: string; especialidades: string[] }>
  respuestas: Array<{ titulo: string; texto: string; formas: string[] }>
  preguntas: Array<{ texto: string; espera?: [string, string]; nada?: boolean }>
}
const bank = JSON.parse(readFileSync(new URL("../eval/busqueda-clinica.json", import.meta.url), "utf8")) as Bank

let container: StartedTestContainer
let ownerDb: Db
let appDb: Db
const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, ORG, fn)

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({ POSTGRES_DB: "dentalagent", POSTGRES_USER: "dentalagent", POSTGRES_PASSWORD: "dentalagent", POSTGRES_APP_PASSWORD: "dentalagent_app" })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  const host = container.getHost()
  const port = container.getMappedPort(5432)
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${host}:${port}/dentalagent`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  appDb = createAppDb(`postgres://dentalagent_app:dentalagent_app@${host}:${port}/dentalagent`)
  await ownerDb.execute(sql`insert into "organization" ("id", "name", "slug", "created_at") values (${ORG}, 'Clínica Sonríe', 'busqueda', now())`)
  await ownerDb.execute(sql`insert into "org_profile" ("organization_id", "legal_name", "trade_name", "country_code", "currency", "timezone", "locale") values (${ORG}, 'Clínica Sonríe', 'Clínica Sonríe', 'PE', 'PEN', 'America/Lima', 'es-PE')`)
  const [sede] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const services = await ownerDb
    .insert(serviceCatalog)
    .values(
      bank.servicios.map((s) => ({
        organizationId: ORG,
        name: s.nombre,
        specialty: s.especialidad,
        scope: "general",
        source: "custom",
        priceCents: s.precio,
        currency: "PEN",
        priceDisclosure: s.dice,
      })),
    )
    .returning({ id: serviceCatalog.id, name: serviceCatalog.name })
  const serviceId = (name: string) => services.find((s) => s.name === name)!.id
  let index = 0
  for (const pro of bank.profesionales) {
    const id = `eval-pro-${index++}`
    await ownerDb.insert(user).values({ id, name: pro.nombre, email: `${id}@example.test` })
    await ownerDb.insert(member).values({ id: `m-${id}`, organizationId: ORG, userId: id, role: "dentist", createdAt: new Date() })
    await ownerDb.insert(professionalSchedule).values({ organizationId: ORG, branchId: sede!.id, dentistUserId: id, weekday: 2, startMin: 540, endMin: 1080 })
    for (const name of pro.especialidades) {
      const key = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_")
      const [specialty] = await ownerDb
        .insert(orgSpecialty)
        .values({ organizationId: ORG, key, name })
        .onConflictDoUpdate({ target: [orgSpecialty.organizationId, orgSpecialty.key], set: { name } })
        .returning({ id: orgSpecialty.id })
      await ownerDb.insert(professionalSpecialty).values({ organizationId: ORG, specialtyId: specialty!.id, userId: id })
    }
  }
  const now = Date.now()
  for (const promo of bank.promociones) {
    await run((tx) =>
      createPromotion(tx, ORG, "eval-pro-0", {
        name: promo.nombre,
        startsAt: new Date(now - 86_400_000).toISOString(),
        endsAt: new Date(now + 30 * 86_400_000).toISOString(),
        conditions: promo.condiciones,
        items: promo.items.map(([name, price]) => ({ serviceId: serviceId(name), mode: "fixed" as const, priceCents: price })),
      }),
    )
  }
  for (const answer of bank.respuestas) {
    const entry = await run((tx) =>
      createKnowledgeEntry(tx, ORG, null, { kind: "faq", title: answer.titulo, body: answer.texto, askForms: answer.formas }),
    )
    await run((tx) => setKnowledgeStatus(tx, ORG, null, entry.id, "publicada"))
  }
})

afterAll(async () => {
  await container?.stop()
})

interface Outcome {
  first: boolean
  top3: boolean
  /** Lo que salió primero, para leer los fallos. */
  got: string
}

/** Cada pregunta se vectoriza una sola vez por modelo, aunque se mida con varios umbrales. */
const vectors = new Map<string, number[]>()
async function vectorOf(embedder: SearchEmbedder, text: string): Promise<number[]> {
  const key = `${embedder.model}|${text}`
  if (!vectors.has(key)) vectors.set(key, (await embedder.embed([text]))[0]!)
  return vectors.get(key)!
}

/** La distancia de lo más cercano, para calibrar el umbral. */
async function nearest(embedder: SearchEmbedder, text: string): Promise<{ distance: number; text: string }> {
  const vector = `[${(await vectorOf(embedder, text)).join(",")}]`
  const rows = (await run((tx) =>
    tx.execute(sql`select text, embedding <=> ${vector}::vector as distance from agent_search_item where organization_id = ${ORG} and model = ${embedder.model} order by distance limit 1`),
  )) as unknown as Array<{ text: string; distance: number }>
  return { distance: Number(rows[0]?.distance ?? 1), text: rows[0]?.text ?? "" }
}

let threshold = SEARCH_MAX_DISTANCE

async function ask(question: Bank["preguntas"][number], embedder: SearchEmbedder | null): Promise<Outcome & { chars: number }> {
  let ranked: MeaningRank | undefined
  if (embedder) {
    const vector = await vectorOf(embedder, question.texto)
    ranked = await run((tx) => rankByMeaning(tx, ORG, { model: embedder.model, embedding: vector }, 8, threshold))
  }
  const found = await run((tx) =>
    searchClinic(tx, ORG, question.texto, {
      rankedServiceIds: ranked?.services,
      rankedPromotionIds: ranked?.promotions,
      rankedProfessionalIds: ranked?.professionals,
    }),
  )
  const answers = await run((tx) => searchPublishedKnowledge(tx, ORG, question.texto, 5, ranked?.answers))
  const chars = formatClinicSearch(found, ZONE).length
  const lists: Record<string, string[]> = {
    servicio: found.services.map((s) => s.name),
    promocion: found.promotions.map((p) => p.name),
    profesional: found.professionals.map((p) => p.name),
    respuesta: answers.map((a) => a.title),
  }
  if (question.nada) {
    const any = Object.values(lists).flat()
    return { first: any.length === 0, top3: any.length === 0, got: any.slice(0, 2).join(" · ") || "(nada)", chars }
  }
  const [kind, name] = question.espera!
  const list = lists[kind] ?? []
  return { first: list[0] === name, top3: list.slice(0, 3).includes(name), got: list[0] ?? "(nada)", chars }
}

async function measure(label: string, embedder: SearchEmbedder | null) {
  const rows: Array<{ pregunta: string; espera: string; ok1: boolean; ok3: boolean; got: string; chars: number }> = []
  for (const question of bank.preguntas) {
    const out = await ask(question, embedder)
    rows.push({
      pregunta: question.texto,
      espera: question.nada ? "(nada)" : question.espera![1],
      ok1: out.first,
      ok3: out.top3,
      got: out.got,
      chars: out.chars,
    })
  }
  const answerable = rows.filter((row) => row.espera !== "(nada)")
  const empty = rows.filter((row) => row.espera === "(nada)")
  const first = answerable.filter((row) => row.ok1).length
  const top3 = answerable.filter((row) => row.ok3).length
  const quiet = empty.filter((row) => row.ok1).length
  console.log(
    `\n=== ${label} ===\nPrimero correcto: ${first}/${answerable.length} · Entre los tres primeros: ${top3}/${answerable.length} · Sin nada cuando no hay nada: ${quiet}/${empty.length} · Texto al modelo por búsqueda (promedio): ${Math.round(rows.reduce((sum, row) => sum + row.chars, 0) / rows.length)} caracteres`,
  )
  for (const row of rows.filter((r) => !r.ok1)) {
    console.log(`  ✗ «${row.pregunta}» → esperaba ${row.espera}; salió ${row.got}${row.ok3 ? " (estaba entre los tres primeros)" : ""}`)
  }
  return { first, top3, quiet, total: answerable.length }
}

const real = embedderFromEnv(env)
const isReal = real && real.model !== fakeEmbedder().model

it("búsqueda en la clínica: palabras, doble y proveedor real", async () => {
  console.log(`Umbral de distancia: ${SEARCH_MAX_DISTANCE}. Proveedor real: ${isReal ? real!.model : "no configurado (EMBEDDINGS_*)"}`)
  await measure("Solo palabras (como antes)", null)
  const fake = fakeEmbedder()
  await refreshAgentSearch(ownerDb, appDb, fake, { maxBatchesPerOrg: 100 })
  await measure(`Doble ${fake.model} + palabras`, fake)
  if (!isReal) return
  const started = Date.now()
  const summary = await refreshAgentSearch(ownerDb, appDb, real!, { maxBatchesPerOrg: 100 })
  console.log(`\nVectorizados con ${real!.model}: ${summary.embedded} en ${((Date.now() - started) / 1000).toFixed(1)} s (sin vector: ${summary.failed})`)
  await measure(`${real!.model} + palabras (lo nuevo)`, real!)

  // Calibrar el umbral: distancia de lo más cercano, en preguntas con respuesta y sin ella.
  console.log("\nDistancia de lo más cercano (menor = más parecido):")
  for (const question of bank.preguntas) {
    const near = await nearest(real!, question.texto)
    console.log(`  ${near.distance.toFixed(3)}  ${question.nada ? "[sin respuesta] " : ""}«${question.texto}» → ${near.text.slice(0, 60)}`)
  }
  for (const value of [0.5, 0.55, 0.6, 0.65]) {
    threshold = value
    await measure(`${real!.model}, umbral ${value}`, real!)
  }
  threshold = SEARCH_MAX_DISTANCE

  // Una clínica grande: 3 000 servicios parecidos de relleno.
  const procs = ["Resina", "Corona metal-porcelana", "Incrustación", "Perno muñón", "Endodoncia", "Exodoncia", "Sellante", "Carilla de porcelana", "Puente fijo", "Gingivectomía"]
  const extra = Array.from({ length: RELLENO }, (_, i) => ({
    organizationId: ORG,
    name: `${procs[i % procs.length]} pieza ${11 + (i % 38)} variante ${Math.floor(i / 380) + 1}`,
    specialty: "general",
    scope: "tooth",
    source: "custom",
    priceCents: 10000 + (i % 50) * 1000,
    currency: "PEN",
    priceDisclosure: "exacto",
  }))
  for (let i = 0; i < extra.length; i += 500) await ownerDb.insert(serviceCatalog).values(extra.slice(i, i + 500))
  const bigStarted = Date.now()
  const big = await refreshAgentSearch(ownerDb, appDb, real!, { maxBatchesPerOrg: 200 })
  console.log(`\nClínica con ${RELLENO + bank.servicios.length} servicios: vectorizados ${big.embedded} más en ${((Date.now() - bigStarted) / 1000).toFixed(1)} s`)
  await measure(`${real!.model} con ${RELLENO} servicios de relleno`, real!)
  await measure(`Solo palabras con ${RELLENO} servicios de relleno`, null)
})
