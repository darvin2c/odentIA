import { toast } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"
import { byFormOrder, type FormTarget, proposesValue, signOrder } from "./clio-form-proposals"

export type DictationKind = "nota" | "diagnostico" | "plan" | "control" | "odontograma" | "receta" | "signos" | "examen" | "descanso" | "alergia" | "procedimiento" | "cita" | "presupuesto" | "material" | "ficha" | "salud"

export interface DictationSuggestion {
  id: string
  kind: DictationKind
  payload: Record<string, unknown>
  sourceText: string
  status: "lista" | "por_revisar" | "confirmada" | "descartada"
  note: string | null
  summary: string
  /**
   * Corregida por voz al seguir dictando: qué decía antes. `removed`: lo de su salud que se quitó por voz,
   * dato por dato, con lo que se dijo para quitarlo (se deshace igual que una corrección).
   */
  voice: { before: string; removed?: string } | null
  /** Quitada por voz: lo que dijo para pedirlo. Se puede deshacer hasta firmar. */
  removal: { said: string } | null
  /** Al confirmar una nota: cómo quedó cada texto en la atención, ya unido a lo que había. */
  joined?: Record<string, string>
  /** Ya confirmada, y se pidió quitarla en voz alta: espera «Quitar del plan» o «Dejarla». */
  undoRequest?: { said: string } | null
  /** Lo de su salud: lo de la entrevista con sus claves, para dejarlo puesto en Antecedentes. */
  interview?: Record<string, unknown>
  /** Lo de su salud, dato por dato y con quién lo dijo, como lo arma el servidor (`healthRows`). */
  healthRows?: SaidHealthRow[]
}

/** Quién dijo un dato de su salud: el paciente, quien lo acompaña (con su vínculo) o no se sabe. */
export interface HealthSaidBy {
  declarante: "paciente" | "acompanante" | "no_se_sabe"
  vinculo?: string
}

/** Un dato de su salud que se dijo en la consulta, como lo arma el servidor. */
export interface SaidHealthRow {
  /** El grupo («anticoagulants») o el campo de la entrevista («dental.problemaAnestesia»). */
  key: string
  group: string
  label: string
  value: string
  by: HealthSaidBy
  /** Lo que dijo antes, si lo dijo distinto. */
  before: string | null
  /** Es un «No»: se confirma en su fila, nunca con «Lo revisé con…». */
  denied?: boolean
  /** Lo que ya no toma: se confirma en su fila con «Sí, lo dejó». */
  stopped?: boolean
  /** La frase en que se oyó, tal cual: la fila la muestra entre comillas. */
  said?: string | null
  /** Lo dicho con palabras de todos los días y la enfermedad que sugiere («presión» → «Hipertensión arterial»). */
  suggested?: Array<{ said: string; name: string }>
}

/** Una frase de lo que se dijo que está en una sugerencia (pendiente o confirmada), con su clase. */
export interface SaidSource {
  kind: string
  said: string
}

/** Lo que devuelve `GET …/dictation/said`. */
export interface SaidReply {
  data: { segments: DictationSaidSegment[]; used?: SaidSource[] }
}

export const NOTE_FIELD_LABEL = {
  reason: "Motivo de consulta",
  presentIllness: "Relato de la enfermedad",
  illnessDuration: "Tiempo de enfermedad",
  evolution: "Evolución",
  indications: "Indicaciones",
  prognosis: "Pronóstico",
} as const

export const DICTATION_KIND_LABEL: Record<DictationKind, string> = {
  nota: "Consulta",
  diagnostico: "Diagnóstico",
  plan: "Plan de tratamiento",
  control: "Controles",
  odontograma: "Odontograma",
  receta: "Receta",
  signos: "Signos vitales",
  examen: "Examen físico",
  descanso: "Descanso médico",
  alergia: "Alergias",
  procedimiento: "Procedimientos",
  cita: "Próxima cita",
  presupuesto: "Presupuesto",
  material: "Materiales",
  ficha: "Fichas",
  salud: "Salud",
}

/** Silencio tras el que se ordena lo dicho hasta ahí: una llamada al modelo por pausa, no por palabra. */
const SILENCE_MS = 2500
/** Por debajo de esto no vale una llamada mientras se sigue hablando; al pausar o terminar se envía igual. */
const MIN_SEGMENT_CHARS = 12
/**
 * Cada cuánto se vuelve a mirar un tramo o un repaso que otro pedido está ordenando («en curso»):
 * el servidor no llama dos veces al modelo y esta pestaña espera a que termine.
 */
const IN_PROGRESS_MS = 3000
/** Cuántas veces se vuelve a mirar: de sobra para lo que tarda una llamada al modelo. */
const IN_PROGRESS_TRIES = 20
/** Cuánto espera «Finalizar y firmar» a que se ordene lo último que se dijo antes de abrir el cierre. */
const SETTLE_MS = 90_000
/**
 * Lo que «Confirmar las N listas» lleva de un toque. Una receta no: emitirla
 * es firmarla con la colegiatura y tiene su propio botón (issue 109, fase 2).
 * El descanso médico tampoco (latidIA, issue 229). La respuesta de una ficha
 * tampoco: se confirma en su pregunta, dentro de la ficha (forma B, ADR 0188).
 *
 * Lo de su salud tampoco, ni ninguna negación («No tiene alergias»): se revisan con la persona, de a
 * una (mesa del 20 nov 2026). Lo de su salud se confirma con «Lo revisé con…», nunca al firmar.
 */
export const confirmable = (item: DictationSuggestion) =>
  item.status === "lista" && item.kind !== "receta" && item.kind !== "descanso" && item.kind !== "ficha" && item.kind !== "salud" && !deniesHealth(item)
/** Una negación de su salud: «No tiene alergias». Se confirma de a una. */
const deniesHealth = (item: DictationSuggestion) => item.kind === "alergia" && item.payload["none"] === true
/**
 * Lo que se confirma al firmar si está marcado: también las respuestas de ficha, y la que cambia lo
 * escrito, que viene desmarcada (`markedByDefault`), y una negación, también desmarcada.
 */
export const confirmableAtSign = (item: DictationSuggestion) =>
  confirmable(item) || (item.kind === "ficha" && proposesValue(item)) || (deniesHealth(item) && item.status === "lista")
/**
 * Al firmar viene marcado lo que se puede confirmar, menos lo que quedó por revisar (lo que cambia lo
 * escrito a mano, lo de la segunda lectura) y las negaciones: eso lo decide una persona.
 */
export const markedByDefault = (item: DictationSuggestion) => confirmableAtSign(item) && item.status === "lista" && !deniesHealth(item)
/** La que ya se decidió (otro toque, otra pestaña): para quien confirmaba, ya está. */
const alreadyDecided = (error: unknown) => error instanceof ApiError && error.shape.code === "SUGGESTION_DECIDED"
/**
 * Confirmar una respuesta de ficha manda lo que se veía (si una pausa la cambió, el servidor
 * avisa) y si entra al firmar: la ficha dice «confirmó al firmar».
 */
const confirmBody = (item: DictationSuggestion, atSign = false): RequestInit =>
  item.kind === "ficha"
    ? { method: "POST", body: JSON.stringify({ expectedValue: item.payload["value"] ?? null, ...(atSign ? { atSign: true } : {}) }) }
    : { method: "POST" }

/** Espera antes del único reintento automático de un tramo que no se pudo ordenar. */
const RETRY_MS = 3000

interface SpeechLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

