import type { Db } from "@odentia/db"
import {
  DICTATION_SPEAKERS,
  type DictationSpeaker,
  type DictationTurn,
  type DictationUnusedItem,
  encounterDictationSegment,
} from "@odentia/db/schema/clinical"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import { type DictationFormQuestion, dictationFormQuestions } from "./dictation-forms.js"
import {
  type DictationDraft,
  type DictationSegmentResult,
  dictationModelLabel,
  listDecidedDictation,
  listDictationSuggestions,
  requireClinicalAssistant,
  saveDictationSegment,
} from "./encounter-dictation.js"
import { DICTATION_IN_PROGRESS_MS } from "./dictation-said.js"
import { assertOpenDraft, lockEncounter } from "./encounters.js"
import { notFound } from "./errors.js"
import { normalizeForSearch } from "./knowledge.js"

/*
 * ---------- El repaso al terminar el dictado (mesa del 20 nov 2026, P4) ----------
 *
 * Las pausas ordenan tramo por tramo, cada uno una sola vez: releerlo todo en cada pausa volvería
 * a aplicar los «quita» y las correcciones por número, traería lo descartado y su costo crece con
 * el cuadrado de la duración (informe de desarrollo de la mesa). Al terminar, Clío lee una vez toda
 * la conversación guardada (`encounter_dictation_segment`) con lo que ya quedó de ella (lo
 * pendiente con su texto, lo confirmado y lo descartado) y completa lo que las pausas dejaron
 * (cuándo vuelve, lo de su salud, las respuestas de una ficha abierta), y parte cada tramo en
 * turnos con quién habló. Lo que propone pasa por el mismo `saveDictationSegment` que una pausa.
 */

export { DICTATION_SPEAKERS }
export type { DictationSpeaker, DictationTurn }

/**
 * Lo que lee el repaso de una vez, como mucho. Una consulta real puede pasar de 30 000 caracteres
 * (unos 40–50 minutos de conversación); si lo guardado pasa de esto, se leen los últimos tramos
 * enteros que caben y el mensaje lo dice: lo de más atrás ya lo ordenaron sus pausas, y es lo que
 * menos falta para el cierre (cuándo vuelve, lo último que se indicó). Medio millar de caracteres
 * más es el margen del mensaje que no es la conversación.
 */
export const DICTATION_REVIEW_CHARS = 30_000

/** Un tramo que lee el repaso, con su número en el mensaje. `needsTurns`: aún no tiene turnos. */
export interface DictationReviewSegment {
  segmentId: string
  number: number
  saidAt: Date
  transcript: string
  needsTurns: boolean
}

export type DictationReviewStart =
  /** `inProgress`: otro repaso está leyendo ahora lo nuevo; este no llama al modelo. */
  | { due: false; inProgress?: boolean }
  | {
      due: true
      /** La identidad del repaso para `saveDictationSegment`: el mismo repaso no se guarda dos veces. */
      reviewId: string
      segments: DictationReviewSegment[]
      /** Hay tramos más antiguos que no entran (`DICTATION_REVIEW_CHARS`). */
      earlierLeftOut: boolean
      /** Lo que el repaso marca como leído al guardarse: los que lee y los que dejó fuera por largo. */
      readIds: string[]
      /** Lo que ya quedó de la conversación, como se le nombra a Clío (`dictationModelLabel`). */
      pending: string[]
      confirmed: string[]
      discarded: string[]
      forms: DictationFormQuestion[]
    }

/**
 * ¿Toca el repaso? Solo si hay tramos que ningún repaso leyó (`reviewed_at`): terminar el dictado
 * otra vez sin haber dicho nada nuevo no vuelve a llamar al modelo. Solo quien lleva la atención en
 * borrador. Lee lo que va en el mensaje del repaso.
 */
