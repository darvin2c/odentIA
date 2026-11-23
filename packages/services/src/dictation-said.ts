import type { Db } from "@odentia/db"
import { type DictationSpeaker, type DictationTurn, type DictationUnusedItem, encounter, encounterDictationSegment, encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import { DICTATION_CHARS, dictationSegmentSeen, requireClinicalAssistant } from "./encounter-dictation.js"
import type { ProductDictation } from "./product-hooks.js"
import { assertOpenDraft, lockEncounter } from "./encounters.js"
import { notFound } from "./errors.js"
import { normalizeForSearch } from "./knowledge.js"

/*
 * ---------- «Lo que se dijo»: cada tramo del dictado, guardado con la atención (ADR 0209) ----------
 *
 * Antes lo dicho vivía solo en la pestaña: al recargar se perdía y la pausa siguiente iba sin
 * contexto, y un tramo que no dejó sugerencias se volvía a mandar al modelo al reintentarlo
 * (mesa del 20 nov 2026, «Clío en una consulta conversada»). Ahora cada tramo se guarda antes de
 * ordenarlo, el contexto de la pausa sale de aquí y su identidad dice si ya se ordenó.
 */

/** Lo último ya dicho que acompaña a cada tramo, para entender a qué se refiere (el mismo largo que mandaba la pantalla). */
export const DICTATION_CONTEXT_CHARS = 600
/** Tramos anteriores que se leen para armar el contexto: de sobra para sus 600 caracteres. */
const CONTEXT_SEGMENTS = 40

/**
 * El final de lo dicho antes, en palabras enteras. Lo guardado puede pasar con creces lo que
 * acepta una pausa: se toma lo último.
 */
export function dictationContext(earlier: readonly string[], max = DICTATION_CONTEXT_CHARS): string {
  const all = earlier.map((text) => text.trim()).filter(Boolean).join(" ")
  if (all.length <= max) return all
  const tail = all.slice(-max)
  // Si el corte cae a mitad de una palabra, empieza en la siguiente.
  const cut = /\s/.test(all[all.length - max - 1] ?? " ") ? 0 : tail.search(/\s/) + 1
  return tail.slice(cut).trim()
}

/**
 * Cuánto dura la marca de «en curso» de un tramo o de un repaso (revisión del 21 nov, C1): lo que
 * tarda de sobra una llamada al modelo. Pasado eso, un pedido que se cortó sin avisar no deja el
 * tramo trabado: otro lo puede volver a intentar.
 */
export const DICTATION_IN_PROGRESS_MS = 60_000
const inProgress = (at: Date | null) => at !== null && Date.now() - at.getTime() < DICTATION_IN_PROGRESS_MS

/** Lo que dice `startDictationSegment`: si ya se ordenó, si se está ordenando y lo dicho antes. */
export interface DictationSegmentStart {
  /** Lo que dicta su producto: la ruta no lo vuelve a pedir. */
  dictation: ProductDictation
  repeated: boolean
  /** Otro pedido del mismo tramo lo está ordenando: este no llama al modelo, espera. */
  inProgress: boolean
  context: string
}

/**
 * Antes de llamar al modelo: guarda el tramo tal cual llegó y dice si ya se ordenó (otra
 * pestaña, el reintento automático), con el contexto de lo dicho antes en la atención. Solo
 * quien lleva la atención en borrador dicta en ella. Un tramo guardado que no se llegó a ordenar
 * (el proveedor falló) se puede volver a intentar, con el contexto de cuando se dijo.
 *
 * Mientras un pedido lo ordena, el tramo queda «en curso» (`organizing_at`): el segundo pedido del
 * mismo tramo no paga otra llamada al modelo (revisión del 21 nov, C1). La marca se quita al
 * ordenarlo (`settleDictationSegment`) o si falla (`releaseDictationSegment`), y vence sola.
 *
 * `retryOf`: «Intentar otra vez» una frase que Clío no usó (C3). Se vuelve a leer con lo dicho
 * antes de su tramo, sin guardarla como otro tramo: «Lo que se dijo» la sigue mostrando una vez.
 */
export async function startDictationSegment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { segmentId: string; transcript: string; retryOf?: string | undefined },
): Promise<DictationSegmentStart> {
  const dictation = await requireClinicalAssistant(tx, orgId)
  // El bloqueo de la atención ordena dos envíos del mismo tramo: el segundo ya lo ve.
  assertOpenDraft(await lockEncounter(tx, orgId, patientId, encounterId), actorUserId)
  const idle = { dictation, inProgress: false, context: "" }
  if (await dictationSegmentSeen(tx, orgId, patientId, encounterId, input.segmentId)) return { ...idle, repeated: true }
  if (!input.retryOf) {
    await tx
      .insert(encounterDictationSegment)
      .values({
        organizationId: orgId,
        patientId,
        encounterId,
        segmentId: input.segmentId,
        transcript: input.transcript.slice(0, DICTATION_CHARS),
        createdBy: actorUserId,
      })
      .onConflictDoNothing({ target: [encounterDictationSegment.organizationId, encounterDictationSegment.encounterId, encounterDictationSegment.segmentId] })
  }
  const [own] = await tx
    .select({ id: encounterDictationSegment.id, saidAt: encounterDictationSegment.saidAt, organizingAt: encounterDictationSegment.organizingAt, organizedAt: encounterDictationSegment.organizedAt })
    .from(encounterDictationSegment)
    .where(segmentWhere(orgId, encounterId, input.retryOf ?? input.segmentId))
    .limit(1)
  if (!own) throw notFound("Tramo")
  // Una frase se reintenta de un tramo ya ordenado: el que no se ordenó se reintenta entero.
  if (input.retryOf && own.organizedAt === null) throw notFound("Tramo")
  if (inProgress(own.organizingAt)) return { ...idle, repeated: false, inProgress: true }
  await tx.update(encounterDictationSegment).set({ organizingAt: new Date(), updatedAt: new Date() }).where(eq(encounterDictationSegment.id, own.id))
  const earlier = await tx
    .select({ transcript: encounterDictationSegment.transcript })
    .from(encounterDictationSegment)
    .where(
      and(
        eq(encounterDictationSegment.organizationId, orgId),
        eq(encounterDictationSegment.encounterId, encounterId),
        sql`(${encounterDictationSegment.saidAt}, ${encounterDictationSegment.id}) < (${own.saidAt.toISOString()}::timestamptz, ${own.id}::uuid)`,
      ),
    )
    .orderBy(desc(encounterDictationSegment.saidAt), desc(encounterDictationSegment.id))
    .limit(CONTEXT_SEGMENTS)
  return { ...idle, repeated: false, context: dictationContext(earlier.map((row) => row.transcript).reverse()) }
}

