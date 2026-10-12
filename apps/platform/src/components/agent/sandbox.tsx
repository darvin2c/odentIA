import { Button, Field, FieldLabel, Input } from "@odentia/ui"
import { DataRefreshMarker } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck } from "lucide-react"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { ANSWER_CHECK_LABEL, type SandboxResult, type SandboxState, type TestCaseItem } from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"
import { mutationErrorMessage } from "../../lib/query-error"

interface Turn {
  role: "contact" | "agent"
  text: string
  /** Solo en los turnos del agente: qué hizo y en qué se basó. */
  result?: SandboxResult
}

const STARTERS = [
  { label: "Quiere una cita", text: "Hola, quiero una cita para una limpieza." },
  { label: "Pregunta un precio", text: "Hola, ¿cuánto cuesta una limpieza?" },
  { label: "Se queja", text: "Llevo una hora esperando y nadie me atiende. Qué mal servicio." },
  { label: "Pide una persona", text: "Prefiero hablar con una persona, por favor." },
]

/**
 * «Probar»: una conversación de prueba con el agente tal como está
 * configurado. Nada se envía ni cambia ninguna ficha; el historial y lo que el
 * agente dejó pendiente viven en esta pantalla y se pierden al empezar de nuevo.
 * Lo único que se guarda, y solo si se pide, es la conversación como caso de prueba.
 *
 * En teléfono es una pantalla propia (`screen`): cabecera con volver, ejemplos
 * en una fila y el campo fijo abajo. Mientras no se abre, ahí no ocupa sitio.
 * Va en el flujo de la página (que oculta lo demás) con cabecera y campo
 * `sticky`: un `fixed` quedaría atrapado por el contenedor de la rejilla.
 */
