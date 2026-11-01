import {
  Badge,
  Button,
  buttonVariants,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import { formatMoney } from "@odentia/clinical"
import {
  ConfirmDialog,
  DetailDrawer,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PastDateInput,
  submitErrorMessage,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileText, MessageSquareOff, PencilLine, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { ChoiceButtons } from "../choice-buttons"
import { ApiError } from "../../lib/api"
import { formatDateTime } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import {
  createDataRequestApi,
  DATA_REQUEST_CHANNEL_PHRASE,
  DATA_REQUEST_CHANNEL_TEXT,
  DATA_REQUEST_DAYS,
  DATA_REQUEST_KIND_TEXT,
  DATA_REQUEST_ROW_TITLE,
  DATA_REQUEST_STATUS_TEXT,
  DATA_REQUEST_VERIFICATION_TEXT,
  type DataRequest,
  type DataRequestChannel,
  type DataRequestKind,
  type DataRequestsView,
  type DataRequestVerification,
  addDays,
  dataRequestsKey,
  dayWords,
  denyDataRequestApi,
  dueWords,
  eraseDataApi,
  type ErasurePreview,
  fetchDataRequests,
  fetchErasurePreview,
  fetchRecordSendOptions,
  patientRecordDownloadUrl,
  respondDataRequestApi,
  sendRecordCopyApi,
  verifyDataRequestApi,
} from "../../lib/data-requests"
import { useOrgLocale } from "../../lib/locale"
import { appWords } from "../../lib/product-words"
import { DataRequestsSkeleton } from "../skeletons/person-sections"

/** Por qué no se pudo cargar algo (la lista, el resumen de lo que se borra). */
function problemOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof ApiError
    ? (error.shape.message ?? "No pudimos completar la acción.")
    : "No pudimos completar la acción. Revisa tu conexión."
}

/** Los mismos límites que la API (`patient-data-requests.ts`). */
const MAX_TEXT = 1000
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

const resolutionSchema = z.object({
  resolution: z
    .string()
    .trim()
    .min(1, "Escribe qué se entregó o qué se hizo")
    .max(MAX_TEXT, `La respuesta admite hasta ${MAX_TEXT} caracteres`),
})

const denySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Escribe por qué se deniega")
    .max(MAX_TEXT, `El motivo admite hasta ${MAX_TEXT} caracteres`),
})

const eraseSchema = z.object({
  typed: z.string().refine((text) => text.trim() === "BORRAR", "Escribe BORRAR, en mayúsculas, para confirmar"),
})

const KIND_ICON = { copia: FileText, corregir: PencilLine, mensajes: MessageSquareOff, borrar: Trash2 } as const

/**
 * Datos › Pedidos sobre sus datos (ADR 0080): lo que la persona o su
 * representante pidieron, con su plazo de 10 días. Lo atienden Recepción y
 * Administración; «Descargar historia» es solo de quien lee la ficha clínica,
 * porque lleva todo lo clínico, y borrar sus datos es solo de Administración.
 */
