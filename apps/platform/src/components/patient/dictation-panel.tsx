import { Badge, Button, Field, FieldDescription, FieldLabel, Input, Textarea } from "@odentia/ui"
import { AgentMark, AgentSurface, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Mic, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"

export type DictationKind = "nota" | "diagnostico" | "plan" | "control"

export interface DictationSuggestion {
  id: string
  kind: DictationKind
  payload: Record<string, unknown>
  sourceText: string
  status: "lista" | "por_revisar" | "confirmada" | "descartada"
  note: string | null
  summary: string
}

const KIND_LABEL: Record<DictationKind, string> = {
  nota: "Consulta",
  diagnostico: "Diagnóstico",
  plan: "Plan de tratamiento",
  control: "Controles",
}
const KIND_ORDER: DictationKind[] = ["nota", "diagnostico", "plan", "control"]

/** Campos que el odontólogo puede corregir a mano en una sugerencia, con su rótulo. */
const EDITABLE: Record<DictationKind, Array<{ key: string; label: string; long?: boolean; number?: boolean }>> = {
  nota: [
    { key: "reason", label: "Motivo de consulta", long: true },
    { key: "presentIllness", label: "Enfermedad actual", long: true },
    { key: "illnessDuration", label: "Tiempo de enfermedad" },
    { key: "evolution", label: "Evolución", long: true },
    { key: "indications", label: "Indicaciones", long: true },
    { key: "nextStep", label: "Siguiente paso", long: true },
    { key: "prognosis", label: "Pronóstico" },
    { key: "auxiliaryExams", label: "Exámenes auxiliares", long: true },
  ],
  diagnostico: [
    { key: "cie10Code", label: "Código CIE-10" },
    { key: "toothNumber", label: "Pieza", number: true },
    { key: "note", label: "Nota", long: true },
  ],
  plan: [
    { key: "toothNumber", label: "Pieza", number: true },
    { key: "detail", label: "Detalle", long: true },
  ],
  control: [
    { key: "title", label: "Control" },
    { key: "instructions", label: "Indicaciones", long: true },
  ],
}

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

const money = (cents: number, currency: string) => `${currency === "PEN" ? "S/" : currency} ${(cents / 100).toFixed(2)}`

function errorText(error: unknown, fallback: string): string | null {
  if (error == null) return null
  if (error instanceof ApiError && error.shape.message && error.status < 500) return error.shape.message
  return fallback
}

function SuggestionCard({
  item,
  base,
  onDecided,
}: {
  item: DictationSuggestion
  base: string
  onDecided: (item: DictationSuggestion, outcome: "confirmada" | "descartada" | "editada") => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const act = useMutation({
    retry: false,
    mutationFn: (input: { action: "confirm" | "discard" } | { patch: Record<string, unknown> }) =>
      "patch" in input
        ? apiFetch(`${base}/${item.id}`, { method: "PATCH", body: JSON.stringify(input.patch) })
        : apiFetch(`${base}/${item.id}/${input.action}`, { method: "POST" }),
    onSuccess: (_data, input) => {
      setEditing(false)
      onDecided(item, "patch" in input ? "editada" : input.action === "confirm" ? "confirmada" : "descartada")
    },
  })
  const fields = EDITABLE[item.kind].filter((field) => item.kind !== "nota" || item.payload[field.key] !== undefined)
  const candidates = Array.isArray(item.payload["candidates"])
    ? (item.payload["candidates"] as Array<{ id: string; name: string; priceCents: number; currency: string }>)
    : []
  const ready = item.status === "lista"

  function openEdit() {
    act.reset()
    setDraft(Object.fromEntries(fields.map((field) => [field.key, item.payload[field.key] == null ? "" : String(item.payload[field.key])])))
    setEditing(true)
  }
  function saveEdit() {
    const patch: Record<string, unknown> = {}
    for (const field of fields) {
      const value = (draft[field.key] ?? "").trim()
      patch[field.key] = value === "" ? null : field.number ? Number(value) : value
    }
    act.mutate({ patch })
  }

  return (
    <li className="flex flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 basis-48 whitespace-pre-wrap font-medium">{item.summary || KIND_LABEL[item.kind]}</p>
        <Badge variant={ready ? "secondary" : "default"}>{ready ? "Sugerido" : "Por revisar"}</Badge>
      </div>
      {item.note ? <p className="text-foreground">{item.note}</p> : null}
      {item.sourceText ? <p className="text-muted-foreground">Lo que dijiste: «{item.sourceText}»</p> : null}

      {candidates.length > 0 ? (
        <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-2" aria-label="Elige la prestación">
          {candidates.map((candidate) => (
            <Button
              key={candidate.id}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={act.isPending}
              onClick={() => act.mutate({ patch: { serviceId: candidate.id } })}
            >
              {candidate.name} · {money(candidate.priceCents, candidate.currency)}
            </Button>
          ))}
        </fieldset>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-3">
          {fields.map((field) => (
            <Field key={field.key}>
              <FieldLabel htmlFor={`dictado-${item.id}-${field.key}`}>{field.label}</FieldLabel>
              {field.long ? (
                <Textarea
                  id={`dictado-${item.id}-${field.key}`}
                  rows={2}
                  value={draft[field.key] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              ) : (
                <Input
                  id={`dictado-${item.id}-${field.key}`}
                  type={field.number ? "number" : "text"}
                  value={draft[field.key] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
                />
              )}
            </Field>
          ))}
          <div className="flex flex-wrap gap-2">
            <SubmitButton type="button" size="sm" className="min-h-11 sm:min-h-8" pending={act.isPending} onClick={saveEdit}>
              Guardar cambios
            </SubmitButton>
            <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {ready ? (
            <SubmitButton type="button" size="sm" className="min-h-11 sm:min-h-8" pending={act.isPending} onClick={() => act.mutate({ action: "confirm" })}>
              Confirmar
            </SubmitButton>
          ) : null}
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={act.isPending} onClick={openEdit}>
            Editar
          </Button>
          <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={act.isPending} onClick={() => act.mutate({ action: "discard" })}>
            Descartar
          </Button>
        </div>
      )}
      {act.isError ? (
        <p role="alert" className="text-destructive">
          {errorText(act.error, "No pude guardar esto. Revísalo y vuelve a intentarlo.")}
        </p>
      ) : null}
    </li>
  )
}

/**
 * Dictado del asistente clínico dentro de una atención en borrador. El
 * odontólogo dicta (o escribe) y lo dicho se ordena en sugerencias; nada entra
 * a la historia hasta que confirma cada una. No se muestra si la clínica no
 * encendió el asistente.
 */
export function DictationPanel({
  patientId,
  encounterId,
  onApplied,
  onPendingChange,
}: {
  patientId: string
  encounterId: string
  /** Una sugerencia entró a la historia: la pantalla refresca lo que muestra. */
  onApplied: (item: DictationSuggestion) => void
  /** Cuántas sugerencias quedan sin decidir, para avisar antes de firmar. */
  onPendingChange: (pending: number) => void
}) {
  const queryClient = useQueryClient()
  const base = `/api/patients/${patientId}/encounters/${encounterId}/dictation`
  const key = ["encounter-dictation", patientId, encounterId]
  const [open, setOpen] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [listening, setListening] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)
  const [demo, setDemo] = useState(false)
  const recognition = useRef<SpeechLike | null>(null)
  const wanted = useRef(false)
  const canListen = speechRecognition() !== null

  const query = useQuery({
    queryKey: key,
    queryFn: () => apiFetch<{ data: { enabled: boolean; suggestions: DictationSuggestion[] } }>(base),
    retry: false,
  })
  const suggestions = query.data?.data.suggestions ?? []
  const pending = suggestions.length
  useEffect(() => {
    onPendingChange(pending)
  }, [pending, onPendingChange])

  useEffect(() => {
    if (!listening) return
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [listening])
  // Al salir de la pantalla el micrófono se apaga: nunca escucha sin que se haya pulsado Dictar.
  useEffect(
    () => () => {
      wanted.current = false
      recognition.current?.stop()
    },
    [],
  )

  const organize = useMutation({
    retry: false,
    mutationFn: () => apiFetch<{ data: { suggestions: DictationSuggestion[]; model: string } }>(base, { method: "POST", body: JSON.stringify({ transcript: transcript.trim() }) }),
    onSuccess: (response) => {
      setDemo(response.data.model === "fake")
      setTranscript("")
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })
  const confirmReady = useMutation({
    retry: false,
    mutationFn: async () => {
      const done: DictationSuggestion[] = []
      for (const item of suggestions.filter((entry) => entry.status === "lista")) {
        await apiFetch(`${base}/${item.id}/confirm`, { method: "POST" })
        done.push(item)
      }
      return done
    },
    onSettled: (done) => {
      for (const item of done ?? []) onApplied(item)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })

  function listen() {
    const Recognition = speechRecognition()
    if (!Recognition) return
    setMicError(null)
    const instance = new Recognition()
    instance.lang = "es-PE"
    instance.continuous = true
    instance.interimResults = false
    instance.onresult = (event) => {
      let heard = ""
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal) heard += result[0]?.transcript ?? ""
      }
      if (heard.trim()) setTranscript((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${heard.trim()}`)
    }
    instance.onerror = (event) => {
      wanted.current = false
      setListening(false)
      setMicError(
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "El navegador no tiene permiso para usar el micrófono. Actívalo o escribe lo dictado."
          : "No pude seguir escuchando. Vuelve a pulsar Dictar o escribe lo dictado.",
      )
    }
    // El navegador corta el reconocimiento tras un silencio: se reanuda mientras siga el dictado.
    instance.onend = () => {
      if (wanted.current) instance.start()
      else setListening(false)
    }
    recognition.current = instance
    wanted.current = true
    setSeconds(0)
    setListening(true)
    instance.start()
  }
  function stop() {
    wanted.current = false
    recognition.current?.stop()
    setListening(false)
  }

  if (!query.data?.data.enabled) return null
  const ready = suggestions.filter((item) => item.status === "lista").length
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

  return (
    <AgentSurface aria-label="Dictado de la atención" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <AgentMark />
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="font-heading text-base font-semibold">{listening ? `Escuchando ${clock}` : "Dictar la atención"}</h2>
          <p className="text-sm text-muted-foreground">Lo que dictas aparece abajo como sugerencias. Nada entra a la historia hasta que confirmes.</p>
        </div>
        {listening ? (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={stop}>
            <Square className="size-4" aria-hidden /> Terminar dictado
          </Button>
        ) : canListen ? (
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            onClick={() => {
              setOpen(true)
              listen()
            }}
          >
            <Mic className="size-4" aria-hidden /> Dictar
          </Button>
        ) : null}
        {!open && !listening ? (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setOpen(true)}>
            Escribir lo dictado
          </Button>
        ) : null}
      </div>
      {micError ? (
        <p role="alert" className="text-sm text-destructive">
          {micError}
        </p>
      ) : null}

      {open || listening || transcript ? (
        <div className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor={`dictado-${encounterId}`}>Lo dictado</FieldLabel>
            <Textarea
              id={`dictado-${encounterId}`}
              rows={4}
              maxLength={12_000}
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              placeholder="En la dieciséis hay caries en dentina, le ponemos una resina en la cara oclusal…"
            />
            <FieldDescription>
              {canListen
                ? "Es tu respaldo: puedes corregirlo antes de ordenarlo. Para corregir al dictar, dilo: «no, es la veintiséis»."
                : "Este navegador no reconoce la voz: escribe o pega aquí lo dictado."}
            </FieldDescription>
          </Field>
          <div className="flex flex-wrap gap-2">
            <SubmitButton
              type="button"
              className="min-h-11 sm:min-h-9"
              pending={organize.isPending}
              disabled={transcript.trim().length < 3 || listening}
              onClick={() => organize.mutate()}
            >
              Ordenar lo dictado
            </SubmitButton>
            {!listening && !transcript ? (
              <Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" onClick={() => setOpen(false)}>
                Cerrar
              </Button>
            ) : null}
          </div>
          {organize.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorText(organize.error, "No pudimos ordenar el dictado. Tu texto sigue aquí: vuelve a intentarlo.")}
            </p>
          ) : null}
        </div>
      ) : null}

      {pending > 0 ? (
        <section aria-label="Sugerencias del dictado" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-48 text-sm">
              <span className="font-semibold">
                {pending} {pending === 1 ? "sugerencia" : "sugerencias"}
              </span>
              : {ready} {ready === 1 ? "lista" : "listas"}
              {pending - ready > 0 ? ` y ${pending - ready} por revisar` : ""}. Todavía no hay nada en la historia.
            </p>
            {ready > 1 ? (
              <SubmitButton type="button" variant="outline" className="min-h-11 sm:min-h-9" pending={confirmReady.isPending} onClick={() => confirmReady.mutate()}>
                Confirmar las {ready} listas
              </SubmitButton>
            ) : null}
          </div>
          {confirmReady.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorText(confirmReady.error, "Alguna no se pudo confirmar. Revisa las que siguen en la lista.")}
            </p>
          ) : null}
          {KIND_ORDER.filter((kind) => suggestions.some((item) => item.kind === kind)).map((kind) => (
            <div key={kind} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{KIND_LABEL[kind]}</h3>
              <ul className="flex flex-col gap-2">
                {suggestions
                  .filter((item) => item.kind === kind)
                  .map((item) => (
                    <SuggestionCard
                      key={item.id}
                      item={item}
                      base={base}
                      onDecided={(decided, outcome) => {
                        if (outcome === "confirmada") onApplied(decided)
                        void queryClient.invalidateQueries({ queryKey: key })
                      }}
                    />
                  ))}
              </ul>
            </div>
          ))}
          {demo ? (
            <p className="text-xs text-muted-foreground">
              Modelo de demostración: reconoce solo unas pocas frases y no dice cómo entendería un dictado un proveedor real.
            </p>
          ) : null}
        </section>
      ) : null}
    </AgentSurface>
  )
}
