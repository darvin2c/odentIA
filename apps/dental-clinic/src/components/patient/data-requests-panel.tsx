import {
  Badge,
  Button,
  buttonVariants,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  Textarea,
  toast,
} from "@odentia/ui"
import { EmptyState, ErrorState, FormDrawer, LoadingState, PastDateInput } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FileText, MessageSquareOff, PencilLine } from "lucide-react"
import { useState } from "react"
import { ChoiceButtons } from "../choice-buttons"
import { ApiError } from "../../lib/api"
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
  fetchDataRequests,
  fetchRecordSendOptions,
  patientRecordDownloadUrl,
  respondDataRequestApi,
  sendRecordCopyApi,
  verifyDataRequestApi,
} from "../../lib/data-requests"
import { useOrgLocale } from "../../lib/locale"

function problemOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof ApiError
    ? (error.shape.message ?? "No pudimos completar la acción.")
    : "No pudimos completar la acción. Revisa tu conexión."
}

const KIND_ICON = { copia: FileText, corregir: PencilLine, mensajes: MessageSquareOff } as const

/**
 * Datos › Pedidos sobre sus datos (ADR 0080): lo que la persona o su
 * representante pidieron, con su plazo de 10 días. Lo atienden Recepción y
 * Administración; «Descargar historia» es solo de quien lee la ficha clínica,
 * porque lleva todo lo clínico.
 */
export function DataRequestsPanel({ patientId }: { patientId: string }) {
  const canManage = usePermission("patients.write")
  const canReadClinical = usePermission("clinical.read")
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
  if (query.isPending) return <LoadingState message="Cargando sus pedidos…" />
  if (query.isError)
    return (
      <ErrorState
        title="No pudimos cargar sus pedidos"
        message={problemOf(query.error) ?? ""}
        onRetry={() => void query.refetch()}
      />
    )
  const view = query.data
  const firstName = view.requesters.find((r) => r.relation === "paciente")?.displayName.split(" ")[0] ?? "La persona"
  const open = view.requests.find((r) => r.id === attending) ?? null

  return (
    <section aria-label="Pedidos sobre sus datos" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Pedidos sobre sus datos</h2>
          <p className="text-sm text-muted-foreground">
            Lo que ella o su representante pidieron: una copia, corregir o no recibir mensajes. Cada uno se responde en{" "}
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
          onClose={() => setAttending(null)}
        />
      ) : null}
    </section>
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