/**
 * El pedido que ordenaba el tramo falló (el proveedor, la red): deja de estar «en curso» y se puede
 * volver a intentar ya. `segmentId`: el tramo, o el de la frase que se reintentaba.
 */
export async function releaseDictationSegment(tx: Db, orgId: string, encounterId: string, segmentId: string): Promise<void> {
  await tx.update(encounterDictationSegment).set({ organizingAt: null, updatedAt: new Date() }).where(segmentWhere(orgId, encounterId, segmentId))
}

/**
 * «Intentar otra vez» ya ordenado: la frase deja de estar en «No lo usé» de su tramo y, si Clío
 * tampoco la usó esta vez, vuelve con lo que se sabe ahora. `used`: si esta vez dejó algo (una
 * propuesta, una corrección, algo sumado). Si no dejó nada ni la devolvió, la frase sigue en «No lo
 * usé» con su motivo de antes: nunca desaparece sin quedar en ninguna parte (QA del 21 nov). Lo que
 * se dijo no cambia.
 */
export async function settleDictationRetry(
  tx: Db,
  orgId: string,
  encounterId: string,
  segmentId: string,
  phrase: string,
  unused: readonly DictationUnusedItem[],
  used = true,
): Promise<void> {
  const [row] = await tx.select().from(encounterDictationSegment).where(segmentWhere(orgId, encounterId, segmentId)).limit(1)
  if (!row) return
  const same = (said: string | null) => (said ?? "").trim() === phrase.trim()
  const returned = unused.some((item) => same(item.said))
  const kept = row.unused.filter((item) => !same(item.said) || (!used && !returned))
  const known = new Set(kept.map((item) => item.said ?? ""))
  const more = unused.filter((item) => {
    const key = item.said ?? ""
    if (known.has(key)) return false
    known.add(key)
    return true
  })
  await tx.update(encounterDictationSegment).set({ unused: [...kept, ...more], organizingAt: null, updatedAt: new Date() }).where(eq(encounterDictationSegment.id, row.id))
}

const segmentWhere = (orgId: string, encounterId: string, segmentId: string) =>
  and(
    eq(encounterDictationSegment.organizationId, orgId),
    eq(encounterDictationSegment.encounterId, encounterId),
    eq(encounterDictationSegment.segmentId, segmentId),
  )

/**
 * Después de guardar lo que Clío ordenó, en la misma transacción: el tramo queda ordenado (no
 * se vuelve a mandar al modelo) con lo que no se usó y por qué.
 */
