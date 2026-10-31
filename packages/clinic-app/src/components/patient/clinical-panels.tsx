/**
 * Paneles clínicos reutilizables del paciente: controles y recetas.
 *
 * Se usan en la ficha (pestañas Controles y Recetas) y dentro del recorrido de
 * un tratamiento, donde quedan acotados por tratamiento y atención. Registrar
 * una receta o un control nunca ejecuta ni cobra nada.
 */

import {
  ADMINISTRATION_ROUTES,
  allergyWarnings,
  DOSAGE_FORMS,
  FOLLOW_UP_REPEAT_MONTHS,
  followUpRepeatWords,
} from "@odentia/clinical"
import { Badge, Button, buttonVariants, Field, FieldDescription, FieldLabel, Input, Textarea, toast } from "@odentia/ui"
import { addDays, DatePickerButton, EmptyState, FormDrawer, regionToday, SkeletonRegion } from "@odentia/ui-patterns"
import { ControlRowsSkeleton } from "../skeletons/person-sections"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useId, useState } from "react"
import { invalidateAppointmentQueries } from "../../lib/agenda"
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
  followUpAppointmentLabel,
  formatDate,
  formatDateTime,
  instantFromClinicValue,
  mutationMessage,
  PRESCRIPTION_STATUS_LABELS,
  type Prescription,
  stopFollowUpRepeatApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { type Encounter, fetchPatientHealth, type PlanItem } from "../../lib/patients"
import { ChoiceSelect } from "../ui/choice-select"
import { DiagnosisSearch } from "./diagnosis-search"
import { FollowUpScheduler } from "./follow-up-scheduler"
import { HealthDocumentSendDrawer } from "./health-document-send"
import { productUi } from "../../product/product-ui"
import { openAppointmentAnywhere } from "../agenda/schedule-host"

const MAX_TITLE = 200
const MAX_TEXT = 2000
const MAX_INSTRUCTIONS = 4000
/** Un control previsto vence a las 9:00 de la clínica del día elegido (la hora la pone su cita). */
const CONTROL_HOUR = "09:00"

function statusBadge(status: string): "default" | "secondary" | "success" | "destructive" {
  if (status === "realizado") return "success"
  if (status === "cancelado" || status === "anulada") return "destructive"
  if (status === "programado") return "default"
  return "secondary"
}


