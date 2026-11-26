/**
 * El examen físico por sistemas de latidIA (issue 229, decisiones 4 y 5).
 * Cada sistema se marca «Sin alteraciones» o «Con hallazgos», y el hallazgo
 * se escribe con la parte del cuerpo («Adenopatías submandibulares…»). Lo
 * que no se marca queda «No examinado», nunca normal: es el `not-performed`
 * de HL7 FHIR (data-absent-reason).
 *
 * Se guarda en `encounter.examination` como `{ sistemas: { piel: { estado,
 * hallazgo? } } }`; un sistema sin marcar no se guarda.
 */

export const EXAM_SYSTEMS = [
  { key: "estadoGeneral", label: "Estado general" },
  { key: "piel", label: "Piel" },
  { key: "cabezaCuello", label: "Cabeza y cuello" },
  { key: "bocaGarganta", label: "Boca y garganta" },
  { key: "toraxPulmones", label: "Tórax y pulmones" },
  { key: "corazon", label: "Corazón" },
  { key: "abdomen", label: "Abdomen" },
  { key: "genitourinario", label: "Genital y urinario" },
  { key: "extremidades", label: "Extremidades" },
  { key: "neurologico", label: "Neurológico" },
] as const

export type ExamSystemKey = (typeof EXAM_SYSTEMS)[number]["key"]

export const EXAM_STATES = ["sin_alteraciones", "con_hallazgos"] as const
export type ExamState = (typeof EXAM_STATES)[number]

export const EXAM_STATE_LABELS: Record<ExamState | "no_examinado", string> = {
  sin_alteraciones: "Sin alteraciones",
  con_hallazgos: "Con hallazgos",
  no_examinado: "No examinado",
}

/** Lo que se escribe de un hallazgo, como los demás textos cortos de la atención. */
export const EXAM_FINDING_MAX = 1000

export interface ExamSystemEntry {
  estado: ExamState
  /**
   * Lo que encontró, con sus palabras; puede faltar mientras se escribe. Lo normal también guarda lo
   * que se dijo («Lasègue negativo»): el estado no reemplaza las palabras del médico (revisión del 26 nov).
   */
  hallazgo?: string
}

export interface SystemsExam {
  sistemas: Partial<Record<ExamSystemKey, ExamSystemEntry>>
}

/** Un sistema en la historia: lo marcado o «No examinado». */
export interface ExamSystemReading {
  key: ExamSystemKey
  label: string
  state: ExamState | "no_examinado"
  finding: string | null
}

function isSystem(key: string): key is ExamSystemKey {
  return EXAM_SYSTEMS.some((system) => system.key === key)
}

/**
 * Valida y limpia el examen: solo sistemas conocidos, cada uno con su estado y,
 * con hallazgos, el texto recortado. Sin ningún sistema marcado, null.
 */
export function parseSystemsExam(
  input: unknown,
): { ok: true; value: SystemsExam | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (typeof input !== "object" || Array.isArray(input))
    return { ok: false, error: "El examen debe ser un objeto" }
  const { sistemas, ...rest } = input as Record<string, unknown>
  const extra = Object.keys(rest)[0]
  if (extra) return { ok: false, error: `El examen no tiene el campo ${extra}` }
  if (sistemas === null || sistemas === undefined) return { ok: true, value: null }
  if (typeof sistemas !== "object" || Array.isArray(sistemas))
    return { ok: false, error: "Los sistemas del examen deben ser un objeto" }
  const out: SystemsExam["sistemas"] = {}
  for (const [key, raw] of Object.entries(sistemas as Record<string, unknown>)) {
    if (!isSystem(key)) return { ok: false, error: `Sistema desconocido: ${key}` }
    if (raw === null || raw === undefined) continue
    if (typeof raw !== "object" || Array.isArray(raw))
      return { ok: false, error: `${labelOf(key)}: falta si tiene hallazgos` }
    const { estado, hallazgo } = raw as Record<string, unknown>
    if (!(EXAM_STATES as readonly unknown[]).includes(estado))
      return {
        ok: false,
        error: `${labelOf(key)}: el estado es «Sin alteraciones» o «Con hallazgos»`,
      }
    if (hallazgo !== undefined && hallazgo !== null && typeof hallazgo !== "string")
      return { ok: false, error: `${labelOf(key)}: el hallazgo es un texto` }
    const text = typeof hallazgo === "string" ? hallazgo.trim() : ""
    if (text.length > EXAM_FINDING_MAX)
      return {
        ok: false,
        error: `${labelOf(key)}: el hallazgo tiene hasta ${EXAM_FINDING_MAX} caracteres`,
      }
    // Lo normal también guarda lo que se dijo («Lasègue negativo»), si se dijo.
    out[key] = text ? { estado: estado as ExamState, hallazgo: text } : { estado: estado as ExamState }
  }
  return { ok: true, value: Object.keys(out).length > 0 ? { sistemas: out } : null }
}

function labelOf(key: ExamSystemKey): string {
  return EXAM_SYSTEMS.find((system) => system.key === key)?.label ?? key
}

/**
 * Lo dictado de un sistema se suma a lo que ya tenía, sin pisarlo (ADR 0012,
 * actualización del 2026-10-24): lo nuevo que se dijo se agrega al texto que ya
 * estaba, y un «sin alteraciones» dictado no borra un hallazgo que ya estaba. Lo
 * normal dicho con palabras («Lasègue negativo») las guarda. La usan el servidor
 * al confirmar y la pantalla al reflejarlo, para que digan lo mismo.
 */
