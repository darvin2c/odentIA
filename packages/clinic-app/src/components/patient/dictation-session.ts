import { toast } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"

export type DictationKind = "nota" | "diagnostico" | "plan" | "control" | "odontograma" | "receta" | "signos" | "examen" | "descanso" | "alergia" | "procedimiento" | "cita" | "presupuesto" | "material"

export interface DictationSuggestion {
  id: string
  kind: DictationKind
  payload: Record<string, unknown>
  sourceText: string
  status: "lista" | "por_revisar" | "confirmada" | "descartada"
  note: string | null
  summary: string
  /** Corregida por voz al seguir dictando: qué decía antes. */
  voice: { before: string } | null
  /** Quitada por voz: lo que dijo para pedirlo. Se puede deshacer hasta firmar. */
  removal: { said: string } | null
  /** Ya confirmada, y se pidió quitarla en voz alta: espera «Quitar del plan» o «Dejarla». */
  undoRequest?: { said: string } | null
}

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
}

/** Silencio tras el que se ordena lo dicho hasta ahí: una llamada al modelo por pausa, no por palabra. */
const SILENCE_MS = 2500
/** Por debajo de esto no vale una llamada mientras se sigue hablando; al pausar o terminar se envía igual. */
const MIN_SEGMENT_CHARS = 12
/** Lo último ya ordenado que acompaña a cada tramo, para que se entienda a qué se refiere. */
const CONTEXT_CHARS = 600
/**
 * Lo que «Confirmar las N listas» lleva de un toque. Una receta no: emitirla
 * es firmarla con la colegiatura y tiene su propio botón (issue 109, fase 2).
 * El descanso médico tampoco (latidIA, issue 229).
 */
export const confirmable = (item: DictationSuggestion) => item.status === "lista" && item.kind !== "receta" && item.kind !== "descanso"

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

interface Segment {
  id: string
  text: string
  context: string
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
    removed: string[]
    sources: string[]
    /** Partes de este tramo que el asistente no pudo usar y, si se sabe, lo que se dijo para pedirlas. */
    omitted: number
    unused: string[]
    /** Alergias dichas que ya estaban registradas: no se proponen otra vez. */
    alreadyOnFile?: string[]
    repeated: boolean
    model: string | null
  }
}

/** Lo que el asistente no pudo usar desde el último «Entendido»: las frases y si hubo algo sin frase. */
export interface UnusedDictation {
  phrases: string[]
  unnamed: boolean
}

const NOTHING_UNUSED: UnusedDictation = { phrases: [], unnamed: false }

