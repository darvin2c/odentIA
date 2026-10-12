import { Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { ConfirmDialog, FormDrawer, LoadingState } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
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
  { key: "recordatorios", label: "Recordatorios de citas y controles", fixed: false },
  { key: "comunicaciones", label: "Comunicaciones comerciales", fixed: false },
] as const

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric" })

function message(error: unknown, fallback: string) {
  return error instanceof ApiError ? (error.shape.message ?? fallback) : error ? fallback : null
}

/**
 * Consentimiento para el tratamiento de datos (Ley 29733): versión del aviso,
 * finalidades, quién lo otorgó y revocación. Revocar da de baja los envíos
 * comerciales. Registrarlo dice «consintió», no «se le informó».
 */
export function DataConsentSection({ detail }: { detail: PatientFull }): React.JSX.Element {
  const uid = useId()
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
  const [purposes, setPurposes] = useState<string[]>(["atencion"])
  const [grantor, setGrantor] = useState(grantors[0]?.contactId ?? "")
  const [revoking, setRevoking] = useState(false)
  const [reason, setReason] = useState("")
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["data-consents", patientId] })
    await queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
  }
  const grant = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/data-consents`, {
        method: "POST",
        body: JSON.stringify({ purposes, grantedByContactId: grantor, channel: "presencial" }),
      }),
    onSuccess: async () => {
      await refresh()
      setGranting(false)
    },
  })
  const revoke = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/data-consents/${current?.id}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() }),
      }),
    onSuccess: async () => {
      await refresh()
      setRevoking(false)
      setReason("")
    },
  })

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
              setPurposes(current ? current.purposes : ["atencion"])
              setGranting(true)
            }}
          >
            {current ? "Actualizar finalidades" : "Registrar consentimiento"}
          </Button>
          {current ? (
            <Button size="sm" variant="ghost" onClick={() => setRevoking(true)}>
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
        open={granting}
        title="Registrar consentimiento de datos"
        description="Quién consintió y para qué finalidades, según el aviso de privacidad vigente."
        onClose={() => setGranting(false)}
        onSubmit={(event) => {
          event.preventDefault()
          grant.mutate()
        }}
        isSubmitting={grant.isPending}
        isDirty
        submitDisabled={!grantor}
        error={message(grant.error, "No se pudo registrar el consentimiento.")}
        submitLabel="Registrar"
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-grantor`}>Consintió</FieldLabel>
            <ChoiceSelect
              id={`${uid}-grantor`}
              
              value={grantor}
              onChange={(event) => setGrantor(event.target.value)}
            >
              {grantors.map((c) => (
                <option key={c.contactId} value={c.contactId}>
                  {c.displayName} · {c.relationship === "self" ? "el paciente" : "representante"}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">Finalidades aceptadas</legend>
            {PURPOSES.map((p) => (
              <label key={p.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={purposes.includes(p.key)}
                  disabled={p.fixed}
                  onChange={(event) =>
                    setPurposes((prev) =>
                      event.target.checked ? [...prev, p.key] : prev.filter((k) => k !== p.key),
                    )
                  }
                />
                {p.label}
                {p.fixed ? (
                  <span className="text-xs text-muted-foreground">(necesaria para atender)</span>
                ) : null}
              </label>
            ))}
          </fieldset>
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={revoking}
        title="Revocar consentimiento"
        description="Queda registrado con el motivo. Se dan de baja las comunicaciones comerciales; la historia clínica se conserva por ley."
        confirmLabel="Revocar"
        pending={revoke.isPending}
        confirmDisabled={!reason.trim()}
        onConfirm={() => revoke.mutate()}
        onClose={() => {
          if (!revoke.isPending) setRevoking(false)
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-revoke`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-revoke`}
            rows={2}
            maxLength={2000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {revoke.error ? (
          <p role="alert" className="text-sm text-destructive">
            {message(revoke.error, "No se pudo revocar.")}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