/** El reconocimiento de voz del navegador, si lo tiene. Sin él, el dictado se escribe o se pega. */
function speechRecognition(): (new () => SpeechLike) | null {
  if (typeof window === "undefined") return null
  const scope = window as unknown as { SpeechRecognition?: new () => SpeechLike; webkitSpeechRecognition?: new () => SpeechLike }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

export function dictationErrorText(error: unknown, fallback: string): string | null {
  if (error == null) return null
  if (error instanceof ApiError && error.shape.message && error.status < 500) return error.shape.message
  return fallback
}

/**
 * Un tramo que se manda a ordenar. Lo dicho antes ya está guardado con la atención: el contexto lo
 * pone el servidor. `retryOf`: «Intentar otra vez» una frase que Clío no usó, del tramo donde se dijo.
 */
interface Segment {
  id: string
  text: string
  retryOf?: string
}

/** Un tramo que no se pudo ordenar ni al reintentarlo: queda aparte, con su hora, y lo demás sigue. */
export interface FailedSegment extends Segment {
  at: Date
  message: string
}

interface SegmentResponse {
  data: {
    suggestions: DictationSuggestion[]
    corrected: string[]
    /** Las pendientes a las que esta pausa sumó algo (la consulta, lo de su salud). */
    added?: string[]
    removed: string[]
    sources: string[]
    /** Los fragmentos de este tramo que dieron lo de su salud (o una alergia): van en ámbar. */
    healthSources?: string[]
    /** Partes de este tramo que el asistente no pudo usar y, si se sabe, lo que se dijo para pedirlas. */
    omitted: number
    unused: string[]
    /** Por qué no se usó una frase, cuando se sabe (lo de una ficha lo dice el servidor). */
    unusedWhy?: Record<string, string>
    /** De qué clase es cada frase no usada (`DictationUnusedItem["why"]`): el motivo se dice como en «Lo que se dijo». */
    unusedKind?: Record<string, DictationUnusedItem["why"]>
    /** La pregunta de la ficha que nombra cada frase: «Usar en Percusión». */
    unusedFor?: Record<string, FormTarget[]>
    /** Alergias dichas que ya estaban registradas: no se proponen otra vez. */
    alreadyOnFile?: string[]
    alreadyDone?: string[]
    repeated: boolean
    /** Otro pedido del mismo tramo lo está ordenando: no se llamó al modelo; se vuelve a mirar. */
    inProgress?: boolean
    model: string | null
  }
}

/** Lo que el asistente no pudo usar desde el último «Entendido»: las frases y si hubo algo sin frase. */
export interface UnusedDictation {
  phrases: string[]
  unnamed: boolean
  /** Por qué no se usó cada frase, con las mismas palabras que «Lo que se dijo» (`unusedReason`). */
  why: Record<string, string>
  /** Las frases sin un motivo propio («no supe dónde va»): piden decirlo de nuevo o anotarlo a mano. */
  open?: string[]
  /** La pregunta de la ficha que nombra cada frase, para abrirla con la frase al lado. */
  targets: Record<string, FormTarget[]>
}

const NOTHING_UNUSED: UnusedDictation = { phrases: [], unnamed: false, why: {}, targets: {} }

/**
 * Lo que «No pude usar esto» ya no tiene que decir: la frase de una pausa anterior cuya pregunta de
 * ficha quedó propuesta en esta con una frase que la contiene. Es la frase que cortó la pausa (prueba
 * con voz del 16 nov, c6, v07: «…frío sin respuesta calor» avisaba «calor», y la pausa siguiente
 * proponía «calor sin respuesta»). Lo que se propuso con otras palabras sigue avisado.
 */
export function withoutAnsweredUnused(unused: UnusedDictation, suggestions: readonly DictationSuggestion[]): UnusedDictation {
  // Sin mayúsculas, tildes ni puntuación: «Calor, sin respuesta.» contiene «calor».
  const loose = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  const answered = suggestions.filter((item) => item.kind === "ficha" && (item.status === "lista" || item.status === "por_revisar"))
  const resolved = (phrase: string) => {
    const targets = unused.targets[phrase] ?? []
    return answered.some(
      (item) =>
        targets.some((target) => target.responseId === item.payload["responseId"] && target.fieldId === item.payload["fieldId"]) &&
        ` ${loose(item.sourceText)} `.includes(` ${loose(phrase)} `),
    )
  }
  const gone = new Set(unused.phrases.filter(resolved))
  if (!gone.size) return unused
  const keep = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([phrase]) => !gone.has(phrase)))
  return {
    ...unused,
    phrases: unused.phrases.filter((phrase) => !gone.has(phrase)),
    why: keep(unused.why),
    open: unused.open?.filter((phrase) => !gone.has(phrase)),
    targets: keep(unused.targets),
  }
}

export type DictationMode = "off" | "listening" | "paused"

/**
 * El repaso al terminar (mesa del 20 nov 2026, P4): «Terminar dictado» lo pide cuando ya se ordenó
 * lo último que se dijo. El servidor solo llama al modelo si hay tramos que ningún repaso leyó.
 * `reviewed`: si leyó algo esta vez; `added`: cuántas propuestas nuevas o sumadas dejó.
 */
export type DictationReview =
  | { status: "idle" }
  | { status: "reviewing" }
  /**
   * `unsplit`: los tramos que quedaron en un turno de «No se sabe» porque no se pudieron separar (UX-1).
   * `where`: el bloque de cada cosa nueva («Consulta», «Próxima cita»), una vez cada uno: la barra dice
   * cuáles son y lleva a ellas (QA del 22 nov: «2 cosas nuevas» sin decir cuáles).
   */
  | { status: "done"; reviewed: boolean; added: number; turns: number; unsplit: number; where: DictationKind[] }
  | { status: "failed"; message: string }

interface ReviewResponse {
  data: { reviewed: boolean; inProgress?: boolean; suggestions: DictationSuggestion[]; added: string[]; turnsSaved: string[]; turnsUnsplit?: string[] }
}

/**
 * «Intentar otra vez» una frase de «No lo usé»: `where` nulo mientras Clío la vuelve a leer; después,
 * los bloques donde la usó, o vacío si sigue sin lugar.
 */
export interface RetriedUnused {
  phrase: string
  where: DictationKind[] | null
}

/** La clave de «Lo que se dijo» de la atención: el repaso la deja vieja (los turnos, lo que no usó). */
export const dictationSaidKey = (patientId: string, encounterId: string) => ["encounter-dictation-said", patientId, encounterId] as const

/** Quién habló en un turno, según el repaso: quien atiende, el paciente, quien lo acompaña o no se sabe. */
export const DICTATION_SPEAKERS = ["dra", "paciente", "acompanante", "no_se_sabe"] as const
export type DictationSpeaker = (typeof DICTATION_SPEAKERS)[number]

/** Un turno de un tramo de lo que se dijo (lo arma el repaso al terminar). */
export interface DictationTurn {
  quien: DictationSpeaker
  vinculo?: string
  texto: string
}

/**
 * Lo que Clío no usó de un tramo y por qué: no supo dónde va (`sin_lugar`), quiso cambiar algo ya
 * confirmado (`ya_confirmada`) o no se dejó pasar (`no_propuesta`, con lo que se dice en `detail`).
 * `said` nulo: no supo citar la frase.
 */
export interface DictationUnusedItem {
  said: string | null
  why: "sin_lugar" | "ya_confirmada" | "no_propuesta"
  detail?: string
  targets?: FormTarget[]
}

/** Un tramo de «Lo que se dijo», guardado con la atención (`GET …/dictation/said`). */
export interface DictationSaidSegment {
  segmentId: string
  transcript: string
  saidAt: string
  createdBy: string
  /** Clío ya lo ordenó; si no, falló o sigue en curso. */
  organized: boolean
  unused: DictationUnusedItem[]
  /** Los turnos, tras el repaso al terminar; nulo antes. */
  turns: DictationTurn[] | null
  /**
   * Ya lo leyó un repaso, aunque no haya dejado turnos: no pide otro. Un servidor de antes no lo
   * manda: entonces vale si tiene turnos.
   */
  reviewed?: boolean
}

/** Lo que refresca lo de su salud: el aviso «Pregúntale a…», la franja y el cierre. */
const healthKeys = (patientId: string) => [
  ["patient-health", patientId],
  ["patient", patientId],
  ["patient-summary", patientId],
  ["encounter-closing", patientId],
]

