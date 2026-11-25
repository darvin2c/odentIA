/**
 * Lo que hace y cuenta `eval:dictado-conversado` (mesa del 20 nov 2026, «Clío en una consulta
 * conversada», P7), sin el modelo: cómo queda lo que devuelve cada pausa en la atención y cómo se
 * compara al final con lo esperado. Puro: lo usan el corredor y su prueba.
 *
 * Lo que aplica el servidor (`saveDictationSegment`) se reproduce con sus funciones puras, las que
 * exporta `@odentia/services` en la rama que se mide: la consulta que se suma (`mergeNote`), la
 * corrección que exige su frase (`saidToCorrectNote`), «no que yo sepa» que no es «no tiene
 * alergias» (`doubtfulAllergy`), lo de su salud (`mergeHealth`, `prepareHealth`), el contexto de lo
 * guardado (`dictationContext`) y las fichas (`prepareFormAnswer`, `formDropNotices`…). Si la rama no
 * tiene una (en `main` faltan las de la consulta, la salud y el contexto guardado), se mide con lo
 * que tenía: cada consulta es otra tarjeta, la corrección no pide su frase y al recargar se pierde
 * el contexto (`serverPartsOf`). Se simula sin base, y solo lo mínimo: lo que el servidor busca en
 * la base (el tarifario, la CIE-10 de la clínica, lo ya registrado del paciente) no se busca; la
 * propuesta queda como la devolvió Clío. No se simula confirmar ni lo que pasa al firmar.
 */
import type { DictationDraft, DictationFormQuestion, ProductDictation } from "@odentia/services"
import * as services from "@odentia/services"

type Payload = Record<string, unknown>

/** Lo que el servidor de la rama sabe hacer, por función: lo que falta se mide como lo hacía `main`. */
export interface ServerParts {
  mergeNote?: (current: Payload, added: Payload, corrects?: boolean) => { payload: Payload; earlier: Record<string, string> } | null
  /** Si en la pausa alguien se corrige: solo así cambia un campo de una línea de la consulta. */
  saysCorrection?: (transcript: string | undefined, said?: string | undefined) => boolean
  saidToCorrectNote?: (said: string | undefined, transcript: string | undefined) => boolean
  /** «también en la 37» suma, no corrige. */
  addsNotCorrects?: (said: string | undefined) => boolean
  doubtfulAllergy?: (draft: DictationDraft) => DictationDraft
  mergeHealth?: (current: Payload, added: Payload, correct?: boolean) => { payload: Payload; earlier: Record<string, string> }
  prepareHealth?: (payload: Payload, said: string | undefined, own: object) => { payload: Payload; status: string; note: string | null } | null
  withoutSettledHealth?: (payload: Payload, settled: readonly Payload[], namedAllergy?: boolean) => Payload | null
  dictationContext?: (earlier: readonly string[]) => string
}

const PART_NAMES = ["mergeNote", "saysCorrection", "saidToCorrectNote", "addsNotCorrects", "doubtfulAllergy", "mergeHealth", "prepareHealth", "withoutSettledHealth", "dictationContext"] as const

/** Las funciones que tiene el módulo de servicios de la rama, por su nombre. */
export function serverPartsOf(module: Record<string, unknown>): ServerParts {
  return Object.fromEntries(PART_NAMES.flatMap((name) => (typeof module[name] === "function" ? [[name, module[name]]] : []))) as ServerParts
}

/** Las de esta rama. */
export const SERVER: ServerParts = serverPartsOf(services as unknown as Record<string, unknown>)

/** Lo que falta en la rama medida, para decirlo en el informe: cuenta como perdido. */
export function missingParts(parts: ServerParts, review: boolean): string[] {
  const missing: string[] = []
  if (!parts.mergeNote) missing.push("la consulta que se suma (cada pausa con consulta es otra tarjeta)")
  if (!parts.saidToCorrectNote) missing.push("la corrección de la consulta con su frase (cualquier corrección la cambia)")
  if (!parts.mergeHealth || !parts.prepareHealth) missing.push("lo de su salud (no tiene dónde ir)")
  if (!parts.doubtfulAllergy) missing.push("«no que yo sepa» como no sabe")
  if (!parts.dictationContext) missing.push("el contexto guardado (al recargar se pierde)")
  if (!review) missing.push("el repaso al terminar (sin turnos ni «No lo usé» del repaso)")
  return missing
}

