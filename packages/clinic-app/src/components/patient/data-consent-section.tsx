import { Button, buttonVariants, Checkbox, cn, Field, FieldLabel } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  LoadingState,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { PatientFull } from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"
import { activeOrgLocale } from "../../lib/locale"

interface DataConsent {
  id: string
  noticeVersion: number
  noticeText: string
  purposes: string[]
  grantedByName: string
  channel: string
  grantedAt: string
  revokedAt: string | null
  revokeReason: string | null
}

const PURPOSES = [
  { key: "atencion", label: "Atención clínica", fixed: true },
  { key: "comunicaciones", label: "Novedades y promociones de la clínica", fixed: false },
] as const

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric" })

const MAX_REASON = 2000

const grantSchema = z.object({
  grantedByContactId: z.string().min(1, "Elige quién consintió"),
  purposes: z.array(z.string()).refine((list) => list.includes("atencion"), "La finalidad de atención es la base del consentimiento"),
})

const revokeSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe el motivo de la revocación")
    .max(MAX_REASON, `El motivo admite hasta ${MAX_REASON} caracteres`),
})

/**
 * Consentimiento para el tratamiento de datos (Ley 29733): versión del aviso,
 * finalidades, quién lo otorgó y revocación. Revocar da de baja los envíos
 * comerciales. Registrarlo dice «consintió», no «se le informó».
 */
