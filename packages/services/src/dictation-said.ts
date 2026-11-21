import type { Db } from "@odentia/db"
import { type DictationUnusedItem, encounter, encounterDictationSegment } from "@odentia/db/schema/clinical"
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm"
import { DICTATION_CHARS, dictationSegmentSeen, requireClinicalAssistant } from "./encounter-dictation.js"
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
 * Antes de llamar al modelo: guarda el tramo tal cual llegó y dice si ya se ordenó (otra
 * pestaña, el reintento automático), con el contexto de lo dicho antes en la atención. Solo
 * quien lleva la atención en borrador dicta en ella. Un tramo guardado que no se llegó a ordenar
 * (el proveedor falló) se puede volver a intentar, con el contexto de cuando se dijo.
 */
export async function startDictationSegment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { segmentId: string; transcript: string },
): Promise<{ repeated: boolean; context: string }> {
  await requireClinicalAssistant(tx, orgId)
  // El bloqueo de la atención ordena dos envíos del mismo tramo: el segundo ya lo ve.
  assertOpenDraft(await lockEncounter(tx, orgId, patientId, encounterId), actorUserId)
  if (await dictationSegmentSeen(tx, orgId, patientId, encounterId, input.segmentId)) return { repeated: true, context: "" }
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
  const [own] = await tx
    .select({ id: encounterDictationSegment.id, saidAt: encounterDictationSegment.saidAt })
    .from(encounterDictationSegment)
    .where(segmentWhere(orgId, encounterId, input.segmentId))
    .limit(1)
  if (!own) throw notFound("Tramo")
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
  return { repeated: false, context: dictationContext(earlier.map((row) => row.transcript).reverse()) }
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
    .set({ organizedAt: new Date(), unused: once, updatedAt: new Date() })
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
  /** Los turnos del repaso, si ya se hizo. */
  turns: unknown[] | null
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
  }))
}