/* ---------- La atención simulada ---------- */

export interface SimSuggestion {
  id: number
  kind: string
  payload: Payload
  sourceText: string
  status: "lista" | "por_revisar" | "descartada"
  /** Lo que se dijo antes de un campo de un solo valor («antes dijo warfarina»). */
  earlier: Record<string, string>
  corrected: boolean
}

/** Una frase en «No lo usé», con por qué y de dónde salió. */
export interface SimUnused {
  said: string
  why: string
  at: string
}

export interface SimTurn {
  quien: string
  vinculo?: string | undefined
  texto: string
}

export interface SimState {
  suggestions: SimSuggestion[]
  unused: SimUnused[]
  turns: SimTurn[]
  nextId: number
}

export const newState = (): SimState => ({ suggestions: [], unused: [], turns: [], nextId: 1 })

/** Lo pendiente, en el orden en que se le nombra a Clío: el número que usa es su posición aquí. */
export const pendingOf = (state: SimState) => state.suggestions.filter((item) => item.status !== "descartada")

/** El producto de la atención, como lo usa el servidor: su dictado, su «dónde» y sus fichas. */
export interface SimProduct {
  dictation: ProductDictation
  site: Parameters<typeof services.prepareFormAnswer>[2]
  formDiagnoses: Readonly<Record<string, string>> | undefined
}

/** Lo que devolvió una pausa (o el repaso), ya leído (`readDictation`). */
export interface SimRead {
  drafts: DictationDraft[]
  corrections: Array<{ index: number; changes: Payload; sourceText: string }>
  removals: Array<{ index: number; sourceText: string }>
  omitted: number
  unused: string[]
  /** Lo de un familiar o un peso dicho, con su frase y su motivo. */
  outOfPlace?: Array<{ said: string; why: string }> | undefined
}

const isRecord = (value: unknown): value is Payload => typeof value === "object" && value !== null && !Array.isArray(value)
const lower = (value: unknown) => String(value ?? "").trim().toLowerCase()
const filled = (payload: Payload) => Object.values(payload).some((value) => (typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null))

/** Los campos de su operación, como los filtra el servidor al corregir. */
function patchOf(kind: string, changes: Payload): Payload {
  const operation = (services.DICTATION_OPERATION as Record<string, string>)[kind]
  if (!operation) return {}
  const shape = services.operationAgentSchema(operation as Parameters<typeof services.operationAgentSchema>[0]).shape as Record<string, unknown>
  return Object.fromEntries(Object.entries(changes).filter(([key, value]) => key in shape && value !== undefined && value !== null))
}

/** La clave con que el servidor no repite lo pendiente, simplificada (sin la base). `null`: no se repite por clave. */
function dedupeKey(kind: string, payload: Payload, dictation: ProductDictation): string | null {
  if ((dictation.kinds as readonly string[]).includes(kind)) {
    const own = dictation.sameKey(kind as DictationDraft["kind"], payload)
    return own === null ? null : `${kind}:${own}`
  }
  const tooth = payload["toothNumber"] ?? ""
  if (kind === "receta") return `receta:${lower(payload["genericName"])}`
  if (kind === "alergia") return `alergia:${payload["none"] === true ? "ninguna" : lower(payload["substance"])}`
  if (kind === "diagnostico") return `diagnostico:${lower(payload["diagnosisCode"])}:${tooth}`
  if (kind === "plan" || kind === "procedimiento") return `${kind}:${lower(payload["serviceName"] ?? payload["service"])}:${tooth}`
  if (kind === "control") return `control:${lower(payload["title"])}`
  if (kind === "cita") return `cita:${lower(payload["date"])}`
  if (kind === "presupuesto") return "presupuesto"
  if (kind === "material") return `material:${lower(payload["product"])}`
  if (kind === "ficha") return `ficha:${String(payload["responseId"])}.${String(payload["fieldId"])}`
  return null
}

