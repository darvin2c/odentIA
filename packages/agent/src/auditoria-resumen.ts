/**
 * Resumen de rondas de `auditoria-masiva.ts` con la misma vara (issue #328):
 * el porcentaje de cada criterio sin contar los que no aplican, cuántas
 * conversaciones cumplen todo, cómo les va a las de más de 20 mensajes y lo
 * que costó cada una. Una columna por ronda, para compararlas.
 *
 *   tsx src/auditoria-resumen.ts <carpeta de la ronda> [<otra ronda> …]
 *
 * Solo lee lo que dejó la auditoría; no llama a ningún modelo.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

interface Conversation {
  index?: number
  persona?: { por_que_escribe?: string }
  transcript?: Array<{ from: string; text: string }>
  verdict?: Record<string, unknown> | null
  cost?: { corridas?: number; entrada?: number; usd?: number } | null
}

/** Los criterios del juez, en el orden del issue; en `dijo_algo…` lo bueno es «no». */
const CRITERIA: Array<{ key: string; label: string; good: boolean }> = [
  { key: "espero", label: "Esperó", good: true },
  { key: "sabe_con_quien", label: "Sabe con quién", good: true },
  { key: "entendio", label: "Entendió", good: true },
  { key: "resolvio_o_paso_con_motivo", label: "Resolvió o pasó con motivo", good: true },
  { key: "fluida", label: "Fluida", good: true },
  { key: "dijo_algo_interno_falso_o_contradictorio", label: "Sin nada interno ni falso", good: false },
  { key: "emergencia_bien", label: "Emergencia bien", good: true },
]

/** Una conversación «larga» pasa del tope que tenía la ventana fija de mensajes. */
const LONG_MESSAGES = 20

function readRound(folder: string): { name: string; items: Conversation[]; errors: number } {
  if (!existsSync(folder)) throw new Error(`No existe la carpeta ${folder}`)
  const files = readdirSync(folder)
  const items = files
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")) as Conversation)
  return { name: basename(folder), items, errors: files.filter((file) => file.endsWith(".error.txt")).length }
}

/**
 * Intervalo de Wilson al 95 %: con 40 conversaciones el margen es de unos 15
 * puntos, así que una diferencia menor entre rondas no dice nada por sí sola.
 */
function wilson(part: number, whole: number): [number, number] {
  const z = 1.96
  const p = part / whole
  const scale = 1 + z ** 2 / whole
  const center = (p + z ** 2 / (2 * whole)) / scale
  const margin = (z * Math.sqrt((p * (1 - p)) / whole + z ** 2 / (4 * whole ** 2))) / scale
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

function percent(part: number, whole: number): string {
  if (!whole) return "—"
  const [low, high] = wilson(part, whole)
  return `${Math.round((part / whole) * 100)} % (${part}/${whole}; ${Math.round(low * 100)}–${Math.round(high * 100)} %)`
}

/** El mismo caso en dos rondas (`CASOS` de auditoria-masiva.ts): su número y por qué escribe. */
const caseKey = (item: Conversation) => `${item.index ?? "?"}·${item.persona?.por_que_escribe ?? ""}`

/** Con los mismos casos, cuántos mejoraron y cuántos empeoraron frente a la primera ronda. */
function paired(first: Conversation[], round: Conversation[], key: string): string | null {
  const before = new Map(first.filter((item) => typeof item.verdict?.[key] === "boolean").map((item) => [caseKey(item), item.verdict?.[key]]))
  let pairs = 0
  let better = 0
  let worse = 0
  for (const item of round) {
    const was = before.get(caseKey(item))
    const now = item.verdict?.[key]
    if (typeof was !== "boolean" || typeof now !== "boolean") continue
    pairs += 1
    if (!was && now) better += 1
    if (was && !now) worse += 1
  }
  return pairs ? `mejoró en ${better}, empeoró en ${worse} (de ${pairs} casos)` : null
}

/** Cuántas cumplen el criterio entre las que el juez calificó (sin `null`). */
function criterion(items: Conversation[], key: string, good: boolean): string {
  const rated = items.filter((item) => typeof item.verdict?.[key] === "boolean")
  return percent(rated.filter((item) => item.verdict?.[key] === good).length, rated.length)
}

function summary(round: ReturnType<typeof readRound>): Record<string, string> {
  const judged = round.items.filter((item) => item.verdict)
  const long = judged.filter((item) => (item.transcript?.length ?? 0) > LONG_MESSAGES)
  const costed = round.items.filter((item) => typeof item.cost?.usd === "number")
  const average = (pick: (item: Conversation) => number) =>
    costed.length ? costed.reduce((sum, item) => sum + pick(item), 0) / costed.length : null
  const usd = average((item) => item.cost?.usd ?? 0)
  const input = average((item) => item.cost?.entrada ?? 0)
  const runs = average((item) => item.cost?.corridas ?? 0)
  const row: Record<string, string> = { Conversaciones: `${judged.length} juzgadas${round.errors ? `, ${round.errors} con error` : ""}` }
  for (const { key, label, good } of CRITERIA) row[label] = criterion(judged, key, good)
  row["Cumple todo"] = percent(judged.filter((item) => item.verdict?.cumple === true).length, judged.length)
  row[`Fluida con más de ${LONG_MESSAGES} mensajes`] = criterion(long, "fluida", true)
  row["Costo por conversación"] = usd === null ? "—" : `USD ${usd.toFixed(4)}`
  row["Tokens de entrada por conversación"] = input === null ? "—" : Math.round(input).toLocaleString("es-PE")
  row["Corridas por conversación"] = runs === null ? "—" : runs.toFixed(1)
  return row
}

const folders = process.argv.slice(2)
if (folders.length === 0) {
  console.error("Uso: tsx src/auditoria-resumen.ts <carpeta de la ronda> [<otra ronda> …]")
  process.exit(1)
}
const read = folders.map(readRound)
const rounds = read.map((round, position) => {
  const row = summary(round)
  // Lo pareado solo existe con los mismos casos que la primera ronda.
  const first = read[0]
  if (position > 0 && first) {
    row["Cumple todo, caso por caso frente a la primera"] = paired(first.items, round.items, "cumple") ?? "—"
    row["Fluida, caso por caso frente a la primera"] = paired(first.items, round.items, "fluida") ?? "—"
  } else {
    row["Cumple todo, caso por caso frente a la primera"] = "(referencia)"
    row["Fluida, caso por caso frente a la primera"] = "(referencia)"
  }
  return { name: round.name, row }
})
const labels = Object.keys(rounds[0]?.row ?? {})
console.log(`| Criterio | ${rounds.map((round) => round.name).join(" | ")} |`)
console.log(`|---|${rounds.map(() => "---").join("|")}|`)
for (const label of labels) console.log(`| ${label} | ${rounds.map((round) => round.row[label] ?? "—").join(" | ")} |`)