/** Controles longitudinales del paciente, acotables a un tratamiento o atención. */
export function ControlesPanel({
  patientId,
  itemId,
  encounterId,
  encounterOnly = false,
  allowCreate = true,
  items,
  heading = "Controles",
}: {
  patientId: string
  itemId?: string
  encounterId?: string
  /** «Próximo control» dentro de la atención; «Controles» en el Plan. */
  heading?: string
  /** Muestra solo los controles de esta atención (ficha de la atención). */
  encounterOnly?: boolean
  /** La atención cerrada es inmutable: allí no se indica un control nuevo. */
  allowCreate?: boolean
  /** Indicaciones del paciente para elegir el tratamiento del control. */
  items?: PlanItem[]
}): React.JSX.Element {
  const uid = useId()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const canSchedule = usePermission("appointments.write")
  const canReadAgenda = usePermission("appointments.read")
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["follow-ups", patientId],
    queryFn: () => fetchFollowUps(patientId),
    enabled: canRead,
  })
  const sessions = useQuery({
    queryKey: ["encounters", patientId, "finalizada"],
    queryFn: () =>
      apiFetch<{ data: Encounter[] }>(
        `/api/patients/${patientId}/encounters?status=finalizada&limit=50`,
      ),
    enabled: canRead,
  })
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["follow-ups", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    // «Qué sigue» nombra el próximo control: cambia con él.
    void queryClient.invalidateQueries({ queryKey: ["plan-next", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
    void invalidateAppointmentQueries(queryClient)
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
  // El día previsto se elige en la zona de la clínica, no en la del navegador:
  // un control es para un día, no para una hora (la hora la pone la cita).
  const [dueDay, setDueDay] = useState(() => addDays(regionToday(), 1))
  const [instructions, setInstructions] = useState("")
  // Controles que se repiten (latidIA, decisión 16 del issue 229): "" es una sola vez.
  const repeats = productUi().plan.repeatingControls
  const [repeat, setRepeat] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState<FollowUp | null>(null)
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
        dueAt: instantFromClinicValue(`${dueDay}T${CONTROL_HOUR}`) ?? "",
        instructions: instructions.trim() || null,
        planItemId: kind === "tratamiento" ? planItemId || null : null,
        originEncounterId: encounterId ?? null,
        repeatEveryMonths: repeats && repeat ? Number(repeat) : null,
      }),
    onSuccess: () => {
      setTitle("")
      setInstructions("")
      setRepeat("")
      setCreateOpen(false)
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
  const stopRepeatMutation = useMutation({
    mutationFn: (followUpId: string) => stopFollowUpRepeatApi(patientId, followUpId),
    onSuccess: () => {
      toast.success("Ya no se repite: al completarlo no queda indicado otro.")
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

  if (!canRead)
    return (
      <p className="text-sm text-muted-foreground">
        No tienes permiso para ver información clínica.
      </p>
    )

  return (
    <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-heading text-base font-medium">{heading}</h3>
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
        <SkeletonRegion message="Cargando controles…">
          <ControlRowsSkeleton />
        </SkeletonRegion>
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
                  {formatDate(row.dueAt)}
                  {row.legacyScheduledAt && !row.appointment
                    ? ` · fecha histórica ${formatDateTime(row.legacyScheduledAt)}`
                    : ""}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{followUpAppointmentLabel(row)}</p>
              {row.repeatEveryMonths && (row.status === "pendiente" || row.status === "programado") ? (
                <p className="text-sm text-muted-foreground">
                  Se repite {followUpRepeatWords(row.repeatEveryMonths)}: al completarlo queda indicado el siguiente.
                </p>
              ) : null}
              {row.appointment &&
              (row.appointment.status === "programada" ||
                row.appointment.status === "confirmada") &&
              row.status === "cancelado" ? (
                <p className="text-sm">
                  Cancelar el control no cancela la cita: la reserva sigue vigente.
                </p>
              ) : null}
              {row.appointment && canReadAgenda ? (
                // La cita se abre al lado, sin salir de la ficha.
                <Button
                  type="button"
                  variant="link"
                  className="h-auto w-fit p-0 text-sm"
                  onClick={() => row.appointment && openAppointmentAnywhere(row.appointment.id)}
                >
                  Ver cita
                </Button>
              ) : null}
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
                  {row.status === "pendiente" &&
                  row.appointment?.status !== "atendida" &&
                  canSchedule ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => {
                        setError(null)
                        setScheduling(row)
                      }}
                    >
                      Reservar cita
                    </Button>
                  ) : null}
                  {row.status === "pendiente" || row.status === "programado" ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null)
                          setCompleteEncounterId(finalized[0]?.id ?? "")
                          setCompleting(row)
                        }}
                      >
                        Completar control
                      </Button>
                      {row.repeatEveryMonths ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={stopRepeatMutation.isPending}
                          onClick={() => {
                            setError(null)
                            stopRepeatMutation.mutate(row.id)
                          }}
                        >
                          Dejar de repetir
                        </Button>
                      ) : null}
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
              {canWrite &&
              !canSchedule &&
              row.status === "pendiente" &&
              row.appointment?.status !== "atendida" ? (
                <p className="text-sm text-muted-foreground">
                  Para reservar el control necesitas también permiso de escritura en agenda.
                </p>
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
          if (!dueDay) {
            setError("Indica la fecha prevista del control.")
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
              <ChoiceSelect
                id={`${uid}-kind`}
                
                value={kind}
                onChange={(event) => {
                  const next = event.target.value as "tratamiento" | "mantenimiento"
                  setKind(next)
                  if (next === "mantenimiento") setPlanItemId("")
                }}
              >
                <option value="mantenimiento">Mantenimiento</option>
                <option value="tratamiento">Seguimiento de un tratamiento</option>
              </ChoiceSelect>
            </Field>
          )}
          {kind === "tratamiento" ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-item`}>Tratamiento</FieldLabel>
              <ChoiceSelect
                id={`${uid}-item`}
                
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
              </ChoiceSelect>
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
            <DatePickerButton
              id={`${uid}-due`}
              className="w-56"
              min={regionToday()}
              value={dueDay}
              onChange={setDueDay}
            />
          </Field>
          {repeats ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-repeat`}>Se repite</FieldLabel>
              <ChoiceSelect
                id={`${uid}-repeat`}
                value={repeat}
                onChange={(event) => setRepeat(event.target.value)}
              >
                <option value="">Una sola vez</option>
                {FOLLOW_UP_REPEAT_MONTHS.map((months) => (
                  <option key={months} value={String(months)}>
                    {followUpRepeatWords(months).replace(/^c/, "C")}
                  </option>
                ))}
              </ChoiceSelect>
              <FieldDescription>
                Al completarlo queda indicado el siguiente, hasta que lo detengas.
              </FieldDescription>
            </Field>
          ) : null}
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

      {scheduling && canWrite && canSchedule ? (
        <FollowUpScheduler
          key={`${patientId}:${scheduling.id}`}
          patientId={patientId}
          control={rows.find((row) => row.id === scheduling.id) ?? scheduling}
          onClose={() => setScheduling(null)}
        />
      ) : null}

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
            <ChoiceSelect
              id={`${uid}-complete-encounter`}
              
              value={completeEncounterId}
              onChange={(event) => setCompleteEncounterId(event.target.value)}
            >
              <option value="">Seleccionar atención</option>
              {finalized.map((encounter) => (
                <option key={encounter.id} value={encounter.id}>
                  {formatDateTime(encounter.createdAt)} · {encounter.reason || "Atención"}
                </option>
              ))}
            </ChoiceSelect>
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
        dock={false}
        open={cancelling != null}
        title="Cancelar control"
        description="El control se conserva con su motivo. Cancelar el control NO cancela la cita: cualquier reserva vigente permanece en agenda."
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
        {cancelling?.appointment && canReadAgenda ? (
          <p className="mb-4 text-sm">
            {followUpAppointmentLabel(cancelling)}.{" "}
            <Link
              to="/agenda"
              search={{ appointmentId: cancelling.appointment.id }}
              className="underline"
            >
              Ver reserva en agenda
            </Link>
          </p>
        ) : null}
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

export function PrescriptionEntry({
  patientId,
  prescription,
  items,
  defaultOpen = false,
}: {
  patientId: string
  prescription: Prescription
  items?: PlanItem[]
  /** Abierta al mostrarse sola (Documentos la abre al lado). */
  defaultOpen?: boolean
}): React.JSX.Element {
  const uid = useId()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ["prescription", patientId, prescription.id],
    queryFn: () => fetchPrescriptionDetail(patientId, prescription.id),
    enabled: canRead,
  })
  const [cancelling, setCancelling] = useState(false)
  const [sending, setSending] = useState(false)
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
    <details className="rounded-md border p-4" open={defaultOpen}>
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
                {item.medicationName}
                {item.brandName ? ` (${item.brandName})` : ""} · {item.dose} · vía {item.route} ·{" "}
                {item.frequency} · {item.duration}
                {item.quantity ? ` · cantidad ${item.quantity}` : ""}
                {item.instructions ? ` · ${item.instructions}` : ""}
              </li>
            ))}
          </ul>
        )}
        {prescription.notes ? <p className="text-sm">{prescription.notes}</p> : null}
        {prescription.allergyOverrideReason ? (
          <p className="text-sm text-muted-foreground">
            Recetada pese al aviso de alergia: {prescription.allergyOverrideReason}
          </p>
        ) : null}
        {prescription.cancelReason ? (
          <p className="text-sm text-muted-foreground">Anulada: {prescription.cancelReason}</p>
        ) : null}
        {error && !cancelling ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {prescription.prescriberName ? (
          <p className="text-xs text-muted-foreground">
            Prescribe {prescription.prescriberName}
            {prescription.prescriberRegistration ? ` · ${prescription.prescriberRegistration}` : ""}
            {prescription.validUntil
              ? ` · válida hasta ${formatDate(prescription.validUntil)}`
              : ""}
          </p>
        ) : null}
        {prescription.status === "emitida" ? (
          <div className="flex flex-wrap gap-2">
            <Link
              to="/patients/$patientId/prescriptions/$prescriptionId/print"
              params={{ patientId, prescriptionId: prescription.id }}
              target="_blank"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Imprimir
            </Link>
            {canWrite ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setSending(true)}>
                Enviar a la persona
              </Button>
            ) : null}
          </div>
        ) : null}
        {sending ? (
          <HealthDocumentSendDrawer
            open
            patientId={patientId}
            documentType="prescription"
            documentId={prescription.id}
            onClose={() => setSending(false)}
          />
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
        dock={false}
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
  genericName: string
  brandName: string
  strength: string
  dosageForm: string
  dose: string
  route: string
  frequency: string
  duration: string
  quantity: string
  instructions: string
}

function emptyMedication(): MedicationDraft {
  return {
    key: crypto.randomUUID(),
    genericName: "",
    brandName: "",
    strength: "",
    dosageForm: "",
    dose: "",
    route: "oral",
    frequency: "",
    duration: "",
    quantity: "",
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
  drawerOnly = false,
  createOpen: createOpenProp,
  onCreateOpenChange,
  defaultDiagnosisCode,
  defaultDiagnosisSystem,
  initialMedications,
  startOverriding = false,
  onIssued,
}: {
  patientId: string
  itemId?: string
  encounterId?: string
  /** Muestra solo las recetas emitidas en esta atención (ficha de la atención). */
  encounterOnly?: boolean
  /** La atención cerrada es inmutable: allí no se emite una receta nueva. */
  allowCreate?: boolean
  items?: PlanItem[]
  /**
   * Desde el bloque Documentos de la atención: solo el formulario de emitir,
   * abierto desde fuera (`createOpen`) y sin la lista, que el bloque ya muestra.
   */
  drawerOnly?: boolean
  createOpen?: boolean
  onCreateOpenChange?: (open: boolean) => void
  /** El diagnóstico de la atención, ya puesto. */
  defaultDiagnosisCode?: string
  /** Lista del código propuesto (el de la atención conserva la suya). */
  defaultDiagnosisSystem?: string
  /** La receta dictada, ya puesta, para completarla o resolver su aviso (issue 109, fase 2). */
  initialMedications?: Array<Partial<Omit<MedicationDraft, "key">>>
  /** Se abre con «Recetar igual, con motivo» ya elegido. */
  startOverriding?: boolean
  /** La receta quedó emitida. */
  onIssued?: (prescriptionId: string) => void
}): React.JSX.Element {
  const uid = useId()
  const canWrite = usePermission("clinical.write")
  const canRead = usePermission("clinical.read")
  const queryClient = useQueryClient()
  const list = useQuery({
    queryKey: ["prescriptions", patientId],
    queryFn: () => fetchPrescriptions(patientId),
    enabled: canRead,
  })
  const [planItemIdState, setPlanItemId] = useState(itemId ?? "")
  // Igual que en controles: desde el recorrido el tratamiento es el del
  // recorrido abierto y no una selección previa de otra pantalla.
  const planItemId = itemId ?? planItemIdState
  const [notes, setNotes] = useState("")
  const [diagnosisCode, setDiagnosisCode] = useState(defaultDiagnosisCode ?? "")
  const [diagnosisSystem, setDiagnosisSystem] = useState<string | null>(defaultDiagnosisSystem ?? null)
  const [validUntil, setValidUntil] = useState("")
  // Recetar igual pese al aviso pide un motivo escrito, que queda en la receta (decisión 10).
  const [overriding, setOverriding] = useState(startOverriding)
  const [overrideReason, setOverrideReason] = useState("")
  const [createOpenState, setCreateOpenState] = useState(false)
  const createOpen = createOpenProp ?? createOpenState
  const setCreateOpen = (open: boolean) => {
    setCreateOpenState(open)
    onCreateOpenChange?.(open)
  }
  // La lista y las reglas de la receta son las del producto (latidIA: controlados, embarazo, peso; issue 229).
  const prescribing = productUi().prescribing
  const rules = prescribing.useRules(patientId, canRead && createOpen)
  const [weight, setWeight] = useState("")
  const [medications, setMedications] = useState<MedicationDraft[]>(() =>
    initialMedications?.length ? initialMedications.map((medication) => ({ ...emptyMedication(), ...medication })) : [emptyMedication()],
  )
  // Alergias activas, también las declaradas sin confirmar: el aviso aparece al
  // escribir la DCI, antes de emitir, con la misma regla que el servidor.
  const healthQuery = useQuery({
    queryKey: ["patient-health", patientId],
    queryFn: () => fetchPatientHealth(patientId),
    enabled: canRead && createOpen,
  })
  const activeAllergies = (healthQuery.data?.data.allergies ?? []).filter(
    (allergy) => allergy.isActive,
  )
  const conflictsByMedication = medications.map((medication) =>
    allergyWarnings(medication.genericName, activeAllergies, prescribing.catalog),
  )
  const weightKg = weight.trim() ? Number(weight.replace(",", ".")) : null
  const ruleCheck = rules.check(medications, weightKg !== null && Number.isFinite(weightKg) ? weightKg : null)
  // Lo contraindicado en el embarazo va como una alergia: se cambia o se receta con motivo.
  const conflicts = [...conflictsByMedication.flat(), ...ruleCheck.warnings]
  const onlyAllergies = ruleCheck.warnings.length === 0
  // El peso del último registro se propone una vez; quien receta lo corrige.
  useEffect(() => {
    if (rules.weight.required && rules.weight.suggested !== null && weight === "")
      setWeight(String(rules.weight.suggested))
  }, [rules.weight.required, rules.weight.suggested, weight])
  const acknowledged = overriding && overrideReason.trim() !== ""
  const [error, setError] = useState<string | null>(null)
  const createMutation = useMutation({
    mutationFn: () =>
      createPrescriptionApi(patientId, {
        encounterId: encounterId ?? null,
        planItemId: planItemId || null,
        notes: notes.trim() || null,
        diagnosisCode: diagnosisCode || null,
        diagnosisSystem: diagnosisCode ? diagnosisSystem : null,
        validUntil: validUntil || null,
        acknowledgeAllergies: conflicts.length > 0 && acknowledged,
        allergyOverrideReason: conflicts.length > 0 && acknowledged ? overrideReason.trim() : null,
        patientWeightKg: rules.weight.required && weightKg !== null && Number.isFinite(weightKg) ? weightKg : null,
        items: medications.map((medication) => ({
          genericName: medication.genericName.trim(),
          brandName: medication.brandName.trim() || null,
          strength: medication.strength.trim(),
          dosageForm: medication.dosageForm.trim(),
          dose: medication.dose.trim(),
          route: medication.route,
          frequency: medication.frequency.trim(),
          duration: medication.duration.trim(),
          quantity: medication.quantity.trim() ? Number(medication.quantity) : null,
          instructions: medication.instructions.trim() || null,
        })),
      }),
    onSuccess: (result) => {
      onIssued?.(result.data.id)
      setMedications([emptyMedication()])
      setNotes("")
      setDiagnosisCode("")
      setValidUntil("")
      setOverriding(false)
      setOverrideReason("")
      setWeight("")
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

  const submitCreate = (event: React.FormEvent) => {
          event.preventDefault()
          const incomplete = medications.some(
            (medication) =>
              !medication.genericName.trim() ||
              !medication.strength.trim() ||
              !medication.dosageForm.trim() ||
              !medication.dose.trim() ||
              !medication.frequency.trim() ||
              !medication.duration.trim(),
          )
          if (incomplete) {
            setError(
              "Completa DCI, concentración, forma farmacéutica, dosis, frecuencia y duración.",
            )
            return
          }
          if (ruleCheck.errors.length > 0) {
            setError(ruleCheck.errors.join(" "))
            return
          }
          if (conflicts.length > 0 && !acknowledged) {
            setError(
              overriding
                ? "Escribe por qué la recetas igual."
                : onlyAllergies
                  ? "Hay un aviso de alergia: cambia el medicamento o recétalo igual con un motivo."
                  : "Hay un aviso: cambia el medicamento o recétalo igual con un motivo.",
            )
            return
          }
          createMutation.mutate()
  }
  const createBody = (
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
              <ChoiceSelect
                id={`${uid}-rx-item`}
                
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
              </ChoiceSelect>
            </Field>
          )}
          {medications.map((medication, index) => (
            <fieldset
              key={medication.key}
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
            >
              <legend className="px-1 text-sm font-medium">Medicamento {index + 1}</legend>
              <Field>
                <FieldLabel htmlFor={`${uid}-med-${medication.key}`}>
                  DCI (denominación común)
                </FieldLabel>
                <Input
                  id={`${uid}-med-${medication.key}`}
                  list={`${uid}-dci`}
                  maxLength={MAX_TITLE}
                  value={medication.genericName}
                  onChange={(event) => patchMedication(index, { genericName: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-brand-${medication.key}`}>
                  Nombre comercial (opcional)
                </FieldLabel>
                <Input
                  id={`${uid}-brand-${medication.key}`}
                  maxLength={MAX_TITLE}
                  value={medication.brandName}
                  onChange={(event) => patchMedication(index, { brandName: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-strength-${medication.key}`}>Concentración</FieldLabel>
                <Input
                  id={`${uid}-strength-${medication.key}`}
                  maxLength={60}
                  placeholder="Ej.: 500 mg"
                  value={medication.strength}
                  onChange={(event) => patchMedication(index, { strength: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-form-${medication.key}`}>
                  Forma farmacéutica
                </FieldLabel>
                <ChoiceSelect
                  id={`${uid}-form-${medication.key}`}
                  
                  value={medication.dosageForm}
                  onChange={(event) => patchMedication(index, { dosageForm: event.target.value })}
                >
                  <option value="">Elige la forma…</option>
                  {DOSAGE_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {form}
                    </option>
                  ))}
                </ChoiceSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-dose-${medication.key}`}>Dosis</FieldLabel>
                <Input
                  id={`${uid}-dose-${medication.key}`}
                  maxLength={MAX_TITLE}
                  placeholder="Ej.: 1 tableta"
                  value={medication.dose}
                  onChange={(event) => patchMedication(index, { dose: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${uid}-route-${medication.key}`}>Vía</FieldLabel>
                <ChoiceSelect
                  id={`${uid}-route-${medication.key}`}
                  
                  value={medication.route}
                  onChange={(event) => patchMedication(index, { route: event.target.value })}
                >
                  {ADMINISTRATION_ROUTES.map((route) => (
                    <option key={route} value={route}>
                      {route}
                    </option>
                  ))}
                </ChoiceSelect>
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
                <FieldLabel htmlFor={`${uid}-qty-${medication.key}`}>Cantidad total</FieldLabel>
                <Input
                  id={`${uid}-qty-${medication.key}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={9999}
                  value={medication.quantity}
                  onChange={(event) => patchMedication(index, { quantity: event.target.value })}
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
          <datalist id={`${uid}-dci`}>
            {prescribing.catalog.medications.map((medication) => (
              <option key={medication.dci} value={medication.dci} />
            ))}
          </datalist>
          {rules.weight.required ? (
            <Field>
              <FieldLabel htmlFor={`${uid}-rx-weight`}>Peso (kg)</FieldLabel>
              <Input
                id={`${uid}-rx-weight`}
                className="w-32"
                inputMode="decimal"
                maxLength={5}
                value={weight}
                onChange={(event) => setWeight(event.target.value.replace(/[^\d.,]/g, ""))}
              />
              <FieldDescription>
                Es menor de 12 años: la receta va con su peso.
                {rules.weight.suggested !== null ? ` El último registrado es ${rules.weight.suggested} kg.` : ""}
              </FieldDescription>
            </Field>
          ) : null}
          {ruleCheck.errors.length > 0 ? (
            <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <p className="font-medium">No se puede emitir así</p>
              <ul className="list-disc pl-5">
                {ruleCheck.errors.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {ruleCheck.reminders.length > 0 ? (
            <div role="note" className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
              {ruleCheck.reminders.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
          {conflicts.length > 0 ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
            >
              <p className="font-medium">{onlyAllergies ? "Aviso de alergia" : "Aviso"}</p>
              <ul className="list-disc pl-5">
                {conflicts.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {overriding ? (
                <Field>
                  <FieldLabel htmlFor={`${uid}-rx-override`}>¿Por qué la recetas igual?</FieldLabel>
                  <Textarea
                    id={`${uid}-rx-override`}
                    autoFocus
                    maxLength={500}
                    value={overrideReason}
                    placeholder="Por ejemplo, la reacción fue un malestar, no una alergia"
                    onChange={(event) => setOverrideReason(event.target.value)}
                  />
                  <FieldDescription>Queda en la receta, con tu nombre.</FieldDescription>
                </Field>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // Lleva al primer medicamento que choca para cambiarlo.
                    const allergyIndex = conflictsByMedication.findIndex((lines) => lines.length > 0)
                    const index = allergyIndex >= 0 ? allergyIndex : 0
                    const field = document.getElementById(`${uid}-med-${medications[index]?.key}`)
                    if (field instanceof HTMLInputElement) {
                      field.focus()
                      field.select()
                    }
                    setOverriding(false)
                    setOverrideReason("")
                  }}
                >
                  Cambiar medicamento
                </Button>
                {overriding ? null : (
                  <Button type="button" size="sm" variant="outline" onClick={() => setOverriding(true)}>
                    Recetar igual, con motivo
                  </Button>
                )}
              </div>
            </div>
          ) : null}
          <DiagnosisSearch
            label="Diagnóstico (opcional)"
            value={diagnosisCode}
            system={diagnosisSystem}
            onChange={(code, _description, system) => {
              setDiagnosisCode(code)
              setDiagnosisSystem(system)
            }}
          />
          <Field>
            <FieldLabel htmlFor={`${uid}-rx-valid`}>Válida hasta (opcional)</FieldLabel>
            <DatePickerButton
              id={`${uid}-rx-valid`}
              className="w-56"
              min={regionToday()}
              value={validUntil}
              emptyLabel="Sin fecha"
              onChange={setValidUntil}
            />
          </Field>
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
  )
  const createDrawer = (
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
        onSubmit={submitCreate}
      >
        {createBody}
      </FormDrawer>
  )
  if (drawerOnly) return createDrawer

  return (
    <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
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

      {createDrawer}
    </div>
  )
}