const joinSource = (before: string, now: string | undefined) => {
  const said = now?.trim() ?? ""
  return said && !before.includes(said) ? [before, said].filter(Boolean).join(" ") : before
}

/**
 * Aplica lo que devolvió una pausa a la atención simulada, como `saveDictationSegment`: primero las
 * correcciones y lo que pidió quitar (con el número de la lista que se le dio), después lo nuevo.
 * Con `review` (el repaso), sin correcciones ni «quita», y lo descartado no vuelve.
 */
export function applyPause(
  state: SimState,
  read: SimRead,
  input: { transcript: string; at: string; questions: readonly DictationFormQuestion[]; review?: boolean },
  product: SimProduct,
  parts: ServerParts = SERVER,
): { created: number; added: number; corrected: number; removed: number } {
  const { dictation, site } = product
  const { transcript, questions } = input
  const counts = { created: 0, added: 0, corrected: 0, removed: 0 }
  const listed = pendingOf(state)
  const health = (dictation as { health?: object }).health ?? {}

  // Lo que se le nombró a Clío: corregir y quitar apuntan a su posición en esta lista.
  if (!input.review) {
    for (const correction of read.corrections) {
      const row = listed[correction.index]
      if (!row || row.status === "descartada") continue
      if (parts.addsNotCorrects?.(correction.sourceText)) continue
      if (row.kind === "nota" || row.kind === "salud") {
        // La consulta y la salud solo se corrigen con la frase que lo pide (la rama nueva).
        if (parts.saidToCorrectNote && !parts.saidToCorrectNote(correction.sourceText, transcript)) continue
      }
      if (row.kind === "salud") {
        if (!parts.mergeHealth || !parts.prepareHealth) continue
        const merged = parts.mergeHealth(row.payload, correction.changes, true)
        const ready = parts.prepareHealth(merged.payload, undefined, health)
        if (!ready || JSON.stringify(ready.payload) === JSON.stringify(row.payload)) continue
        row.payload = ready.payload
        Object.assign(row.earlier, merged.earlier)
        row.corrected = true
        counts.corrected += 1
        continue
      }
      // Corregir una respuesta de ficha pasa por la comprobación con la base: no se simula.
      if (row.kind === "ficha") continue
      const patch = patchOf(row.kind, correction.changes)
      if (!Object.keys(patch).length) continue
      const next = { ...row.payload, ...patch }
      if (JSON.stringify(next) === JSON.stringify(row.payload)) continue
      row.payload = next
      row.corrected = true
      counts.corrected += 1
    }
    for (const removal of read.removals) {
      const row = listed[removal.index]
      if (!row || row.status === "descartada") continue
      row.status = "descartada"
      counts.removed += 1
    }
  }

  for (const said of read.unused) state.unused.push({ said, why: "sin_lugar", at: input.at })
  // Lo de un familiar o un peso dicho ya va a «No lo usé» en la pausa, como en la atención.
  for (const item of read.outOfPlace ?? []) state.unused.push({ said: item.said, why: item.why, at: input.at })
  if (read.omitted > read.unused.length) state.unused.push({ said: "", why: "sin_lugar", at: input.at })

  const pendingNow = pendingOf(state)
  const discarded = state.suggestions.filter((item) => item.status === "descartada")
  const dictated = read.drafts.slice(0, services.DICTATION_MAX_SUGGESTIONS).map((draft) => (parts.doubtfulAllergy ? parts.doubtfulAllergy(draft) : draft))
  const fromDiagnoses = services.withDiagnosisFormAnswers(dictated, questions).slice(dictated.length)
  const pendingValues = services.pendingFormValues(pendingNow, questions)
  const known = pendingNow.filter((item) => item.kind === "diagnostico").map((item) => item.payload)
  const fromForms = services.withFormDiagnoses([...dictated, ...fromDiagnoses], questions, product.formDiagnoses, { site, transcript, known, pending: pendingValues })
  const pendingNotes = [...pendingNow, ...(input.review ? discarded : [])]
    .filter((item) => item.kind === "nota")
    .flatMap((item) => Object.values(item.payload).filter((value): value is string => typeof value === "string"))
  const { drafts, twins } = services.withFormTwins(
    services.withoutRepeatedNotes(services.withoutFormNotes([...dictated, ...fromDiagnoses, ...fromForms], questions, site, transcript), pendingNotes),
    questions,
  )
  for (const draft of fromDiagnoses) twins.add(draft)

  type Ready = { payload: Payload; status: "lista" | "por_revisar"; said?: string | undefined }
  const prepare = (draft: (typeof drafts)[number]): Ready | null => {
    if (draft.kind === "nota") return filled(draft.payload) ? { payload: draft.payload, status: "lista" } : null
    if (draft.kind === "salud") {
      if (!parts.prepareHealth) return null
      const ready = parts.prepareHealth(draft.payload, draft.sourceText, health)
      return ready ? { payload: ready.payload, status: ready.status === "por_revisar" ? "por_revisar" : "lista" } : null
    }
    if (draft.kind === "ficha") {
      const ready = services.prepareFormAnswer(draft as Parameters<typeof services.prepareFormAnswer>[0], questions, site, transcript)
      return ready ? { payload: ready.payload, status: ready.status, said: ready.said } : null
    }
    return { payload: draft.payload, status: "lista" }
  }
  const outcomes: Array<{ draft: (typeof drafts)[number]; ready: boolean }> = []
  const prepared: Array<{ draft: (typeof drafts)[number]; ready: Ready }> = []
  for (const draft of drafts) {
    const ready = prepare(draft)
    outcomes.push({ draft, ready: ready !== null })
    if (ready) prepared.push({ draft, ready })
  }
  for (const notice of services.formDropNotices(outcomes, twins, questions, { site, transcript }, pendingValues)) {
    state.unused.push({ said: notice.said, why: notice.why, at: input.at })
  }

  const keys = new Map(pendingNow.flatMap((item) => {
    const key = dedupeKey(item.kind, item.payload, dictation)
    return key === null ? [] : [[key, item] as const]
  }))
  const settledKeys = new Set(discarded.flatMap((item) => dedupeKey(item.kind, item.payload, dictation) ?? []))
  const lastForm = new Map(prepared.flatMap(({ ready }, index) => (ready.payload["fieldId"] !== undefined ? [[`${String(ready.payload["responseId"])}.${String(ready.payload["fieldId"])}`, index] as const] : [])))
  let note = pendingNow.filter((item) => item.kind === "nota").at(-1)
  let saved = pendingNow.filter((item) => item.kind === "salud").at(-1)
  const create = (kind: string, ready: Ready, sourceText: string | undefined): SimSuggestion => {
    const row: SimSuggestion = { id: state.nextId++, kind, payload: ready.payload, sourceText: sourceText ?? "", status: ready.status, earlier: {}, corrected: false }
    state.suggestions.push(row)
    counts.created += 1
    return row
  }
  for (const [index, { draft, ready }] of prepared.entries()) {
    const sourceText = ready.said ?? draft.sourceText
    if (draft.kind === "ficha" && lastForm.get(`${String(ready.payload["responseId"])}.${String(ready.payload["fieldId"])}`) !== index) continue
    if (draft.kind === "nota") {
      // La rama nueva: lo nuevo se suma a la consulta pendiente; en `main`, cada una es otra tarjeta.
      if (parts.mergeNote && note) {
        // Sin `saysCorrection` (una rama anterior al 22 nov), lo dicho distinto siempre reemplazaba.
        const merged = parts.mergeNote(note.payload, ready.payload, parts.saysCorrection ? parts.saysCorrection(transcript, sourceText) : true)
        if (merged) {
          if (JSON.stringify(merged.payload) !== JSON.stringify(note.payload)) {
            note.payload = merged.payload
            Object.assign(note.earlier, merged.earlier)
            note.sourceText = joinSource(note.sourceText, sourceText)
            counts.added += 1
          }
          continue
        }
      }
      const row = create("nota", ready, sourceText)
      if (parts.mergeNote) note ??= row
      continue
    }
    if (draft.kind === "salud") {
      let payload = ready.payload
      if (input.review && parts.withoutSettledHealth) {
        // Como el servidor: una alergia ya nombrada (pendiente o descartada) gana al «no sabe» (mesa del 25 nov, H3).
        const namedAllergy = state.suggestions.some(
          (item) => item.kind === "alergia" && typeof item.payload["substance"] === "string" && String(item.payload["substance"]).trim() !== "",
        )
        const kept = parts.withoutSettledHealth(payload, discarded.filter((item) => item.kind === "salud").map((item) => item.payload), namedAllergy)
        if (!kept) continue
        payload = kept
      }
      if (saved && parts.mergeHealth && parts.prepareHealth) {
        const merged = parts.mergeHealth(saved.payload, payload)
        const ready2 = parts.prepareHealth(merged.payload, undefined, health)
        if (ready2 && JSON.stringify(ready2.payload) !== JSON.stringify(saved.payload)) {
          saved.payload = ready2.payload
          Object.assign(saved.earlier, merged.earlier)
          saved.sourceText = joinSource(saved.sourceText, sourceText)
          counts.added += 1
        }
        continue
      }
      saved = create("salud", { ...ready, payload }, sourceText)
      continue
    }
    const key = dedupeKey(draft.kind, ready.payload, dictation)
    if (input.review && key !== null && settledKeys.has(key)) continue
    const earlier = key === null ? undefined : keys.get(key)
    if (earlier) {
      // Una respuesta de ficha dicha otra vez con otro valor la cambia; lo demás ya está.
      if (draft.kind === "ficha" && JSON.stringify(earlier.payload["value"]) !== JSON.stringify(ready.payload["value"])) {
        earlier.payload = ready.payload
        earlier.status = ready.status
        earlier.corrected = true
        counts.corrected += 1
      }
      continue
    }
    const row = create(draft.kind, ready, sourceText)
    if (key !== null) keys.set(key, row)
  }
  return counts
}