export async function startDictationReview(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  options: { openForms?: readonly string[] } = {},
): Promise<DictationReviewStart> {
  const dictation = await requireClinicalAssistant(tx, orgId)
  assertOpenDraft(await lockEncounter(tx, orgId, patientId, encounterId), actorUserId)
  const rows = await tx
    .select()
    .from(encounterDictationSegment)
    .where(
      and(
        eq(encounterDictationSegment.organizationId, orgId),
        eq(encounterDictationSegment.patientId, patientId),
        eq(encounterDictationSegment.encounterId, encounterId),
      ),
    )
    .orderBy(asc(encounterDictationSegment.saidAt), asc(encounterDictationSegment.id))
  const unread = rows.filter((row) => row.reviewedAt === null)
  if (!unread.length) return { due: false }
  // Otro repaso ya está leyendo todo lo nuevo (otra pestaña, «Terminar» en una y «Finalizar» en
  // otra): este no lo vuelve a pagar (revisión del 21 nov, C1). La marca se quita al guardarlo
  // (`saveDictationReview`) o si falla (`releaseDictationReview`), y vence sola.
  if (unread.every((row) => row.reviewingAt !== null && Date.now() - row.reviewingAt.getTime() < DICTATION_IN_PROGRESS_MS)) return { due: false, inProgress: true }
  await tx
    .update(encounterDictationSegment)
    .set({ reviewingAt: new Date(), updatedAt: new Date() })
    .where(inArray(encounterDictationSegment.id, unread.map((row) => row.id)))
  // El largo acotado: desde el último hacia atrás, los tramos enteros que caben.
  let from = rows.length
  let total = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const length = (rows[index]?.transcript.length ?? 0) + 1
    if (total + length > DICTATION_REVIEW_CHARS) break
    total += length
    from = index
  }
  const included = rows.slice(from)
  const last = included.at(-1)
  if (!last) return { due: false }
  const label = (item: Parameters<typeof dictationModelLabel>[0]) => dictationModelLabel(item, dictation)
  return {
    due: true,
    reviewId: `repaso:${last.segmentId}`,
    segments: included.map((row, index) => ({
      segmentId: row.segmentId,
      number: index + 1,
      saidAt: row.saidAt,
      transcript: row.transcript,
      needsTurns: row.turns === null,
    })),
    earlierLeftOut: from > 0,
    readIds: rows.map((row) => row.id),
    pending: (await listDictationSuggestions(tx, orgId, patientId, encounterId)).map(label),
    confirmed: (await listDecidedDictation(tx, orgId, patientId, encounterId, "confirmada")).map(label),
    discarded: (await listDecidedDictation(tx, orgId, patientId, encounterId, "descartada")).map(label),
    forms: await dictationFormQuestions(tx, orgId, encounterId, { open: options.openForms ?? [] }),
  }
}

/**
 * ¿Estos turnos son el tramo tal cual? Juntos y en orden tienen que decir exactamente lo que se
 * dijo: solo se perdona el espacio entre palabras (el modelo parte «hola,doctora» en dos turnos).
 * Un turno vacío, una palabra corregida, resumida o saltada, o un signo de más, y no lo son.
 */
export function turnsSayTranscript(turns: ReadonlyArray<{ texto: string }>, transcript: string): boolean {
  const bare = (text: string) => text.replace(/\s+/gu, "")
  return turns.length > 0 && turns.every((turn) => bare(turn.texto).length > 0) && bare(turns.map((turn) => turn.texto).join("")) === bare(transcript)
}

/**
 * Largo de una frase sin puntuación, como mucho, antes de partirla. La voz de Chrome casi no pone
 * puntos: un tramo entero puede llegar como una sola «frase» de cientos de caracteres, y dos
 * personas cabrían en ella.
 */
export const DICTATION_SENTENCE_CHARS = 160
/** Lo mínimo que queda de un lado al partir una frase larga: un pedazo más corto no se separa. */
const SENTENCE_MIN_CHARS = 40
/**
 * Palabras con que suele empezar otra idea en lo hablado: una frase larga sin puntuación se parte
 * antes de la última que cabe. No son reglas de gramática: solo eligen un corte razonable.
 */
