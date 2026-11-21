import type { Db } from "@odentia/db"
import { type DictationTurn, type DictationUnusedItem, encounter, encounterDictationSegment, encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import { DICTATION_CHARS, dictationSegmentSeen, requireClinicalAssistant } from "./encounter-dictation.js"
import type { ProductDictation } from "./product-hooks.js"
import { assertOpenDraft, lockEncounter } from "./encounters.js"
import { notFound } from "./errors.js"

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
  return rows.map((row) => ({
    segmentId: row.segmentId,
    transcript: row.transcript,
    saidAt: row.saidAt.toISOString(),
    createdBy: row.createdBy,
    organized: row.organizedAt !== null,
    unused: row.unused,
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