/** El contexto de la pausa: de lo guardado en la rama nueva; de la pestaña en `main`, que lo pierde al recargar. */
export function pauseContext(earlier: readonly string[], sinceReload: readonly string[], parts: ServerParts = SERVER, tabChars = 600): string {
  if (parts.dictationContext) return parts.dictationContext(earlier)
  return sinceReload.join(" ").slice(-tabChars).trim()
}

/* ---------- Lo esperado ---------- */

/** Palabras con variantes («dos semanas|2 semanas»): basta con una, desde el inicio de una palabra. */
type Words = string[]

export interface ExpectedItem {
  /** La clase de sugerencia (`odontograma`, `diagnostico`, `alergia`, `procedimiento`, `control`, `examen`, `signos`…). */
  tipo: string
  /** Lo que tiene que decir su contenido, en cualquier campo. */
  con?: Words
  /** Campos que tiene que tener con ese valor (puede ser parte de un objeto). */
  campos?: Payload
}

export interface ExpectedHealth {
  /** Dónde, en la forma del registro: `medications`, `anticoagulants`, `dental.bruxismo`, `personal.embarazo`… */
  ruta: string
  valor?: unknown
  con?: Words
  /** Lo que se dijo antes y quedó como «antes dijo» (la corrección del paciente). */
  antes?: Words
}

