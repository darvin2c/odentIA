import { documentText } from "@odentia/clinical"
import { Badge, Button, toast } from "@odentia/ui"
import {
  ErrorState,
  PageHeader,
  PageShell,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import {
  fetchLockedRecord,
  type LockedRecordView,
  lockedRecordKey,
  openLockedRecordApi,
  RECORD_OPENING_REASONS,
  type RecordOpeningReason,
} from "../../lib/locked-records"
import { hcLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { ChoiceButtons } from "../choice-buttons"
import { LockedRecordPageSkeleton } from "../skeletons/people"

/** Lo que exige `openLockedRecord`, dicho en su campo: el motivo y, con «Otro», cuál. */
const openSchema = z
  .object({
    reason: z.custom<RecordOpeningReason | null>((value) => value !== null, "Elige el motivo"),
    note: z.string().trim().max(500, "El motivo admite hasta 500 caracteres"),
  })
  .superRefine((value, ctx) => {
    if (value.reason === "otro" && !value.note.trim())
      ctx.addIssue({ code: "custom", path: ["note"], message: "Escribe el motivo" })
  })

/** ¿La página de la persona respondió que su historia está bloqueada? (423, solo a Administración). */
export function isRecordLocked(error: unknown): boolean {
  return error instanceof ApiError && error.status === 423
}

/** «15:40»: la hora en la zona de la clínica. */
function clock(iso: string | null): string {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString(activeOrgLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: activeOrgTimeZone(),
  })
}

/** «HC-000214 · DNI 41234567». */
function recordLine(record: LockedRecordView): string {
  return [hcLabel(record.patientNumber), record.docNumber ? documentText(record.docType, record.docNumber) : null]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Una historia bloqueada (tablero 7): por qué está así, qué se borró y
 * «Abrirla con motivo». «Vuelve a atenderse» la desbloquea entera; los demás
 * motivos la abren a quien lo pide durante una hora, solo para leer.
 */
export function LockedRecordPage({ personId }: { personId: string }) {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: lockedRecordKey(personId), queryFn: () => fetchLockedRecord(personId), retry: false })
  const open = useMutation({
    mutationFn: (input: { reason: RecordOpeningReason; note?: string }) => openLockedRecordApi(personId, input),
  })
  const form = useAppForm({
    defaultValues: { reason: null as RecordOpeningReason | null, note: "" },
    validators: { onSubmit: openSchema },
    onSubmit: async ({ value }) => {
      const result = await open.mutateAsync({ reason: value.reason as RecordOpeningReason, note: value.note.trim() || undefined })
      toast.success(
        result.locked
          ? `Abierta para leer hasta las ${clock(result.openUntil)}`
          : "Desbloqueada: vuelve a ser paciente, con su historia de antes",
      )
      await queryClient.invalidateQueries({ queryKey: ["person", personId] })
      await queryClient.invalidateQueries({ queryKey: lockedRecordKey(personId) })
    },
  })
  const submit = useFormSubmit(form)
  const submitError = useFormSubmitError(form)
  const reason = useStore(form.store, (state) => state.values.reason)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  if (query.isPending) return <LockedRecordPageSkeleton />
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const record = query.data
  const firstName = record.displayName.split(" ")[0] ?? record.displayName
  const opening = reason === "vuelve"
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={record.displayName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Link to="/people/locked" className="underline-offset-4 hover:underline">
              Historias bloqueadas
            </Link>
            <span aria-hidden="true">·</span>
            {recordLine(record)}
          </span>
        }
      />
      <section className="flex max-w-3xl flex-col gap-2 rounded-xl border bg-muted/40 p-5 text-sm">
        <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <Lock aria-hidden="true" className="size-4" />
          Bloqueada a pedido {record.request?.requesterName ? `de ${record.request.requesterName}` : "suyo"} el{" "}
          {formatDate(record.lockedAt)}
          <Badge variant="outline">Historia bloqueada</Badge>
        </p>
        <p className="text-muted-foreground">
          Se conserva porque la ley pide guardar la historia clínica durante años. No sale en búsquedas, agenda, listas ni
          reportes, y el agente no la ve.
        </p>
        {record.request?.resolution ? <p className="text-muted-foreground">{record.request.resolution}</p> : null}
        {record.lockedByName ? <p className="text-muted-foreground">Lo hizo {record.lockedByName}.</p> : null}
      </section>
      <form
        noValidate
        onSubmit={submit}
        aria-labelledby="locked-open"
        className="flex max-w-3xl flex-col gap-4 rounded-xl border p-5 text-sm"
      >
        <div>
          <h2 id="locked-open" className="text-base font-semibold">
            Abrirla con motivo
          </h2>
          <p className="text-muted-foreground">
            Solo Administración. Queda en «Consultas a la historia» y en la Actividad del equipo, con quién y cuándo.
          </p>
        </div>
        <form.AppField name="reason">
          {(field) => (
            <field.Group
              legend="Motivo"
              description="«Vuelve a atenderse» desbloquea la ficha entera: vuelve a ser paciente, con su historia de antes (lo borrado no vuelve). Los otros motivos la abren para leer durante una hora, sin cambiar nada."
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-label="Motivo"
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={field.handleChange}
                  columns={2}
                  options={RECORD_OPENING_REASONS.map((item) => ({
                    value: item.value,
                    label: item.value === "vuelve" ? `${firstName} vuelve a atenderse` : item.label,
                  }))}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {reason === "otro" || reason === "autoridad" || reason === "reclamo" ? (
          <form.AppField name="note">
            {(field) => (
              <field.TextareaField
                label={reason === "otro" ? "Escribe el motivo" : "Detalle (opcional)"}
                rows={2}
                maxLength={500}
              />
            )}
          </form.AppField>
        ) : null}
        {submitError ? (
          <p role="alert" className="text-destructive">
            {submitError}
          </p>
        ) : null}
        <Button type="submit" className="self-start" disabled={submitting}>
          {opening ? "Desbloquear la historia" : "Abrir para leer"}
        </Button>
      </form>
    </PageShell>
  )
}

/**
 * Sobre la página de una historia bloqueada abierta para leer: hasta cuándo
 * y que no se puede cambiar nada (el servidor lo rechaza igual).
 */
export function LockedRecordNotice({ personId }: { personId: string }) {
  const query = useQuery({ queryKey: lockedRecordKey(personId), queryFn: () => fetchLockedRecord(personId), retry: false })
  if (!query.data?.openUntil) return null
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
      <Lock aria-hidden="true" className="size-4" />
      <span>
        <strong>Historia bloqueada, abierta para leer</strong> hasta las {clock(query.data.openUntil)}: no se puede
        cambiar nada.
      </span>
    </p>
  )
}

/** Sin permiso para la lista. */
export function LockedRecordsNoAccess() {
  return <ErrorState title="Sin acceso" message="Las historias bloqueadas solo las ve Administración." />
}
