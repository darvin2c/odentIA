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
import { Badge, Button, buttonVariants, FieldLegend, FieldSet, Input, toast } from "@odentia/ui"
import {
  addDays,
  DatePickerButton,
  EmptyState,
  FormDrawer,
  FormField,
  regionToday,
  submitErrorMessage,
  useAppForm,
  useFieldContext,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
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
  PRESCRIPTION_STATUS_LABELS,
  type Prescription,
  stopFollowUpRepeatApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { type Encounter, fetchPatientHealth, type PlanItem } from "../../lib/patients"
import { productUi } from "../../product/product-ui"
import { openAppointmentAnywhere } from "../agenda/schedule-host"
import { ChoiceSelect } from "../ui/choice-select"
import { DiagnosisSearch } from "./diagnosis-search"
import { PrescriptionPaper } from "./document-papers"
import { FollowUpScheduler } from "./follow-up-scheduler"

const MAX_TITLE = 200
const MAX_TEXT = 2000
/** Las indicaciones de un control: el límite de `POST /follow-ups`. */
const MAX_INSTRUCTIONS = 4000
/** Un control previsto vence a las 9:00 de la clínica del día elegido (la hora la pone su cita). */
const CONTROL_HOUR = "09:00"

function statusBadge(status: string): "default" | "secondary" | "success" | "destructive" {
  if (status === "realizado") return "success"
  if (status === "cancelado" || status === "anulada") return "destructive"
  if (status === "programado") return "default"
  return "secondary"
}

/**
 * Una opción de una lista (`ChoiceSelect`) como campo de `useAppForm`: su
 * etiqueta, su ayuda y su error, que sale al salir del campo o al enviar.
 */
function ChoiceField({
  label,
  description,
  onPick,
  children,
}: {
  label: string
  description?: string
  onPick?: (value: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  const field = useFieldContext<string>()
  return (
    <FormField label={label} description={description}>
      {(control) => (
        <ChoiceSelect
          id={control.id}
          name={control.name}
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          onBlur={control.onBlur}
          value={field.state.value}
          onChange={(event) => {
            field.handleChange(event.target.value)
            onPick?.(event.target.value)
          }}
        >
          {children}
        </ChoiceSelect>
      )}
    </FormField>
  )
}

/** El motivo de cancelar o anular: lo pide la ruta (1–2000 caracteres). */
function reasonSchema(required: string) {
  return z.object({
    reason: z
      .string()
      .trim()
      .min(1, required)
      .max(MAX_TEXT, `El motivo tiene como mucho ${MAX_TEXT} caracteres.`),
  })
}

/** Lo de «Indicar control», con los límites de `POST /follow-ups`. */
function followUpSchema(fixedItem: boolean) {
  return z
    .object({
      kind: z.string(),
      planItemId: z.string(),
      title: z
        .string()
        .trim()
        .min(1, "Indica el título del control.")
        .max(MAX_TITLE, `El título tiene como mucho ${MAX_TITLE} caracteres.`),
      dueDay: z.string().min(1, "Indica la fecha prevista del control."),
      repeat: z.string(),
      instructions: z
        .string()
        .max(
          MAX_INSTRUCTIONS,
          `Las indicaciones tienen como mucho ${MAX_INSTRUCTIONS} caracteres.`,
        ),
    })
    .superRefine((value, ctx) => {
      if (!fixedItem && value.kind === "tratamiento" && !value.planItemId)
        ctx.addIssue({
          code: "custom",
          path: ["planItemId"],
          message: "Elige el tratamiento que sigue este control.",
        })
    })
}

const completeSchema = z.object({
  encounterId: z.string().min(1, "Elige la atención finalizada donde se atendió el control."),
  outcome: z
    .string()
    .trim()
    .min(1, "Registra el resultado del control.")
    .max(MAX_TEXT, `El resultado tiene como mucho ${MAX_TEXT} caracteres.`),
})

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

  // Controles que se repiten (latidIA, decisión 16 del issue 229): "" es una sola vez.
  const repeats = productUi().plan.repeatingControls
  const [createOpen, setCreateOpen] = useState(false)
  const [scheduling, setScheduling] = useState<FollowUp | null>(null)
  const [completing, setCompleting] = useState<FollowUp | null>(null)
  const [cancelling, setCancelling] = useState<FollowUp | null>(null)
  // «Dejar de repetir» es un botón suelto, no un formulario: su error va junto a la lista.
  const [repeatError, setRepeatError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof createFollowUpApi>[1]) =>
      createFollowUpApi(patientId, body),
  })
  const createForm = useAppForm({
    defaultValues: {
      kind: (itemId ? "tratamiento" : "mantenimiento") as string,
      planItemId: itemId ?? "",
      title: "",
      // El día previsto se elige en la zona de la clínica, no en la del navegador:
      // un control es para un día, no para una hora (la hora la pone la cita).
      dueDay: addDays(regionToday(), 1),
      repeat: "",
      instructions: "",
    },
    validators: { onSubmit: followUpSchema(Boolean(itemId)) },
    onSubmit: async ({ value }) => {
      // El tratamiento del recorrido manda siempre: el panel nunca conserva la
      // selección anterior cuando se cambia de tratamiento en la ficha.
      const kind = itemId
        ? "tratamiento"
        : value.kind === "tratamiento"
          ? "tratamiento"
          : "mantenimiento"
      const planItemId = itemId ?? value.planItemId
      await createMutation.mutateAsync({
        kind,
        title: value.title.trim(),
        dueAt: instantFromClinicValue(`${value.dueDay}T${CONTROL_HOUR}`) ?? "",
        instructions: value.instructions.trim() || null,
        planItemId: kind === "tratamiento" ? planItemId || null : null,
        originEncounterId: encounterId ?? null,
        repeatEveryMonths: repeats && value.repeat ? Number(value.repeat) : null,
      })
      createForm.reset({ ...value, title: "", instructions: "", repeat: "" })
      setCreateOpen(false)
      invalidate()
    },
  })
  const createSurface = useFormSurface(createForm, {
    fieldMap: { dueAt: "dueDay", repeatEveryMonths: "repeat" },
  })
  const kind = useStore(createForm.store, (state) => (itemId ? "tratamiento" : state.values.kind))

  const completeMutation = useMutation({
    mutationFn: (input: { followUpId: string; encounterId: string; outcome: string }) =>
      completeFollowUpApi(patientId, input.followUpId, {
        encounterId: input.encounterId,
        outcome: input.outcome,
      }),
  })
  const completeForm = useAppForm({
    defaultValues: { encounterId: "", outcome: "" },
    validators: { onSubmit: completeSchema },
    onSubmit: async ({ value }) => {
      if (!completing) return
      await completeMutation.mutateAsync({
        followUpId: completing.id,
        encounterId: value.encounterId,
        outcome: value.outcome.trim(),
      })
      setCompleting(null)
      completeForm.reset({ encounterId: "", outcome: "" })
      invalidate()
    },
  })
  const completeSurface = useFormSurface(completeForm)

  const stopRepeatMutation = useMutation({
    mutationFn: (followUpId: string) => stopFollowUpRepeatApi(patientId, followUpId),
    onSuccess: () => {
      toast.success("Ya no se repite: al completarlo no queda indicado otro.")
      setRepeatError(null)
      invalidate()
    },
    onError: (mutationError) => setRepeatError(submitErrorMessage(mutationError)),
  })

  const cancelMutation = useMutation({
    mutationFn: (input: { followUpId: string; reason: string }) =>
      cancelFollowUpApi(patientId, input.followUpId, { reason: input.reason }),
  })
  const cancelForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: reasonSchema("Indica el motivo de la cancelación.") },
    onSubmit: async ({ value }) => {
      if (!cancelling) return
      await cancelMutation.mutateAsync({ followUpId: cancelling.id, reason: value.reason.trim() })
      setCancelling(null)
      cancelForm.reset({ reason: "" })
      invalidate()
    },
  })
  const cancelSurface = useFormSurface(cancelForm)

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
                  {FOLLOW_UP_KIND_LABELS[row.kind] ?? row.kind} · previsto {formatDate(row.dueAt)}
                  {row.legacyScheduledAt && !row.appointment
                    ? ` · fecha histórica ${formatDateTime(row.legacyScheduledAt)}`
                    : ""}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">{followUpAppointmentLabel(row)}</p>
              {row.repeatEveryMonths &&
              (row.status === "pendiente" || row.status === "programado") ? (
                <p className="text-sm text-muted-foreground">
                  Se repite {followUpRepeatWords(row.repeatEveryMonths)}: al completarlo queda
                  indicado el siguiente.
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
                          completeForm.reset({ encounterId: finalized[0]?.id ?? "", outcome: "" })
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
                            setRepeatError(null)
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

      {repeatError ? (
        <p role="alert" className="text-sm text-destructive">
          {repeatError}
        </p>
      ) : null}

      <FormDrawer
        {...createSurface}
        open={createOpen}
        title="Indicar control"
        description="El control queda ligado al tratamiento o al mantenimiento del paciente."
        submitLabel="Indicar control"
        onClose={() => {
          if (!createSurface.isSubmitting) setCreateOpen(false)
        }}
      >
        <div className="flex flex-col gap-4">
          {itemId ? (
            <p className="text-sm text-muted-foreground">
              Tratamiento: {planItemLabel(itemId) ?? "el tratamiento abierto"}
            </p>
          ) : (
            <createForm.AppField name="kind">
              {() => (
                <ChoiceField
                  label="Tipo de control"
                  onPick={(next) => {
                    if (next === "mantenimiento") createForm.setFieldValue("planItemId", "")
                  }}
                >
                  <option value="mantenimiento">Mantenimiento</option>
                  <option value="tratamiento">Seguimiento de un tratamiento</option>
                </ChoiceField>
              )}
            </createForm.AppField>
          )}
          {kind === "tratamiento" && !itemId ? (
            <createForm.AppField name="planItemId">
              {() => (
                <ChoiceField label="Tratamiento">
                  <option value="">Seleccionar tratamiento</option>
                  {(items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                      {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""}
                    </option>
                  ))}
                </ChoiceField>
              )}
            </createForm.AppField>
          ) : null}
          <createForm.AppField name="title">
            {(field) => <field.TextField label="Título del control" maxLength={MAX_TITLE} />}
          </createForm.AppField>
          <createForm.AppField name="dueDay">
            {(field) => (
              <field.Control label="Fecha prevista">
                {(control) => (
                  <DatePickerButton
                    {...control.props}
                    className="w-56"
                    min={regionToday()}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </field.Control>
            )}
          </createForm.AppField>
          {repeats ? (
            <createForm.AppField name="repeat">
              {() => (
                <ChoiceField
                  label="Se repite"
                  description="Al completarlo queda indicado el siguiente, hasta que lo detengas."
                >
                  <option value="">Una sola vez</option>
                  {FOLLOW_UP_REPEAT_MONTHS.map((months) => (
                    <option key={months} value={String(months)}>
                      {followUpRepeatWords(months).replace(/^c/, "C")}
                    </option>
                  ))}
                </ChoiceField>
              )}
            </createForm.AppField>
          ) : null}
          <createForm.AppField name="instructions">
            {(field) => (
              <field.TextareaField label="Indicaciones del control" maxLength={MAX_INSTRUCTIONS} />
            )}
          </createForm.AppField>
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
        {...completeSurface}
        open={completing != null}
        title="Completar control"
        description="Se registra el resultado contra una atención finalizada del paciente."
        submitLabel="Completar"
        onClose={() => {
          if (!completeSurface.isSubmitting) setCompleting(null)
        }}
      >
        <div className="flex flex-col gap-4">
          <completeForm.AppField name="encounterId">
            {() => (
              <ChoiceField label="Atención finalizada">
                <option value="">Seleccionar atención</option>
                {finalized.map((encounter) => (
                  <option key={encounter.id} value={encounter.id}>
                    {formatDateTime(encounter.createdAt)} · {encounter.reason || "Atención"}
                  </option>
                ))}
              </ChoiceField>
            )}
          </completeForm.AppField>
          <completeForm.AppField name="outcome">
            {(field) => <field.TextareaField label="Resultado del control" maxLength={MAX_TEXT} />}
          </completeForm.AppField>
        </div>
      </FormDrawer>

      <FormDrawer
        {...cancelSurface}
        dock={false}
        open={cancelling != null}
        title="Cancelar control"
        description="El control se conserva con su motivo. Cancelar el control NO cancela la cita: cualquier reserva vigente permanece en agenda."
        submitLabel="Cancelar control"
        onClose={() => {
          if (!cancelSurface.isSubmitting) setCancelling(null)
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
        <cancelForm.AppField name="reason">
          {(field) => <field.TextareaField label="Motivo" maxLength={MAX_TEXT} />}
        </cancelForm.AppField>
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
  /** Abierta al mostrarse sola. */
  defaultOpen?: boolean
}): React.JSX.Element {
  const canRead = usePermission("clinical.read")
  const detail = useQuery({
    queryKey: ["prescription", patientId, prescription.id],
    queryFn: () => fetchPrescriptionDetail(patientId, prescription.id),
    enabled: canRead,
  })
  const [viewing, setViewing] = useState(false)
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
        {prescription.prescriberName ? (
          <p className="text-xs text-muted-foreground">
            Prescribe {prescription.prescriberName}
            {prescription.prescriberRegistration ? ` · ${prescription.prescriberRegistration}` : ""}
            {prescription.validUntil
              ? ` · válida hasta ${formatDate(prescription.validUntil)}`
              : ""}
          </p>
        ) : null}
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setViewing(true)}>
            Ver
          </Button>
        </div>
      </div>
      {viewing ? (
        <PrescriptionPaper
          patientId={patientId}
          prescription={prescription}
          onClose={() => setViewing(false)}
        />
      ) : null}
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

/** Como mucho, los medicamentos de una receta (`POST /prescriptions`). */
const MAX_MEDICATIONS = 20
const QUANTITY_RANGE = "La cantidad es un número entero de 1 a 9999."
const WEIGHT_RANGE = "Escribe el peso en kilos, de 0,5 a 400."

/** El peso escrito («12,5»), si está entre 0,5 y 400 kg como pide la ruta; si no, null. */
function weightOf(text: string): number | null {
  const kg = Number(text.trim().replace(",", "."))
  return text.trim() !== "" && Number.isFinite(kg) && kg >= 0.5 && kg <= 400 ? kg : null
}

const required = (max: number, missing: string) =>
  z.string().trim().min(1, missing).max(max, `Escribe como mucho ${max} caracteres.`)

/** Cada medicamento, con los límites de `POST /prescriptions` (sus nombres en el cuerpo: `items[i].…`). */
const medicationSchema = z.object({
  key: z.string(),
  genericName: required(MAX_TITLE, "Escribe la DCI."),
  brandName: z.string().trim().max(MAX_TITLE, `Escribe como mucho ${MAX_TITLE} caracteres.`),
  strength: required(60, "Escribe la concentración."),
  dosageForm: z.string().min(1, "Elige la forma farmacéutica."),
  dose: required(MAX_TITLE, "Escribe la dosis."),
  route: z.string().min(1, "Elige la vía."),
  frequency: required(MAX_TITLE, "Escribe la frecuencia."),
  duration: required(MAX_TITLE, "Escribe la duración."),
  quantity: z.string().refine((text) => {
    const value = text.trim()
    if (value === "") return true
    const count = Number(value)
    return /^\d+$/.test(value) && count >= 1 && count <= 9999
  }, QUANTITY_RANGE),
  instructions: z.string().max(MAX_TEXT, `Escribe como mucho ${MAX_TEXT} caracteres.`),
})

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
  const [createOpenState, setCreateOpenState] = useState(false)
  const createOpen = createOpenProp ?? createOpenState
  const setCreateOpen = (open: boolean) => {
    setCreateOpenState(open)
    onCreateOpenChange?.(open)
  }
  // La lista y las reglas de la receta son las del producto (latidIA: controlados, embarazo, peso; issue 229).
  const prescribing = productUi().prescribing
  const rules = prescribing.useRules(patientId, canRead && createOpen)
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
  /** Lo que se receta solo con motivo para un medicamento: sus alergias y lo que avisan las reglas. */
  const conflictsOf = (genericName: string) => [
    ...allergyWarnings(genericName, activeAllergies, prescribing.catalog),
    ...rules.check([{ genericName }], 1).warnings,
  ]
  // El esquema se arma una vez; las reglas y las alergias llegan después y cambian.
  const latest = useRef({ rules, conflictsOf })
  latest.current = { rules, conflictsOf }
  const schema = useMemo(
    () =>
      z
        .object({
          planItemId: z.string(),
          items: z
            .array(medicationSchema)
            .min(1, "Añade al menos un medicamento.")
            .max(MAX_MEDICATIONS, `La receta lleva hasta ${MAX_MEDICATIONS} medicamentos.`),
          patientWeightKg: z.string(),
          overriding: z.boolean(),
          allergyOverrideReason: z
            .string()
            .max(500, "El motivo para recetar igual tiene como mucho 500 caracteres."),
          diagnosisCode: z.string(),
          diagnosisSystem: z.string().nullable(),
          validUntil: z.string(),
          notes: z.string().max(MAX_TEXT, `Las notas tienen como mucho ${MAX_TEXT} caracteres.`),
        })
        .superRefine((value, ctx) => {
          const { rules, conflictsOf } = latest.current
          let warned = false
          value.items.forEach((medication, index) => {
            const name = medication.genericName.trim()
            if (!name) return
            const path = ["items", index, "genericName"]
            // Con un peso cualquiera, la revisión de un medicamento solo dice lo suyo.
            if (rules.check([{ genericName: name }], 1).errors.length > 0) {
              ctx.addIssue({
                code: "custom",
                path,
                message: "Este medicamento no va en la receta común.",
              })
              return
            }
            if (conflictsOf(name).length === 0) return
            warned = true
            if (!value.overriding)
              ctx.addIssue({
                code: "custom",
                path,
                message: "Tiene un aviso: cámbialo o recétalo igual con un motivo.",
              })
          })
          if (rules.weight.required && weightOf(value.patientWeightKg) === null)
            ctx.addIssue({
              code: "custom",
              path: ["patientWeightKg"],
              message: value.patientWeightKg.trim() ? WEIGHT_RANGE : "Escribe su peso en kilos.",
            })
          if (warned && value.overriding && !value.allergyOverrideReason.trim())
            ctx.addIssue({
              code: "custom",
              path: ["allergyOverrideReason"],
              message: "Escribe por qué la recetas igual.",
            })
        }),
    [],
  )
  // Los medicamentos de partida se arman una vez: cada uno lleva una clave al
  // azar y TanStack Form vuelve a aplicar unos `defaultValues` distintos en
  // cada render mientras no se toque el formulario (un ciclo sin fin).
  const [initialItems] = useState(() =>
    initialMedications?.length
      ? initialMedications.map((medication) => ({ ...emptyMedication(), ...medication }))
      : [emptyMedication()],
  )
  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof createPrescriptionApi>[1]) =>
      createPrescriptionApi(patientId, body),
  })
  const form = useAppForm({
    defaultValues: {
      // Igual que en controles: desde el recorrido el tratamiento es el del
      // recorrido abierto y no una selección previa de otra pantalla.
      planItemId: itemId ?? "",
      items: initialItems,
      patientWeightKg: "",
      // Recetar igual pese al aviso pide un motivo escrito, que queda en la receta (decisión 10).
      overriding: startOverriding,
      allergyOverrideReason: "",
      diagnosisCode: defaultDiagnosisCode ?? "",
      diagnosisSystem: defaultDiagnosisSystem ?? (null as string | null),
      validUntil: "",
      notes: "",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const { rules, conflictsOf } = latest.current
      const warned = value.items.some(
        (medication) => conflictsOf(medication.genericName.trim()).length > 0,
      )
      const acknowledged = warned && value.overriding && value.allergyOverrideReason.trim() !== ""
      const result = await createMutation.mutateAsync({
        encounterId: encounterId ?? null,
        planItemId: (itemId ?? value.planItemId) || null,
        notes: value.notes.trim() || null,
        diagnosisCode: value.diagnosisCode || null,
        diagnosisSystem: value.diagnosisCode ? value.diagnosisSystem : null,
        validUntil: value.validUntil || null,
        acknowledgeAllergies: acknowledged,
        allergyOverrideReason: acknowledged ? value.allergyOverrideReason.trim() : null,
        patientWeightKg: rules.weight.required ? weightOf(value.patientWeightKg) : null,
        items: value.items.map((medication) => ({
          genericName: medication.genericName.trim(),
          brandName: medication.brandName.trim() || null,
          strength: medication.strength.trim(),
          dosageForm: medication.dosageForm.trim(),
          dose: medication.dose.trim(),
          route: medication.route,
          frequency: medication.frequency.trim(),
          duration: medication.duration.trim(),
          quantity: medication.quantity.trim() ? Number(medication.quantity.trim()) : null,
          instructions: medication.instructions.trim() || null,
        })),
      })
      onIssued?.(result.data.id)
      form.reset({
        planItemId: value.planItemId,
        items: [emptyMedication()],
        patientWeightKg: "",
        overriding: false,
        allergyOverrideReason: "",
        diagnosisCode: "",
        diagnosisSystem: value.diagnosisSystem,
        validUntil: "",
        notes: "",
      })
      setCreateOpen(false)
      toast.success("Receta emitida.")
      void queryClient.invalidateQueries({ queryKey: ["prescriptions", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
    },
  })
  const surface = useFormSurface(form)

  const medications = useStore(form.store, (state) => state.values.items)
  const weight = useStore(form.store, (state) => state.values.patientWeightKg)
  const overriding = useStore(form.store, (state) => state.values.overriding)
  const conflictsByMedication = medications.map((medication) => conflictsOf(medication.genericName))
  const typedWeight = weight.trim() ? Number(weight.replace(",", ".")) : null
  const ruleCheck = rules.check(
    medications,
    typedWeight !== null && Number.isFinite(typedWeight) ? typedWeight : null,
  )
  // Lo contraindicado en el embarazo va como una alergia: se cambia o se receta con motivo.
  const conflicts = [...new Set(conflictsByMedication.flat())]
  const onlyAllergies = ruleCheck.warnings.length === 0
  // El peso del último registro se propone una vez; quien receta lo corrige.
  useEffect(() => {
    if (rules.weight.required && rules.weight.suggested !== null && weight === "")
      form.setFieldValue("patientWeightKg", String(rules.weight.suggested), {
        dontUpdateMeta: true,
      })
  }, [rules.weight.required, rules.weight.suggested, weight, form])

  const rows = (list.data?.data ?? []).filter(
    (row) =>
      (!itemId || row.planItemId === itemId) &&
      (!encounterOnly || encounterId === undefined || row.encounterId === encounterId),
  )
  const dciId = (key: string | undefined) => `${uid}-med-${key}`

  const createBody = (
    <div className="flex flex-col gap-4">
      {itemId ? (
        <p className="text-sm text-muted-foreground">
          Tratamiento:{" "}
          {(items ?? []).find((item) => item.id === itemId)?.title ?? "el tratamiento abierto"}
        </p>
      ) : (
        <form.AppField name="planItemId">
          {() => (
            <ChoiceField label="Tratamiento">
              <option value="">Sin tratamiento asociado</option>
              {(items ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                  {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""}
                </option>
              ))}
            </ChoiceField>
          )}
        </form.AppField>
      )}
      <form.AppField name="items" mode="array">
        {(itemsField) => (
          <>
            {itemsField.state.value.map((medication, index) => (
              <FieldSet
                key={medication.key}
                className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
              >
                <FieldLegend variant="label" className="mb-0 px-1">
                  Medicamento {index + 1}
                </FieldLegend>
                <form.AppField name={`items[${index}].genericName`}>
                  {(field) => (
                    <field.TextField
                      label="DCI (denominación común)"
                      id={dciId(medication.key)}
                      list={`${uid}-dci`}
                      maxLength={MAX_TITLE}
                    />
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].brandName`}>
                  {(field) => (
                    <field.TextField label="Nombre comercial (opcional)" maxLength={MAX_TITLE} />
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].strength`}>
                  {(field) => (
                    <field.TextField
                      label="Concentración"
                      maxLength={60}
                      placeholder="Ej.: 500 mg"
                    />
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].dosageForm`}>
                  {() => (
                    <ChoiceField label="Forma farmacéutica">
                      <option value="">Elige la forma…</option>
                      {DOSAGE_FORMS.map((dosageForm) => (
                        <option key={dosageForm} value={dosageForm}>
                          {dosageForm}
                        </option>
                      ))}
                    </ChoiceField>
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].dose`}>
                  {(field) => (
                    <field.TextField
                      label="Dosis"
                      maxLength={MAX_TITLE}
                      placeholder="Ej.: 1 tableta"
                    />
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].route`}>
                  {() => (
                    <ChoiceField label="Vía">
                      {ADMINISTRATION_ROUTES.map((route) => (
                        <option key={route} value={route}>
                          {route}
                        </option>
                      ))}
                    </ChoiceField>
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].frequency`}>
                  {(field) => <field.TextField label="Frecuencia" maxLength={MAX_TITLE} />}
                </form.AppField>
                <form.AppField name={`items[${index}].duration`}>
                  {(field) => <field.TextField label="Duración" maxLength={MAX_TITLE} />}
                </form.AppField>
                <form.AppField name={`items[${index}].quantity`}>
                  {(field) => (
                    <field.TextField label="Cantidad total" inputMode="numeric" maxLength={4} />
                  )}
                </form.AppField>
                <form.AppField name={`items[${index}].instructions`}>
                  {(field) => <field.TextField label="Instrucciones" maxLength={MAX_TEXT} />}
                </form.AppField>
              </FieldSet>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={itemsField.state.value.length >= MAX_MEDICATIONS}
                onClick={() => itemsField.pushValue(emptyMedication())}
              >
                Añadir medicamento
              </Button>
              {itemsField.state.value.length > 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => itemsField.removeValue(itemsField.state.value.length - 1)}
                >
                  Quitar el último
                </Button>
              ) : null}
            </div>
          </>
        )}
      </form.AppField>
      <datalist id={`${uid}-dci`}>
        {prescribing.catalog.medications.map((medication) => (
          <option key={medication.dci} value={medication.dci} />
        ))}
      </datalist>
      {rules.weight.required ? (
        <form.AppField name="patientWeightKg">
          {(field) => (
            <field.Control
              label="Peso (kg)"
              description={`Es menor de 12 años: la receta va con su peso.${rules.weight.suggested !== null ? ` El último registrado es ${rules.weight.suggested} kg.` : ""}`}
            >
              {(control) => (
                <Input
                  {...control.props}
                  className="w-32"
                  inputMode="decimal"
                  maxLength={5}
                  value={field.state.value}
                  onChange={(event) =>
                    field.handleChange(event.target.value.replace(/[^\d.,]/g, ""))
                  }
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      ) : null}
      {ruleCheck.errors.length > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <p className="font-medium">No se puede emitir así</p>
          <ul className="list-disc pl-5">
            {ruleCheck.errors.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {ruleCheck.reminders.length > 0 ? (
        <div
          role="note"
          className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
        >
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
            <form.AppField name="allergyOverrideReason">
              {(field) => (
                <field.TextareaField
                  label="¿Por qué la recetas igual?"
                  description="Queda en la receta, con tu nombre."
                  autoFocus
                  maxLength={500}
                  placeholder="Por ejemplo, la reacción fue un malestar, no una alergia"
                />
              )}
            </form.AppField>
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
                const field = document.getElementById(dciId(medications[index]?.key))
                if (field instanceof HTMLInputElement) {
                  field.focus()
                  field.select()
                }
                form.setFieldValue("overriding", false)
                form.setFieldValue("allergyOverrideReason", "")
              }}
            >
              Cambiar medicamento
            </Button>
            {overriding ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => form.setFieldValue("overriding", true)}
              >
                Recetar igual, con motivo
              </Button>
            )}
          </div>
        </div>
      ) : null}
      <form.AppField name="diagnosisCode">
        {(field) => (
          <field.Control label="Diagnóstico (opcional)">
            {(control) => (
              <DiagnosisSearch
                id={control.id}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                value={field.state.value}
                system={form.getFieldValue("diagnosisSystem")}
                onChange={(code, _description, system) => {
                  field.handleChange(code)
                  form.setFieldValue("diagnosisSystem", system)
                }}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      <form.AppField name="validUntil">
        {(field) => (
          <field.Control label="Válida hasta (opcional)">
            {(control) => (
              <DatePickerButton
                {...control.props}
                className="w-56"
                min={regionToday()}
                value={field.state.value}
                emptyLabel="Sin fecha"
                onChange={field.handleChange}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      <form.AppField name="notes">
        {(field) => <field.TextareaField label="Notas de la receta" maxLength={MAX_TEXT} />}
      </form.AppField>
    </div>
  )
  const createDrawer = (
    <FormDrawer
      {...surface}
      open={createOpen}
      title="Emitir receta"
      description="La receta queda inmutable: para corregirla se anula con motivo."
      submitLabel="Emitir receta"
      className="sm:[--drawer-content-width:min(46rem,calc(100vw-2rem))]"
      onClose={() => {
        if (!surface.isSubmitting) setCreateOpen(false)
      }}
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
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
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