export interface ExpectedCase {
  consulta?: {
    motivo?: Words
    motivoSin?: Words
    /** Una palabra del tiempo; `null`: no se dijo y queda vacío. */
    tiempo?: string | null
    tiempoSin?: Words
    relato?: Words
    relatoSin?: Words
  }
  salud?: ExpectedHealth[]
  /** Quién lo dijo, en la salud propuesta. */
  saludQuien?: { declarante: string; vinculo?: string }
  /** Lo de salud que no debe proponerse (lo de un familiar, la duda como «no»). */
  saludNo?: Array<Omit<ExpectedHealth, "antes">>
  propone?: ExpectedItem[]
  noPropone?: ExpectedItem[]
  /** Cuándo vuelve: un control o una cita con esas palabras. */
  vuelve?: { con: Words }
  /** Respuestas de la ficha abierta, «ficha.pregunta»: valor (lista para aceptar). */
  fichas?: Record<string, unknown>
  /** Lo que tiene que quedar en «No lo usé». */
  noLoUse?: Words
  /** Quién habló, por frase (tras el repaso). */
  quien?: Array<{ frase: string; quien: string; vinculo?: string }>
  /** Pura charla: no debe quedar nada, ni en «No lo usé». */
  nada?: true
}

export interface CaseScore {
  /** Lo dicho que se esperaba en su lugar. */
  esperado: number
  llego: number
  /** No llegó, pero está en «No lo usé» o por revisar. */
  avisado: number
  perdidoSinAviso: number
  /** Comprobaciones de lo que no debe colarse, y cuántas fallaron. */
  ruidoComprobado: number
  ruido: number
  noLoUse: { bien: number; total: number }
  quien: { bien: number; total: number }
  consultas: number
  notas: string[]
}