/** Los grupos de su salud que puede traer la sugerencia `salud` (la forma de su registro). */
export const HEALTH_GROUPS: readonly string[] = [
  "anticoagulants",
  "boneMedicines",
  "medications",
  "stopped",
  "conditions",
  "allergies",
  "personal",
  "gyneco",
  "medical",
  "dental",
  "family",
]

export type DictationSession = ReturnType<typeof useDictationSession>

/**
 * El dictado de una atención: el micrófono, lo dictado (solo en memoria de esta
 * pantalla), los tramos que se envían a ordenar y las sugerencias que el
 * odontólogo aún no decide. La pantalla lo usa una sola vez y reparte sus
 * piezas: la barra, las sugerencias dentro de cada bloque, el respaldo de lo
 * dictado y el aviso antes de firmar.
 *
 * Mientras se dicta, cada pausa cierra un tramo y solo ese tramo viaja al
 * modelo; un tramo lleva su identidad, así que reintentarlo no duplica
 * sugerencias. Nada de esto escribe en la historia: eso lo hace confirmar.
 */
export function useDictationSession({
  patientId,
  encounterId,
  active,
  onApplied,
  noteText,
  openForms,
}: {
  patientId: string
  encounterId: string
  /** Solo para quien lleva la atención y puede escribirla. */
  active: boolean
  /** Una sugerencia entró a la historia: la pantalla refresca lo que muestra. */
  onApplied: (item: DictationSuggestion) => void
  /** Lo que muestra hoy un campo de la nota. */
  noteText: (key: string) => string
  /** Las fichas abiertas en pantalla: Clío las lee aunque no sean de las dos últimas tocadas. */
  openForms?: () => string[]
}) {
  const queryClient = useQueryClient()
  const base = `/api/patients/${patientId}/encounters/${encounterId}/dictation`
  const key = useMemo(() => ["encounter-dictation", patientId, encounterId], [patientId, encounterId])

  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{
        data: {
          enabled: boolean
          suggestions: DictationSuggestion[]
          removedByVoice: DictationSuggestion[]
          undoRequests?: DictationSuggestion[]
          /** Las piezas nombradas en lo dictado de esta atención. */
          teeth?: number[]
          confirmed: number
          /** Por qué Clío no escucha en esta atención (el presupuesto del mes o el saldo de prueba); null si escucha. */
          blocked?: { code: string; message: string } | null
        }
      }>(base),
    retry: false,
    enabled: active,
  })
  const enabled = active && query.data?.data.enabled === true
  const suggestions = useMemo(() => query.data?.data.suggestions ?? [], [query.data])
  const removedByVoice = useMemo(() => query.data?.data.removedByVoice ?? [], [query.data])
  const undoRequests = useMemo(() => query.data?.data.undoRequests ?? [], [query.data])
  const teeth = useMemo(() => query.data?.data.teeth ?? [], [query.data])
  const confirmed = query.data?.data.confirmed ?? 0
  const blocked = query.data?.data.blocked ?? null
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: key }), [queryClient, key])
  // «Lo que se dijo»: guardado con la atención, sigue igual al recargar o al volver otro día.
  const saidKey = useMemo(() => dictationSaidKey(patientId, encounterId), [patientId, encounterId])
  const saidQuery = useQuery({
    queryKey: saidKey,
    queryFn: () => apiFetch<SaidReply>(`${base}/said`),
    retry: false,
    enabled,
  })
  const saved = useMemo(() => saidQuery.data?.data.segments ?? [], [saidQuery.data])
  const saidUsed = useMemo(() => saidQuery.data?.data.used ?? [], [saidQuery.data])
  // Lo que esta pestaña ya mandó y el servidor aún no devuelve (se está ordenando): se ve igual.
  const [sentHere, setSentHere] = useState<DictationSaidSegment[]>([])
  const said = useMemo(() => {
    const known = new Set(saved.map((segment) => segment.segmentId))
    return [...saved, ...sentHere.filter((segment) => !known.has(segment.segmentId))]
  }, [saved, sentHere])
  // Lo que el servidor ya devuelve sale de lo mandado aquí: la lista no crece mientras la pestaña sigue abierta.
  useEffect(() => {
    const known = new Set(saved.map((segment) => segment.segmentId))
    setSentHere((current) => (current.some((segment) => known.has(segment.segmentId)) ? current.filter((segment) => !known.has(segment.segmentId)) : current))
  }, [saved])
  const refreshSaid = useCallback(() => queryClient.invalidateQueries({ queryKey: saidKey }), [queryClient, saidKey])
  /** Lo de su salud cambió (una pausa, el repaso, «Lo revisé con…»): el aviso y la franja lo dicen al momento. */
  const refreshHealth = useCallback(
    () => Promise.all(healthKeys(patientId).map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
    [queryClient, patientId],
  )

  const [mode, setMode] = useState<DictationMode>("off")
  const [seconds, setSeconds] = useState(0)
  const [transcript, setTranscript] = useState("")
  const [interim, setInterim] = useState("")
  const [highlights, setHighlights] = useState<string[]>([])
  const [healthHighlights, setHealthHighlights] = useState<string[]>([])
  const [micError, setMicError] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const [failed, setFailed] = useState<FailedSegment[]>([])
  const [unused, setUnused] = useState<UnusedDictation>(NOTHING_UNUSED)
  const [demo, setDemo] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  // La sugerencia en la que se detuvo «Confirmar las N listas», para decir cuál falló.
  const [confirmReadyFailed, setConfirmReadyFailed] = useState<DictationSuggestion | null>(null)
  // La marcada en la que se detuvo «Firmar con N marcadas»: el aviso de la firma dice cuál.
  const [confirmManyFailed, setConfirmManyFailed] = useState<DictationSuggestion | null>(null)
  const [review, setReview] = useState<DictationReview>({ status: "idle" })
  // Lo que pasó con el último «Intentar otra vez»: dónde lo usó, o nada (`where` vacío) y sigue en «No lo usé».
  const [retried, setRetried] = useState<RetriedUnused | null>(null)
  // Lo escrito en el cuadro y aún no mandado: vive aquí, no en el cuadro, para que no se pierda si la
  // barra se vuelve a dibujar al llegar las propuestas (QA del 21 nov, novato T3 pausa 3).
  const [typedDraft, setTypedDraft] = useState("")

  const recognition = useRef<SpeechLike | null>(null)
  const wanted = useRef(false)
  // Ya se reabrió tras un corte de red y aún no se oyó nada: otro corte significa que la red no volvió.
  const reopenedAfterCut = useRef(false)
  // Lo que se va oyendo sin cerrar: si el servicio de voz corta con «network» en medio de una frase, no se pierde.
  const partialHeard = useRef("")
  const text = useRef("")
  const sent = useRef(0)
  const queue = useRef<Segment[]>([])
  const draining = useRef(false)
  const silence = useRef<number | null>(null)
  const mounted = useRef(true)
  // «Terminar dictado» pidió el repaso: va cuando la cola de tramos se vacía.
  const reviewWanted = useRef(false)
  const reviewing = useRef(false)
  // Hay tramos sin repasar (del último render): `settle` lo mira después de esperar.
  const unreviewedRef = useRef(false)
  const canListen = speechRecognition() !== null

  useEffect(() => {
    if (mode !== "listening") return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [mode])

  /** El bloque de lo nuevo y de las pendientes a las que se sumó algo (por su id), una vez cada uno. */
  const kindsOf = useCallback(
    (fresh: readonly DictationSuggestion[], addedIds: readonly string[]): DictationKind[] => {
      const known = queryClient.getQueryData<{ data: { suggestions: DictationSuggestion[] } }>(key)?.data.suggestions ?? []
      const kindOf = new Map([...known, ...fresh].map((item) => [item.id, item.kind] as const))
      return [...new Set([...fresh.map((item) => item.kind), ...addedIds.flatMap((id) => kindOf.get(id) ?? [])])]
    },
    [queryClient, key],
  )

  /** Ordena un tramo y refleja lo que volvió: lo resaltado, lo que no se pudo usar y las sugerencias. */
  const send = useCallback(
    async (segment: Segment) => {
      const post = () =>
        apiFetch<SegmentResponse>(base, {
          method: "POST",
          body: JSON.stringify({
            transcript: segment.text,
            segmentId: segment.id,
            ...(segment.retryOf ? { retryOf: segment.retryOf } : {}),
            ...(openForms?.().length ? { openForms: openForms().slice(0, 5) } : {}),
          }),
        })
      let response = await post()
      // Otro pedido del mismo tramo lo está ordenando (el reintento tras un corte, otra pestaña): no se
      // paga dos veces; se espera a que termine y entonces se lee lo que dejó.
      for (let tries = 0; response.data.inProgress && tries < IN_PROGRESS_TRIES && mounted.current; tries += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, IN_PROGRESS_MS))
        response = await post()
      }
      if (!mounted.current) return
      const data = response.data
      if (data.model) setDemo(data.model === "fake")
      if (data.sources.length) setHighlights((current) => [...current, ...data.sources])
      if (data.healthSources?.length) setHealthHighlights((current) => [...current, ...(data.healthSources ?? [])])
      // La alergia que ya estaba registrada no se propone otra vez: se dice y se sigue.
      for (const name of data.alreadyOnFile ?? []) toast(`La alergia a ${name} ya está en sus antecedentes.`)
      for (const name of data.alreadyDone ?? []) toast(`Ya está registrado en esta atención: «${name}». No se vuelve a sumar.`)
      // Lo de su salud que esta pausa propuso, sumó o corrigió: la franja y el aviso lo dicen ya.
      // También una alergia: la franja dice «Alergias: dijo…, sin confirmar» (QA del 25 nov: seguía en
      // «Niega alergias» hasta recargar si en la pausa solo se habló de alergias).
      const saidKinds = new Set(["salud", "alergia"])
      const healthIds = new Set(
        (queryClient.getQueryData<{ data: { suggestions: DictationSuggestion[] } }>(key)?.data.suggestions ?? [])
          .filter((item) => saidKinds.has(item.kind))
          .map((item) => item.id),
      )
      const touchedHealth =
        data.suggestions.some((item) => saidKinds.has(item.kind)) || [...(data.added ?? []), ...data.corrected].some((id) => healthIds.has(id))
      setUnused((before) => {
        // Lo avisado antes que esta pausa respondió ya no se avisa; después, lo que esta no pudo usar.
        const current = withoutAnsweredUnused(before, data.suggestions)
        if (data.omitted === 0) return current
        // El motivo de cada frase, dicho como en «Lo que se dijo»: el mismo para la misma frase (QA del 23 nov).
        const items = data.unused.map((said) => ({ said, why: data.unusedKind?.[said] ?? "sin_lugar", ...(data.unusedWhy?.[said] ? { detail: data.unusedWhy[said] } : {}) }))
        return {
          phrases: [...current.phrases, ...data.unused.filter((phrase) => !current.phrases.includes(phrase))],
          unnamed: current.unnamed || data.unused.length === 0,
          why: { ...current.why, ...Object.fromEntries(items.map((item) => [item.said, unusedReason(item)])) },
          open: [...(current.open ?? []), ...items.filter((item) => item.why === "sin_lugar" && !item.detail).map((item) => item.said)],
          targets: { ...current.targets, ...(data.unusedFor ?? {}) },
        }
      })
      // «Intentar otra vez»: qué pasó con la frase, para decirlo donde se pidió (QA del 22 nov, UX-6).
      const retried = segment.retryOf ? segment.text : null
      if (retried !== null) {
        const where = kindsOf(data.suggestions, [...(data.added ?? []), ...data.corrected])
        setRetried({ phrase: retried, where })
      }
      await refresh()
      void refreshSaid()
      if (touchedHealth) void refreshHealth()
    },
    [base, refresh, refreshSaid, refreshHealth, queryClient, key, kindsOf],
  )

  /**
   * El repaso al terminar: una lectura de toda la conversación guardada. Lo pide «Terminar dictado»
   * (y lo podrá pedir «Finalizar y firmar»); si no hay tramos nuevos desde el último, el servidor no
   * llama al modelo. Si falla, lo ya ordenado sigue igual y se puede pedir otra vez.
   */
  const requestReview = useCallback(async (): Promise<number | null> => {
    if (reviewing.current) return null
    reviewing.current = true
    setReview({ status: "reviewing" })
    setRetried(null)
    try {
      const post = () =>
        apiFetch<ReviewResponse>(`${base}/review`, {
          method: "POST",
          body: JSON.stringify(openForms?.().length ? { openForms: openForms().slice(0, 5) } : {}),
        })
      let response = await post()
      // Otro repaso (otra pestaña) ya lee lo nuevo: no se paga dos veces; se espera y se lee lo que dejó.
      const waited = !!response.data.inProgress
      for (let tries = 0; response.data.inProgress && tries < IN_PROGRESS_TRIES && mounted.current; tries += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, IN_PROGRESS_MS))
        response = await post()
      }
      if (!mounted.current) return null
      const data = response.data
      setReview({
        status: "done",
        reviewed: data.reviewed || waited,
        added: data.suggestions.length + data.added.length,
        turns: data.turnsSaved.length,
        unsplit: data.turnsUnsplit?.length ?? 0,
        where: kindsOf(data.suggestions, data.added),
      })
      if (data.reviewed || waited) {
        await refresh()
        void refreshSaid()
        if (data.suggestions.length + data.added.length > 0) void refreshHealth()
      }
    } catch (error) {
      if (mounted.current) setReview({ status: "failed", message: dictationErrorText(error, "No pude repasar la conversación. Lo que ya ordené sigue igual.") ?? "" })
    } finally {
      reviewing.current = false
    }
    // Las pendientes de ahora, con lo que dejó el repaso: el cierre que se abre justo después decide con
    // estas, no con las del render anterior (QA del 21 nov: firmaba sin lo que trajo el repaso).
    return queryClient.getQueryData<{ data: { suggestions: DictationSuggestion[] } }>(key)?.data.suggestions.length ?? null
  }, [base, openForms, refresh, refreshSaid, refreshHealth, queryClient, key, kindsOf])

  /**
   * Envía, uno por uno y en orden, los tramos pendientes. Uno que falla se
   * reintenta una vez sin avisar (si el fallo es del proveedor); si vuelve a
   * fallar queda aparte, con su identidad, y los siguientes siguen su curso
   * (issue 135): lo que se dicta después no se queda trabado detrás.
   */
  const drain = useCallback(async () => {
    if (draining.current) return
    draining.current = true
    setOrganizing(true)
    try {
      for (let segment = queue.current.shift(); segment; segment = queue.current.shift()) {
        try {
          await send(segment)
        } catch (error) {
          let last = error
          // Un rechazo de la clínica (apagado, atención cerrada) no cambia al reintentar.
          const transient = !(error instanceof ApiError && error.status < 500)
          if (transient && mounted.current) {
            await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS))
            try {
              await send(segment)
              last = null
            } catch (again) {
              last = again
            }
          }
          if (last && mounted.current) {
            const message = transient ? "Lo intenté dos veces." : (dictationErrorText(last, "") ?? "")
            setFailed((current) => [...current, { ...segment, at: new Date(), message }])
            // Un «Intentar otra vez» que no se pudo leer ya no dice «volviendo a leer»: lo dice su aviso.
            if (segment.retryOf) setRetried(null)
            // Se llegó al presupuesto mientras tanto: la atención lo dice arriba (ADR 0085).
            if (last instanceof ApiError && (last.shape.code === "CLIO_BUDGET_REACHED" || last.shape.code === "AGENTS_PAUSED")) void refresh()
          }
        }
        if (!mounted.current) return
      }
    } finally {
      draining.current = false
      if (mounted.current) setOrganizing(false)
      // Terminado el dictado y ordenado lo último que se dijo: el repaso de toda la conversación.
      if (reviewWanted.current && queue.current.length === 0 && mounted.current) {
        reviewWanted.current = false
        void requestReview()
      }
    }
  }, [send, requestReview])

  /** «Reintentar» una parte que quedó aparte: va primero, porque se dictó antes que lo que espera. */
  const retryFailed = useCallback(
    (id: string) => {
      const segment = failed.find((item) => item.id === id)
      if (!segment) return
      setFailed((current) => current.filter((item) => item.id !== id))
      queue.current.unshift({ id: segment.id, text: segment.text, ...(segment.retryOf ? { retryOf: segment.retryOf } : {}) })
      void drain()
    },
    [failed, drain],
  )

  /** Cierra un tramo con lo dicho desde el anterior. `force`: al pausar, terminar o escribir, aunque sea corto. */
  const cut = useCallback(
    (force: boolean) => {
      const tail = text.current.slice(sent.current).trim()
      if (tail.length < 3 || (!force && tail.length < MIN_SEGMENT_CHARS)) return
      const id = crypto.randomUUID()
      queue.current.push({ id, text: tail.slice(0, 12_000) })
      // Se dijo otra cosa: lo de «Intentar otra vez» ya no es lo último que pasó (QA del 23 nov).
      setRetried(null)
      setSentHere((current) => [
        ...current,
        { segmentId: id, transcript: tail.slice(0, 12_000), saidAt: new Date().toISOString(), createdBy: "", organized: false, unused: [], turns: null },
      ])
      sent.current = text.current.length
      void drain()
    },
    [drain],
  )

  const clearSilence = () => {
    if (silence.current !== null) window.clearTimeout(silence.current)
    silence.current = null
  }
  const append = useCallback((heard: string, separator = " ") => {
    const clean = heard.trim()
    if (!clean) return
    text.current = `${text.current}${text.current ? separator : ""}${clean}`
    setTranscript(text.current)
  }, [])

  const stopMic = useCallback(() => {
    wanted.current = false
    clearSilence()
    recognition.current?.stop()
    setInterim("")
  }, [])

  // Al salir de la pantalla el micrófono se apaga: nunca escucha sin que se haya pulsado Dictar.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      wanted.current = false
      if (silence.current !== null) window.clearTimeout(silence.current)
      recognition.current?.stop()
    }
  }, [])

  const listen = useCallback(() => {
    const Recognition = speechRecognition()
    if (!Recognition) return
    setMicError(null)
    reopenedAfterCut.current = false
    partialHeard.current = ""
    const instance = new Recognition()
    // Idioma del dictado: el formato de la clínica; sin él, español sin país.
    instance.lang = activeOrgLocale() ?? "es"
    instance.continuous = true
    // Lo que se va oyendo se muestra al momento; solo las frases cerradas entran a lo dictado.
    instance.interimResults = true
    instance.onresult = (event) => {
      let heard = ""
      let partial = ""
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal) heard += `${result[0]?.transcript ?? ""} `
        else partial += result?.[0]?.transcript ?? ""
      }
      if (heard.trim()) append(heard)
      setInterim(partial.trim())
      partialHeard.current = partial.trim()
      reopenedAfterCut.current = false
      // Mientras siga hablando no se ordena nada: se espera a la pausa.
      clearSilence()
      silence.current = window.setTimeout(() => cut(false), SILENCE_MS)
    }
    instance.onerror = (event) => {
      // Un silencio largo no es un fallo: el navegador corta y `onend` reanuda.
      if (event.error === "no-speech" || event.error === "aborted") return
      if (event.error === "network") {
        // Lo que se estaba oyendo no llega a cerrarse: entra a lo dictado, como al pausar.
        append(partialHeard.current)
        partialHeard.current = ""
        setInterim("")
        // El servicio de voz de Chrome cierra la conexión tras unos 5 minutos de habla seguida y avisa
        // «network» (en Chrome 156, a los 300 s): `onend` la reabre. Si la escucha reabierta vuelve a
        // cortarse sin haber oído nada, la red no volvió y se pausa con el aviso.
        if (!reopenedAfterCut.current) {
          reopenedAfterCut.current = true
          return
        }
      }
      wanted.current = false
      setMode("paused")
      setMicError(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "El navegador no tiene permiso para usar el micrófono. Actívalo o escribe lo dictado."
          : "No pude seguir escuchando. Reanuda el dictado o escribe lo que falta.",
      )
    }
    // El navegador corta el reconocimiento tras un silencio: se reanuda mientras siga el dictado.
    instance.onend = () => {
      if (wanted.current) instance.start()
      // Al pausar o terminar, lo último que alcanzó a oír también se ordena; al terminar, con el repaso detrás.
      else {
        cut(true)
        if (reviewWanted.current) void drain()
      }
    }
    recognition.current = instance
    wanted.current = true
    instance.start()
  }, [append, cut, drain])

  const start = useCallback(() => {
    if (!canListen) return
    setSeconds(0)
    setMode("listening")
    listen()
  }, [canListen, listen])
  const pause = useCallback(() => {
    stopMic()
    setMode("paused")
    cut(true)
  }, [stopMic, cut])
  const resume = useCallback(() => {
    setMode("listening")
    listen()
  }, [listen])
  const finish = useCallback(() => {
    const listening = wanted.current
    stopMic()
    setMode("off")
    reviewWanted.current = true
    cut(true)
    // El repaso lo pide `drain` al vaciar la cola. Con el micrófono abierto, lo último que oyó llega
    // al cerrarse (`onend`), que lo envía y lo pide; si no, va ya, aunque no quede nada por enviar.
    if (!listening) void drain()
  }, [stopMic, cut, drain])

  /**
   * Antes de firmar, sin que nadie tenga que encontrar «Terminar dictado» (QA del 21 nov: escribiendo
   * no había cómo, y la firma quedaba apagada): el micrófono se apaga, lo último que se dijo se ordena
   * y, si hay tramos que ningún repaso leyó, se repasa. Devuelve cuántas pendientes hay ahora, con lo
   * que dejó el repaso, para que el cierre decida con ellas.
   */
  const settle = useCallback(async (): Promise<number | null> => {
    if (wanted.current) stopMic()
    setMode("off")
    cut(true)
    const sentNow = queue.current.length > 0 || draining.current
    void drain()
    const busyNow = () => draining.current || queue.current.length > 0 || reviewing.current
    for (let waited = 0; busyNow() && mounted.current && waited < SETTLE_MS; waited += 200)
      await new Promise((resolve) => window.setTimeout(resolve, 200))
    if (!mounted.current) return null
    if (sentNow || unreviewedRef.current) return requestReview()
    return queryClient.getQueryData<{ data: { suggestions: DictationSuggestion[] } }>(key)?.data.suggestions.length ?? null
  }, [stopMic, cut, drain, requestReview, queryClient, key])

  /** Dictado escrito o pegado: para navegadores sin reconocimiento de voz. Se ordena de una vez. */
  const submitTyped = useCallback(
    (typed: string) => {
      append(typed, "\n")
      cut(true)
    },
    [append, cut],
  )

  /**
   * «Intentar otra vez» una frase de «No lo usé»: Clío la vuelve a leer con lo dicho antes de su
   * tramo. No es algo dicho otra vez: «Lo que se dijo» la sigue mostrando una sola vez, en su hora.
   */
  const retryUnused = useCallback(
    (segmentId: string, phrase: string) => {
      setRetried({ phrase, where: null })
      queue.current.push({ id: crypto.randomUUID(), text: phrase.slice(0, 12_000), retryOf: segmentId })
      void drain()
    },
    [drain],
  )

  const act = useMutation({
    retry: false,
    // «undo-voice» deshace lo hecho en voz alta: una corrección o un «quita».
    // «undo-confirmed» quita lo ya confirmado que se pidió quitar; «keep» lo deja como está.
    // `chosen`: al descartar la duda de una respuesta de ficha, la opción que eligió la persona (queda la constancia).
    mutationFn: async (input: { item: DictationSuggestion; action: "confirm" | "discard" | "undo-voice" | "undo-confirmed" | "keep" | "restore"; chosen?: string }) => {
      const response = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${input.item.id}/${input.action}`, {
        method: "POST",
        ...(input.chosen !== undefined ? { body: JSON.stringify({ chosen: input.chosen }) } : {}),
      })
      return { ...input, result: response?.data ?? null }
    },
    onSuccess: (input) => {
      // Confirmar o descartar una alergia cambia lo que dice la franja («dijo…, sin confirmar»; QA del 25 nov).
      // Deshacer lo quitado por voz de su salud también: la franja vuelve a decir lo que dijo.
      if (input.item.kind === "alergia" || (input.item.kind === "salud" && input.action === "undo-voice")) void refreshHealth()
      // Quitar lo ya confirmado cambia la atención: se refresca como al confirmar.
      if (input.action === "undo-confirmed") onApplied(input.item)
      if (input.action !== "confirm") return
      // La cita cuyo hueco se ocupó mientras atendía no se reservó: queda con el más cercano, para tocar otra vez.
      if (input.result && input.result.status !== "confirmada") {
        toast(input.result.note ?? "No se pudo reservar ese hueco: elige otro.")
        return
      }
      onApplied({ ...input.item, joined: input.result?.joined })
      // Un diagnóstico que ya estaba registrado: quedó el que había, y lo dictado que no entró se dice.
      if (input.item.kind === "diagnostico" && input.result?.note) toast(input.result.note)
      if (input.item.kind === "cita") toast.success(input.item.payload["existing"] ? "Queda la cita que ya tenía." : "Cita reservada. Le llega el aviso como cuando reserva recepción.")
      if (input.item.kind === "presupuesto") toast.success("Presupuesto armado. Muéstralo, imprímelo o envíalo desde «Plan y controles».")
      // Lo que cambia fuera de la tarjeta se dice al confirmar, no antes.
      const options = Array.isArray(input.item.payload["options"]) ? input.item.payload["options"].length : 0
      if (input.item.kind === "plan" && options > 0) {
        toast.success(`Entró al plan. Su presupuesto en borrador quedó con ${options === 1 ? "las dos opciones" : "las tres opciones"}.`)
      }
      if (input.item.kind === "procedimiento" && input.item.payload["acceptOnDo"] === true) {
        toast.success("Quedó registrado y el tratamiento, aceptado. Se cobra al cerrar la atención.")
      }
      // El material no deja nada a la vista hasta firmar: se dice cuándo sale.
      if (input.item.kind === "material") toast.success("Anotado. Sale de la sede al firmar; lo ves en el cierre.")
    },
    onSettled: () => void refresh(),
  })
  /** Guarda lo corregido a mano y, si queda lista, la confirma. Devuelve la sugerencia si aún hay que revisarla. */
  const save = useMutation({
    retry: false,
    mutationFn: async (input: { item: DictationSuggestion; patch: Record<string, unknown>; confirm: boolean }) => {
      const updated = await apiFetch<{ data: DictationSuggestion }>(`${base}/${input.item.id}`, { method: "PATCH", body: JSON.stringify(input.patch) })
      if (!input.confirm || updated.data.status !== "lista") return { item: updated.data, confirmed: false }
      const confirmed = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${input.item.id}/confirm`, { method: "POST" })
      return { item: { ...updated.data, joined: confirmed?.data?.joined }, confirmed: true, note: confirmed?.data?.note ?? null }
    },
    onSuccess: (result) => {
      // Lo que falló antes con esta sugerencia ya no vale: se acaba de corregir.
      if (act.variables?.item.id === result.item.id) act.reset()
      if (result.confirmed) onApplied(result.item)
      // Como al confirmar con un toque: lo que no entró de un diagnóstico que ya estaba se dice.
      if (result.confirmed && result.item.kind === "diagnostico" && "note" in result && result.note) toast(result.note)
    },
    onSettled: () => void refresh(),
  })
  const confirmReady = useMutation({
    retry: false,
    mutationFn: async () => {
      const done: DictationSuggestion[] = []
      let current: DictationSuggestion | null = null
      setConfirmReadyFailed(null)
      try {
        for (const item of suggestions.filter(confirmable)) {
          current = item
          const response = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${item.id}/confirm`, { method: "POST" })
          done.push({ ...item, joined: response?.data?.joined })
        }
      } catch (error) {
        setConfirmReadyFailed(current)
        throw error
      } finally {
        // Las que sí entraron se reflejan aunque una posterior falle.
        for (const item of done) onApplied(item)
      }
      return done
    },
    onSettled: () => void refresh(),
  })

  /** «Firmar con N marcadas»: confirma las marcadas, una por una, antes de firmar. */
  const confirmMany = useMutation({
    retry: false,
    mutationFn: async (ids: string[]) => {
      const done: DictationSuggestion[] = []
      let current: DictationSuggestion | null = null
      setConfirmManyFailed(null)
      try {
        // Las de una ficha, en su orden: la pregunta de la que depende otra entra primero.
        for (const item of signOrder(suggestions.filter((candidate) => ids.includes(candidate.id) && confirmableAtSign(candidate)))) {
          current = item
          const response = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${item.id}/confirm`, confirmBody(item, true))
          // La pregunta de la ficha que alguien respondió a mano: queda la suya y no frena la firma.
          if (response?.data?.status === "descartada") {
            if (response.data.note) toast(response.data.note)
            continue
          }
          // Un hueco que se ocupó no se reserva: se firma después de elegir el que quedó.
          if (response?.data && response.data.status !== "confirmada") {
            throw new ApiError(409, { code: "SLOT_TAKEN", message: `${response.data.note ?? "Un hueco se ocupó."} Revísalo y vuelve a firmar.` })
          }
          done.push({ ...item, joined: response?.data?.joined })
        }
      } catch (error) {
        setConfirmManyFailed(current)
        throw error
      } finally {
        for (const item of done) onApplied(item)
      }
      return done
    },
    onSettled: () => void refresh(),
  })

  /**
   * «Confirmar» y «Confirmar las N» en la ficha (entrega 11): una por una, en
   * el orden de la ficha, con el valor que se veía. Lo que alguien ya respondió
   * a mano no se pisa: el servidor la descarta y se dice por qué. La que ya se
   * decidió (doble toque, otra pestaña) cuenta como hecha; si una pausa cambió
   * la propuesta, se detiene y lo dice.
   */
  const acceptForms = useMutation({
    retry: false,
    mutationFn: async (items: DictationSuggestion[]) => {
      const done: DictationSuggestion[] = []
      const notes: string[] = []
      try {
        for (const item of items.filter((candidate) => candidate.kind === "ficha" && confirmableAtSign(candidate)).sort(byFormOrder)) {
          const response = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${item.id}/confirm`, confirmBody(item)).catch((error: unknown) => {
            if (alreadyDecided(error)) return undefined
            throw error
          })
          if (response?.data?.status === "descartada") {
            if (response.data.note) notes.push(response.data.note)
            continue
          }
          done.push(item)
        }
      } finally {
        for (const item of done) onApplied(item)
        if (notes.length) toast(notes.join(" "))
        // Ocupado hasta que la lista ya no trae lo confirmado: un segundo toque no llega al servidor.
        await refresh()
      }
      return done
    },
  })

  /**
   * «Lo revisé con…» de lo que dijo de su salud: queda como su declaración en la consulta y entra a
   * Antecedentes (`confirm-health`). Lo confirma quien lleva la atención; nunca «Confirmar las N».
   */
  const confirmHealth = useMutation({
    retry: false,
    mutationFn: (item: DictationSuggestion) =>
      apiFetch<{ data: DictationSuggestion }>(`${base}/${item.id}/confirm-health`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (_result, item) => onApplied({ ...item, status: "confirmada" }),
    onSettled: () => {
      void refresh()
      void refreshHealth()
    },
  })
  /**
   * «Sí, lo dejó» de una medicina que dijo que ya no toma: termina en Antecedentes el día anterior al
   * que se dijo (mesa del 25 nov, entrega 2). Lo confirma quien lleva la atención, en su fila.
   */
  const confirmStopped = useMutation({
    retry: false,
    mutationFn: (input: { item: DictationSuggestion; key: string }) =>
      apiFetch(`/api/patients/${patientId}/health/said/${input.item.id}/stopped`, { method: "POST", body: JSON.stringify({ key: input.key }) }),
    onSettled: () => {
      void refresh()
      void refreshHealth()
    },
  })
  /**
   * «No lo registro» de lo que dijo de su salud: no entra a Antecedentes y deja de avisarse. Lo
   * decide quien lleva la atención (revisión del 21 nov, A3).
   */
  const discardHealth = useMutation({
    retry: false,
    mutationFn: (item: DictationSuggestion) => apiFetch(`${base}/${item.id}/discard`, { method: "POST", body: JSON.stringify({}) }),
    onSettled: () => {
      void refresh()
      void refreshHealth()
    },
  })
  /**
   * Lo de su salud que ya quedó en Antecedentes por otra vía («Corregir algo», «Niega enfermedades»):
   * sale de lo que Clío propone, para que «Lo revisé con…» no lo vuelva a sumar. Si no queda nada,
   * la sugerencia se descarta.
   */
  const settleHealthGroups = useMutation({
    retry: false,
    mutationFn: async (input: { item: DictationSuggestion; groups: readonly string[] }) => {
      const taken = input.groups.filter((group) => group in input.item.payload)
      if (taken.length === 0) return null
      const left = Object.keys(input.item.payload).filter((group) => HEALTH_GROUPS.includes(group) && !taken.includes(group))
      if (left.length === 0) return apiFetch(`${base}/${input.item.id}/discard`, { method: "POST", body: JSON.stringify({}) })
      return apiFetch(`${base}/${input.item.id}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(taken.map((group) => [group, null]))) })
    },
    onSettled: () => {
      void refresh()
      void refreshHealth()
    },
  })

  /** «Emitir receta» de la receta dictada: una receta con todos sus medicamentos. */
  const issuePrescription = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: { prescriptionId: string } }>(`${base}/prescription`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prescriptions", patientId] })
      onApplied({ id: "", kind: "receta", payload: {}, sourceText: "", status: "confirmada", note: null, summary: "", voice: null, removal: null })
    },
    onSettled: () => void refresh(),
  })
  /** La receta dictada se terminó en el formulario de siempre: sus sugerencias quedan con esa receta. */
  const settlePrescription = useMutation({
    retry: false,
    mutationFn: (prescriptionId: string) => apiFetch(`${base}/prescription/settle`, { method: "POST", body: JSON.stringify({ prescriptionId }) }),
    onSettled: () => void refresh(),
  })
  /** El descanso dictado se emitió con su formulario, ya lleno: su sugerencia queda con ese descanso. */
  const settleMedicalLeave = useMutation({
    retry: false,
    mutationFn: (medicalLeaveId: string) => apiFetch(`${base}/medical-leave/settle`, { method: "POST", body: JSON.stringify({ medicalLeaveId }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["medical-leaves", patientId] }),
    onSettled: () => void refresh(),
  })

  const ready = suggestions.filter(confirmable).length
  const dictating = mode !== "off"
  // Tramos ya ordenados que ningún repaso leyó: «Finalizar y firmar» los repasa antes. Uno ya leído
  // sin turnos (los rechazó, o no empezó ninguno en él) no pide otro repaso.
  const unreviewed = said.some((segment) => segment.organized && !(segment.reviewed ?? segment.turns !== null))
  unreviewedRef.current = unreviewed
  return {
    enabled,
    confirmReadyFailed,
    confirmManyFailed,
    base,
    suggestions,
    /** Quitadas por voz, a la vista en su bloque con «Deshacer». No cuentan como pendientes. */
    removedByVoice,
    /** Ya confirmadas que se pidió quitar en voz alta, en su bloque con «Quitar del plan» y «Dejarla». */
    undoRequests,
    /** Las piezas nombradas en lo dictado de esta atención, para elegir con un toque la que falta. */
    teeth,
    pending: suggestions.length,
    ready,
    confirmed,
    /** Clío no escucha en esta atención (ADR 0085): la pantalla lo dice antes de dictar. */
    blocked,
    refresh,
    mode,
    dictating,
    /** Aún se está dictando u ordenando: no es momento de firmar. */
    busy: dictating || organizing || queue.current.length > 0 || review.status === "reviewing",
    seconds,
    transcript,
    interim,
    highlights,
    /** Lo de esta pestaña que dio lo de su salud: en «Lo que se dijo» va en ámbar. */
    healthHighlights,
    canListen,
    micError,
    organizing,
    /** Partes que no se pudieron ordenar ni al reintentar, con «Reintentar» y «Descartar esta parte». */
    failed,
    retryFailed,
    discardFailed: (id: string) => setFailed((current) => current.filter((item) => item.id !== id)),
    /** Lo que el asistente no pudo usar, hasta «Entendido». */
    unused,
    /** El repaso al terminar: cómo va, para la barra y el panel de lo que se dijo. */
    review,
    requestReview,
    /** Lo que se dijo en la atención, tramo por tramo, del servidor: sigue igual al recargar. */
    said,
    /** Las frases de lo que se dijo que están en una sugerencia, pendiente o confirmada (del servidor). */
    saidUsed,
    /** Lo que se está oyendo y todavía no se mandó a ordenar: «Lo que se dijo» lo muestra al final. */
    unsent: transcript.slice(sent.current).trim(),
    saidLoading: enabled && saidQuery.isPending,
    saidError: saidQuery.isError,
    refreshSaid,
    /** Hay tramos sin repasar: el repaso se lanza antes de firmar. */
    unreviewed,
    confirmHealth,
    confirmStopped,
    discardHealth,
    settleHealthGroups,
    dismissUnused: () => setUnused(NOTHING_UNUSED),
    demo,
    start,
    pause,
    resume,
    finish,
    /** Antes de firmar: apaga el micrófono, ordena lo último y repasa lo nuevo; da las pendientes de ahora. */
    settle,
    /** Lo escrito en el cuadro sin mandar todavía. */
    typedDraft,
    setTypedDraft,
    submitTyped,
    retryUnused,
    /** Lo que pasó con el último «Intentar otra vez»: mientras se lee, `where` es nulo. */
    retried,
    clearRetried: () => setRetried(null),
    act,
    save,
    confirmReady,
    confirmMany,
    acceptForms,
    issuePrescription,
    settlePrescription,
    settleMedicalLeave,
    patientId,
    encounterId,
    editing: suggestions.find((item) => item.id === editingId) ?? null,
    /** Dónde se agregará una nota dictada: se dice antes de confirmarla y de firmar, cuando aún se puede cambiar. */
    noteAddsTo: (item: DictationSuggestion) => {
      if (item.kind !== "nota") return ""
      const fields = Object.entries(NOTE_FIELD_LABEL)
        .filter(([key]) => typeof item.payload[key] === "string" && noteText(key).trim())
        .map(([, label]) => label)
      return fields.length ? `Se agrega a lo que ya hay en ${new Intl.ListFormat("es").format(fields)}.` : ""
    },
    openEdit: (item: DictationSuggestion) => {
      save.reset()
      setEditingId(item.id)
    },
    closeEdit: () => setEditingId(null),
  }
}

