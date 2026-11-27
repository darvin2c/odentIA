/**
 * El control que se indicó para la próxima sesión de un tratamiento («vuelva en una semana para la
 * segunda sesión», QA del 26 nov, H6). Si ese tratamiento termina con esta firma («Sí, terminar»),
 * el control ya no tiene a qué volver: el cierre lo dice como sugerencia junto a su «Quitar», y
 * quien firma decide. El sistema no lo quita solo.
 *
 * No hay un vínculo guardado entre el control dictado y la sesión (Clío lo crea como control suelto):
 * se reconoce por lo dicho, con su título o la frase de donde salió, y por el tratamiento trabajado hoy.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { normalizeForSearch } from "./knowledge.js"

/** Lo trabajado hoy de un tratamiento: su sesión de hoy (`n`) de las previstas (`m`). */
export interface WorkedSession {
  planItemId: string
  title: string
  n: number
  m: number
}

/** El tratamiento y la sesión para la que era el control. */
export interface ControlForSession {
  planItemId: string
  /** El nombre del tratamiento, como en su plan: «Endodoncia». */
  title: string
  /** La sesión para la que era: la 2 de «segunda sesión». */
  session: number
}

const ORDINALS: Record<string, number> = {
  primera: 1,
  segunda: 2,
  tercera: 3,
  cuarta: 4,
  quinta: 5,
  sexta: 6,
  septima: 7,
  setima: 7,
  octava: 8,
  novena: 9,
  decima: 10,
}

/** Palabras que no nombran un tratamiento: «Control de la endodoncia» lo nombra por «endodoncia». */
const NOT_NAMING = new Set(["control", "tratamiento", "sesion", "sesiones", "pieza", "piezas", "para", "con", "del", "las", "los", "una"])

/** La sesión dicha: «segunda sesión», «sesión 2», «2da sesión»; `next` si solo dice «la próxima/otra sesión». */
function saidSession(words: readonly string[]): number | "next" | null {
  let found: number | "next" | null = null
  words.forEach((word, index) => {
    if (word !== "sesion" || found !== null) return
    const before = words[index - 1] ?? ""
    const after = words[index + 1] ?? ""
    const ordinal = ORDINALS[before] ?? Number(/^(\d{1,2})(?:da|ra|ta|va|na|a)?$/.exec(before)?.[1] ?? Number.NaN)
    if (Number.isInteger(ordinal) && ordinal > 0) found = ordinal
    else if (/^\d{1,2}$/.test(after)) found = Number(after)
    else if (after === "numero" && /^\d{1,2}$/.test(words[index + 2] ?? "")) found = Number(words[index + 2])
    else found = "next"
  })
  return found
}

/**
 * ¿Para qué sesión de lo trabajado hoy era este control? Lo dicho tiene que hablar de una sesión
 * («segunda sesión», «la próxima sesión»); el tratamiento es el que nombra (o al que está ligado),
 * o el único trabajado hoy. Una sesión ya hecha («la primera», hoy la 1) no es para lo que sigue.
 */
export function sessionControlOf(
  texts: readonly (string | null | undefined)[],
  sessions: readonly WorkedSession[],
  linkedPlanItemId: string | null = null,
): ControlForSession | null {
  if (sessions.length === 0) return null
  const words = normalizeForSearch(texts.filter(Boolean).join(" ")).split(" ")
  const said = saidSession(words)
  if (said === null) return null
  const heard = new Set(words)
  const names = (session: WorkedSession) =>
    session.planItemId === linkedPlanItemId ||
    normalizeForSearch(session.title)
      .split(" ")
      .some((word) => word.length >= 4 && !NOT_NAMING.has(word) && heard.has(word))
  const named = sessions.filter(names)
  const target = named.length === 1 ? named[0] : named.length === 0 && sessions.length === 1 ? sessions[0] : undefined
  if (!target) return null
  const session = said === "next" ? target.n + 1 : said
  if (session <= target.n) return null
  return { planItemId: target.planItemId, title: target.title, session }
}

/**
 * Los controles abiertos, pendientes y sin cita, que se indicaron para la próxima sesión de un
 * tratamiento trabajado hoy: por id, el tratamiento y la sesión. Lo dicho es su título, sus
 * indicaciones y, si salió del dictado, la frase de donde salió.
 */
export async function controlsForSessionOf(
  tx: Db,
  orgId: string,
  patientId: string,
  controlIds: readonly string[],
  sessions: readonly WorkedSession[],
): Promise<Map<string, ControlForSession>> {
  const out = new Map<string, ControlForSession>()
  if (controlIds.length === 0 || sessions.length === 0) return out
  const rows = await tx.execute<{ id: string; title: string; instructions: string | null; plan_item_id: string | null; said: string | null }>(sql`
    select f.id, f.title, f.instructions, f.plan_item_id,
      (select string_agg(s.source_text, ' ') from encounter_dictation_suggestion s
        where s.organization_id = f.organization_id and s.kind = 'control' and s.entity_id = f.id) as said
    from clinical_follow_up f
    where f.organization_id = ${orgId} and f.patient_id = ${patientId}
      and f.status = 'pendiente' and f.appointment_id is null
      and f.id in (${sql.join(
        controlIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`)
  for (const row of rows) {
    const found = sessionControlOf([row.title, row.instructions, row.said], sessions, row.plan_item_id)
    if (found) out.set(row.id, found)
  }
  return out
}