export function DataConsentSection({ detail }: { detail: PatientFull }): React.JSX.Element {
  const canWrite = usePermission("patients.write")
  const queryClient = useQueryClient()
  const patientId = detail.patient.id
  const query = useQuery({
    queryKey: ["data-consents", patientId],
    queryFn: () => apiFetch<{ data: DataConsent[] }>(`/api/patients/${patientId}/data-consents`),
  })
  const consents = query.data?.data ?? []
  const current = consents.find((c) => !c.revokedAt) ?? null
  const grantors = detail.contacts.filter(
    (c) => c.relationship === "self" || c.relationship === "guardian",
  )
  const [granting, setGranting] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["data-consents", patientId] })
    await queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
  }
  const grant = useMutation({
    mutationFn: (body: { purposes: string[]; grantedByContactId: string }) =>
      apiFetch(`/api/patients/${patientId}/data-consents`, {
        method: "POST",
        body: JSON.stringify({ ...body, channel: "presencial" }),
      }),
  })
  const revoke = useMutation({
    mutationFn: (reason: string) =>
      apiFetch(`/api/patients/${patientId}/data-consents/${current?.id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
  })
  const grantForm = useAppForm({
    defaultValues: { grantedByContactId: "", purposes: ["atencion"] as string[] },
    validators: { onSubmit: grantSchema },
    onSubmit: async ({ value }) => {
      await grant.mutateAsync(value)
      await refresh()
      setGranting(false)
    },
  })
  const grantSurface = useFormSurface(grantForm)
  const purposes = useStore(grantForm.store, (state) => state.values.purposes)
  const revokeForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: revokeSchema },
    onSubmit: async ({ value }) => {
      await revoke.mutateAsync(value.reason.trim())
      await refresh()
      setRevoking(false)
    },
  })
  const revokeError = useFormSubmitError(revokeForm)
  const revokePending = useStore(revokeForm.store, (state) => state.isSubmitting)
  const responsiblesLink = (
    <Link
      to="/patients/$patientId"
      params={{ patientId }}
      search={{ tab: "responsables" }}
      className={cn(buttonVariants({ variant: "link", size: "sm" }), "h-auto p-0")}
    >
      Registrar un representante en Responsables
    </Link>
  )

  return (
    <div className="flex flex-col gap-2 border-t pt-3 text-sm">
      <p className="text-xs font-medium text-muted-foreground">Tratamiento de datos personales</p>
      {query.isPending ? (
        <LoadingState message="Cargando consentimientos de datos…" />
      ) : current ? (
        <>
          <p>
            Aceptado · aviso v{current.noticeVersion} · {day(current.grantedAt)}, por{" "}
            {current.grantedByName}
          </p>
          <p className="text-muted-foreground">
            {PURPOSES.map((p) => `${p.label} ${current.purposes.includes(p.key) ? "✓" : "✗"}`).join(
              " · ",
            )}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">Sin consentimiento vigente.</p>
      )}
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              grantForm.reset({
                grantedByContactId: grantors[0]?.contactId ?? "",
                purposes: current ? current.purposes : ["atencion"],
              })
              setGranting(true)
            }}
          >
            {current ? "Actualizar finalidades" : "Registrar consentimiento"}
          </Button>
          {current ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                revokeForm.reset({ reason: "" })
                setRevoking(true)
              }}
            >
              Revocar…
            </Button>
          ) : null}
        </div>
      ) : null}
      {consents.length > 1 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Ver historial</summary>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
            {consents.map((c) => (
              <li key={c.id}>
                v{c.noticeVersion} · {day(c.grantedAt)} · {c.grantedByName}
                {c.revokedAt ? ` · revocado el ${day(c.revokedAt)}: ${c.revokeReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <FormDrawer
        {...grantSurface}
        open={granting}
        title="Registrar consentimiento de datos"
        description="Quién consintió y para qué finalidades, según el aviso de privacidad vigente."
        onClose={() => {
          if (!grantSurface.isSubmitting) setGranting(false)
        }}
        submitLabel="Registrar"
      >
        <div className="flex flex-col gap-4">
          <grantForm.AppField name="grantedByContactId">
            {(field) => (
              <field.Control
                label="Consintió"
                description={
                  grantors.length === 0 ? (
                    <>
                      Lo registra el paciente o su representante legal vigente, y no hay ninguno
                      registrado. {responsiblesLink}
                    </>
                  ) : undefined
                }
              >
                {(control) => (
                  <ChoiceSelect
                    id={control.id}
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    value={field.state.value}
                    disabled={grantors.length === 0}
                    onBlur={control.onBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {grantors.map((c) => (
                      <option key={c.contactId} value={c.contactId}>
                        {c.displayName} · {c.relationship === "self" ? "el paciente" : "representante"}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </grantForm.AppField>
          <grantForm.AppField name="purposes">
            {(field) => (
              <field.Group legend="Finalidades aceptadas">
                {(control) => (
                  <div className="flex flex-col gap-2">
                    {PURPOSES.map((p) => {
                      const optionId = `${control.id}-${p.key}`
                      return (
                        <Field key={p.key} orientation="horizontal">
                          <Checkbox
                            id={optionId}
                            checked={purposes.includes(p.key)}
                            disabled={p.fixed}
                            aria-invalid={control.invalid || undefined}
                            aria-describedby={control.describedBy}
                            onCheckedChange={(checked) => {
                              field.handleChange(
                                checked === true
                                  ? [...field.state.value, p.key]
                                  : field.state.value.filter((k) => k !== p.key),
                              )
                              field.handleBlur()
                            }}
                          />
                          <FieldLabel htmlFor={optionId} className="font-normal">
                            {p.label}
                            {p.fixed ? (
                              <span className="text-xs text-muted-foreground">(necesaria para atender)</span>
                            ) : null}
                          </FieldLabel>
                        </Field>
                      )
                    })}
                  </div>
                )}
              </field.Group>
            )}
          </grantForm.AppField>
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={revoking}
        title="Revocar consentimiento"
        description="Queda registrado con el motivo. Se dan de baja los mensajes que había aceptado recibir; la historia clínica se conserva por ley."
        confirmLabel="Revocar"
        pending={revokePending}
        error={revokeError}
        onConfirm={() => void submitForm(revokeForm)}
        onClose={() => {
          if (!revokePending) setRevoking(false)
        }}
      >
        <revokeForm.AppField name="reason">
          {(field) => (
            <field.TextareaField label="Motivo" rows={2} maxLength={MAX_REASON} aria-required />
          )}
        </revokeForm.AppField>
      </ConfirmDialog>
    </div>
  )
}