const SENTENCE_CONNECTORS = /\s(?=(?:y|pero|porque|entonces|bueno|o sea|ya|después|además|también|ahora|mira|oiga|doctora?|sí|no)\s)/giu

/** Parte un pedazo largo sin puntuación: antes del último conector que cabe; si no hay, en el último espacio. */
function splitLong(piece: string): string[] {
  const parts: string[] = []
  let rest = piece
  while (rest.length > DICTATION_SENTENCE_CHARS) {
    const window = rest.slice(0, DICTATION_SENTENCE_CHARS + 1)
    let cut = -1
    for (const found of window.matchAll(SENTENCE_CONNECTORS)) if (found.index >= SENTENCE_MIN_CHARS) cut = found.index
    if (cut < 0) cut = window.lastIndexOf(" ")
    if (cut < SENTENCE_MIN_CHARS) cut = rest.indexOf(" ", DICTATION_SENTENCE_CHARS)
    if (cut < 0) break
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.trim()) parts.push(rest.trim())
  return parts.filter(Boolean)
}

/**
 * Las frases de un tramo, en orden: lo que el repaso numera para decir dónde empieza cada turno.
 * Pura y estable (el mismo tramo da siempre las mismas frases), y cada frase es un pedazo exacto
 * del tramo: juntas, sin los espacios entre ellas, son el tramo tal cual (`turnsSayTranscript`).
 * - Termina una frase el punto, el signo de cierre de pregunta o exclamación o los puntos
 *   suspensivos seguidos de un espacio (con las comillas o el paréntesis que cierran): «6.5» no
 *   se parte. Una abreviatura con punto («Dra. Pérez») sí se parte: es raro en lo dictado y solo
 *   mueve un corte.
 * - Empieza otra antes de «¿» o «¡» tras un espacio: «Bien ¿y desde cuándo?» son dos.
 * - Lo que sigue pasando de `DICTATION_SENTENCE_CHARS` (la voz de Chrome, sin puntuación) se parte
 *   antes de un conector razonable o, si no hay, en el último espacio que cabe.
 */