/** Título y resto de una sugerencia, a partir del resumen que arma el servidor. */
export function suggestionText(item: DictationSuggestion): { title: string; detail: string } {
  const [title = "", ...rest] = item.summary.split("\n").filter(Boolean)
  return { title: title || DICTATION_KIND_LABEL[item.kind], detail: rest.join(" · ") }
}

/** Qué le falta a una sugerencia para poder entrar a la historia, en pocas palabras. */
export function suggestionMissing(item: DictationSuggestion): string {
  if (item.kind === "receta") return item.status === "lista" ? "falta emitirla" : "falta completarla"
  if (item.kind === "descanso") return "falta emitirlo"
  if (item.status === "lista") return "falta confirmarla"
  if (item.kind === "plan" && typeof item.payload["serviceId"] !== "string") return "falta elegir la prestación"
  if (item.kind === "diagnostico") return "falta revisar el diagnóstico"
  if (item.kind === "odontograma") return "falta completar el hallazgo"
  if (item.kind === "procedimiento") return "falta la pieza"
  if (item.kind === "cita") return "falta elegir el horario"
  if (item.kind === "presupuesto") return "falta algo con precio"
  return "falta completarla"
}

/** Reloj del dictado: 0:42. */
export function dictationClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/**
 * Parte lo dictado en trozos, marcando los que dieron lugar a una sugerencia
 * (`used`) y los que el asistente no pudo usar (`unused`). Un fragmento solo
 * se marca si aparece tal cual en el texto (el servidor ya descartó lo que el
 * modelo no citó literalmente); si un trozo está en los dos, manda «no lo usé».
 */
