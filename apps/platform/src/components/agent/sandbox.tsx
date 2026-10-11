import { Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { CircleAlert, CircleCheck } from "lucide-react"
import { type FormEvent, useState } from "react"
import { ANSWER_CHECK_LABEL, type SandboxResult, type SandboxState } from "../../lib/agent"
import { ApiError, apiFetch } from "../../lib/api"

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
 * configurado. Nada se envía ni se guarda; el historial y lo que el agente dejó
 * pendiente viven en esta pantalla y se pierden al empezar de nuevo.
 */
export function AgentSandbox({ onTested }: { onTested?: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [state, setState] = useState<SandboxState | undefined>(undefined)
  const [draft, setDraft] = useState("")

  const send = useMutation({
    retry: false,
    mutationFn: (message: string) =>
      apiFetch<{ data: SandboxResult }>("/api/agent/sandbox", {
        method: "POST",
        body: JSON.stringify({
          message,
          transcript: turns.map(({ role, text }) => ({ role, text })),
          ...(state ? { state } : {}),
        }),
      }),
    onMutate: (message) => {
      setTurns((current) => [...current, { role: "contact", text: message }])
      setDraft("")
    },
    onSuccess: (response) => {
      const result = response.data
      setState(result.state)
      setTurns((current) => [...current, { role: "agent", text: result.reply, result }])
      onTested?.()
    },
    // El mensaje sin respuesta se retira y vuelve al cuadro de texto para reintentar.
    onError: (_error, message) => {
      setTurns((current) => current.slice(0, -1))
      setDraft(message)
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || send.isPending) return
    send.mutate(message)
  }

  function restart() {
    send.reset()
    setTurns([])
    setState(undefined)
    setDraft("")
  }

  const error =
    send.error instanceof ApiError
      ? (send.error.shape.message ?? "No pudimos probar")
      : send.error
        ? "No pudimos probar. Vuelve a intentarlo."
        : null

  return (
    <section
      id="probar"
      aria-labelledby="probar-titulo"
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border border-agent-border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="probar-titulo" className="font-heading text-base font-semibold">
            Probar
          </h2>
          <p className="text-sm text-muted-foreground">
            Escribe como si fueras un paciente. No se envía nada ni cambia ninguna ficha.
          </p>
        </div>
        {turns.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={restart}>
            Empezar de nuevo
          </Button>
        ) : null}
      </div>

      {turns.length === 0 ? (
        <fieldset className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-2" aria-label="Ejemplos para empezar">
          {STARTERS.map((starter) => (
            <Button
              key={starter.label}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 rounded-full sm:min-h-8"
              disabled={send.isPending}
              onClick={() => send.mutate(starter.text)}
            >
              {starter.label}
            </Button>
          ))}
        </fieldset>
      ) : (
        <ol className="flex flex-col gap-3" aria-live="polite">
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
          {send.isPending ? <li className="text-sm text-muted-foreground">El agente está respondiendo…</li> : null}
        </ol>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-2">
        <Field>
          <FieldLabel htmlFor="probar-mensaje" className="sr-only">
            Mensaje de prueba
          </FieldLabel>
          <Textarea
            id="probar-mensaje"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="Mensaje de prueba…"
          />
        </Field>
        <SubmitButton type="submit" pending={send.isPending} disabled={!draft.trim()} className="self-end">
          Enviar prueba
        </SubmitButton>
      </form>
    </section>
  )
}

/** Debajo de cada respuesta de prueba: lo que hizo, en qué se basó y lo que queda esperando. */
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
          <p className="text-xs font-semibold text-muted-foreground">Lo que queda esperando</p>
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
