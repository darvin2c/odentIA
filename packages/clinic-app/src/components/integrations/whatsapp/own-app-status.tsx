import { Button, cn, Field, FieldDescription, FieldError, FieldLabel, Input } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, CircleAlert, TriangleAlert } from "lucide-react"
import { type FormEvent, useId, useState } from "react"
import { ApiError, apiFetch } from "../../../lib/api"
import type { OwnAppState } from "../../../lib/crm"
import { activeOrgTimeZone, useOrgLocale } from "../../../lib/locale"
import { appWords } from "../../../lib/product-words"
import { type OwnAppCheckState, ownAppChecks, ownAppHelpText } from "../../../lib/whatsapp"
import { openSupportRequest } from "../../help-panel"

const CHECK_ICON: Record<OwnAppCheckState, { icon: typeof Check; className: string; word: string }> = {
  ok: { icon: Check, className: "text-primary", word: "Hecho" },
  warn: { icon: TriangleAlert, className: "text-warning", word: "Aviso" },
  problem: { icon: CircleAlert, className: "text-destructive", word: "Falta" },
}

/** Lo que responde «Volver a comprobar» y «Registrar el número». */
interface RetryResult {
  ownApp: OwnAppState | null
  problem: string | null
}

/**
 * Lo que el sistema comprobó e hizo en Meta por una conexión con la app propia
 * de la clínica, una línea por cosa. Si el número ya tenía un PIN, lo pide; si
 * algo falta, «Volver a comprobar» lo intenta de nuevo y «Pedir ayuda» abre un
 * mensaje a soporte con lo que dice esta lista (sin claves).
 */
export function OwnAppStatus({
  connectionId,
  state,
  found,
  lastInboundAt = null,
  step,
  onUpdated,
}: {
  connectionId: string
  state: OwnAppState
  /** El número y el nombre que respondió WhatsApp, si se saben. */
  found: string | null
  lastInboundAt?: string | null
  /** En qué paso del alta está, para el mensaje a soporte. */
  step: number
  onUpdated: (state: OwnAppState | null) => void
}) {
  const queryClient = useQueryClient()
  const locale = useOrgLocale()
  const pinId = useId()
  const [pin, setPin] = useState("")
  const [pinError, setPinError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { timeZone: activeOrgTimeZone(), day: "numeric", month: "long" })
  const checks = ownAppChecks(state, { found, day, lastInboundAt })
  const pending = checks.some((check) => check.state !== "ok")

  const retry = useMutation({
    mutationFn: (body: { pin?: string }) =>
      apiFetch<{ data: RetryResult }>(`/api/channels/connections/${connectionId}/own-app`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: ({ data }, body) => {
      onUpdated(data.ownApp)
      setResult(data.problem ?? "Todo en orden.")
      if (body.pin) setPin("")
      void queryClient.invalidateQueries({ queryKey: ["connections"] })
    },
    onError: (failure) =>
      setResult(failure instanceof ApiError && failure.shape.message ? failure.shape.message : "Meta no respondió. Vuelve a intentarlo en un momento."),
  })

  function submitPin(event: FormEvent) {
    event.preventDefault()
    const value = pin.trim()
    if (!/^\d{6}$/.test(value)) {
      setPinError("El PIN tiene 6 dígitos.")
      document.getElementById(pinId)?.focus()
      return
    }
    setPinError(null)
    retry.mutate({ pin: value })
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2 text-sm" aria-label="Lo que comprobamos en Meta">
        {checks.map((check) => {
          const { icon: Icon, className, word } = CHECK_ICON[check.state]
          return (
            <li key={check.key} className="flex gap-2">
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", className)} />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="sr-only">{word}: </span>
                <strong className="font-semibold">{check.title}</strong>
                {check.text ? ` ${check.text}` : ""}
              </span>
            </li>
          )
        })}
      </ul>

      {state.pinNeeded && !state.registeredAt ? (
        <form noValidate onSubmit={submitPin} className="flex flex-col gap-2 rounded-xl bg-warning-soft px-3.5 py-3">
          <Field data-invalid={pinError ? true : undefined}>
            <FieldLabel htmlFor={pinId}>PIN de 6 dígitos del número</FieldLabel>
            <div className="flex flex-wrap gap-2">
              <Input
                id={pinId}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                aria-invalid={pinError ? true : undefined}
                aria-describedby={`${pinId}-ayuda`}
                className="h-11 w-40 tracking-[0.2em] sm:h-9"
                value={pin}
                onChange={(event) => {
                  setPin(event.target.value.replace(/\D/g, "").slice(0, 6))
                  setPinError(null)
                }}
              />
              <SubmitButton type="submit" pending={retry.isPending && retry.variables?.pin !== undefined} className="h-11 sm:h-9">
                Registrar el número
              </SubmitButton>
            </div>
            <FieldDescription id={`${pinId}-ayuda`}>Lo guardamos cifrado; no se vuelve a pedir.</FieldDescription>
            {pinError ? <FieldError>{pinError}</FieldError> : null}
          </Field>
        </form>
      ) : null}

      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-9"
            disabled={retry.isPending}
            onClick={() => {
              setResult(null)
              retry.mutate({})
            }}
          >
            {retry.isPending && retry.variables?.pin === undefined ? "Comprobando…" : "Volver a comprobar"}
          </Button>
          <Button type="button" variant="ghost" className="h-11 sm:h-9" onClick={() => openSupportRequest(ownAppHelpText(step, checks))}>
            Pedir ayuda a {appWords().name}
          </Button>
        </div>
      ) : null}
      {result ? (
        <p role="status" className="text-sm font-medium">
          {result}
        </p>
      ) : null}
    </div>
  )
}