export function highlightTranscript(
  transcript: string,
  sources: string[],
  unused: string[] = [],
): Array<{ text: string; mark: "used" | "unused" | null }> {
  const lower = transcript.toLowerCase()
  if (lower.length !== transcript.length) return [{ text: transcript, mark: null }]
  const ranges: Array<[number, number, "used" | "unused"]> = []
  const find = (fragment: string, mark: "used" | "unused") => {
    const needle = fragment.trim().toLowerCase()
    if (needle.length < 3) return false
    const at = lower.indexOf(needle)
    if (at < 0) return false
    ranges.push([at, at + needle.length, mark])
    return true
  }
  for (const phrase of unused) find(phrase, "unused")
  for (const source of sources) {
    if (!find(source, "used")) for (const sentence of source.split(/(?<=[.;!?])\s+/)) find(sentence, "used")
  }
  // Cada letra toma la marca más fuerte que la cubre: «no lo usé» antes que «usado».
  const marks: Array<"used" | "unused" | null> = Array.from({ length: transcript.length }, () => null)
  for (const [from, to, mark] of ranges) for (let index = from; index < to; index += 1) if (marks[index] !== "unused") marks[index] = mark
  const parts: Array<{ text: string; mark: "used" | "unused" | null }> = []
  for (let index = 0; index < transcript.length; index += 1) {
    const last = parts.at(-1)
    if (last && last.mark === marks[index]) last.text += transcript[index]
    else parts.push({ text: transcript[index] ?? "", mark: marks[index] ?? null })
  }
  return parts
}

