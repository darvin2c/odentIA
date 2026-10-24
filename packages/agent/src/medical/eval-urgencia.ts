/**
 * Calibración del umbral de urgencias en un consultorio (issue 229). Uso:
 *
 *   pnpm --filter @odentia/agent eval:urgencia-medica -- --provider=jev [--repeats=3] [--file=eval/urgencias-medicas.json]
 *
 * Pasa cada mensaje por el modelo de decisión con las preguntas de latidIA y
 * toma la nota de urgencia (0 a 2). Las señales de alarma no dependen de esa
 * nota (las detecta `hasAlarmSignal` antes), así que solo se comprueba que las
 * detecte. Para cada umbral posible cuenta cuántos urgentes marca y cuántos
 * de hoy o de rutina marca de más, y propone el más alto que marca todos los
 * urgentes con el menor número de falsos. Hoy rige `URGENT_SCORE`. No toca
 * ninguna base ni envía nada; es evidencia de este conjunto, no del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { agentTextsFor } from "@odentia/services"
import { hasAlarmSignal } from "../alarm.js"
import { createDecisionModel, type DecisionProvider } from "../decision/index.js"
import { triageQuestions, triageState } from "../decision/points.js"
import { answerOf } from "../decision/port.js"
import { URGENT_SCORE } from "../decision/route.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"

interface Message {
  mensaje: string
  /** Urgente: hay que atender ya. Hoy: necesita atención pronto. Rutina: sin apuro. */
  nivel: "urgente" | "hoy" | "rutina"
  /** La detecta `hasAlarmSignal`: no pasa por la nota de urgencia. */
  alarma?: boolean
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const provider = arg("provider", "jev") as DecisionProvider
const repeats = Number(arg("repeats", "3"))
const messages = JSON.parse(
  readFileSync(resolve(arg("file", "eval/urgencias-medicas.json")), "utf8"),
) as Message[]
const texts = agentTextsFor("medical")

const env = process.env
const decision = await createDecisionModel(
  provider,
  {
    ...(env.JEV_API_KEY
      ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } }
      : {}),
    timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 5000),
  },
  resolveLlmSpec(platformLlmFromEnv(env)),
)
if (!decision) throw new Error("Elige un proveedor distinto de none")

// Las alarmas: solo si las reglas las detectan, sin preguntar al modelo.
for (const message of messages.filter((m) => m.alarma)) {
  if (!hasAlarmSignal(message.mensaje, texts.alarmSignals))
    console.log(`  ALARMA NO DETECTADA: «${message.mensaje}»`)
}
const scored = messages.filter((m) => !m.alarma)

// La nota de cada mensaje: el promedio de las repeticiones, y la más baja (la que decide si se escapa).
const scores: Array<Message & { mean: number; min: number; max: number }> = []
for (const message of scored) {
  const values: number[] = []
  for (let i = 0; i < repeats; i += 1) {
    const result = await decision.decide(triageState([], message.mensaje), triageQuestions(texts))
    const urgency = answerOf(result, "urgency", "score")
    if (urgency) values.push(urgency.score)
  }
  if (values.length === 0) {
    console.log(`  SIN NOTA: «${message.mensaje}»`)
    continue
  }
  scores.push({
    ...message,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  })
}

console.log(
  `Proveedor ${decision.provider} · ${scores.length} mensajes con nota · ${repeats} repetición(es) · hoy URGENT_SCORE = ${URGENT_SCORE}`,
)
for (const level of ["urgente", "hoy", "rutina"] as const) {
  console.log(`\n${level}:`)
  for (const item of scores.filter((s) => s.nivel === level).sort((a, b) => a.min - b.min)) {
    console.log(`  ${item.min.toFixed(2)}–${item.max.toFixed(2)}  «${item.mensaje}»`)
  }
}

// Cada umbral con la nota más baja de cada mensaje para los urgentes (que no se escape ninguno)
// y la más alta para los demás (que no se marque de más ni una vez).
const urgent = scores.filter((s) => s.nivel === "urgente")
const others = scores.filter((s) => s.nivel !== "urgente")
const rows: Array<{ threshold: number; caught: number; extra: number; extraHoy: number }> = []
for (let t = 0.8; t <= 2.0001; t += 0.1) {
  const threshold = Math.round(t * 10) / 10
  rows.push({
    threshold,
    caught: urgent.filter((s) => s.min >= threshold).length,
    extra: others.filter((s) => s.max >= threshold).length,
    extraHoy: others.filter((s) => s.max >= threshold && s.nivel === "hoy").length,
  })
}
console.log(
  `\numbral  urgentes marcados (de ${urgent.length})  de más (de ${others.length}; de ellos «hoy»)`,
)
for (const row of rows)
  console.log(
    `  ${row.threshold.toFixed(1)}    ${String(row.caught).padStart(2)}                        ${row.extra} (${row.extraHoy})`,
  )

const full = rows.filter((row) => row.caught === urgent.length)
const best = full.sort((a, b) => a.extra - b.extra || b.threshold - a.threshold)[0]
console.log(
  best
    ? `\nPropuesta: ${best.threshold.toFixed(1)} marca los ${urgent.length} urgentes y ${best.extra} de más.`
    : "\nNingún umbral marca todos los urgentes: revisar la pregunta de urgencia, no solo el número.",
)