export function DataRequestsPanel({ patientId }: { patientId: string }) {
  const canManage = usePermission("patients.write")
  const canReadClinical = usePermission("clinical.read")
  const canErase = usePermission("patients.erase")
  const locale = useOrgLocale() ?? "es"
  const query = useQuery({ queryKey: dataRequestsKey(patientId), queryFn: () => fetchDataRequests(patientId), enabled: canManage })
  const [registering, setRegistering] = useState(false)
  const [attending, setAttending] = useState<string | null>(null)

  if (!canManage)
    return (
      <EmptyState
        title="Pedidos sobre sus datos"
        description="Los pedidos de una persona sobre sus datos los atienden Recepción y Administración."
      />
    )
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando sus pedidos…">
        <DataRequestsSkeleton />
      </SkeletonRegion>
    )
  if (query.isError)
    return (
      <ErrorState
        title="No pudimos cargar sus pedidos"
        message={problemOf(query.error) ?? ""}
        onRetry={() => void query.refetch()}
      />
    )
  const view = query.data
  const patientName = view.requesters.find((r) => r.relation === "paciente")?.displayName ?? null
  const firstName = patientName?.split(" ")[0] ?? "La persona"
  const open = view.requests.find((r) => r.id === attending) ?? null

  return (
    <section aria-label="Pedidos sobre sus datos" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Pedidos sobre sus datos</h2>
          <p className="text-sm text-muted-foreground">
            Lo que ella o su representante pidieron: una copia, corregir, no recibir mensajes o borrar sus datos. Cada uno se
            responde en{" "}
            {DATA_REQUEST_DAYS} días.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReadClinical ? (
            <a
              className={buttonVariants({ variant: "outline", size: "sm" })}
              href={patientRecordDownloadUrl(patientId)}
              download
            >
              Descargar historia
            </a>
          ) : null}
          {view.requests.length > 0 && view.requesters.length > 0 ? (
            <Button type="button" size="sm" onClick={() => setRegistering(true)}>
              Registrar un pedido
            </Button>
          ) : null}
        </div>
      </div>
      {view.requests.length === 0 ? (
        <EmptyState
          title="Sin pedidos sobre sus datos"
          description={
            view.requesters.length > 0
              ? `${firstName} no ha pedido nada sobre sus datos. Si lo pide, regístralo aquí: tienes ${DATA_REQUEST_DAYS} días para responder.`
              : "Es menor de edad y no tiene representante legal vigente: nadie puede pedir por ella todavía."
          }
          actionLabel={view.requesters.length > 0 ? "Registrar un pedido" : undefined}
          onAction={view.requesters.length > 0 ? () => setRegistering(true) : undefined}
        />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {view.requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              today={view.today}
              locale={locale}
              onOpen={() => setAttending(request.id)}
            />
          ))}
        </ul>
      )}
      {registering ? (
        <RegisterDrawer patientId={patientId} view={view} locale={locale} onClose={() => setRegistering(false)} />
      ) : null}
      {open ? (
        <AttendDrawer
          patientId={patientId}
          request={open}
          today={view.today}
          locale={locale}
          canReadClinical={canReadClinical}
          canErase={canErase}
          patientName={patientName}
          onClose={() => setAttending(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * «Atender el pedido» desde «Te espera»: el mismo cajón de la ficha, para
 * comprobar, enviar y responder sin salir de Inicio.
 */
export function DataRequestDrawer({ patientId, requestId, onClose }: { patientId: string; requestId: string; onClose: () => void }) {
  const canReadClinical = usePermission("clinical.read")
  const canErase = usePermission("patients.erase")
  const locale = useOrgLocale() ?? "es"
  const query = useQuery({ queryKey: dataRequestsKey(patientId), queryFn: () => fetchDataRequests(patientId) })
  const view = query.data
  const request = view?.requests.find((item) => item.id === requestId) ?? null
  if (!view || !request) {
    return (
      <DetailDrawer open title="Pedido sobre sus datos" isLoading={query.isPending} onClose={onClose}>
        {query.isError ? (
          <ErrorState title="No pudimos cargar el pedido" message={problemOf(query.error) ?? ""} onRetry={() => void query.refetch()} />
        ) : query.isPending ? null : (
          <EmptyState title="Este pedido ya no está" description="Se atendió desde que se abrió la pantalla." />
        )}
      </DetailDrawer>
    )
  }
  return (
    <AttendDrawer
      patientId={patientId}
      request={request}
      today={view.today}
      locale={locale}
      canReadClinical={canReadClinical}
      canErase={canErase}
      patientName={view.requesters.find((item) => item.relation === "paciente")?.displayName ?? null}
      onClose={onClose}
    />
  )
}

function statusVariant(status: DataRequest["status"]) {
  return status === "pendiente" ? ("warning" as const) : status === "denegada" ? ("outline" as const) : ("success" as const)
}

function RequestRow({
  request,
  today,
  locale,
  onOpen,
}: {
  request: DataRequest
  today: string
  locale: string
  onOpen: () => void
}) {
  const Icon = KIND_ICON[request.kind]
  const pending = request.status === "pendiente"
  const late = pending && request.dueOn < today
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <span
        aria-hidden="true"
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${pending ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground"}`}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {DATA_REQUEST_ROW_TITLE[request.kind]}
          <Badge variant={statusVariant(request.status)}>{DATA_REQUEST_STATUS_TEXT[request.status]}</Badge>
        </p>
        <p className="text-sm text-muted-foreground">
          {[
            `Lo pidió ${request.requesterName} ${DATA_REQUEST_CHANNEL_PHRASE[request.channel]} el ${dayWords(request.requestedOn, locale)}`,
            request.said ? `«${request.said}»` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {pending ? (
          <p className={`text-sm font-medium ${late ? "text-destructive" : "text-warning"}`}>
            Responder hasta el {dayWords(request.dueOn, locale)} · {dueWords(today, request.dueOn)}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {DATA_REQUEST_STATUS_TEXT[request.status]}
            {request.resolvedByName ? ` por ${request.resolvedByName}` : ""}
            {request.resolution ? ` · ${request.resolution}` : ""}
          </p>
        )}
      </div>
      <Button type="button" size="sm" variant={pending ? "default" : "ghost"} onClick={onOpen}>
        {pending ? "Atender" : "Ver"}
      </Button>
    </li>
  )
}

const KIND_ORDER: DataRequestKind[] = ["copia", "corregir", "mensajes", "borrar"]
const CHANNEL_ORDER: DataRequestChannel[] = ["clinica", "whatsapp", "correo", "portal"]

function RegisterDrawer({
  patientId,
  view,
  locale,
  onClose,
}: {
  patientId: string
  view: DataRequestsView
  locale: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const create = useMutation({ mutationFn: (body: Parameters<typeof createDataRequestApi>[1]) => createDataRequestApi(patientId, body) })
  const schema = useMemo(
    () =>
      z.object({
        kind: z.custom<DataRequestKind | "">().refine((kind) => kind !== "", "Elige qué pide"),
        requesterContactId: z.string().min(1, "Elige quién lo pide"),
        channel: z.custom<DataRequestChannel | "">().refine((channel) => channel !== "", "Elige por dónde llegó"),
        requestedOn: z
          .string()
          .refine((day) => ISO_DAY.test(day), "Cuándo lo pidió: escribe una fecha completa")
          .refine((day) => !ISO_DAY.test(day) || day <= view.today, "Cuándo lo pidió: no puede ser una fecha futura"),
        said: z.string().max(MAX_TEXT, `Lo que dijo admite hasta ${MAX_TEXT} caracteres`),
      }),
    [view.today],
  )
  const form = useAppForm({
    defaultValues: {
      kind: "" as DataRequestKind | "",
      requesterContactId:
        view.requesters.find((r) => r.relation === "paciente")?.contactId ?? view.requesters[0]?.contactId ?? "",
      channel: "" as DataRequestChannel | "",
      requestedOn: view.today,
      said: "",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const created = await create.mutateAsync({
        kind: value.kind as DataRequestKind,
        requesterContactId: value.requesterContactId,
        channel: value.channel as DataRequestChannel,
        requestedOn: value.requestedOn,
        said: value.said.trim() || undefined,
      })
      await queryClient.invalidateQueries({ queryKey: dataRequestsKey(patientId) })
      toast.success(
        created.kind === "mensajes"
          ? "Pedido registrado: ya no le llegan recordatorios, controles ni novedades"
          : `Pedido registrado: responder hasta el ${dayWords(created.dueOn, locale)}`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const requestedOn = useStore(form.store, (state) => state.values.requestedOn)
  const validDay = ISO_DAY.test(requestedOn) && requestedOn <= view.today
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Registrar un pedido"
      submitLabel="Registrar"
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="kind">
          {(field) => (
            <field.Group legend="¿Qué pide?">
              {(control) => (
                <RadioGroup
                  id={control.id}
                  name={control.name}
                  value={field.state.value}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  onValueChange={(value) => {
                    field.handleChange(value as DataRequestKind)
                    field.handleBlur()
                  }}
                >
                  {KIND_ORDER.map((item) => (
                    <label
                      key={item}
                      htmlFor={`data-request-kind-${item}`}
                      className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5"
                    >
                      <RadioGroupItem
                        id={`data-request-kind-${item}`}
                        value={item}
                        className="mt-0.5"
                        aria-invalid={control.invalid || undefined}
                      />
                      <span>
                        <span className="font-medium">{DATA_REQUEST_KIND_TEXT[item].title}</span>
                        <span className="block text-muted-foreground">{DATA_REQUEST_KIND_TEXT[item].detail}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
        {/* Con una sola persona no hay nada que elegir: su rechazo se dice junto a los botones. */}
        {view.requesters.length > 1 ? (
          <form.AppField name="requesterContactId">
            {(field) => (
              <field.Group legend="Quién lo pide">
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value || null}
                    onChange={(next) => field.handleChange(next)}
                    options={view.requesters.map((r) => ({
                      value: r.contactId,
                      label: `${r.displayName} · ${r.relation === "paciente" ? "ella misma" : "representante legal"}`,
                    }))}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : (
          <p className="text-sm">
            Lo pide <strong>{view.requesters[0]?.displayName}</strong>
            {view.requesters[0]?.relation === "representante_legal" ? " (representante legal)" : ""}.
          </p>
        )}
        <form.AppField name="channel">
          {(field) => (
            <field.Group legend="Por dónde llegó">
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value || null}
                  onChange={(next) => field.handleChange(next)}
                  columns={2}
                  options={CHANNEL_ORDER.map((value) => ({ value, label: DATA_REQUEST_CHANNEL_TEXT[value] }))}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="requestedOn">
          {(field) => (
            <field.Control label="Cuándo lo pidió">
              {(control) => (
                <PastDateInput
                  id={control.id}
                  name={control.name}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  today={view.today}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="said">
          {(field) => <field.TextareaField label="Lo que dijo (opcional)" rows={2} maxLength={MAX_TEXT} />}
        </form.AppField>
        {validDay ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Responder hasta el {dayWords(addDays(requestedOn, DATA_REQUEST_DAYS), locale)}</p>
            <p className="text-sm text-muted-foreground">
              {DATA_REQUEST_DAYS} días, para cualquier pedido y en cualquier país. Es más corto que lo que piden las leyes de la
              región: respondiendo a tiempo, cumples en todas.
            </p>
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">Solo la propia persona, si es mayor de edad, o su representante legal vigente.</p>
      </div>
    </FormDrawer>
  )
}

const VERIFY_ORDER: DataRequestVerification[] = ["documento", "portal", "representante"]

function AttendDrawer({
  patientId,
  request,
  today,
  locale,
  canReadClinical,
  canErase,
  patientName,
  onClose,
}: {
  patientId: string
  request: DataRequest
  today: string
  locale: string
  canReadClinical: boolean
  canErase: boolean
  patientName: string | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: dataRequestsKey(patientId) })
  const pending = request.status === "pendiente"
  const verified = request.verifiedAt !== null
  const [how, setHow] = useState<DataRequestVerification>(
    request.requesterRelation === "representante_legal" ? "representante" : request.channel === "portal" ? "portal" : "documento",
  )
  const [denying, setDenying] = useState(false)
  const verify = useMutation({ mutationFn: () => verifyDataRequestApi(patientId, request.id, how), onSuccess: refresh })
  const respond = useMutation({ mutationFn: (resolution: string) => respondDataRequestApi(patientId, request.id, resolution) })
  const deny = useMutation({ mutationFn: (reason: string) => denyDataRequestApi(patientId, request.id, reason) })
  const respondForm = useAppForm({
    defaultValues: { resolution: "" },
    validators: {
      // Sin el paso 1 no hay respuesta que valga: se dice junto a «Marcar respondida».
      onSubmit: ({ value }) => {
        if (!verified) return { form: "Primero comprueba que es ella (paso 1)." }
        const parsed = resolutionSchema.safeParse(value)
        return parsed.success ? undefined : { fields: { resolution: parsed.error.issues[0]?.message ?? "" } }
      },
    },
    onSubmit: async ({ value }) => {
      await respond.mutateAsync(value.resolution.trim())
      await refresh()
      toast.success("Pedido respondido")
      onClose()
    },
  })
  const denyForm = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: denySchema },
    onSubmit: async ({ value }) => {
      await deny.mutateAsync(value.reason.trim())
      await refresh()
      toast.success("Pedido denegado")
      onClose()
    },
  })
  const respondSurface = useFormSurface(respondForm)
  const denySurface = useFormSurface(denyForm)
  const surface = denying ? denySurface : respondSurface
  const sendOptions = useQuery({
    queryKey: ["data-request-send-options", request.id],
    queryFn: () => fetchRecordSendOptions(patientId, request.id),
    enabled: pending && verified && request.kind === "copia",
  })
  const send = useMutation({
    mutationFn: (connectionId: string) => sendRecordCopyApi(patientId, request.id, connectionId),
    onSuccess: async (result) => {
      await refresh()
      toast.success(`Copia enviada por ${result.channel === "email" ? "correo" : "WhatsApp"}: el pedido quedó respondido`)
      onClose()
    },
  })
  const [erasing, setErasing] = useState(false)
  // Borrar se responde al borrar: no hay «Marcar respondida» (ADR 0080).
  const erase = request.kind === "borrar"

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={DATA_REQUEST_ROW_TITLE[request.kind]}
      description={
        pending
          ? `Responder hasta el ${dayWords(request.dueOn, locale)} · ${dueWords(today, request.dueOn)}`
          : `${DATA_REQUEST_STATUS_TEXT[request.status]}${request.resolvedByName ? ` por ${request.resolvedByName}` : ""}`
      }
      hideSubmit={!pending || (erase && !denying)}
      submitLabel={denying ? "Denegar" : "Marcar respondida"}
      cancelLabel={pending ? "Cerrar" : "Listo"}
      dock={false}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">
          Lo pidió {request.requesterName} {DATA_REQUEST_CHANNEL_PHRASE[request.channel]} el{" "}
          {dayWords(request.requestedOn, locale)}
          {request.said ? ` · «${request.said}»` : ""}
        </p>
        {!pending ? (
          <div className="rounded-lg border p-3">
            <p className="font-medium">{DATA_REQUEST_STATUS_TEXT[request.status]}</p>
            {request.resolution ? <p className="text-muted-foreground">{request.resolution}</p> : null}
            {request.verifiedHow ? (
              <p className="text-muted-foreground">
                Se comprobó: {DATA_REQUEST_VERIFICATION_TEXT[request.verifiedHow].toLowerCase()}
                {request.verifiedByName ? ` · ${request.verifiedByName}` : ""}
              </p>
            ) : null}
          </div>
        ) : denying ? (
          <div className="flex flex-col gap-2">
            <denyForm.AppField name="reason">
              {(field) => (
                <field.TextareaField
                  label="¿Por qué se deniega?"
                  rows={3}
                  maxLength={MAX_TEXT}
                  description="Se le dice a la persona. Por ejemplo: «No pudimos comprobar que la pide ella»."
                />
              )}
            </denyForm.AppField>
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setDenying(false)}>
              Volver
            </Button>
          </div>
        ) : (
          <>
            <Step number={1} done={verified} title={verified ? "Comprobaste que es ella" : "Comprueba que es ella"}>
              {verified ? (
                <p className="text-muted-foreground">
                  {request.verifiedHow ? DATA_REQUEST_VERIFICATION_TEXT[request.verifiedHow] : ""}
                  {request.verifiedByName ? ` · ${request.verifiedByName}` : ""}
                </p>
              ) : (
                <>
                  <FieldSet>
                    <FieldLegend className="sr-only">Cómo comprobaste que es ella</FieldLegend>
                    <RadioGroup
                      value={how}
                      aria-invalid={verify.error ? true : undefined}
                      aria-describedby={verify.error ? "data-request-verify-error" : undefined}
                      onValueChange={(value) => setHow(value as DataRequestVerification)}
                    >
                      {VERIFY_ORDER.filter((item) =>
                        request.requesterRelation === "representante_legal" ? item !== "documento" : item !== "representante",
                      ).map((item) => (
                        <label key={item} htmlFor={`data-request-how-${item}`} className="flex min-h-11 cursor-pointer items-center gap-3">
                          <RadioGroupItem id={`data-request-how-${item}`} value={item} />
                          {DATA_REQUEST_VERIFICATION_TEXT[item]}
                        </label>
                      ))}
                    </RadioGroup>
                  </FieldSet>
                  <p className="text-muted-foreground">Nunca porque escribió desde su número.</p>
                  <Button type="button" size="sm" className="self-start" disabled={verify.isPending} onClick={() => verify.mutate()}>
                    Comprobé que es ella
                  </Button>
                  {verify.error ? (
                    <p id="data-request-verify-error" role="alert" className="text-destructive">
                      {submitErrorMessage(verify.error)}
                    </p>
                  ) : null}
                </>
              )}
            </Step>
            <Step
              number={2}
              done={false}
              disabled={!verified}
              title={request.kind === "copia" ? "Envía la copia" : erase ? "Borra sus datos y bloquea su historia" : "Haz lo que pidió"}
            >
              {erase ? (
                <div className="flex flex-col gap-2">
                  <p className="text-muted-foreground">
                    Se borra lo que no es clínico: sus conversaciones, oportunidades, tareas, notas, correo y lo que el agente
                    recuerda. Su historia clínica, sus cobros y sus comprobantes se guardan bloqueados, porque la ley lo pide. El
                    pedido queda respondido solo.
                  </p>
                  {canErase ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="self-start"
                      disabled={!verified}
                      onClick={() => setErasing(true)}
                    >
                      Revisar y borrar…
                    </Button>
                  ) : (
                    <p className="font-medium">Lo hace Administración: avísale que ya comprobaste que es ella.</p>
                  )}
                </div>
              ) : request.kind === "copia" ? (
                verified ? (
                  <div className="flex flex-col gap-2">
                    {sendOptions.isPending ? <p className="text-muted-foreground">Buscando por dónde enviarla…</p> : null}
                    {sendOptions.data && sendOptions.data.channels.length === 0 ? (
                      <p className="text-muted-foreground">No tiene WhatsApp ni correo para enviársela: entrégala en mano.</p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {(sendOptions.data?.channels ?? []).map((option) => (
                        <Button
                          key={option.connectionId}
                          type="button"
                          size="sm"
                          variant={option.isProposed ? "default" : "outline"}
                          disabled={!option.usable || send.isPending}
                          title={option.reason ?? undefined}
                          onClick={() => send.mutate(option.connectionId)}
                        >
                          Enviar por {option.channel === "email" ? "correo" : "WhatsApp"}
                        </Button>
                      ))}
                      {canReadClinical ? (
                        <a className={buttonVariants({ variant: "outline", size: "sm" })} href={patientRecordDownloadUrl(patientId)} download>
                          Descargar
                        </a>
                      ) : null}
                    </div>
                    <p className="text-muted-foreground">
                      Le llega el PDF de su historia; el pedido queda respondido solo. Se envía únicamente a ella o a su
                      representante legal.
                      {canReadClinical ? " «Descargar» trae además el archivo FHIR y sus imágenes, para entregarlo en mano." : ""}
                    </p>
                    {send.error ? (
                      <p role="alert" className="text-destructive">
                        {submitErrorMessage(send.error)}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground">Primero comprueba que es ella.</p>
                )
              ) : (
                <p className="text-muted-foreground">
                  Un dato personal se corrige en «Datos personales». Lo clínico lo corrige el {appWords().clinician.one} con una adenda: nunca se
                  reescribe lo firmado.
                </p>
              )}
            </Step>
            {erase ? null : (
            <Step number={3} done={false} disabled={!verified} title="Responde">
              <respondForm.AppField name="resolution">
                {(field) => (
                  <field.TextareaField
                    label="Qué se entregó o qué se hizo"
                    rows={2}
                    maxLength={MAX_TEXT}
                    disabled={!verified}
                    placeholder={request.kind === "copia" ? "Se le entregó en mano el 23 oct" : "Se cambió su dirección"}
                  />
                )}
              </respondForm.AppField>
            </Step>
            )}
            <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={() => setDenying(true)}>
              Denegar…
            </Button>
          </>
        )}
      </div>
      {erasing ? (
        <EraseDialog
          patientId={patientId}
          request={request}
          patientName={patientName}
          locale={locale}
          onClose={() => setErasing(false)}
          onDone={onClose}
        />
      ) : null}
    </FormDrawer>
  )
}

/** Cómo se comprobó, después de por dónde llegó: sin repetir «en la clínica». */
const ERASE_VERIFIED_TEXT: Record<DataRequestVerification, string> = {
  documento: "comprobado con su documento",
  portal: "desde su portal",
  representante: "su representante legal, con su documento",
}

/** «46 mensajes», «1 oportunidad». */
function countWords(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * «¿Borrar los datos de…?» (tablero 6): lo que se borra, lo que se guarda
 * bloqueado y lo que hay que saber antes (su cita por venir, lo que debe).
 * Se confirma escribiendo BORRAR: no se puede deshacer.
 */
function EraseDialog({
  patientId,
  request,
  patientName,
  locale,
  onClose,
  onDone,
}: {
  patientId: string
  request: DataRequest
  patientName: string | null
  locale: string
  onClose: () => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const preview = useQuery({
    queryKey: ["data-request-erase-preview", request.id],
    queryFn: () => fetchErasurePreview(patientId, request.id),
  })
  const erase = useMutation({ mutationFn: () => eraseDataApi(patientId, request.id) })
  const form = useAppForm({
    defaultValues: { typed: "" },
    validators: { onSubmit: eraseSchema },
    onSubmit: async () => {
      await erase.mutateAsync()
      toast.success("Se borraron sus datos y su historia quedó bloqueada")
      onDone()
      // La ficha ya no existe para el equipo: la página pasa a la historia bloqueada.
      await queryClient.invalidateQueries()
    },
  })
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const submitError = useFormSubmitError(form)
  const verifiedText = request.verifiedHow ? ` · ${ERASE_VERIFIED_TEXT[request.verifiedHow]}` : ""
  return (
    <ConfirmDialog
      open
      title={`¿Borrar los datos de ${patientName ?? "esta persona"}?`}
      description={`Lo pidió ${request.requesterName} ${DATA_REQUEST_CHANNEL_PHRASE[request.channel]} el ${dayWords(request.requestedOn, locale)}${verifiedText}.`}
      confirmLabel="Borrar y bloquear"
      pending={submitting}
      // Sin el resumen a la vista no se confirma: lo dice «Revisando…» o su error.
      confirmDisabled={!preview.data}
      error={submitError}
      onConfirm={() => void submitForm(form)}
      onClose={onClose}
    >
      {preview.isPending ? <LoadingState message="Revisando lo que se borra…" /> : null}
      {preview.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {problemOf(preview.error)}
        </p>
      ) : null}
      {preview.data ? <ErasureSummary preview={preview.data} locale={locale} /> : null}
      <form.AppField name="typed">
        {(field) => (
          <field.TextField
            label="Escribe BORRAR para confirmar"
            autoComplete="off"
            placeholder="BORRAR"
            description="Lo que se borra no se puede recuperar. Queda en la Actividad del equipo y el pedido pasa a «Respondida» con el detalle."
          />
        )}
      </form.AppField>
    </ConfirmDialog>
  )
}

function ErasureSummary({ preview, locale }: { preview: ErasurePreview; locale: string }) {
  const erased = [
    preview.conversations
      ? `Sus conversaciones: ${countWords(preview.conversations, "conversación", "conversaciones")}, ${countWords(preview.messages, "mensaje", "mensajes")}`
      : null,
    preview.opportunities + preview.tasks > 0 ? `Sus oportunidades y tareas: ${preview.opportunities + preview.tasks}` : null,
    preview.notes ? `Sus notas: ${preview.notes}` : null,
    "Correo y etiquetas",
    "Lo que el agente recuerda de ella",
    "Sus permisos de mensajes: no se le escribe más",
  ].filter((item): item is string => item !== null)
  const appointments = preview.futureAppointments.map((a) => formatDateTime(a.startsAt))
  const debts = preview.balances.map((b) => formatMoney(b.cents, b.currency, locale))
  const one = appointments.length === 1
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <p className="font-semibold text-destructive">Se borra ahora</p>
        <ul className="mt-1 list-disc pl-5 text-muted-foreground">
          {erased.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div className="rounded-lg border bg-muted/40 p-3">
        <p className="font-semibold">Se guarda bloqueado</p>
        <ul className="mt-1 list-disc pl-5 text-muted-foreground">
          <li>Su historia clínica: la ley pide guardarla años</li>
          <li>Sus cobros y comprobantes: los pide la ley tributaria</li>
          <li>Nombre, documento y teléfono, solo dentro de la historia</li>
        </ul>
        <p className="mt-2 text-muted-foreground">
          No sale en búsquedas, agenda, listas ni reportes, y el agente no la ve. Solo Administración la abre, con motivo.
        </p>
      </div>
      {preview.linkedPeople ? (
        <p className="text-muted-foreground">
          Lo que sus personas vinculadas tienen por su cuenta, como sus conversaciones, no se borra: es de ellas.
        </p>
      ) : null}
      {appointments.length || debts.length ? (
        <p className="rounded-lg bg-warning-soft p-3 text-warning">
          <strong>Antes de borrar: </strong>
          {appointments.length
            ? `tiene ${one ? "una cita" : `${appointments.length} citas`} (${appointments.join(", ")}), que se cancela${one ? "" : "n"} sin avisarle. `
            : ""}
          {debts.length ? `Debe ${debts.join(" y ")}, que se mantiene en Caja. ` : ""}
          {appointments.length ? `Si prefiere conservar ${one ? "la cita" : "las citas"}, deniega el pedido o espera a después.` : ""}
        </p>
      ) : null}
    </div>
  )
}

function Step({
  number,
  done,
  disabled = false,
  title,
  children,
}: {
  number: number
  done: boolean
  disabled?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <section className={`flex flex-col gap-2 rounded-lg border p-3 ${disabled ? "opacity-60" : ""}`} aria-disabled={disabled}>
      <p className="flex items-center gap-2 font-medium">
        <span
          aria-hidden="true"
          className={`flex size-6 items-center justify-center rounded-full text-xs ${done ? "bg-success text-white" : "bg-primary text-primary-foreground"}`}
        >
          {done ? "✓" : number}
        </span>
        {title}
      </p>
      {children}
    </section>
  )
}