export async function settleDictationSegment(
  tx: Db,
  orgId: string,
  encounterId: string,
  segmentId: string,
  unused: readonly DictationUnusedItem[],
): Promise<void> {
  const seen = new Set<string>()
  const once = unused.filter((item) => {
    const key = item.said ?? ""
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  await tx
    .update(encounterDictationSegment)
    .set({ organizedAt: new Date(), organizingAt: null, unused: once, updatedAt: new Date() })
    .where(and(segmentWhere(orgId, encounterId, segmentId), isNull(encounterDictationSegment.organizedAt)))
}

/**
 * Cómo empieza una pregunta, sin tildes y sin signos (la voz de Chrome no los pone): «cuanto pesa
 * lucas mas o menos», «y desde cuando le pasa». Con «como» solo si no sigue una cantidad: «como dos
 * semanas» es una respuesta, como «que yo sepa».
 */
const ASKS =
  /^(?:y |e )?(?:desde |hace |para |por |de |a |con |en )?(?:que(?! yo sepa)|cuanto|cuanta|cuantos|cuantas|cuando|donde|cual|cuales|quien|quienes|como(?! (?:un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|medio|media|mas|menos|\d)\b))\b/u

/**
 * Lo que pregunta quien atiende sin palabra de pregunta: «tiene alergias», «toma algo», «usa alguna
 * medicina», «es alérgico a algo». Dicho por el paciente o quien lo acompaña es una respuesta («tiene
 * asma», «toma algo para la tiroides»): solo cuenta si se sabe que lo dijo quien atiende.
 */
const ATTENDING_ASKS =
  /^(?:y |e )?(?:tiene |tienes |(?:toma|tomas|usa|usas) (?:algo|alguna|alguno|algun|algunas|algunos)\b|es alergic|eres alergic|ha tenido |has tenido |le han |te han |sabe si |le duele |te duele |le molesta |te molesta )/u

/**
 * ¿Es una pregunta? Las que llevan sus signos, las que empiezan con una palabra de pregunta, con
 * tilde o sin ella (QA del 23 nov, verificador 2: «cuanto pesa lucas mas o menos» salía en «No lo
 * usé»), y lo que pregunta quien atiende (`speaker`, de los turnos del repaso, si ya se sabe).
 */
export function isQuestion(said: string, speaker: DictationSpeaker | null = null): boolean {
  if (/^\s*¿|\?\s*$/u.test(said)) return true
  // Lo que dijo el paciente o quien lo acompaña es una respuesta, aunque empiece como pregunta.
  if (speaker === "paciente" || speaker === "acompanante") return false
  const flat = normalizeForSearch(said)
  if (speaker === "dra") return ASKS.test(flat) || ATTENDING_ASKS.test(flat)
  // Sin saber quién lo dijo, solo lo que no puede ser una respuesta: sin tildes, «cuando tomo algo
  // frío me duele» o «que me duele de noche» son del paciente y no se pierden sin aviso.
  return SURE_ASKS.test(flat)
}

/** Lo que solo puede ser una pregunta, aun sin tildes ni signos: «cuanto pesa», «desde cuando le pasa». */
const SURE_ASKS =
  /^(?:y |e )?(?:(?:desde|hace) (?:cuando|cuanto)|cuanto|cuanta|cuantos|cuantas|donde|cual|cuales|quien|quienes|que (?:tiene|toma|siente|(?:le|te) (?:duele|molesta|pasa|paso)))\b/u

/** Quién dijo esa frase, según los turnos del repaso: el turno que la contiene. Nulo si no se sabe. */
export function speakerOfSaid(said: string, turns: readonly DictationTurn[] | null | undefined): DictationSpeaker | null {
  const phrase = normalizeForSearch(said)
  if (!phrase || !turns?.length) return null
  const turn = turns.find((one) => {
    const text = normalizeForSearch(one.texto)
    return !!text && (` ${text} `.includes(` ${phrase} `) || ` ${phrase} `.includes(` ${text} `))
  })
  return turn?.quien ?? null
}

/** ¿Dice lo mismo, o una de las dos contiene a la otra palabra por palabra? Ya sin tildes ni signos. */
const sameSaid = (a: string, b: string) => a === b || (!!a && !!b && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `)))

/** ¿Las dos hablan de la misma frase de lo que no se usó? Dos sin frase, también. */
export const sameUnusedSaid = (a: DictationUnusedItem, b: DictationUnusedItem) => sameSaid(normalizeForSearch(a.said ?? ""), normalizeForSearch(b.said ?? ""))

/**
 * Lo que no se usó, cada frase una sola vez (QA del 22 nov, H6): si se repite, o una contiene a la
 * otra («debe pesar unos 24 kilos» y «… doctora»), queda la que trae su motivo (`detail`), el mismo
 * que dio el aviso; sin motivo en ninguna, la primera. Las preguntas no entran (`isQuestion`; con los
 * turnos del tramo, también lo que preguntó quien atiende). Las que no tienen frase quedan una.
 */
export function unusedOnce(items: readonly DictationUnusedItem[], turns: readonly DictationTurn[] | null = null): DictationUnusedItem[] {
  const kept: DictationUnusedItem[] = []
  for (const item of items) {
    if (item.said !== null && isQuestion(item.said, speakerOfSaid(item.said, turns))) continue
    const at = kept.findIndex((other) => sameUnusedSaid(other, item))
    if (at < 0) kept.push(item)
    else if (item.detail && !kept[at]!.detail) kept[at] = item
  }
  return kept
}

/**
 * Lo que «No lo usé» ya no debe decir de una atención: una frase que está (o cabe entera) en lo que
 * se dijo de una sugerencia viva, porque sí se usó (QA del 22 nov, H4). Lo que Clío dejó fuera de
 * una frase usada (`no_propuesta`, «No encontré «apixabán»…») sí sigue: habla de una parte.
 */
export function unusedNotInSources(items: readonly DictationUnusedItem[], sources: readonly string[]): DictationUnusedItem[] {
  const used = sources.map((said) => normalizeForSearch(said)).filter(Boolean)
  return items.filter((item) => {
    if (item.said === null || item.why === "no_propuesta") return true
    const key = normalizeForSearch(item.said)
    return !key || !used.some((source) => ` ${source} `.includes(` ${key} `))
  })
}

/** Un tramo de lo que se dijo, como lo lee la pantalla. */
export interface DictationSaidSegment {
  segmentId: string
  transcript: string
  saidAt: string
  createdBy: string
  /** Clío ya lo ordenó; si no, falló o sigue en curso. */
  organized: boolean
  unused: DictationUnusedItem[]
  /** Los turnos del repaso, si ya se hizo (`dictation-review.ts`). */
  turns: DictationTurn[] | null
  /**
   * Ya lo leyó un repaso, aunque no haya dejado turnos (los rechazó, o no empezó ninguno en él): la
   * pantalla no pide otro repaso por él (revisión del 21 nov, C2).
   */
  reviewed: boolean
}

/**
 * Lo que se dijo en una atención, en orden: lo ve quien ve la atención (permiso clínico, lo pone
 * la ruta), en borrador, firmada o anulada. No es historia clínica.
 */
export async function listDictationSaid(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<DictationSaidSegment[]> {
  const [found] = await tx
    .select({ id: encounter.id })
    .from(encounter)
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId), eq(encounter.id, encounterId)))
    .limit(1)
  if (!found) throw notFound("Atención")
  const rows = await tx
    .select()
    .from(encounterDictationSegment)
    .where(and(eq(encounterDictationSegment.organizationId, orgId), eq(encounterDictationSegment.encounterId, encounterId)))
    .orderBy(asc(encounterDictationSegment.saidAt), asc(encounterDictationSegment.id))
  // Lo que ya está en una sugerencia que no se descartó no se lista como no usado.
  const sources = rows.some((row) => row.unused.length) ? (await listDictationSaidSources(tx, orgId, encounterId)).map((item) => item.said) : []
  return rows.map((row) => ({
    segmentId: row.segmentId,
    transcript: row.transcript,
    saidAt: row.saidAt.toISOString(),
    createdBy: row.createdBy,
    organized: row.organizedAt !== null,
    unused: unusedNotInSources(unusedOnce(row.unused, row.turns), sources),
    turns: row.turns ?? null,
    reviewed: row.reviewedAt !== null,
  }))
}

/**
 * Lo que se dijo que está en una sugerencia de la atención, pendiente o ya confirmada, con su
 * clase: la pantalla lo resalta (lo de su salud aparte) y sigue igual al recargar o ya firmada.
 * Lo descartado no: ya no está en ninguna parte.
 */
export async function listDictationSaidSources(tx: Db, orgId: string, encounterId: string): Promise<Array<{ kind: string; said: string }>> {
  const rows = await tx
    .select({ kind: encounterDictationSuggestion.kind, said: encounterDictationSuggestion.sourceText })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        inArray(encounterDictationSuggestion.status, ["lista", "por_revisar", "confirmada"]),
        ne(encounterDictationSuggestion.sourceText, ""),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.createdAt), asc(encounterDictationSuggestion.id))
  return rows
}
