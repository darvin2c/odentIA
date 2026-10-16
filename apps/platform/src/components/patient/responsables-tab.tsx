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

import { Badge, Button, Field, FieldLabel, Textarea } from "@odentia/ui"
import { DatePickerButton, EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { apiFetch } from "../../lib/api"
import {
  fetchResponsibilities,
  formatDate,
  grantResponsibilityApi,
  mutationMessage,
  RESPONSIBILITY_KIND_LABELS,
  RESPONSIBILITY_KINDS,
  type ResponsibilityKind,
  revokeResponsibilityApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { ageFrom, type PatientDocument, type PatientFull } from "../../lib/patients"
import { type PickedPerson, PersonPicker } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"

const MAX_TEXT = 2000

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function ResponsablesTab({ patientId }: { patientId: string }): React.JSX.Element {
  const uid = useId()
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
  const [chosen, setChosen] = useState<PickedPerson | null>(null)
  const [kind, setKind] = useState<ResponsibilityKind>("representante_legal")
  const [startsAt, setStartsAt] = useState(todayIso())
  const [endsAt, setEndsAt] = useState("")
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("")
  const [notes, setNotes] = useState("")
  const [revoking, setRevoking] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["responsibilities", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
  }

  const grantMutation = useMutation({
    mutationFn: async () => {
      const contactId = chosen?.id ?? ""
      // Quien aún no está vinculado al paciente se vincula en el mismo paso.
      if (!contacts.some((link) => link.contactId === contactId)) {
        const age = Number(ageFrom(patient.data?.data.patient.birthDate ?? null))
        await apiFetch(`/api/patients/${patientId}/contacts/${contactId}`, {
          method: "PUT",
          body: JSON.stringify({
            relationship: Number.isFinite(age) && age < 18 ? "guardian" : "family",
            isPreferred: false,
          }),
        })
        void queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
        void queryClient.invalidateQueries({ queryKey: ["person"] })
      }
      return grantResponsibilityApi(patientId, {
        contactId,
        kind,
        startsAt,
        endsAt: endsAt || null,
        evidenceDocumentId: evidenceDocumentId || null,
        notes: notes.trim() || null,
      })
    },
    onSuccess: () => {
      setGrantOpen(false)
      setNotes("")
      setError(null)
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const revokeMutation = useMutation({
    mutationFn: () => revokeResponsibilityApi(patientId, revoking ?? "", { reason: reason.trim() }),
    onSuccess: () => {
      setRevoking(null)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })

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
              setError(null)
              const first = contacts.find((link) => link.relationship !== "self")
              setChosen(first ? { id: first.contactId, name: first.displayName } : null)
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
                      setError(null)
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

      {error && !grantOpen && revoking == null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <FormDrawer
        open={grantOpen}
        title="Asignar responsabilidad"
        description="La responsabilidad queda vigente desde la fecha indicada y solo puede sustituirse revocándola antes."
        error={grantOpen ? error : null}
        isSubmitting={grantMutation.isPending}
        submitLabel="Asignar"
        onClose={() => {
          if (!grantMutation.isPending) setGrantOpen(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!chosen) {
            setError("Elige a la persona.")
            return
          }
          if (endsAt && endsAt < startsAt) {
            setError("La fecha final no puede preceder a la inicial.")
            return
          }
          grantMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <PersonPicker
            label="Persona"
            value={chosen}
            onChange={setChosen}
            excludeId={contacts.find((link) => link.relationship === "self")?.contactId}
            description="Si aún no está vinculada al paciente, se vincula al asignarle el rol."
          />
          <Field>
            <FieldLabel htmlFor={`${uid}-resp-kind`}>Responsabilidad</FieldLabel>
            <ChoiceSelect
              id={`${uid}-resp-kind`}
              className="w-full"
              value={kind}
              onChange={(event) => setKind(event.target.value as ResponsibilityKind)}
            >
              {RESPONSIBILITY_KINDS.map((value) => (
                <option key={value} value={value}>
                  {RESPONSIBILITY_KIND_LABELS[value]}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-resp-start`}>Vigente desde</FieldLabel>
            <DatePickerButton
              id={`${uid}-resp-start`}
              className="w-56"
              value={startsAt}
              onChange={(next) => {
                setStartsAt(next)
                if (endsAt && endsAt < next) setEndsAt(next)
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-resp-end`}>Vigente hasta</FieldLabel>
            <DatePickerButton
              id={`${uid}-resp-end`}
              className="w-56"
              value={endsAt}
              min={startsAt}
              emptyLabel="Sin fecha final"
              onChange={setEndsAt}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-resp-evidence`}>Documento de respaldo</FieldLabel>
            <ChoiceSelect
              id={`${uid}-resp-evidence`}
              className="w-full"
              value={evidenceDocumentId}
              onChange={(event) => setEvidenceDocumentId(event.target.value)}
            >
              <option value="">Sin documento</option>
              {evidence.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.label}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-resp-notes`}>Notas</FieldLabel>
            <Textarea
              id={`${uid}-resp-notes`}
              maxLength={MAX_TEXT}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        dock={false}
        open={revoking != null}
        title="Revocar responsabilidad"
        description="El rol deja de estar vigente y se conserva en la historia con su motivo."
        error={revoking != null ? error : null}
        isSubmitting={revokeMutation.isPending}
        submitLabel="Revocar"
        onClose={() => {
          if (!revokeMutation.isPending) setRevoking(null)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la revocación.")
            return
          }
          revokeMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-resp-reason`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-resp-reason`}
            maxLength={MAX_TEXT}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}