export function AgentSandbox({
  onTested,
  screen = false,
  onLeaveScreen,
}: {
  onTested?: () => void
  /** Teléfono: ocupa toda la pantalla. En ventana ancha no cambia nada. */
  screen?: boolean
  /** Teléfono: volver a la página del agente. */
  onLeaveScreen?: () => void
}) {
  const queryClient = useQueryClient()
  const [turns, setTurns] = useState<Turn[]>([])
  const [state, setState] = useState<SandboxState | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const backRef = useRef<HTMLButtonElement>(null)
  const endRef = useRef<HTMLLIElement>(null)

  const cases = useQuery({
    queryKey: ["agent-test-cases"],
    queryFn: () => apiFetch<{ data: TestCaseItem[] }>("/api/agent/learning/cases"),
    retry: false,
  })

  const send = useMutation({
    retry: false,
    mutationFn: (input: { message: string; fresh: boolean }) =>
      apiFetch<{ data: SandboxResult }>("/api/agent/sandbox", {
        method: "POST",
        body: JSON.stringify({
          message: input.message,
          transcript: input.fresh ? [] : turns.map(({ role, text }) => ({ role, text })),
          ...(state && !input.fresh ? { state } : {}),
        }),
      }),
    onMutate: ({ message, fresh }) => {
      if (fresh) setState(undefined)
      setTurns((current) => [...(fresh ? [] : current), { role: "contact", text: message }])
      setDraft("")
    },
    onSuccess: (response) => {
      const result = response.data
      setState(result.state)
      setTurns((current) => [...current, { role: "agent", text: result.reply, result }])
      onTested?.()
    },
    // El mensaje sin respuesta se retira y vuelve al campo para reintentar.
    onError: (_error, { message }) => {
      setTurns((current) => current.slice(0, -1))
      setDraft(message)
    },
  })

  // Un caso de prueba se vuelve a responder sin conversación previa: se guarda
  // la pregunta que abrió la prueba con su respuesta, no un turno intermedio.
  const opening = turns[0]?.role === "contact" && turns[1]?.role === "agent" ? { question: turns[0].text, answer: turns[1] } : null
  const canSave = opening !== null && opening.answer.result?.replied === true
  const saveCase = useMutation({
    retry: false,
    mutationFn: (input: { question: string; expected: string }) =>
      apiFetch<{ data: TestCaseItem }>("/api/agent/learning/cases", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      for (const key of ["agent-test-cases", "agent-learning"]) void queryClient.invalidateQueries({ queryKey: [key] })
    },
  })

  // En teléfono, al abrir la pantalla el foco va a «volver» y la conversación sigue al último mensaje.
  useEffect(() => {
    if (screen) backRef.current?.focus()
  }, [screen])
  const turnCount = turns.length
  useEffect(() => {
    if (screen && turnCount > 0) endRef.current?.scrollIntoView({ block: "nearest" })
  }, [screen, turnCount])

  function submit(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || send.isPending) return
    send.mutate({ message, fresh: false })
  }

  function restart() {
    send.reset()
    saveCase.reset()
    setTurns([])
    setState(undefined)
    setDraft("")
  }

  /** Un ejemplo abre su propia conversación: la anterior se reemplaza. */
  function start(text: string) {
    if (send.isPending) return
    saveCase.reset()
    send.mutate({ message: text, fresh: true })
  }

  const error =
    send.error instanceof ApiError
      ? (send.error.shape.message ?? "No pudimos probar")
      : send.error
        ? "No pudimos probar. Vuelve a intentarlo."
        : null
  // En teléfono es la pantalla entera y su título es el de la página; al lado de la página, una sección.
  const Title = screen ? "h1" : "h2"
  const used = STARTERS.find((starter) => starter.text === turns[0]?.text)?.label
  const saved = cases.data?.data.filter((item) => item.agent === "recepcion").length

  return (
    <section
      id="probar"
      aria-labelledby="probar-titulo"
      className={`min-w-0 flex-col gap-3 sm:elevated sm:flex sm:rounded-xl sm:border sm:border-agent-border sm:bg-card sm:p-6 ${
        screen ? "max-sm:flex max-sm:min-h-[calc(100svh-2rem)]" : "max-sm:hidden"
      }`}
    >
      <div className="flex items-start gap-2 max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:items-center max-sm:bg-canvas max-sm:pb-1">
        {onLeaveScreen ? (
          <Button
            ref={backRef}
            type="button"
            variant="ghost"
            size="icon"
            className="-ml-2 size-11 shrink-0 sm:hidden"
            aria-label="Volver a Recepción"
            onClick={onLeaveScreen}
          >
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <Title id="probar-titulo" className="font-heading text-base font-semibold max-sm:text-lg">
            Probar
          </Title>
          <p className="text-sm text-muted-foreground">
            <span className="max-sm:hidden">Escribe como si fueras un paciente. </span>No se envía nada ni cambia ninguna ficha.
          </p>
        </div>
        {turns.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11 shrink-0 sm:min-h-8" onClick={restart}>
            Empezar de nuevo
          </Button>
        ) : null}
      </div>

      {/* En teléfono los ejemplos van en una fila que se desplaza; el contenedor es `relative` por lo que lleva dentro. */}
      <fieldset
        className="relative m-0 flex min-w-0 shrink-0 gap-2 border-0 p-0 max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-1 sm:flex-wrap"
        aria-label="Ejemplos"
      >
        {STARTERS.map((starter) => (
          <Button
            key={starter.label}
            type="button"
            variant="outline"
            size="sm"
            className={`min-h-11 shrink-0 rounded-full sm:min-h-8 ${used === starter.label ? "border-primary bg-primary-soft" : ""}`}
            aria-pressed={used === starter.label}
            disabled={send.isPending}
            onClick={() => start(starter.text)}
          >
            {starter.label}
          </Button>
        ))}
      </fieldset>

      {turns.length === 0 ? (
        <p className="text-sm text-muted-foreground max-sm:flex-1">Elige un ejemplo o escribe tu propio mensaje.</p>
      ) : (
        <ol className="flex min-h-0 flex-col gap-3 max-sm:flex-1" aria-live="polite">
          {turns.map((turn, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: la conversación solo crece por el final; no se reordena.
            <li key={`${index}-${turn.role}`} className={`flex flex-col gap-2 ${turn.role === "contact" ? "items-end" : "items-start"}`}>
              <p
                className={
                  turn.role === "contact"
                    ? "max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground"
                    : "max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-agent-border bg-agent-soft px-4 py-2.5 text-sm"
                }
              >
                <span className="sr-only">{turn.role === "contact" ? "Paciente de prueba: " : "Agente: "}</span>
                {turn.text}
              </p>
              {turn.result ? <TurnDetail result={turn.result} /> : null}
            </li>
          ))}
          <li ref={endRef} aria-hidden={!send.isPending}>
            {send.isPending ? <DataRefreshMarker message="El agente está respondiendo…" /> : null}
          </li>
        </ol>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Casos de prueba: cuántos hay y guardar esta conversación como uno. En teléfono la pantalla es solo la conversación. */}
      <div className="flex flex-col gap-2 border-t pt-3 text-sm max-sm:hidden">
        <p>
          {saved === undefined ? (
            <span className="text-muted-foreground">Casos de prueba</span>
          ) : saved === 0 ? (
            "Todavía no guardaste ningún caso de prueba."
          ) : (
            <>
              <strong className="font-semibold">
                {saved} {saved === 1 ? "caso de prueba" : "casos de prueba"}
              </strong>{" "}
              {saved === 1 ? "guardado." : "guardados."}
            </>
          )}{" "}
          <span className="text-muted-foreground">Con ellos se prueba una lección antes de aprobarla.</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={!canSave || saveCase.isPending || saveCase.isSuccess}
            onClick={() => {
              if (opening) saveCase.mutate({ question: opening.question, expected: opening.answer.text })
            }}
          >
            Guardar esta como caso
          </Button>
          {saveCase.isSuccess ? (
            <span role="status" className="text-muted-foreground">
              Guardada: «{saveCase.data.data.question}» con su respuesta.
            </span>
          ) : opening && !canSave ? (
            <span className="text-muted-foreground">Esta respuesta no llegó a salir: no se guarda como caso.</span>
          ) : null}
        </div>
        {saveCase.isError ? (
          <p role="alert" className="text-destructive">
            {mutationErrorMessage(saveCase.error)}
          </p>
        ) : null}
      </div>

      <form onSubmit={submit} className="flex shrink-0 items-end gap-2 max-sm:sticky max-sm:bottom-0 max-sm:bg-canvas max-sm:py-3">
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="probar-mensaje" className="sr-only">
            Mensaje de prueba
          </FieldLabel>
          <Input
            id="probar-mensaje"
            value={draft}
            maxLength={2000}
            autoComplete="off"
            enterKeyHint="send"
            className="h-11 sm:h-9"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Escribe como paciente…"
          />
        </Field>
        <Button
          type="submit"
          size="icon"
          className="size-11 shrink-0 sm:size-9"
          aria-label="Enviar el mensaje de prueba"
          disabled={!draft.trim() || send.isPending}
        >
          <ArrowRight aria-hidden />
        </Button>
      </form>
    </section>
  )
}

/** Debajo de cada respuesta de prueba: lo que hizo, en qué se basó y lo que haría después. */
function TurnDetail({ result }: { result: SandboxResult }) {
  const nothing =
    result.did.length === 0 && result.basis.length === 0 && result.checks.length === 0 && result.waiting.length === 0
  return (
    <div className="flex w-full max-w-[88%] flex-col gap-2 rounded-xl border bg-card p-3 text-sm">
      {!result.replied && !result.handedOff ? (
        <p role="status" className="font-medium text-destructive">
          El agente no llegó a enviar esta respuesta: en una conversación real el paciente no la recibiría.
        </p>
      ) : null}
      {result.handedOff ? <p className="font-semibold">Pasaría el caso a una persona de tu equipo.</p> : null}
      {result.did.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Lo que hizo</p>
          <ul className="list-disc pl-5">
            {result.did.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.basis.length > 0 || result.checks.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">En qué se basó</p>
          <ul className="flex flex-col gap-1">
            {result.basis.map((item) => (
              <li key={item.label}>
                {item.label}
                {item.detail ? <span className="text-muted-foreground"> · {item.detail}</span> : null}
              </li>
            ))}
            {result.checks.map((check) => (
              <li key={`${check.kind}-${check.value}`} className="flex items-start gap-1.5">
                <span className={`mt-0.5 shrink-0 [&>svg]:size-4 ${check.ok ? "text-success" : "text-destructive"}`}>
                  {check.ok ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
                </span>
                <span>
                  {ANSWER_CHECK_LABEL[check.kind]} «{check.value}»:{" "}
                  {check.ok ? `coincide con ${check.source ?? "tus datos"}` : "no está en tus datos; esta respuesta no saldría"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.waiting.length > 0 ? (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Lo que haría después</p>
          <ul className="list-disc pl-5">
            {result.waiting.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {nothing && result.replied ? (
        <p className="text-muted-foreground">Respondió sin consultar nada: con lo que ya había en la conversación.</p>
      ) : null}
      {result.model === "fake" ? (
        <p className="text-xs text-muted-foreground">
          Modelo de demostración: siempre responde lo mismo y no acredita la calidad de un proveedor real.
        </p>
      ) : null}
    </div>
  )
}