/** De qué se usó un trozo de lo que se dijo: de la consulta (azul) o de su salud (ámbar). La charla, sin marca. */
export type SaidMark = "consulta" | "salud"

/**
 * Lo que se dijo en trozos, con lo que dio una propuesta de la consulta o de su salud. Como
 * `highlightTranscript`: un fragmento solo se marca si está tal cual (o frase por frase); lo de su
 * salud gana si los dos lo cubren.
 */
export function markSaid(text: string, sources: { consulta: readonly string[]; salud: readonly string[] }): Array<{ text: string; mark: SaidMark | null }> {
  const lower = text.toLowerCase()
  if (lower.length !== text.length) return [{ text, mark: null }]
  const marks: Array<SaidMark | null> = Array.from({ length: text.length }, () => null)
  const paint = (fragment: string, mark: SaidMark): boolean => {
    const needle = fragment.trim().toLowerCase()
    if (needle.length < 3) return false
    const at = lower.indexOf(needle)
    if (at < 0) return false
    for (let index = at; index < at + needle.length; index += 1) if (marks[index] !== "salud") marks[index] = mark
    return true
  }
  /**
   * Lo que una propuesta juntó de varias pausas («si tomo losartán para la presión» y «no que yo sepa»
   * en una sola frase, sin puntos) no está entero en ninguna: se pintan los pedazos de tres o más
   * palabras seguidas que sí están (QA del 22 nov, H7: lo de su salud nunca salía en ámbar).
   */
  const paintRuns = (source: string, mark: SaidMark) => {
    const words = [...source.matchAll(/\S+/g)]
    const span = (from: number, to: number) => source.slice(words[from]?.index ?? 0, (words[to]?.index ?? 0) + (words[to]?.[0].length ?? 0))
    for (let from = 0; from < words.length; ) {
      let last = -1
      for (let to = from; to < words.length && lower.includes(span(from, to).toLowerCase()); to += 1) last = to
      if (last - from + 1 >= 3) {
        paint(span(from, last), mark)
        from = last + 1
      } else from += 1
    }
  }
  for (const mark of ["consulta", "salud"] as const) {
    for (const source of sources[mark]) {
      if (paint(source, mark)) continue
      for (const sentence of source.split(/(?<=[.;!?])\s+/)) if (!paint(sentence, mark)) paintRuns(sentence, mark)
    }
  }
  const parts: Array<{ text: string; mark: SaidMark | null }> = []
  for (let index = 0; index < text.length; index += 1) {
    const last = parts.at(-1)
    if (last && last.mark === marks[index]) last.text += text[index]
    else parts.push({ text: text[index] ?? "", mark: marks[index] ?? null })
  }
  return parts
}

