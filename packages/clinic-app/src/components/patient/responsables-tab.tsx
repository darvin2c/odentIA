/**
 * Responsables del paciente: quién representa, autoriza información o responde
 * económicamente, con vigencia y documento de respaldo. Quien solo acompaña va
 * en «Personas vinculadas», no aquí.
 *
 * La persona se elige con el buscador de personas de la aplicación; si aún no
 * está vinculada al paciente, se vincula en el mismo paso (tutor si es menor,
 * familiar si no). La responsabilidad se revoca con motivo y se conserva en la
 * historia.
 */

import { Badge, Button } from "@odentia/ui"
import { DatePickerButton, EmptyState, FormDrawer, useAppForm, useFormSurface, zonedDateOf } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import {
  fetchResponsibilities,
  formatDate,
  grantResponsibilityApi,
  RESPONSIBILITY_KIND_LABELS,
  RESPONSIBILITY_KINDS,
  type ResponsibilityKind,
  revokeResponsibilityApi,
} from "../../lib/clinical-journey"
import { activeOrgTimeZone } from "../../lib/locale"
import { usePermission } from "../../lib/crm"
import type { PatientDocument, PatientFull } from "../../lib/patients"
import { type PickedPerson, PersonPicker } from "../person-picker"

const MAX_TEXT = 2000

const KIND_OPTIONS = RESPONSIBILITY_KINDS.map((value) => ({ value, label: RESPONSIBILITY_KIND_LABELS[value] }))

/** Lo que exige `grantResponsibility`, dicho en su campo antes de enviar. */
const grantSchema = z
  .object({
    person: z.custom<PickedPerson | null>((value) => value !== null, "Elige a la persona."),
    kind: z.enum(RESPONSIBILITY_KINDS, "Elige la responsabilidad"),
    startsAt: z.string().min(1, "Elige desde cuándo está vigente"),
    endsAt: z.string(),
    evidenceDocumentId: z.string(),
    notes: z.string().max(MAX_TEXT),
  })
  .superRefine((value, ctx) => {
    if (value.endsAt && value.endsAt < value.startsAt)
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "La fecha final no puede preceder a la inicial." })
  })

const revokeSchema = z.object({
  reason: z.string().trim().min(1, "Indica el motivo de la revocación.").max(MAX_TEXT),
})

/**
 * Hoy en la zona de la clínica, como lo cuenta el servidor al decir si una
 * responsabilidad está vigente: en UTC, por la noche en América ya sería mañana
 * y lo recién asignado quedaría «No vigente» hasta el día siguiente.
 */
function todayIso(): string {
  return zonedDateOf(new Date().toISOString(), activeOrgTimeZone())
}

