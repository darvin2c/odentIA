import { Button, cn, Input } from "@odentia/ui"
import { SubmitButton, submitErrorMessage, useAppForm, useFormSubmit, useFormSubmitError } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, CircleAlert, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
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
  /** `pin`: Meta no aceptó el PIN escrito (el problema se dice junto a él). */
  problemField: "pin" | null
}

const pinSchema = z.object({ pin: z.string().regex(/^\d{6}$/, "El PIN tiene 6 dígitos.") })

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
  const [result, setResult] = useState<string | null>(null)
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { timeZone: activeOrgTimeZone(), day: "numeric", month: "long" })
  const checks = ownAppChecks(state, { found, day, lastInboundAt })
  const pending = checks.some((check) => check.state !== "ok")

  const retry = useMutation({
    mutationFn: (body: { pin?: string }) =>
      apiFetch<{ data: RetryResult }>(`/api/channels/connections/${connectionId}/own-app`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: ({ data }) => {
      onUpdated(data.ownApp)
      void queryClient.invalidateQueries({ queryKey: ["connections"] })
    },
  })

  const pinForm = useAppForm({
    defaultValues: { pin: "" },
    validators: { onSubmit: pinSchema },
    onSubmit: async ({ value }) => {
      setResult(null)
      const { data } = await retry.mutateAsync({ pin: value.pin })
      // Meta guardó lo que respondió, pero el PIN escrito no sirvió: se dice en el campo.
      if (data.problemField === "pin" && data.problem) {
        throw new ApiError(400, { code: "WRONG_PIN", message: data.problem, fields: { pin: data.problem } })
      }
      setResult(data.problem ?? "Todo en orden.")
      pinForm.reset({ pin: "" })
    },
  })
  const submitPin = useFormSubmit(pinForm)
  const pinFormError = useFormSubmitError(pinForm)
  const pinSubmitting = useStore(pinForm.store, (state) => state.isSubmitting)
  const checking = retry.isPending && !pinSubmitting

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
          <pinForm.AppField name="pin">
            {(field) => (
              <field.Control label="PIN de 6 dígitos del número" description="Lo guardamos cifrado; no se vuelve a pedir.">
                {(control) => (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      {...control.props}
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      className="h-11 w-40 tracking-[0.2em] sm:h-9"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    />
                    {/* Mientras «Volver a comprobar» pregunta a Meta (lo dice su botón), se espera. */}
                    <SubmitButton type="submit" pending={pinSubmitting} disabled={checking} className="h-11 sm:h-9">
                      Registrar el número
                    </SubmitButton>
                  </div>
                )}
              </field.Control>
            )}
          </pinForm.AppField>
          {pinFormError ? (
            <p role="alert" className="text-sm text-destructive">
              {pinFormError}
            </p>
          ) : null}
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
              retry.mutate({}, { onSuccess: ({ data }) => setResult(data.problem ?? "Todo en orden.") })
            }}
          >
            {checking ? "Comprobando…" : "Volver a comprobar"}
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
      {/* Un fallo de «Volver a comprobar» (no del PIN): con su motivo y como error. */}
      {retry.isError && !pinSubmitting && retry.variables?.pin === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          {submitErrorMessage(retry.error)}
        </p>
      ) : null}
    </div>
  )
}