export type DictationMode = "off" | "listening" | "paused"

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
}: {
  patientId: string
  encounterId: string
  /** Solo para quien lleva la atención y puede escribirla. */
  active: boolean
  /** Una sugerencia entró a la historia: la pantalla refresca lo que muestra. */
  onApplied: (item: DictationSuggestion) => void
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

  const [mode, setMode] = useState<DictationMode>("off")
  const [seconds, setSeconds] = useState(0)
  const [transcript, setTranscript] = useState("")
  const [interim, setInterim] = useState("")
  const [highlights, setHighlights] = useState<string[]>([])
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

  const recognition = useRef<SpeechLike | null>(null)
  const wanted = useRef(false)
  const text = useRef("")
  const sent = useRef(0)
  const queue = useRef<Segment[]>([])
  const draining = useRef(false)
  const silence = useRef<number | null>(null)
  const mounted = useRef(true)
  const canListen = speechRecognition() !== null

  useEffect(() => {
    if (mode !== "listening") return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [mode])

  /** Ordena un tramo y refleja lo que volvió: lo resaltado, lo que no se pudo usar y las sugerencias. */
  const send = useCallback(
    async (segment: Segment) => {
      const response = await apiFetch<SegmentResponse>(base, {
        method: "POST",
        body: JSON.stringify({ transcript: segment.text, segmentId: segment.id, ...(segment.context ? { context: segment.context } : {}) }),
      })
      if (!mounted.current) return
      const data = response.data
      if (data.model) setDemo(data.model === "fake")
      if (data.sources.length) setHighlights((current) => [...current, ...data.sources])
      // La alergia que ya estaba registrada no se propone otra vez: se dice y se sigue.
      for (const name of data.alreadyOnFile ?? []) toast(`La alergia a ${name} ya está en sus antecedentes.`)
      if (data.omitted > 0) {
        setUnused((current) => ({
          phrases: [...current.phrases, ...data.unused.filter((phrase) => !current.phrases.includes(phrase))],
          unnamed: current.unnamed || data.unused.length === 0,
        }))
      }
      await refresh()
    },
    [base, refresh],
  )

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
            // Se llegó al presupuesto mientras tanto: la atención lo dice arriba (ADR 0085).
            if (last instanceof ApiError && (last.shape.code === "CLIO_BUDGET_REACHED" || last.shape.code === "AGENTS_PAUSED")) void refresh()
          }
        }
        if (!mounted.current) return
      }
    } finally {
      draining.current = false
      if (mounted.current) setOrganizing(false)
    }
  }, [send])

  /** «Reintentar» una parte que quedó aparte: va primero, porque se dictó antes que lo que espera. */
  const retryFailed = useCallback(
    (id: string) => {
      const segment = failed.find((item) => item.id === id)
      if (!segment) return
      setFailed((current) => current.filter((item) => item.id !== id))
      queue.current.unshift({ id: segment.id, text: segment.text, context: segment.context })
      void drain()
    },
    [failed, drain],
  )

  /** Cierra un tramo con lo dicho desde el anterior. `force`: al pausar, terminar o escribir, aunque sea corto. */
  const cut = useCallback(
    (force: boolean) => {
      const tail = text.current.slice(sent.current).trim()
      if (tail.length < 3 || (!force && tail.length < MIN_SEGMENT_CHARS)) return
      queue.current.push({
        id: crypto.randomUUID(),
        text: tail.slice(0, 12_000),
        context: text.current.slice(Math.max(0, sent.current - CONTEXT_CHARS), sent.current).trim(),
      })
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
      // Mientras siga hablando no se ordena nada: se espera a la pausa.
      clearSilence()
      silence.current = window.setTimeout(() => cut(false), SILENCE_MS)
    }
    instance.onerror = (event) => {
      // Un silencio largo no es un fallo: el navegador corta y `onend` reanuda.
      if (event.error === "no-speech" || event.error === "aborted") return
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
      // Al pausar o terminar, lo último que alcanzó a oír también se ordena.
      else cut(true)
    }
    recognition.current = instance
    wanted.current = true
    instance.start()
  }, [append, cut])

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
    stopMic()
    setMode("off")
    cut(true)
  }, [stopMic, cut])

  /** Dictado escrito o pegado: para navegadores sin reconocimiento de voz. Se ordena de una vez. */
  const submitTyped = useCallback(
    (typed: string) => {
      append(typed, "\n")
      cut(true)
    },
    [append, cut],
  )

  const act = useMutation({
    retry: false,
    // «undo-voice» deshace lo hecho en voz alta: una corrección o un «quita».
    // «undo-confirmed» quita lo ya confirmado que se pidió quitar; «keep» lo deja como está.
    mutationFn: async (input: { item: DictationSuggestion; action: "confirm" | "discard" | "undo-voice" | "undo-confirmed" | "keep" }) => {
      const response = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${input.item.id}/${input.action}`, { method: "POST" })
      return { ...input, result: response?.data ?? null }
    },
    onSuccess: (input) => {
      // Quitar lo ya confirmado cambia la atención: se refresca como al confirmar.
      if (input.action === "undo-confirmed") onApplied(input.item)
      if (input.action !== "confirm") return
      // La cita cuyo hueco se ocupó mientras atendía no se reservó: queda con el más cercano, para tocar otra vez.
      if (input.result && input.result.status !== "confirmada") {
        toast(input.result.note ?? "No se pudo reservar ese hueco: elige otro.")
        return
      }
      onApplied(input.item)
      if (input.item.kind === "cita") toast.success(input.item.payload["existing"] ? "Queda la cita que ya tenía." : "Cita reservada. Le llega el aviso como cuando reserva recepción.")
      if (input.item.kind === "presupuesto") toast.success("Presupuesto armado. Muéstralo, imprímelo o envíalo desde «Plan y controles».")
      // Lo que cambia fuera de la tarjeta se dice al confirmar, no antes.
      const options = Array.isArray(input.item.payload["options"]) ? input.item.payload["options"].length : 0
      if (input.item.kind === "plan" && options > 0) {
        toast.success(`Entró al plan. Su presupuesto en borrador quedó con ${options === 1 ? "las dos opciones" : "las tres opciones"}.`)
      }
      if (input.item.kind === "procedimiento" && input.item.payload["acceptOnDo"] === true) {
        toast.success("Quedó hecho y el tratamiento, aceptado. Se cobra al cerrar la atención.")
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
      await apiFetch(`${base}/${input.item.id}/confirm`, { method: "POST" })
      return { item: updated.data, confirmed: true }
    },
    onSuccess: (result) => {
      // Lo que falló antes con esta sugerencia ya no vale: se acaba de corregir.
      if (act.variables?.item.id === result.item.id) act.reset()
      if (result.confirmed) onApplied(result.item)
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
          await apiFetch(`${base}/${item.id}/confirm`, { method: "POST" })
          done.push(item)
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
        for (const item of suggestions.filter((candidate) => ids.includes(candidate.id) && confirmable(candidate))) {
          current = item
          const response = await apiFetch<{ data?: DictationSuggestion } | undefined>(`${base}/${item.id}/confirm`, { method: "POST" })
          // Un hueco que se ocupó no se reserva: se firma después de elegir el que quedó.
          if (response?.data && response.data.status !== "confirmada") {
            throw new ApiError(409, { code: "SLOT_TAKEN", message: `${response.data.note ?? "Un hueco se ocupó."} Revísalo y vuelve a firmar.` })
          }
          done.push(item)
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
    busy: dictating || organizing || queue.current.length > 0,
    seconds,
    transcript,
    interim,
    highlights,
    canListen,
    micError,
    organizing,
    /** Partes que no se pudieron ordenar ni al reintentar, con «Reintentar» y «Descartar esta parte». */
    failed,
    retryFailed,
    discardFailed: (id: string) => setFailed((current) => current.filter((item) => item.id !== id)),
    /** Lo que el asistente no pudo usar, hasta «Entendido». */
    unused,
    dismissUnused: () => setUnused(NOTHING_UNUSED),
    demo,
    start,
    pause,
    resume,
    finish,
    submitTyped,
    act,
    save,
    confirmReady,
    confirmMany,
    issuePrescription,
    settlePrescription,
    settleMedicalLeave,
    patientId,
    encounterId,
    editing: suggestions.find((item) => item.id === editingId) ?? null,
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