export function ResponsablesTab({ patientId }: { patientId: string }): React.JSX.Element {
  const canWrite = usePermission("patients.write")
  const canRead = usePermission("patients.read")
  const canDocuments = usePermission("clinical.read")
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["responsibilities", patientId],
    queryFn: () => fetchResponsibilities(patientId),
    enabled: canRead,
  })
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canRead,
  })
  const documents = useQuery({
    queryKey: ["patient-documents", patientId],
    queryFn: () => apiFetch<{ data: PatientDocument[] }>(`/api/patients/${patientId}/documents`),
    enabled: canDocuments,
  })

  const [grantOpen, setGrantOpen] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["responsibilities", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
  }

  const grantMutation = useMutation({
    mutationFn: async (value: z.infer<typeof grantSchema>) => {
      const contactId = value.person?.id ?? ""
      // Quien aún no está vinculado al paciente se vincula en el mismo paso.
      if (!contacts.some((link) => link.contactId === contactId)) {
        await apiFetch(`/api/patients/${patientId}/contacts/${contactId}`, {
          method: "PUT",
          body: JSON.stringify({
            relationship: patient.data?.data.isMinor ? "guardian" : "family",
            isPreferred: false,
          }),
        })
        void queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
        void queryClient.invalidateQueries({ queryKey: ["person"] })
      }
      return grantResponsibilityApi(patientId, {
        contactId,
        kind: value.kind,
        startsAt: value.startsAt,
        endsAt: value.endsAt || null,
        evidenceDocumentId: value.evidenceDocumentId || null,
        notes: value.notes.trim() || null,
      })
    },
  })
  const grantForm = useAppForm({
    defaultValues: {
      person: null as PickedPerson | null,
      kind: "representante_legal" as ResponsibilityKind,
      startsAt: todayIso(),
      endsAt: "",
      evidenceDocumentId: "",
      notes: "",
    },
    validators: { onSubmit: grantSchema },
    onSubmit: async ({ value }) => {
      await grantMutation.mutateAsync(value)
      setGrantOpen(false)
      invalidate()
    },
  })
  // La persona se elige con el buscador: lo que el servidor dice de `contactId` va en él.
  const grantSurface = useFormSurface(grantForm, { fieldMap: { contactId: "person" } })
  const startsAt = useStore(grantForm.store, (state) => state.values.startsAt)
  const revokeMutation = useMutation({
    mutationFn: (reason: string) => revokeResponsibilityApi(patientId, revoking ?? "", { reason }),
  })
  const revokeForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: revokeSchema },
    onSubmit: async ({ value }) => {
      await revokeMutation.mutateAsync(value.reason.trim())
      setRevoking(null)
      invalidate()
    },
  })
  const revokeSurface = useFormSurface(revokeForm)

  const rows = list.data?.data ?? []
  const contacts = patient.data?.data.contacts ?? []
  const evidence = documents.data?.data ?? []

  return (
    <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Responsables</div>
          <p className="text-sm text-muted-foreground">
            El representante legal vigente puede decidir por el paciente; el responsable económico
            responde por la cuenta. Los roles se otorgan con vigencia y se revocan con motivo.
          </p>
        </div>
        {canWrite ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              const first = contacts.find((link) => link.relationship !== "self")
              grantForm.reset({
                person: first ? { id: first.contactId, name: first.displayName } : null,
                kind: "representante_legal",
                startsAt: todayIso(),
                endsAt: "",
                evidenceDocumentId: "",
                notes: "",
              })
              setGrantOpen(true)
            }}
          >
            Asignar responsabilidad
          </Button>
        ) : null}
      </div>

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando responsables…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin responsables"
          description="Asigna quién representa, autoriza o responde económicamente por este paciente."
        />
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.contact.displayName}</span>
                <Badge variant="secondary">
                  {RESPONSIBILITY_KIND_LABELS[row.kind] ?? row.kind}
                </Badge>
                <Badge
                  variant={row.revokedAt ? "destructive" : row.isCurrent ? "success" : "secondary"}
                >
                  {row.revokedAt ? "Revocada" : row.isCurrent ? "Vigente" : "No vigente"}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {formatDate(row.startsAt)} —{" "}
                  {row.endsAt ? formatDate(row.endsAt) : "sin fecha final"}
                </span>
              </div>
              {row.evidenceDocument ? (
                <p className="text-sm text-muted-foreground">
                  Respaldo: {row.evidenceDocument.label}
                </p>
              ) : null}
              {row.notes ? <p className="text-sm">{row.notes}</p> : null}
              {row.revokeReason ? (
                <p className="text-sm text-muted-foreground">Revocada: {row.revokeReason}</p>
              ) : null}
              {canWrite && !row.revokedAt ? (
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      revokeForm.reset()
                      setRevoking(row.id)
                    }}
                  >
                    Revocar
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <FormDrawer
        {...grantSurface}
        open={grantOpen}
        title="Asignar responsabilidad"
        description="La responsabilidad queda vigente desde la fecha indicada y solo puede sustituirse revocándola antes."
        submitLabel="Asignar"
        onClose={() => {
          if (!grantSurface.isSubmitting) setGrantOpen(false)
        }}
      >
        <div className="flex flex-col gap-4">
          <grantForm.AppField name="person">
            {(field) => (
              <field.Control
                label="Persona"
                description="Si aún no está vinculada al paciente, se vincula al asignarle el rol."
              >
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    label="Persona"
                    value={field.state.value}
                    onChange={field.handleChange}
                    excludeId={contacts.find((link) => link.relationship === "self")?.contactId}
                  />
                )}
              </field.Control>
            )}
          </grantForm.AppField>
          <grantForm.AppField name="kind">
            {(field) => <field.SelectField label="Responsabilidad" options={KIND_OPTIONS} />}
          </grantForm.AppField>
          <grantForm.AppField name="startsAt">
            {(field) => (
              <field.Control label="Vigente desde">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    className="w-56"
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      const endsAt = grantForm.getFieldValue("endsAt")
                      if (endsAt && endsAt < next) grantForm.setFieldValue("endsAt", next)
                    }}
                  />
                )}
              </field.Control>
            )}
          </grantForm.AppField>
          <grantForm.AppField name="endsAt">
            {(field) => (
              <field.Control label="Vigente hasta">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    className="w-56"
                    value={field.state.value}
                    min={startsAt}
                    emptyLabel="Sin fecha final"
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            )}
          </grantForm.AppField>
          <grantForm.AppField name="evidenceDocumentId">
            {(field) => (
              <field.SelectField
                label="Documento de respaldo"
                options={[
                  { value: "", label: "Sin documento" },
                  ...evidence.map((document) => ({ value: document.id, label: document.label })),
                ]}
              />
            )}
          </grantForm.AppField>
          <grantForm.AppField name="notes">
            {(field) => <field.TextareaField label="Notas" maxLength={MAX_TEXT} />}
          </grantForm.AppField>
        </div>
      </FormDrawer>

      <FormDrawer
        {...revokeSurface}
        dock={false}
        open={revoking != null}
        title="Revocar responsabilidad"
        description="El rol deja de estar vigente y se conserva en la historia con su motivo."
        submitLabel="Revocar"
        onClose={() => {
          if (!revokeSurface.isSubmitting) setRevoking(null)
        }}
      >
        <revokeForm.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo" maxLength={MAX_TEXT} />}
        </revokeForm.AppField>
      </FormDrawer>
    </div>
  )
}