const KIND_ORDER: DataRequestKind[] = ["copia", "corregir", "mensajes"]
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
  const [kind, setKind] = useState<DataRequestKind | null>(null)
  const [requester, setRequester] = useState(view.requesters.find((r) => r.relation === "paciente")?.contactId ?? view.requesters[0]?.contactId ?? "")
  const [channel, setChannel] = useState<DataRequestChannel | null>(null)
  const [requestedOn, setRequestedOn] = useState(view.today)
  const [said, setSaid] = useState("")
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(requestedOn) && requestedOn <= view.today
  const create = useMutation({
    mutationFn: () =>
      createDataRequestApi(patientId, {
        kind: kind as DataRequestKind,
        requesterContactId: requester,
        channel: channel as DataRequestChannel,
        requestedOn,
        said: said.trim() || undefined,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: dataRequestsKey(patientId) })
      toast.success(
        created.kind === "mensajes"
          ? "Pedido registrado: ya no le llegan recordatorios, controles ni novedades"
          : `Pedido registrado: responder hasta el ${dayWords(created.dueOn, locale)}`,
      )
      onClose()
    },
  })
  const ready = kind !== null && channel !== null && requester !== "" && validDay
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Registrar un pedido"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) create.mutate()
      }}
      isDirty={kind !== null || channel !== null || said.trim() !== ""}
      isSubmitting={create.isPending}
      submitDisabled={!ready}
      error={problemOf(create.error)}
      submitLabel="Registrar"
    >
      <div className="flex flex-col gap-5">
        <FieldSet>
          <FieldLegend variant="label">¿Qué pide?</FieldLegend>
          <RadioGroup value={kind ?? ""} onValueChange={(value) => setKind(value as DataRequestKind)}>
            {KIND_ORDER.map((item) => (
              <label
                key={item}
                htmlFor={`data-request-kind-${item}`}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5"
              >
                <RadioGroupItem id={`data-request-kind-${item}`} value={item} className="mt-0.5" />
                <span>
                  <span className="font-medium">{DATA_REQUEST_KIND_TEXT[item].title}</span>
                  <span className="block text-muted-foreground">{DATA_REQUEST_KIND_TEXT[item].detail}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </FieldSet>
        {view.requesters.length > 1 ? (
          <Field>
            <FieldLabel>Quién lo pide</FieldLabel>
            <ChoiceButtons
              label="Quién lo pide"
              value={requester}
              onChange={setRequester}
              options={view.requesters.map((r) => ({
                value: r.contactId,
                label: `${r.displayName} · ${r.relation === "paciente" ? "ella misma" : "representante legal"}`,
              }))}
            />
          </Field>
        ) : (
          <p className="text-sm">
            Lo pide <strong>{view.requesters[0]?.displayName}</strong>
            {view.requesters[0]?.relation === "representante_legal" ? " (representante legal)" : ""}.
          </p>
        )}
        <Field>
          <FieldLabel>Por dónde llegó</FieldLabel>
          <ChoiceButtons
            label="Por dónde llegó"
            value={channel}
            onChange={setChannel}
            columns={2}
            options={CHANNEL_ORDER.map((value) => ({ value, label: DATA_REQUEST_CHANNEL_TEXT[value] }))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="data-request-day">Cuándo lo pidió</FieldLabel>
          <PastDateInput id="data-request-day" value={requestedOn} today={view.today} onChange={(next) => setRequestedOn(next)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="data-request-said">Lo que dijo (opcional)</FieldLabel>
          <Textarea id="data-request-said" rows={2} maxLength={1000} value={said} onChange={(event) => setSaid(event.target.value)} />
        </Field>
        {validDay ? (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Responder hasta el {dayWords(addDays(requestedOn, DATA_REQUEST_DAYS), locale)}</p>
            <FieldDescription>
              {DATA_REQUEST_DAYS} días, para cualquier pedido y en cualquier país. Es más corto que lo que piden las leyes de la
              región: respondiendo a tiempo, cumples en todas.
            </FieldDescription>
          </div>
        ) : null}
        <FieldDescription>Solo la propia persona, si es mayor de edad, o su representante legal vigente.</FieldDescription>
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
  onClose,
}: {
  patientId: string
  request: DataRequest
  today: string
  locale: string
  canReadClinical: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: dataRequestsKey(patientId) })
  const pending = request.status === "pendiente"
  const verified = request.verifiedAt !== null
  const [how, setHow] = useState<DataRequestVerification>(
    request.requesterRelation === "representante_legal" ? "representante" : request.channel === "portal" ? "portal" : "documento",
  )
  const [resolution, setResolution] = useState("")
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState("")
  const verify = useMutation({ mutationFn: () => verifyDataRequestApi(patientId, request.id, how), onSuccess: refresh })
  const respond = useMutation({
    mutationFn: () => respondDataRequestApi(patientId, request.id, resolution.trim()),
    onSuccess: async () => {
      await refresh()
      toast.success("Pedido respondido")
      onClose()
    },
  })
  const deny = useMutation({
    mutationFn: () => denyDataRequestApi(patientId, request.id, reason.trim()),
    onSuccess: async () => {
      await refresh()
      toast.success("Pedido denegado")
      onClose()
    },
  })
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
  const error = problemOf(verify.error ?? respond.error ?? deny.error ?? send.error)

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={DATA_REQUEST_ROW_TITLE[request.kind]}
      description={
        pending
          ? `Responder hasta el ${dayWords(request.dueOn, locale)} · ${dueWords(today, request.dueOn)}`
          : `${DATA_REQUEST_STATUS_TEXT[request.status]}${request.resolvedByName ? ` por ${request.resolvedByName}` : ""}`
      }
      onSubmit={(event) => {
        event.preventDefault()
        if (denying && reason.trim()) deny.mutate()
        else if (verified && resolution.trim()) respond.mutate()
      }}
      isSubmitting={respond.isPending || deny.isPending}
      submitDisabled={denying ? !reason.trim() : !(verified && resolution.trim())}
      hideSubmit={!pending}
      submitLabel={denying ? "Denegar" : "Marcar respondida"}
      cancelLabel={pending ? "Cerrar" : "Listo"}
      error={error}
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
          <Field>
            <FieldLabel htmlFor="data-request-deny">¿Por qué se deniega?</FieldLabel>
            <Textarea id="data-request-deny" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
            <FieldDescription>Se le dice a la persona. Por ejemplo: «No pudimos comprobar que la pide ella».</FieldDescription>
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setDenying(false)}>
              Volver
            </Button>
          </Field>
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
                  <RadioGroup value={how} onValueChange={(value) => setHow(value as DataRequestVerification)}>
                    {VERIFY_ORDER.filter((item) =>
                      request.requesterRelation === "representante_legal" ? item !== "documento" : item !== "representante",
                    ).map((item) => (
                      <label key={item} htmlFor={`data-request-how-${item}`} className="flex min-h-11 cursor-pointer items-center gap-3">
                        <RadioGroupItem id={`data-request-how-${item}`} value={item} />
                        {DATA_REQUEST_VERIFICATION_TEXT[item]}
                      </label>
                    ))}
                  </RadioGroup>
                  <p className="text-muted-foreground">Nunca porque escribió desde su número.</p>
                  <Button type="button" size="sm" className="self-start" disabled={verify.isPending} onClick={() => verify.mutate()}>
                    Comprobé que es ella
                  </Button>
                </>
              )}
            </Step>
            <Step number={2} done={false} disabled={!verified} title={request.kind === "copia" ? "Envía la copia" : "Haz lo que pidió"}>
              {request.kind === "copia" ? (
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
                  </div>
                ) : (
                  <p className="text-muted-foreground">Primero comprueba que es ella.</p>
                )
              ) : (
                <p className="text-muted-foreground">
                  Un dato personal se corrige en «Datos personales». Lo clínico lo corrige el odontólogo con una adenda: nunca se
                  reescribe lo firmado.
                </p>
              )}
            </Step>
            <Step number={3} done={false} disabled={!verified} title="Responde">
              <Field>
                <FieldLabel htmlFor="data-request-resolution">Qué se entregó o qué se hizo</FieldLabel>
                <Textarea
                  id="data-request-resolution"
                  rows={2}
                  disabled={!verified}
                  value={resolution}
                  placeholder={request.kind === "copia" ? "Se le entregó en mano el 23 oct" : "Se cambió su dirección"}
                  onChange={(event) => setResolution(event.target.value)}
                />
              </Field>
            </Step>
            <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={() => setDenying(true)}>
              Denegar…
            </Button>
          </>
        )}
      </div>
    </FormDrawer>
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
