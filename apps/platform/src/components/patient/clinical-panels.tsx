/**
 * Paneles clínicos reutilizables del paciente: controles y recetas.
 *
 * Se usan en la ficha (pestañas Controles y Recetas) y dentro del recorrido de
 * un tratamiento, donde quedan acotados por tratamiento y atención. Registrar
 * una receta o un control nunca ejecuta ni cobra nada.
 */
import { Badge, Button, Field, FieldLabel, Input, Textarea, toast } from "@odentia/ui"
import { EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { apiFetch } from "../../lib/api"
import {
  cancelFollowUpApi,
  cancelPrescriptionApi,
  completeFollowUpApi,
  createFollowUpApi,
  createPrescriptionApi,
  FOLLOW_UP_KIND_LABELS,
  FOLLOW_UP_STATUS_LABELS,
  type FollowUp,
  fetchFollowUps,
  fetchPrescriptionDetail,
  fetchPrescriptions,
  formatDate,
  formatDateTime,
  mutationMessage,
  PRESCRIPTION_STATUS_LABELS,
  type Prescription,
  scheduleFollowUpApi,
} from "../../lib/clinical-journey"
import { useCanWrite } from "../../lib/crm"
import type { Encounter, PlanItem } from "../../lib/patients"

const MAX_TITLE = 200
const MAX_TEXT = 2000
const MAX_INSTRUCTIONS = 4000

function statusBadge(status: string): "default" | "secondary" | "success" | "destructive" {
  if (status === "realizado") return "success"
  if (status === "cancelado" || status === "anulada") return "destructive"
  if (status === "programado") return "default"
  return "secondary"
}

function toIso(value: string): string {
  return new Date(value).toISOString()
}

/** Valor para inputs `datetime-local` en hora local del navegador. */
function localInputValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

/** Controles longitudinales del paciente, acotables a un tratamiento o atención. */
export function ControlesPanel({
  patientId,
  itemId,
  encounterId,
  encounterOnly = false,
  allowCreate = true,
  items,
}: {
  patientId: string
  itemId?: string
  encounterId?: string
  /** Muestra solo los controles de esta atención (ficha de la atención). */
  encounterOnly?: boolean
  /** La atención cerrada es inmutable: allí no se indica un control nuevo. */
  allowCreate?: boolean
  /** Indicaciones del paciente para elegir el tratamiento del control. */
  items?: PlanItem[]
}): React.JSX.Element {
  const uid = useId()
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
  })
  const sessions = useQuery({
    queryKey: ["encounters", patientId, "finalizada"],
    queryFn: () =>
      apiFetch<{ data: Encounter[] }>(
        `/api/patients/${patientId}/encounters?status=finalizada&limit=50`,
      ),
  })
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["follow-ups", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
  }

  const [kindState, setKind] = useState<"tratamiento" | "mantenimiento">(
    itemId ? "tratamiento" : "mantenimiento",
  )
  const [planItemIdState, setPlanItemId] = useState(itemId ?? "")
  // El tratamiento del recorrido manda siempre: el panel nunca conserva la
  // selección anterior cuando se cambia de tratamiento en la ficha.
  const kind = itemId ? "tratamiento" : kindState
  const planItemId = itemId ?? planItemIdState
  const [title, setTitle] = useState("")
  const [dueAt, setDueAt] = useState(localInputValue(new Date(Date.now() + 86_400_000)))
  const [instructions, setInstructions] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState<FollowUp | null>(null)
  const [scheduledAt, setScheduledAt] = useState(localInputValue(new Date(Date.now() + 86_400_000)))
  const [completing, setCompleting] = useState<FollowUp | null>(null)
  const [completeEncounterId, setCompleteEncounterId] = useState("")
  const [outcome, setOutcome] = useState("")
  const [cancelling, setCancelling] = useState<FollowUp | null>(null)
  const [reason, setReason] = useState("")

  const createMutation = useMutation({
    mutationFn: () =>
      createFollowUpApi(patientId, {
        kind,
        title: title.trim(),
        dueAt: toIso(dueAt),
        instructions: instructions.trim() || null,
        planItemId: kind === "tratamiento" ? planItemId || null : null,
        originEncounterId: encounterId ?? null,
      }),
    onSuccess: () => {
      setTitle("")
      setInstructions("")
      setCreateOpen(false)
      setError(null)
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const scheduleMutation = useMutation({
    mutationFn: () =>
      scheduleFollowUpApi(patientId, scheduling?.id ?? "", { scheduledAt: toIso(scheduledAt) }),
    onSuccess: () => {
      setScheduling(null)
      setError(null)
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const completeMutation = useMutation({
    mutationFn: () =>
      completeFollowUpApi(patientId, completing?.id ?? "", {
        encounterId: completeEncounterId,
        outcome: outcome.trim(),
      }),
    onSuccess: () => {
      setCompleting(null)
      setOutcome("")
      setError(null)
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const cancelMutation = useMutation({
    mutationFn: () => cancelFollowUpApi(patientId, cancelling?.id ?? "", { reason: reason.trim() }),
    onSuccess: () => {
      setCancelling(null)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })

  const rows = (list.data?.data ?? []).filter(
    (row) =>
      (!itemId || row.planItemId === itemId) &&
      (!encounterOnly ||
        encounterId === undefined ||
        row.originEncounterId === encounterId ||
        row.completedEncounterId === encounterId),
  )
  const finalized = sessions.data?.data ?? []
  const planItemLabel = (id: string | null) =>
    id ? ((items ?? []).find((item) => item.id === id)?.title ?? id) : null

  return (
    <div className="flex flex-col gap-4 rounded-md bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Controles</div>
          <p className="text-sm text-muted-foreground">
            Un control programado no equivale a un control realizado: se completa contra una
            atención finalizada y deja su resultado en la historia.
          </p>
        </div>
        {canWrite && allowCreate ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setError(null)
              setCreateOpen(true)
            }}
          >
            Indicar control
          </Button>
        ) : null}
      </div>

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando controles…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudieron cargar los controles.{" "}
          <Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin controles"
          description="Indica el próximo control para no perder el seguimiento del tratamiento o del mantenimiento."
        />
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.title}</span>
                <Badge variant={statusBadge(row.status)}>
                  {FOLLOW_UP_STATUS_LABELS[row.status]}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {FOLLOW_UP_KIND_LABELS[row.kind] ?? row.kind} · previsto{" "}
                  {formatDateTime(row.dueAt)}
                  {row.scheduledAt ? ` · cita ${formatDateTime(row.scheduledAt)}` : ""}
                </span>
              </div>
              {planItemLabel(row.planItemId) ? (
                <p className="text-sm text-muted-foreground">
                  Tratamiento: {planItemLabel(row.planItemId)}
                </p>
              ) : null}
              {row.instructions ? <p className="text-sm">{row.instructions}</p> : null}
              {row.outcome ? <p className="text-sm">Resultado: {row.outcome}</p> : null}
              {row.cancelledReason ? (
                <p className="text-sm text-muted-foreground">Cancelado: {row.cancelledReason}</p>
              ) : null}
              {canWrite ? (
                <div className="flex flex-wrap gap-2">
                  {row.status === "pendiente" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setError(null)
                        setScheduling(row)
                      }}
                    >
                      Programar cita
                    </Button>
                  ) : null}
                  {row.status === "pendiente" || row.status === "programado" ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          setError(null)
                          setCompleteEncounterId(finalized[0]?.id ?? "")
                          setCompleting(row)
                        }}
                      >
                        Completar control
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null)
                          setCancelling(row)
                        }}
                      >
                        Cancelar control
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {error && !createOpen && scheduling == null && completing == null && cancelling == null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <FormDrawer
        open={createOpen}
        title="Indicar control"
        description="El control queda ligado al tratamiento o al mantenimiento del paciente."
        error={createOpen ? error : null}
        isSubmitting={createMutation.isPending}
        isDirty={title.trim().length > 0}
        submitLabel="Indicar control"
        onClose={() => {
          if (!createMutation.isPending) setCreateOpen(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (kind === "tratamiento" && !planItemId) {
            setError("Elige el tratamiento que sigue este control.")
            return
          }
          if (!title.trim()) {
            setError("Indica el título del control.")
            return
          }
          createMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          {itemId ? (
            <p className="text-sm text-muted-foreground">
              Tratamiento: {planItemLabel(itemId) ?? "el tratamiento abierto"}
            </p>
          ) : null}
          {itemId ? null : (
            <Field>
              <FieldLabel htmlFor={`${uid}-kind`}>Tipo de control</FieldLabel>
              <select
                id={`${uid}-kind`}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={kind}
                onChange={(event) => {
                  const next = event.target.value as "tratamiento" | "mantenimiento"
                  setKind(next)
                  if (next === "mantenimiento") setPlanItemId("")
                }}
              >
                <option value="mantenimiento">Mantenimiento</option>
                <option value="tratamiento">Seguimiento de un tratamiento</option>
              </select>
            </Field>
          )}
          {kind === "tratamiento" ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-item`}>Tratamiento</FieldLabel>
              <select
                id={`${uid}-item`}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={planItemId}
                onChange={(event) => setPlanItemId(event.target.value)}
              >
                <option value="">Seleccionar tratamiento</option>
                {(items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field>
            <FieldLabel htmlFor={`${uid}-title`}>Título del control</FieldLabel>
            <Input
              id={`${uid}-title`}
              maxLength={MAX_TITLE}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-due`}>Fecha prevista</FieldLabel>
            <Input
              id={`${uid}-due`}
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-instructions`}>Indicaciones del control</FieldLabel>
            <Textarea
              id={`${uid}-instructions`}
              maxLength={MAX_INSTRUCTIONS}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={scheduling != null}
        title="Programar cita del control"
        description="La cita no marca el control como realizado: eso ocurre al completarlo."
        error={scheduling != null ? error : null}
        isSubmitting={scheduleMutation.isPending}
        submitLabel="Programar"
        onClose={() => {
          if (!scheduleMutation.isPending) setScheduling(null)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          scheduleMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-scheduled-at`}>Fecha de cita</FieldLabel>
          <Input
            id={`${uid}-scheduled-at`}
            type="datetime-local"
            value={scheduledAt}
            onChange={(event) => setScheduledAt(event.target.value)}
          />
        </Field>
      </FormDrawer>

      <FormDrawer
        open={completing != null}
        title="Completar control"
        description="Se registra el resultado contra una atención finalizada del paciente."
        error={completing != null ? error : null}
        isSubmitting={completeMutation.isPending}
        submitLabel="Completar"
        onClose={() => {
          if (!completeMutation.isPending) setCompleting(null)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!completeEncounterId) {
            setError("Elige la atención finalizada donde se atendió el control.")
            return
          }
          if (!outcome.trim()) {
            setError("Registra el resultado del control.")
            return
          }
          completeMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-complete-encounter`}>Atención finalizada</FieldLabel>
            <select
              id={`${uid}-complete-encounter`}
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={completeEncounterId}
              onChange={(event) => setCompleteEncounterId(event.target.value)}
            >
              <option value="">Seleccionar atención</option>
              {finalized.map((encounter) => (
                <option key={encounter.id} value={encounter.id}>
                  {formatDateTime(encounter.createdAt)} · {encounter.reason || "Atención"}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-outcome`}>Resultado del control</FieldLabel>
            <Textarea
              id={`${uid}-outcome`}
              maxLength={MAX_TEXT}
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={cancelling != null}
        title="Cancelar control"
        description="El control se conserva en la historia con su motivo de cancelación."
        error={cancelling != null ? error : null}
        isSubmitting={cancelMutation.isPending}
        submitLabel="Cancelar control"
        onClose={() => {
          if (!cancelMutation.isPending) setCancelling(null)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la cancelación.")
            return
          }
          cancelMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-cancel-reason`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-cancel-reason`}
            maxLength={MAX_TEXT}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </div>
  )
}

function PrescriptionEntry({
  patientId,
  prescription,
  items,
}: {
  patientId: string
  prescription: Prescription
  items?: PlanItem[]
}): React.JSX.Element {
  const uid = useId()
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ["prescription", patientId, prescription.id],
    queryFn: () => fetchPrescriptionDetail(patientId, prescription.id),
  })
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const cancelMutation = useMutation({
    mutationFn: () => cancelPrescriptionApi(patientId, prescription.id, { reason: reason.trim() }),
    onSuccess: () => {
      setCancelling(false)
      setReason("")
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["prescriptions", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const rows = detail.data?.data.items ?? prescription.items ?? []
  const planItem = items?.find((item) => item.id === prescription.planItemId) ?? null
  return (
    <details className="rounded-md border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Receta N.º {prescription.prescriptionNumber} ·{" "}
        {PRESCRIPTION_STATUS_LABELS[prescription.status] ?? prescription.status} ·{" "}
        {formatDate(prescription.issuedAt)}
      </summary>
      <div className="flex flex-col gap-3 pt-4">
        {planItem ? (
          <p className="text-sm text-muted-foreground">Tratamiento: {planItem.title}</p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin medicamentos registrados.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {rows.map((item) => (
              <li key={item.id}>
                {item.medicationName} · {item.dose} · {item.route} · {item.frequency} ·{" "}
                {item.duration}
                {item.instructions ? ` · ${item.instructions}` : ""}
              </li>
            ))}
          </ul>
        )}
        {prescription.notes ? <p className="text-sm">{prescription.notes}</p> : null}
        {prescription.cancelReason ? (
          <p className="text-sm text-muted-foreground">Anulada: {prescription.cancelReason}</p>
        ) : null}
        {error && !cancelling ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {canWrite && prescription.status === "emitida" ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null)
                setCancelling(true)
              }}
            >
              Anular receta
            </Button>
          </div>
        ) : null}
      </div>
      <FormDrawer
        open={cancelling}
        title="Anular receta"
        description="La receta conserva su contenido original y el motivo de anulación."
        error={cancelling ? error : null}
        isSubmitting={cancelMutation.isPending}
        submitLabel="Anular receta"
        onClose={() => {
          if (!cancelMutation.isPending) setCancelling(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          cancelMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-rx-cancel`}>Motivo de anulación</FieldLabel>
          <Textarea
            id={`${uid}-rx-cancel`}
            maxLength={MAX_TEXT}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>
    </details>
  )
}

interface MedicationDraft {
  key: string
  medicationName: string
  dose: string
  route: string
  frequency: string
  duration: string
  instructions: string
}

function emptyMedication(): MedicationDraft {
  return {
    key: crypto.randomUUID(),
    medicationName: "",
    dose: "",
    route: "Oral",
    frequency: "",
    duration: "",
    instructions: "",
  }
}

/** Recetas del paciente, acotables a un tratamiento. Emitir nunca cobra ni ejecuta. */
export function RecetasPanel({
  patientId,
  itemId,
  encounterId,
  encounterOnly = false,
  allowCreate = true,
  items,
}: {
  patientId: string
  itemId?: string
  encounterId?: string
  /** Muestra solo las recetas emitidas en esta atención (ficha de la atención). */
  encounterOnly?: boolean
  /** La atención cerrada es inmutable: allí no se emite una receta nueva. */
  allowCreate?: boolean
  items?: PlanItem[]
}): React.JSX.Element {
  const uid = useId()
  const canWrite = useCanWrite()
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
  })
  const [planItemIdState, setPlanItemId] = useState(itemId ?? "")
  // Igual que en controles: desde el recorrido el tratamiento es el del
  // recorrido abierto y no una selección previa de otra pantalla.
  const planItemId = itemId ?? planItemIdState
  const [notes, setNotes] = useState("")
  const [medications, setMedications] = useState<MedicationDraft[]>([emptyMedication()])
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createMutation = useMutation({
    mutationFn: () =>
      createPrescriptionApi(patientId, {
        encounterId: encounterId ?? null,
        planItemId: planItemId || null,
        notes: notes.trim() || null,
        items: medications.map((medication) => ({
          medicationName: medication.medicationName.trim(),
          dose: medication.dose.trim(),
          route: medication.route.trim(),
          frequency: medication.frequency.trim(),
          duration: medication.duration.trim(),
          instructions: medication.instructions.trim() || null,
        })),
      }),
    onSuccess: () => {
      setMedications([emptyMedication()])
      setNotes("")
      setCreateOpen(false)
      setError(null)
      toast.success("Receta emitida.")
      void queryClient.invalidateQueries({ queryKey: ["prescriptions", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })

  const rows = (list.data?.data ?? []).filter(
    (row) =>
      (!itemId || row.planItemId === itemId) &&
      (!encounterOnly || encounterId === undefined || row.encounterId === encounterId),
  )
  const patchMedication = (index: number, patch: Partial<MedicationDraft>) =>
    setMedications((current) =>
      current.map((medication, position) =>
        position === index ? { ...medication, ...patch } : medication,
      ),
    )

  return (
    <div className="flex flex-col gap-4 rounded-md bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Recetas</div>
          <p className="text-sm text-muted-foreground">
            La receta queda ligada al tratamiento y a la atención donde se emitió; se corrige
            anulándola con motivo.
          </p>
        </div>
        {canWrite && allowCreate ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setError(null)
              setCreateOpen(true)
            }}
          >
            Emitir receta
          </Button>
        ) : null}
      </div>

      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando recetas…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudieron cargar las recetas.{" "}
          <Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Sin recetas"
          description="Emite una receta cuando el tratamiento lo requiera; quedará enlazada a esta historia."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((prescription) => (
            <PrescriptionEntry
              key={prescription.id}
              patientId={patientId}
              prescription={prescription}
              items={items}
            />
          ))}
        </div>
      )}

      <FormDrawer
        open={createOpen}
        title="Emitir receta"
        description="La receta queda inmutable: para corregirla se anula con motivo."
        error={createOpen ? error : null}
        isSubmitting={createMutation.isPending}
        submitLabel="Emitir receta"
        className="sm:[--drawer-content-width:min(46rem,calc(100vw-2rem))]"
        onClose={() => {
          if (!createMutation.isPending) setCreateOpen(false)
        }}
        onSubmit={(event) => {
          event.preventDefault()
          const incomplete = medications.some(
            (medication) =>
              !medication.medicationName.trim() ||
              !medication.dose.trim() ||
              !medication.route.trim() ||
              !medication.frequency.trim() ||
              !medication.duration.trim(),
          )
          if (incomplete) {
            setError("Completa medicamento, dosis, vía, frecuencia y duración.")
            return
          }
          createMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          {itemId ? (
            <p className="text-sm text-muted-foreground">
              Tratamiento:{" "}
              {(items ?? []).find((item) => item.id === itemId)?.title ?? "el tratamiento abierto"}
            </p>
          ) : null}
          {itemId ? null : (
            <Field>
              <FieldLabel htmlFor={`${uid}-rx-item`}>Tratamiento</FieldLabel>
              <select
                id={`${uid}-rx-item`}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={planItemId}
                onChange={(event) => setPlanItemId(event.target.value)}
              >
                <option value="">Sin tratamiento asociado</option>
                {(items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {medications.map((medication, index) => (
            <fieldset
              key={medication.key}
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
            >
              <legend className="px-1 text-sm font-medium">Medicamento {index + 1}</legend>
              <Field>
                <FieldLabel htmlFor={`${uid}-med-${medication.key}`}>Medicamento</FieldLabel>
                <Input
                  id={`${uid}-med-${medication.key}`}
                  maxLength={MAX_TITLE}
                  value={medication.medicationName}
                  onChange={(event) =>
                    patchMedication(index, { medicationName: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-dose-${medication.key}`}>Dosis</FieldLabel>
                <Input
                  id={`${uid}-dose-${medication.key}`}
                  maxLength={MAX_TITLE}
                  value={medication.dose}
                  onChange={(event) => patchMedication(index, { dose: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-route-${medication.key}`}>Vía</FieldLabel>
                <Input
                  id={`${uid}-route-${medication.key}`}
                  maxLength={MAX_TITLE}
                  value={medication.route}
                  onChange={(event) => patchMedication(index, { route: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-frequency-${medication.key}`}>Frecuencia</FieldLabel>
                <Input
                  id={`${uid}-frequency-${medication.key}`}
                  maxLength={MAX_TITLE}
                  value={medication.frequency}
                  onChange={(event) => patchMedication(index, { frequency: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-duration-${medication.key}`}>Duración</FieldLabel>
                <Input
                  id={`${uid}-duration-${medication.key}`}
                  maxLength={MAX_TITLE}
                  value={medication.duration}
                  onChange={(event) => patchMedication(index, { duration: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-med-notes-${medication.key}`}>
                  Instrucciones
                </FieldLabel>
                <Input
                  id={`${uid}-med-notes-${medication.key}`}
                  maxLength={MAX_INSTRUCTIONS}
                  value={medication.instructions}
                  onChange={(event) => patchMedication(index, { instructions: event.target.value })}
                />
              </Field>
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={medications.length >= 20}
              onClick={() => setMedications((current) => [...current, emptyMedication()])}
            >
              Añadir medicamento
            </Button>
            {medications.length > 1 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMedications((current) => current.slice(0, -1))}
              >
                Quitar el último
              </Button>
            ) : null}
          </div>
          <Field>
            <FieldLabel htmlFor={`${uid}-rx-notes`}>Notas de la receta</FieldLabel>
            <Textarea
              id={`${uid}-rx-notes`}
              maxLength={MAX_INSTRUCTIONS}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>
    </div>
  )
}