export function dictationSentences(transcript: string): string[] {
  const pieces: string[] = []
  let start = 0
  for (let at = 0; at < transcript.length; at += 1) {
    const char = transcript.charAt(at)
    if ((char === "¿" || char === "¡") && at > start && /\s/u.test(transcript.charAt(at - 1))) {
      pieces.push(transcript.slice(start, at))
      start = at
      continue
    }
    if (!/[.?!…]/u.test(char)) continue
    let end = at + 1
    while (end < transcript.length && /[.?!…»"”')\]]/u.test(transcript.charAt(end))) end += 1
    if (end < transcript.length && !/\s/u.test(transcript.charAt(end))) {
      at = end - 1
      continue
    }
    pieces.push(transcript.slice(start, end))
    start = end
    at = end - 1
  }
  pieces.push(transcript.slice(start))
  return pieces.map((piece) => piece.trim()).filter(Boolean).flatMap(splitLong)
}

const SPEAKER_SET = new Set<string>(DICTATION_SPEAKERS)

/** Dónde empieza un turno, como lo devuelve el repaso: el número de su primera frase y quién habló. */
export interface DictationTurnStart {
  desde: number
  quien: DictationSpeaker
  vinculo?: string | undefined
  /**
   * Las primeras palabras del turno, tal cual, si empieza a media frase: la voz de Chrome no pone
   * puntos y la pregunta y su respuesta llegan en una sola («toma alguna medicina si tomo losartán»;
   * QA del 21 nov, C10). El servidor las ubica en la frase; si no están, el turno empieza en la frase.
   */
  empieza?: string | undefined
}

/** Dónde empiezan en la frase esas palabras: tal cual, o sin mirar mayúsculas; 0 si no están. */
function startIn(sentence: string, words: string | undefined): number {
  const wanted = words?.trim()
  if (!wanted) return 0
  const at = sentence.indexOf(wanted)
  if (at >= 0) return at
  const folded = sentence.toLocaleLowerCase("es").indexOf(wanted.toLocaleLowerCase("es"))
  return folded >= 0 ? folded : 0
}

/**
 * Los turnos de cada tramo, armados con el texto exacto de sus frases (`dictationSentences`): así
 * son el tramo tal cual por construcción. Las frases se numeran seguidas en toda la conversación,
 * desde 1, en el orden de los tramos. Cada turno empieza en su frase y sigue hasta donde empieza
 * el siguiente, también en el tramo que viene (quien seguía hablando al cortar la pausa). Una frase
 * en la que hablaron dos queda con quien la empieza: la frase es lo más fino que se marca.
 * `null`: el tramo no pide turnos o ningún turno empieza en él ni antes; queda para otro repaso.
 */
export function turnsFromStarts(
  segments: ReadonlyArray<{ transcript: string; needsTurns: boolean }>,
  starts: readonly DictationTurnStart[],
): Array<DictationTurn[] | null> {
  // Varios turnos pueden empezar en la misma frase: cada uno donde están sus primeras palabras.
  const byNumber = new Map<number, DictationTurnStart[]>()
  for (const start of starts)
    if (Number.isInteger(start.desde) && start.desde >= 1 && SPEAKER_SET.has(start.quien)) byNumber.set(start.desde, [...(byNumber.get(start.desde) ?? []), start])
  let number = 0
  let current: DictationTurnStart | undefined
  return segments.map((segment) => {
    const turns: DictationTurn[] = []
    // Lo del principio sin ningún turno empezado antes: no se sabe quién lo dijo.
    const leading: string[] = []
    let open: DictationTurn | undefined
    /** Un pedazo de lo dicho, con quien habla en ese momento. */
    const say = (piece: string) => {
      if (!piece) return
      if (!current) {
        leading.push(piece)
        return
      }
      if (open) open.texto = `${open.texto} ${piece}`
      else {
        const vinculo = current.quien === "acompanante" ? current.vinculo?.trim().slice(0, 80) || undefined : undefined
        open = { quien: current.quien, ...(vinculo ? { vinculo } : {}), texto: piece }
        turns.push(open)
      }
    }
    for (const sentence of dictationSentences(segment.transcript)) {
      number += 1
      // Dónde empieza cada turno en la frase; dos en el mismo lugar: vale el último.
      const cuts = new Map<number, DictationTurnStart>()
      for (const start of byNumber.get(number) ?? []) cuts.set(startIn(sentence, start.empieza), start)
      const ordered = [...cuts.entries()].sort(([a], [b]) => a - b)
      if (!segment.needsTurns) {
        if (ordered.length) current = ordered.at(-1)?.[1]
        continue
      }
      let from = 0
      for (const [at, start] of ordered) {
        // Lo de antes de las primeras palabras sigue con quien hablaba.
        say(sentence.slice(from, at).trim())
        current = start
        open = undefined
        from = at
      }
      say(sentence.slice(from).trim())
    }
    if (!segment.needsTurns || !turns.length) return null
    if (leading.length) turns.unshift({ quien: "no_se_sabe", texto: leading.join(" ") })
    return turns
  })
}


/** Lo que el repaso dejó fuera por ser de otro lugar, con lo que se le dice a la persona. */
export const DICTATION_OUT_OF_PLACE = {
  familiar: "Es de la salud de un familiar: va en sus antecedentes familiares, no en los suyos.",
  peso_dicho: "Es un peso o una talla dichos, no medidos: si hace falta, mídelo.",
  otro: null,
} as const satisfies Record<string, string | null>
export type DictationOutOfPlace = keyof typeof DICTATION_OUT_OF_PLACE

export interface DictationReviewInput {
  reviewId: string
  segments: ReadonlyArray<Pick<DictationReviewSegment, "segmentId" | "transcript">>
  readIds: readonly string[]
  drafts: DictationDraft[]
  /**
   * Los turnos de cada tramo, armados con sus frases desde dónde Clío dijo que empieza cada uno
   * (`turnsFromStarts`): se vuelven a comprobar contra el tramo antes de guardarlos.
   */
  turns: ReadonlyArray<{ segmentId: string; turns: DictationTurn[] }>
  /** Lo que Clío no supo dónde poner y pudo citar (`readDictation`). */
  unused: readonly string[]
  /** Partes que no pudo usar: si son más que las citadas, queda una sin frase. */
  omitted: number
  /** Lo clínico que dejó fuera con su motivo (un familiar, un peso dicho). */
  outOfPlace: ReadonlyArray<{ said: string; why: DictationOutOfPlace }>
  formQuestions: readonly DictationFormQuestion[]
}

export interface DictationReviewResult extends DictationSegmentResult {
  /** Los tramos cuyos turnos quedaron guardados. */
  turnsSaved: string[]
  /** Los tramos cuyos turnos no eran el tramo tal cual: no se guardaron. */
  turnsRejected: string[]
  /** Lo que quedó en «No lo usé» de los tramos, nuevo. */
  unused: DictationUnusedItem[]
}

const loose = (text: string) => ` ${normalizeForSearch(text)} `

/**
 * Guarda lo que devolvió el repaso, en una transacción: lo que propone pasa por el mismo
 * `saveDictationSegment` que una pausa (la consulta y la salud se suman a las pendientes, lo
 * pendiente no se repite, las fichas se comprueban igual) con la identidad del repaso, y lo
 * descartado o confirmado no vuelve (`review`). Después, los turnos, lo que no se usó y que esos
 * tramos ya se leyeron.
 */
export async function saveDictationReview(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: DictationReviewInput,
): Promise<DictationReviewResult> {
  const heard = input.segments.map((segment) => segment.transcript).join("\n")
  const result = await saveDictationSegment(tx, orgId, actorUserId, patientId, encounterId, {
    drafts: input.drafts,
    segmentId: input.reviewId,
    transcript: heard,
    formQuestions: input.formQuestions,
    review: true,
  })
  const rows = await tx
    .select()
    .from(encounterDictationSegment)
    .where(
      and(
        eq(encounterDictationSegment.organizationId, orgId),
        eq(encounterDictationSegment.encounterId, encounterId),
        inArray(
          encounterDictationSegment.segmentId,
          input.segments.map((segment) => segment.segmentId),
        ),
      ),
    )
  const turnsSaved: string[] = []
  const turnsRejected: string[] = []
  for (const { segmentId, turns } of input.turns) {
    const row = rows.find((item) => item.segmentId === segmentId)
    // Los turnos que ya tiene (de otro repaso, o que una persona cambió) no se pisan.
    if (!row || row.turns !== null) continue
    // Si no son el tramo tal cual (una palabra corregida, algo saltado), no se guardan: «Lo que se
    // dijo» muestra el tramo como se oyó, nunca un texto que nadie dijo.
    if (!turnsSayTranscript(turns, row.transcript)) {
      turnsRejected.push(segmentId)
      continue
    }
    await tx.update(encounterDictationSegment).set({ turns, updatedAt: new Date() }).where(eq(encounterDictationSegment.id, row.id))
    turnsSaved.push(segmentId)
  }
  // Lo que no se usó va al tramo donde se dijo, como lo de una pausa; sin tramo claro, al último.
  const items: DictationUnusedItem[] = [
    ...input.unused.map((said): DictationUnusedItem => ({ said, why: "sin_lugar" })),
    ...input.outOfPlace.map(({ said, why }): DictationUnusedItem => {
      const detail = DICTATION_OUT_OF_PLACE[why]
      return { said, why: "sin_lugar", ...(detail ? { detail } : {}) }
    }),
    ...result.droppedForms.map((item): DictationUnusedItem => ({ said: item.said, why: "no_propuesta", detail: item.why, ...(item.targets.length ? { targets: item.targets } : {}) })),
    ...(input.omitted > input.unused.length ? [{ said: null, why: "sin_lugar" } satisfies DictationUnusedItem] : []),
  ]
  const added: DictationUnusedItem[] = []
  const lastId = input.segments.at(-1)?.segmentId
  const bySegment = new Map<string, DictationUnusedItem[]>()
  for (const item of items) {
    const where = item.said ? input.segments.find((segment) => loose(segment.transcript).includes(loose(item.said ?? ""))) : undefined
    const segmentId = where?.segmentId ?? lastId
    if (segmentId) bySegment.set(segmentId, [...(bySegment.get(segmentId) ?? []), item])
  }
  for (const [segmentId, fresh] of bySegment) {
    const row = rows.find((item) => item.segmentId === segmentId)
    if (!row) continue
    // Lo que la pausa ya avisó de esa frase no se avisa dos veces.
    const known = new Set(row.unused.map((item) => item.said ?? ""))
    const more = fresh.filter((item) => {
      const key = item.said ?? ""
      if (known.has(key)) return false
      known.add(key)
      return true
    })
    if (!more.length) continue
    added.push(...more)
    await tx
      .update(encounterDictationSegment)
      .set({ unused: [...row.unused, ...more], updatedAt: new Date() })
      .where(eq(encounterDictationSegment.id, row.id))
  }
  // Los tramos que leyó (o dejó fuera por largo) ya no piden otro repaso; lo dicho mientras tanto, sí.
  if (input.readIds.length) {
    await tx
      .update(encounterDictationSegment)
      .set({ reviewedAt: new Date(), reviewingAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(encounterDictationSegment.organizationId, orgId),
          eq(encounterDictationSegment.encounterId, encounterId),
          inArray(encounterDictationSegment.id, [...input.readIds]),
          isNull(encounterDictationSegment.reviewedAt),
        ),
      )
  }
  return { ...result, turnsSaved, turnsRejected, unused: added }
}

/** El repaso falló (el proveedor, la red): lo que iba a leer deja de estar «en curso» y se puede pedir ya. */
export async function releaseDictationReview(tx: Db, orgId: string, encounterId: string, readIds: readonly string[]): Promise<void> {
  if (!readIds.length) return
  await tx
    .update(encounterDictationSegment)
    .set({ reviewingAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(encounterDictationSegment.organizationId, orgId),
        eq(encounterDictationSegment.encounterId, encounterId),
        inArray(encounterDictationSegment.id, [...readIds]),
        isNull(encounterDictationSegment.reviewedAt),
      ),
    )
}

/**
 * «Quién habló» de un turno, cambiado con un toque: lo decide la persona y ningún repaso lo pisa.
 * Escribe lo que se dijo de la atención: quien la lleva, en borrador (`clinical.write` lo pone la ruta).
 */
export async function setDictationTurnSpeaker(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  segmentId: string,
  index: number,
  input: { quien: DictationSpeaker; vinculo?: string | null | undefined },
): Promise<DictationTurn[]> {
  assertOpenDraft(await lockEncounter(tx, orgId, patientId, encounterId), actorUserId)
  const [row] = await tx
    .select()
    .from(encounterDictationSegment)
    .where(
      and(
        eq(encounterDictationSegment.organizationId, orgId),
        eq(encounterDictationSegment.patientId, patientId),
        eq(encounterDictationSegment.encounterId, encounterId),
        eq(encounterDictationSegment.segmentId, segmentId),
      ),
    )
    .limit(1)
  const turn = row?.turns?.[index]
  if (!row?.turns || !turn) throw notFound("Turno")
  // El vínculo es de quien acompaña: con otro, no queda.
  const vinculo = input.quien === "acompanante" ? (input.vinculo?.trim() || undefined) : undefined
  const turns = row.turns.map((item, at) => (at === index ? { quien: input.quien, ...(vinculo ? { vinculo } : {}), texto: item.texto } : item))
  await tx.update(encounterDictationSegment).set({ turns, updatedAt: new Date() }).where(eq(encounterDictationSegment.id, row.id))
  return turns
}