export const plain = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Si el texto tiene alguna de las variantes, empezando donde empieza una palabra (como `eval-consulta`). */
export const has = (text: string, word: string) =>
  word.split("|").some((variant) => new RegExp(`(^|[^a-z0-9])${literal(plain(variant))}`).test(plain(text)))

const textOf = (value: unknown) => plain(JSON.stringify(value ?? ""))

/** ¿`value` tiene todo lo de `want`? Los objetos, campo por campo; lo demás, igual. */
export function partial(value: unknown, want: unknown): boolean {
  if (isRecord(want)) return isRecord(value) && Object.entries(want).every(([key, item]) => partial(value[key], item))
  if (Array.isArray(want) && Array.isArray(value)) return JSON.stringify([...want].sort()) === JSON.stringify([...value].sort())
  return JSON.stringify(value) === JSON.stringify(want)
}

const at = (payload: Payload, path: string): unknown => path.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), payload)

const itemMatches = (item: SimSuggestion, want: ExpectedItem) =>
  item.kind === want.tipo && (!want.campos || partial(item.payload, want.campos)) && (want.con ?? []).every((word) => has(textOf(item.payload), word))

const healthMatches = (item: SimSuggestion, want: Omit<ExpectedHealth, "antes"> & { antes?: Words }) => {
  const value = at(item.payload, want.ruta)
  if (value === undefined) return false
  if (want.valor !== undefined && !partial(value, want.valor)) return false
  if (!(want.con ?? []).every((word) => has(textOf(value), word))) return false
  return (want.antes ?? []).every((word) => Object.values(item.earlier).some((before) => has(before, word)))
}

/** Lo dicho en «No lo usé», con cualquiera de sus variantes (o la frase guardada dentro de la variante). */
const inUnused = (unused: readonly SimUnused[], word: string) =>
  unused.some((item) => item.said && word.split("|").some((variant) => plain(item.said).includes(plain(variant)) || (plain(item.said).length >= 12 && plain(variant).includes(plain(item.said)))))

/** La consulta como quedaría: los campos de todas sus tarjetas, juntos. */
function consultaOf(notes: readonly SimSuggestion[]) {
  const join = (key: string) => notes.map((item) => String(item.payload[key] ?? "")).filter((value) => value.trim()).join(" | ")
  const durations = new Set(notes.map((item) => plain(String(item.payload["illnessDuration"] ?? ""))).filter(Boolean))
  return { motivo: join("reason"), tiempo: join("illnessDuration"), relato: join("presentIllness"), durations: durations.size }
}

