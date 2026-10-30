import {
  clinicalProfileFor,
  DIAGNOSIS_SYSTEM_INFO,
  SELECTABLE_DIAGNOSIS_SYSTEMS,
  type SelectableDiagnosisSystem,
} from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { useOrgLocale } from "../../lib/locale"
import { effectiveDiagnosisSystem, type OrgProfile, saveDiagnosisSystem } from "../../lib/org"
import { countryName, displayLanguage } from "../../lib/region-format"

const CARD = "elevated flex flex-col gap-4 rounded-xl border bg-card p-5"

/**
 * «Lista de diagnósticos» (decisión 26 v3): la clínica elige la CIE-10 o la
 * CIE-11 de la OMS o, en Perú, la CIE-10 del MINSA. Viene la que recomienda su
 * país; elegir otra muestra el aviso de su
 * país y pide confirmar. Desde ese día los diagnósticos nuevos se eligen en la
 * lista nueva; lo anterior no se reescribe y se puede volver atrás. El cambio
 * se guarda solo, como un interruptor, y queda en la actividad de la clínica.
 */
export function DiagnosisListSettings({ profile }: { profile: OrgProfile }) {
  const groupId = useId()
  const queryClient = useQueryClient()
  const language = displayLanguage(useOrgLocale())
  const current = effectiveDiagnosisSystem(profile).key
  const country = clinicalProfileFor(profile.countryCode)
  const recommended = country.diagnosis.recommended
  const countryLabel = country.country ? countryName(country.country, language) : null
  const [pending, setPending] = useState<SelectableDiagnosisSystem | null>(null)
  // Una lista nacional solo en su país (o si ya la tiene); la recomendada, primero.
  const options = SELECTABLE_DIAGNOSIS_SYSTEMS.filter((system) => {
    const listCountry = DIAGNOSIS_SYSTEM_INFO[system].country
    return listCountry === null || listCountry === profile.countryCode || system === current
  }).sort((a, b) => Number(b === recommended) - Number(a === recommended))

  const mutation = useMutation({
    mutationFn: (system: SelectableDiagnosisSystem) => saveDiagnosisSystem(system),
    onSuccess: async (_data, system) => {
      setPending(null)
      toast.success(
        `Desde hoy, los diagnósticos nuevos se eligen en la ${DIAGNOSIS_SYSTEM_INFO[system].short}`,
      )
      await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
    },
  })

  const notice = (system: SelectableDiagnosisSystem): string | null => {
    if (system === recommended) return null
    return (
      country.diagnosis.notices[system] ??
      `${countryLabel ? `En ${countryLabel} se recomienda` : "Se recomienda"} la ${DIAGNOSIS_SYSTEM_INFO[recommended].short}.`
    )
  }

  return (
    <section aria-labelledby={`${groupId}-title`} className={CARD}>
      <div className="flex flex-col gap-1">
        <h2 id={`${groupId}-title`} className="font-heading text-base font-medium">
          Lista de diagnósticos
        </h2>
        <p className="text-sm text-muted-foreground">
          En ella se eligen los diagnósticos de las atenciones. Cada diagnóstico guarda su lista.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-title`}
        className="flex flex-wrap gap-1.5"
      >
        {options.map((system) => (
          <Button
            key={system}
            type="button"
            role="radio"
            aria-checked={current === system}
            variant={current === system ? "default" : "outline"}
            className="min-h-11"
            disabled={mutation.isPending}
            onClick={() => {
              if (system !== current) setPending(system)
            }}
          >
            {DIAGNOSIS_SYSTEM_INFO[system].short}
            {system === recommended && countryLabel ? ` · recomendada en ${countryLabel}` : ""}
          </Button>
        ))}
      </div>
      {notice(current as SelectableDiagnosisSystem) ? (
        <p className="rounded-lg bg-muted px-3 py-2.5 text-sm">
          {notice(current as SelectableDiagnosisSystem)}
        </p>
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `Cambiar a la ${DIAGNOSIS_SYSTEM_INFO[pending].short}` : ""}
        description={
          pending
            ? `Desde hoy, los diagnósticos nuevos se eligen en la ${DIAGNOSIS_SYSTEM_INFO[pending].short}. Los anteriores se quedan como se registraron.`
            : ""
        }
        confirmLabel={pending ? `Cambiar a ${DIAGNOSIS_SYSTEM_INFO[pending].short}` : "Cambiar"}
        variant="default"
        pending={mutation.isPending}
        error={mutation.error ? submitErrorMessage(mutation.error) : undefined}
        onConfirm={() => {
          if (pending) mutation.mutate(pending)
        }}
        onClose={() => {
          setPending(null)
          mutation.reset()
        }}
      >
        {pending && notice(pending) ? (
          <p className="rounded-lg bg-muted px-3 py-2.5 text-sm">{notice(pending)}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Una atención abierta conserva lo que ya tenía. Puedes volver atrás cuando quieras y cada
          cambio queda en la actividad de la clínica.
        </p>
      </ConfirmDialog>
    </section>
  )
}