/**
 * Por qué no se usó una frase, en palabras de la pantalla: lo dicen igual «Lo que se dijo» y el aviso
 * de la atención (QA del 23 nov, verificador 2: el panel decía «no supe dónde va» y el aviso, nada).
 */
export function unusedReason(item: Pick<DictationUnusedItem, "why" | "detail">): string {
  // El motivo guardado con la frase es el mismo que dio el aviso de la pausa (QA del 22 nov, H6/UX-5).
  if (item.detail) return item.detail
  if (item.why === "ya_confirmada") return "ya estaba confirmado: cámbialo a mano"
  if (item.why === "no_propuesta") return "no se pudo proponer"
  return "no supe dónde va"
}

/** Lo que Clío no usó, con su tramo: lo que se lista en «No lo usé». */
export interface UnusedSaid extends DictationUnusedItem {
  segmentId: string
  saidAt: string
}

/**
 * «No lo usé (n)» de lo que se dijo, guardado con cada tramo. Una frase que una pausa siguiente
 * volvió a decir y esa sí usó («Intentar otra vez», o dicha de nuevo) ya no se lista; las repetidas
 * van una vez.
 */
export function unusedOfSaid(segments: readonly DictationSaidSegment[]): UnusedSaid[] {
  const loose = (value: string) => value.toLocaleLowerCase("es").replace(/\s+/g, " ").trim()
  const seen = new Set<string>()
  return segments.flatMap((segment, index) =>
    segment.unused.flatMap((item): UnusedSaid[] => {
      const phrase = item.said ? loose(item.said) : null
      if (phrase) {
        const usedLater = segments
          .slice(index + 1)
          .some((later) => later.organized && loose(later.transcript).includes(phrase) && !later.unused.some((other) => other.said && loose(other.said) === phrase))
        if (usedLater || seen.has(phrase)) return []
        seen.add(phrase)
      }
      return [{ ...item, segmentId: segment.segmentId, saidAt: segment.saidAt }]
    }),
  )
}