/**
 * Compara la atención simulada, al final (con el repaso si lo hubo), con lo esperado del caso. Cada
 * dato esperado llega a su lugar, se avisa (está en «No lo usé» o por revisar) o se pierde sin
 * aviso; cada cosa que no debía colarse cuenta como ruido; «quién habló», por frase.
 */
export function scoreCase(expected: ExpectedCase, state: SimState): CaseScore {
  const score: CaseScore = { esperado: 0, llego: 0, avisado: 0, perdidoSinAviso: 0, ruidoComprobado: 0, ruido: 0, noLoUse: { bien: 0, total: 0 }, quien: { bien: 0, total: 0 }, consultas: 0, notas: [] }
  const pending = pendingOf(state)
  const notes = pending.filter((item) => item.kind === "nota")
  const health = pending.filter((item) => item.kind === "salud")
  score.consultas = notes.length
  /** Algo que debía llegar: llegó, se avisó (con sus palabras en «No lo usé») o se perdió sin aviso. */
  const positive = (label: string, ok: boolean, words: Words, reviewing = false) => {
    score.esperado += 1
    if (ok) {
      score.llego += 1
      return
    }
    if (reviewing || words.some((word) => inUnused(state.unused, word))) {
      score.avisado += 1
      score.notas.push(`avisado: ${label}`)
      return
    }
    score.perdidoSinAviso += 1
    score.notas.push(`PERDIDO: ${label}`)
  }
  const negative = (label: string, clean: boolean) => {
    score.ruidoComprobado += 1
    if (clean) return
    score.ruido += 1
    score.notas.push(`RUIDO: ${label}`)
  }

  const consulta = expected.consulta
  if (consulta) {
    const got = consultaOf(notes)
    const hasNote = notes.length > 0
    for (const word of consulta.motivo ?? []) positive(`motivo con «${word}»`, hasNote && has(got.motivo, word), [word])
    for (const word of consulta.motivoSin ?? []) negative(`motivo con «${word}»`, !has(got.motivo, word))
    if (consulta.tiempo === null) negative(`tiempo «${got.tiempo}», debía quedar vacío`, got.tiempo === "")
    else if (consulta.tiempo !== undefined) positive(`tiempo con «${consulta.tiempo}»`, hasNote && has(got.tiempo, consulta.tiempo), [consulta.tiempo])
    for (const word of consulta.tiempoSin ?? []) negative(`tiempo con «${word}»`, !has(got.tiempo, word))
    for (const word of consulta.relato ?? []) positive(`relato con «${word}»`, hasNote && has(got.relato, word), [word])
    for (const word of consulta.relatoSin ?? []) negative(`relato con «${word}»`, !has(got.relato, word))
    if (hasNote) {
      negative(`${notes.length} tarjetas de consulta`, notes.length === 1)
      negative(`el tiempo con ${got.durations} valores («${got.tiempo}»)`, got.durations <= 1)
    }
  }

  for (const want of expected.salud ?? []) {
    const label = `salud ${want.ruta}${want.con ? ` con «${want.con.join(", ")}»` : ""}${want.valor !== undefined ? ` = ${JSON.stringify(want.valor)}` : ""}${want.antes ? ` (antes dijo «${want.antes.join(", ")}»)` : ""}`
    positive(label, health.some((item) => healthMatches(item, want)), [...(want.con ?? []), ...(want.antes ?? [])])
  }
  if (expected.saludQuien) {
    const who = expected.saludQuien
    const ok = health.some((item) => item.payload["declarante"] === who.declarante && (!who.vinculo || has(String(item.payload["vinculo"] ?? ""), who.vinculo)))
    positive(`salud dicha por ${who.declarante}${who.vinculo ? ` (${who.vinculo})` : ""}`, ok, [])
  }
  for (const want of expected.saludNo ?? []) {
    negative(`salud ${want.ruta}${want.con ? ` con «${want.con.join(", ")}»` : ""}`, !health.some((item) => healthMatches(item, want)))
  }

  for (const want of expected.propone ?? []) {
    const label = `${want.tipo}${want.campos ? ` ${JSON.stringify(want.campos)}` : ""}${want.con ? ` con «${want.con.join(", ")}»` : ""}`
    positive(label, pending.some((item) => itemMatches(item, want)), want.con ?? [])
  }
  for (const want of expected.noPropone ?? []) {
    negative(`${want.tipo}${want.campos ? ` ${JSON.stringify(want.campos)}` : ""}${want.con ? ` con «${want.con.join(", ")}»` : ""}`, !pending.some((item) => itemMatches(item, want)))
  }
  if (expected.vuelve) {
    const words = expected.vuelve.con
    const ok = pending.some((item) => (item.kind === "control" || item.kind === "cita") && words.every((word) => has(textOf(item.payload), word)))
    positive(`cuándo vuelve, con «${words.join(", ")}»`, ok, words)
  }
  for (const [key, value] of Object.entries(expected.fichas ?? {})) {
    const [responseId, fieldId] = key.split(".")
    const found = pending.filter((item) => item.kind === "ficha" && item.payload["responseId"] === responseId && item.payload["fieldId"] === fieldId && partial(item.payload["value"], value))
    const ready = found.some((item) => item.status === "lista")
    positive(`ficha ${key} = ${JSON.stringify(value)}`, ready, [], !ready && found.length > 0)
  }

  for (const word of expected.noLoUse ?? []) {
    score.noLoUse.total += 1
    if (inUnused(state.unused, word)) score.noLoUse.bien += 1
    else {
      score.perdidoSinAviso += 1
      score.notas.push(`PERDIDO: «${word}» no está en «No lo usé»`)
    }
  }

  for (const want of expected.quien ?? []) {
    score.quien.total += 1
    const turn = state.turns.find((item) => plain(item.texto).includes(plain(want.frase)))
    const ok = !!turn && turn.quien === want.quien && (!want.vinculo || has(turn.vinculo ?? "", want.vinculo))
    if (ok) score.quien.bien += 1
    else score.notas.push(`quién: «${want.frase}» ${turn ? `como ${turn.quien}${turn.vinculo ? ` (${turn.vinculo})` : ""}` : "sin turno"}, era ${want.quien}${want.vinculo ? ` (${want.vinculo})` : ""}`)
  }

  if (expected.nada) {
    score.ruidoComprobado += 1
    const extra = pending.length + state.unused.filter((item) => item.said).length
    if (extra) {
      score.ruido += extra
      score.notas.push(`RUIDO: la charla dejó ${pending.map((item) => item.kind).join(", ") || "nada"}${state.unused.some((item) => item.said) ? ` y ${state.unused.filter((item) => item.said).length} en «No lo usé»` : ""}`)
    }
  }
  return score
}

/** La suma de los casos. */
export function sumScores(scores: readonly CaseScore[]): Omit<CaseScore, "notas" | "consultas"> & { consultasDeMas: number } {
  const total = { esperado: 0, llego: 0, avisado: 0, perdidoSinAviso: 0, ruidoComprobado: 0, ruido: 0, noLoUse: { bien: 0, total: 0 }, quien: { bien: 0, total: 0 }, consultasDeMas: 0 }
  for (const score of scores) {
    total.esperado += score.esperado
    total.llego += score.llego
    total.avisado += score.avisado
    total.perdidoSinAviso += score.perdidoSinAviso
    total.ruidoComprobado += score.ruidoComprobado
    total.ruido += score.ruido
    total.noLoUse.bien += score.noLoUse.bien
    total.noLoUse.total += score.noLoUse.total
    total.quien.bien += score.quien.bien
    total.quien.total += score.quien.total
    total.consultasDeMas += Math.max(0, score.consultas - 1)
  }
  return total
}