export function mergeDictatedSystem(
  exam: SystemsExam | null,
  system: ExamSystemKey,
  dictated: ExamSystemEntry,
): SystemsExam {
  const current = exam?.sistemas[system]
  const had = (current?.hallazgo ?? "").trim()
  const said = (dictated.hallazgo ?? "").trim()
  // Lo mismo dicho otra vez es lo que ya está, frase por frase: «edema» no es «Sin edema».
  const same = (a: string, b: string) => a.toLocaleLowerCase("es").replace(/\s+/g, " ") === b.toLocaleLowerCase("es").replace(/\s+/g, " ")
  const text = !said ? had : !had ? said : had.split(";").some((part) => same(part.trim(), said)) ? had : `${had}; ${said}`.slice(0, EXAM_FINDING_MAX)
  // Con un hallazgo, de antes o dictado, el sistema queda con hallazgos: lo normal dicho no lo borra.
  const estado: ExamState = current?.estado === "con_hallazgos" || dictated.estado === "con_hallazgos" ? "con_hallazgos" : "sin_alteraciones"
  const entry: ExamSystemEntry = text ? { estado, hallazgo: text } : { estado }
  return { sistemas: { ...(exam?.sistemas ?? {}), [system]: entry } }
}

/**
 * El sistema con el estado que se eligió a mano. De «con hallazgos» a «sin alteraciones» se borra lo
 * que encontró: no queda «Cardiovascular, sin alteraciones: edema en MMII» (revisión de código del 26
 * nov). Lo normal dicho con sus palabras («Lasègue negativo») se conserva, y lo escrito también al pasar
 * a «con hallazgos».
 */
export function withExamState(entry: ExamSystemEntry | undefined, estado: ExamState): ExamSystemEntry {
  const kept = entry?.estado === "con_hallazgos" && estado === "sin_alteraciones" ? "" : (entry?.hallazgo ?? "")
  return kept ? { estado, hallazgo: kept } : { estado }
}

/** Lo guardado, leído sin fallar: lo que no se entiende queda «No examinado». */
export function readSystemsExam(value: unknown): SystemsExam | null {
  const parsed = parseSystemsExam(value)
  return parsed.ok ? parsed.value : null
}

/** Cada sistema, en su orden, con lo marcado o «No examinado». */
export function examReadings(exam: SystemsExam | null): ExamSystemReading[] {
  return EXAM_SYSTEMS.map(({ key, label }) => {
    const entry = exam?.sistemas[key]
    return {
      key,
      label,
      state: entry?.estado ?? "no_examinado",
      finding: entry?.hallazgo ?? null,
    }
  })
}

/** Cuántos se examinaron, cuántos con hallazgos y cuántos quedan sin examinar. */
export function examCounts(exam: SystemsExam | null): {
  examined: number
  findings: number
  notExamined: number
} {
  const readings = examReadings(exam)
  const examined = readings.filter((r) => r.state !== "no_examinado").length
  return {
    examined,
    findings: readings.filter((r) => r.state === "con_hallazgos").length,
    notExamined: readings.length - examined,
  }
}

/** «Marcar el resto sin alteraciones»: lo no examinado pasa a sin alteraciones; lo marcado no cambia. */
export function markRestNormal(exam: SystemsExam | null): SystemsExam {
  const sistemas: SystemsExam["sistemas"] = { ...exam?.sistemas }
  for (const { key } of EXAM_SYSTEMS) sistemas[key] ??= { estado: "sin_alteraciones" }
  return { sistemas }
}

/** El resumen de una línea: «2 sistemas con hallazgos», «6 sistemas sin alteraciones». */
export function examSummary(exam: SystemsExam | null): string {
  const { examined, findings } = examCounts(exam)
  if (examined === 0) return ""
  if (findings > 0)
    return findings === 1 ? "1 sistema con hallazgos" : `${findings} sistemas con hallazgos`
  return examined === 1 ? "1 sistema sin alteraciones" : `${examined} sistemas sin alteraciones`
}

/**
 * El examen en la historia, en líneas: cada hallazgo en la suya, lo normal dicho
 * con palabras también en la suya («Neurológico, sin alteraciones: Lasègue
 * negativo»), y juntos los demás sin alteraciones y los no examinados. Sin nada
 * marcado, ninguna.
 */
export function examLines(exam: SystemsExam | null): string[] {
  const readings = examReadings(exam)
  if (readings.every((r) => r.state === "no_examinado")) return []
  const names = (state: ExamSystemReading["state"]) =>
    readings.filter((r) => r.state === state).map((r) => r.label)
  const lines = readings
    .filter((r) => r.state === "con_hallazgos")
    .map((r) => `${r.label}: ${r.finding ?? "con hallazgos, sin describir"}`)
  for (const r of readings)
    if (r.state === "sin_alteraciones" && r.finding)
      lines.push(`${r.label}, ${EXAM_STATE_LABELS.sin_alteraciones.toLowerCase()}: ${r.finding}`)
  const normal = readings.filter((r) => r.state === "sin_alteraciones" && !r.finding).map((r) => r.label)
  if (normal.length) lines.push(`Sin alteraciones: ${normal.join(", ")}`)
  const missing = names("no_examinado")
  if (missing.length) lines.push(`No examinado: ${missing.join(", ")}`)
  return lines
}
