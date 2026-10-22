import {
  Button,
  Checkbox,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from "@odentia/ui"
import { DataRefreshMarker, ErrorState, FormDrawer, SubmitButton } from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { FileText, Send } from "lucide-react"
import { useEffect, useId, useState, type ReactNode } from "react"
import { ApiError, apiFetch, apiFetchBytes } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { ChoiceSelect } from "../ui/choice-select"

export interface SendFinancialDocumentProps {
  patientId: string
  /** «return»: la devolución de un cobro (ADR 0068), de caja como el ticket. */
  documentType: "ticket" | "budget" | "return"
  documentId: string
  trigger?: ReactNode
  onSent?: (info: { conversationId: string; messageId: string }) => void
  /** Layout del envoltorio del botón que abre el panel. */
  className?: string
}

interface ChannelOption {
  channel: string
  connectionId: string
  connectionName: string
  provider: string
  usable: boolean
  reason: string | null
  hasThread: boolean
  isPreferred: boolean
  isProposed: boolean
}

interface RecipientOption {
  contactId: string
  displayName: string
  email: string | null
  phone: string | null
  relation: string
  isDefault: boolean
}

interface SendOptions {
  recipients: RecipientOption[]
  recipient: RecipientOption
  channels: ChannelOption[]
  proposed: ChannelOption | null
  document: { type: string; label: string; statusLabel: string; isDraft: boolean }
  /** Mensaje propuesto por el servidor; aquí solo se edita. */
  message: string
}

interface SendResult {
  conversationId: string
  messageId: string
  status: string
  channel: string
  sentToEmail?: string | null
}

const MAX_MESSAGE = 500

const RELATION_LABELS: Record<string, string> = {
  paciente: "paciente",
  representante_legal: "representante legal",
  responsable_economico: "responsable económico",
  autorizado_informacion: "autorizado para información",
}

function channelLabel(channel: string): string {
  if (channel === "email") return "Correo"
  if (channel === "whatsapp") return "WhatsApp"
  if (channel === "telegram") return "Telegram"
  if (channel === "messenger") return "Messenger"
  if (channel === "instagram") return "Instagram"
  return channel
}

/** El mensaje del servidor se muestra tal cual; el respaldo solo si no hay ninguno. */
function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.shape.message ?? fallback
  if (err instanceof TypeError) return "No hay conexión con el servidor. Revisa tu conexión e inténtalo de nuevo."
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * «Enviar al paciente»: manda el ticket o el presupuesto en PDF (el mismo del
 * servidor que se imprime) y lo deja en la conversación de la persona. El
 * servidor propone el canal —correo si la persona tiene uno, si no su medio
 * preferido— y quien envía puede cambiarlo, igual que el destinatario y el
 * mensaje. Cada apertura lleva su clave: reintentar o un doble clic no manda
 * el documento dos veces. Lo que responde el servidor es «en cola»: nunca se
 * presenta como entregado.
 */
export function SendFinancialDocument({
  patientId,
  documentType,
  documentId,
  trigger,
  onSent,
  className,
}: SendFinancialDocumentProps) {
  const uid = useId()
  const navigate = useNavigate()
  const canConfigure = usePermission("settings.read")
  const canInbox = usePermission("conversations.read")
  const [open, setOpen] = useState(false)
  // null = el destinatario y el canal que propone el servidor.
  const [recipientId, setRecipientId] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [choosingRecipient, setChoosingRecipient] = useState(false)
  // null = el mensaje propuesto, sin tocar.
  const [message, setMessage] = useState<string | null>(null)
  const [savePreferred, setSavePreferred] = useState(false)
  const [sent, setSent] = useState<SendResult | null>(null)
  const [viewing, setViewing] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  // Correo escrito en el momento: para enviarlo ahí esta vez, o para guardarlo en sus datos.
  const [emailMode, setEmailMode] = useState<"otro" | "agregar" | null>(null)
  const [emailText, setEmailText] = useState("")
  const [emailConfirmed, setEmailConfirmed] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)

  const optionsQuery = useQuery({
    queryKey: ["financial-document-options", patientId, documentType, documentId, recipientId],
    queryFn: () => {
      const params = new URLSearchParams({ documentType, documentId })
      if (recipientId) params.set("recipientContactId", recipientId)
      return apiFetch<{ data: SendOptions }>(
        `/api/patients/${patientId}/financial-document-options?${params}`,
      )
    },
    enabled: open,
    // Al cambiar de destinatario se conserva la lista mientras llegan sus canales.
    placeholderData: keepPreviousData,
  })
  const options = optionsQuery.data?.data ?? null
  const refreshing = optionsQuery.isPlaceholderData

  const sendMutation = useMutation({
    mutationFn: (input: {
      connectionId: string
      recipientContactId: string
      message: string
      otherEmail: string | null
    }) =>
      apiFetch<{ data: SendResult }>(`/api/patients/${patientId}/financial-documents/send`, {
        method: "POST",
        body: JSON.stringify({
          documentType,
          documentId,
          recipientContactId: input.recipientContactId,
          connectionId: input.connectionId,
          message: input.message || null,
          savePreferredChannel: savePreferred,
          requestId,
          ...(input.otherEmail ? { otherEmail: input.otherEmail, confirmOtherEmail: true } : {}),
        }),
      }),
    onSuccess: (result) => {
      setSent(result.data)
      onSent?.({ conversationId: result.data.conversationId, messageId: result.data.messageId })
    },
  })
  const resetSend = sendMutation.reset

  const saveEmailMutation = useMutation({
    mutationFn: (input: { recipientContactId: string; email: string }) =>
      apiFetch(`/api/patients/${patientId}/financial-documents/recipient-email`, {
        method: "POST",
        body: JSON.stringify({ documentType, ...input }),
      }),
    onSuccess: () => {
      setEmailMode(null)
      setEmailText("")
      setEmailError(null)
      setConnectionId(null)
      void optionsQuery.refetch()
    },
    onError: (err) => setEmailError(errorMessage(err, "No se pudo guardar el correo.")),
  })

  // Cada apertura (o documento) es un intento nuevo: borrador limpio y clave nueva.
  useEffect(() => {
    if (!open) return
    setRecipientId(null)
    setConnectionId(null)
    setChoosingRecipient(false)
    setMessage(null)
    setSavePreferred(false)
    setSent(null)
    setViewError(null)
    setEmailMode(null)
    setEmailText("")
    setEmailConfirmed(false)
    setEmailError(null)
    setRequestId(crypto.randomUUID())
    resetSend()
  }, [open, patientId, documentType, documentId, resetSend])

  const recipient = options?.recipient ?? null
  const patientPerson = options?.recipients.find((item) => item.relation === "paciente") ?? null
  const channels = options?.channels ?? []
  const emailChannel = channels.find((item) => item.channel === "email") ?? null
  // Con otro correo se envía por el buzón de la clínica aunque la persona no tenga uno registrado.
  const otherEmail = emailMode === "otro" ? emailText.trim() : ""
  const sendingToOther = emailMode === "otro" && emailChannel !== null
  const selected = sendingToOther
    ? emailChannel
    : (channels.find((item) => item.connectionId === connectionId && item.usable) ??
      (options?.proposed && options.proposed.usable ? options.proposed : null))
  const usableCount = channels.filter((item) => item.usable).length
  const canSend = usableCount > 0 || sendingToOther

  const proposedMessage = options?.message ?? ""
  const messageText = message ?? proposedMessage

  const viewPdf = async () => {
    if (viewing) return
    // La pestaña se abre en el clic para que el navegador no la bloquee.
    const tab = window.open("", "_blank")
    if (tab) tab.opener = null
    setViewing(true)
    setViewError(null)
    try {
      const bytes = await apiFetchBytes(
        `/api/patients/${patientId}/financial-document-pdf?documentType=${documentType}&documentId=${documentId}`,
      )
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
      if (tab && !tab.closed) tab.location.href = url
      else window.open(url, "_blank", "noopener")
      window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
    } catch (err) {
      if (tab && !tab.closed) tab.close()
      setViewError(errorMessage(err, "No se pudo generar el documento."))
    } finally {
      setViewing(false)
    }
  }

  const close = () => {
    if (!sendMutation.isPending) setOpen(false)
  }

  const submit = () => {
    if (!recipient || !selected || refreshing) return
    if (sendingToOther) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(otherEmail)) {
        setEmailError("Escribe un correo válido.")
        return
      }
      if (!emailConfirmed) {
        setEmailError("Marca la confirmación para enviarlo a ese correo.")
        return
      }
    }
    setEmailError(null)
    sendMutation.mutate({
      connectionId: selected.connectionId,
      recipientContactId: recipient.contactId,
      message: messageText.trim(),
      otherEmail: sendingToOther ? otherEmail : null,
    })
  }

  const channelTitle = (item: ChannelOption) =>
    channels.filter((other) => other.channel === item.channel).length > 1
      ? `${channelLabel(item.channel)} · ${item.connectionName}`
      : channelLabel(item.channel)
  const channelAddress = (item: ChannelOption) =>
    item.channel === "email" ? recipient?.email : item.channel === "whatsapp" ? recipient?.phone : null

  return (
    <>
      <span onClick={() => setOpen(true)} className={cn("inline-flex", className)}>
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <Send aria-hidden />
            Enviar al paciente
          </Button>
        )}
      </span>
      <FormDrawer
        open={open}
        title="Enviar"
        headerContent={
          options && recipient ? (
            <p className="break-words font-heading text-lg font-semibold">
              {options.document.label} a {recipient.displayName}
            </p>
          ) : undefined
        }
        isLoading={optionsQuery.isPending}
        isSubmitting={sendMutation.isPending}
        isDirty={!sent && message !== null && message !== proposedMessage}
        error={
          sendMutation.isError
            ? `${errorMessage(sendMutation.error, "No se pudo enviar.")} Tu mensaje se conserva: puedes intentarlo otra vez sin que se envíe dos veces.`
            : null
        }
        hideSubmit={sent !== null || !options || !canSend}
        submitDisabled={!selected || refreshing}
        submitLabel={selected ? `Enviar por ${channelLabel(selected.channel).toLowerCase()}` : "Enviar"}
        cancelLabel={sent ? "Listo" : undefined}
        onClose={close}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {sent ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
              {sent.status === "queued"
                ? `Quedó en cola para enviarse por ${channelLabel(sent.channel).toLowerCase()}${sent.sentToEmail ? ` a ${sent.sentToEmail}` : ""}. Todavía no está entregado: la conversación mostrará si llegó.`
                : `Enviado por ${channelLabel(sent.channel).toLowerCase()}${sent.sentToEmail ? ` a ${sent.sentToEmail}` : ""}. Queda en la conversación de la persona.`}
            </p>
            {canInbox ? (
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => {
                  setOpen(false)
                  void navigate({ to: "/inbox", search: { conversation: sent.conversationId } })
                }}
              >
                Ver en la bandeja
              </Button>
            ) : null}
          </div>
        ) : optionsQuery.isError || !options || !recipient ? (
          <ErrorState
            title="No se pudo preparar el envío"
            message={errorMessage(optionsQuery.error, "No se pudieron consultar los canales.")}
            onRetry={() => void optionsQuery.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-sm">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 break-words font-medium">{options.document.label}.pdf</span>
              <SubmitButton size="sm" variant="ghost" pending={viewing} onClick={() => void viewPdf()}>
                Ver
              </SubmitButton>
            </div>
            {viewError ? (
              <p role="alert" className="text-sm text-destructive">
                {viewError}
              </p>
            ) : null}
            {options.document.isDraft ? (
              <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
                Está en borrador: al enviarlo queda entregado al paciente.
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span id={`${uid}-canal`} className="text-sm font-semibold">
                  Por dónde
                </span>
                {refreshing ? <DataRefreshMarker message="Buscando sus canales" /> : null}
              </div>
              {channels.length === 0 ? (
                <div className="flex flex-col gap-2 rounded-xl border px-3 py-3 text-sm">
                  <p>
                    La clínica no tiene ningún canal conectado para enviar documentos.{" "}
                    {canConfigure ? "" : "Pídele a quien administra la clínica que conecte uno."}
                  </p>
                  {canConfigure ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="self-start"
                      onClick={() => {
                        setOpen(false)
                        void navigate({ to: "/settings/integrations" })
                      }}
                    >
                      Conectar un canal
                    </Button>
                  ) : null}
                </div>
              ) : (
                <RadioGroup
                  aria-labelledby={`${uid}-canal`}
                  value={selected?.connectionId ?? ""}
                  disabled={sendingToOther}
                  onValueChange={(next) => setConnectionId(String(next))}
                >
                  {channels.map((item) => (
                    <FieldLabel
                      key={item.connectionId}
                      className={cn(
                        "flex min-h-11 w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm font-normal",
                        item.usable ? "cursor-pointer" : "opacity-70",
                        selected?.connectionId === item.connectionId && "border-primary bg-primary-soft",
                      )}
                    >
                      <RadioGroupItem
                        className="mt-0.5"
                        value={item.connectionId}
                        disabled={!item.usable || refreshing || sendMutation.isPending}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="font-medium">{channelTitle(item)}</span>
                        {channelAddress(item) ? (
                          <span className="break-all text-muted-foreground">{channelAddress(item)}</span>
                        ) : null}
                        {!item.usable && item.reason ? (
                          <span className="text-muted-foreground">{item.reason}</span>
                        ) : null}
                      </span>
                      {item.usable && (item.isPreferred || item.channel === "email") ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {item.isPreferred ? "Su medio preferido" : "Para documentos"}
                        </span>
                      ) : null}
                    </FieldLabel>
                  ))}
                </RadioGroup>
              )}
              {emailChannel && !recipient.email && emailMode === null ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">{recipient.displayName} no tiene correo registrado.</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEmailMode("agregar")
                      setEmailText("")
                      setEmailError(null)
                    }}
                  >
                    Agregar correo
                  </Button>
                </div>
              ) : channels.length > 0 && usableCount === 0 && emailMode === null ? (
                <p className="text-sm text-muted-foreground">
                  Por ahora no hay por dónde enviárselo a {recipient.displayName}.
                </p>
              ) : null}
              {emailMode ? (
                <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
                  <Field>
                    <FieldLabel htmlFor={`${uid}-correo`}>
                      {emailMode === "agregar" ? `Correo de ${recipient.displayName}` : "Otro correo"}
                    </FieldLabel>
                    <Input
                      id={`${uid}-correo`}
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      autoFocus
                      maxLength={200}
                      value={emailText}
                      disabled={saveEmailMutation.isPending || sendMutation.isPending}
                      onChange={(event) => {
                        setEmailText(event.target.value)
                        setEmailError(null)
                      }}
                      onKeyDown={(event) => {
                        // Enter aquí no envía el documento.
                        if (event.key === "Enter") event.preventDefault()
                      }}
                    />
                    <FieldDescription>
                      {emailMode === "agregar"
                        ? "Se guarda en sus datos y queda para los próximos envíos."
                        : "Solo para este envío: no cambia el correo registrado. Queda anotado a qué dirección se envió y quién lo decidió."}
                    </FieldDescription>
                  </Field>
                  {emailMode === "otro" ? (
                    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={emailConfirmed}
                        disabled={sendMutation.isPending}
                        onCheckedChange={(value) => {
                          setEmailConfirmed(value === true)
                          setEmailError(null)
                        }}
                      />
                      <span>Confirmo que {recipient.displayName} pidió recibirlo en este correo</span>
                    </label>
                  ) : null}
                  {emailError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {emailError}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {emailMode === "agregar" ? (
                      <SubmitButton
                        size="sm"
                        pending={saveEmailMutation.isPending}
                        onClick={() => {
                          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailText.trim())) {
                            setEmailError("Escribe un correo válido.")
                            return
                          }
                          saveEmailMutation.mutate({
                            recipientContactId: recipient.contactId,
                            email: emailText.trim(),
                          })
                        }}
                      >
                        Guardar correo
                      </SubmitButton>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={saveEmailMutation.isPending || sendMutation.isPending}
                      onClick={() => {
                        setEmailMode(null)
                        setEmailText("")
                        setEmailConfirmed(false)
                        setEmailError(null)
                      }}
                    >
                      {emailMode === "otro" ? "Usar el correo registrado" : "Cancelar"}
                    </Button>
                  </div>
                </div>
              ) : null}
              {emailChannel && emailMode === null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    setEmailMode("otro")
                    setEmailText("")
                    setEmailConfirmed(false)
                    setEmailError(null)
                  }}
                >
                  Enviar a otro correo
                </Button>
              ) : null}
              {options.recipients.length > 1 ? (
                choosingRecipient ? (
                  <Field>
                    <FieldLabel htmlFor={`${uid}-destinatario`}>A quién se lo envías</FieldLabel>
                    <ChoiceSelect
                      id={`${uid}-destinatario`}
                      value={recipient.contactId}
                      disabled={sendMutation.isPending}
                      onChange={(event) => {
                        // Otra persona, otros canales: se vuelven a pedir al servidor.
                        setRecipientId(event.target.value)
                        setConnectionId(null)
                        setSavePreferred(false)
                      }}
                    >
                      {options.recipients.map((item) => (
                        <option key={item.contactId} value={item.contactId}>
                          {item.displayName}, {RELATION_LABELS[item.relation] ?? item.relation}
                        </option>
                      ))}
                    </ChoiceSelect>
                    <FieldDescription>
                      Solo el paciente y sus responsables vigentes pueden recibirlo.
                    </FieldDescription>
                  </Field>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => setChoosingRecipient(true)}
                  >
                    Enviar a otra persona
                  </Button>
                )
              ) : null}
            </div>

            {canSend ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`${uid}-mensaje`}>Mensaje</FieldLabel>
                  <Textarea
                    id={`${uid}-mensaje`}
                    rows={4}
                    maxLength={MAX_MESSAGE}
                    value={messageText}
                    disabled={sendMutation.isPending}
                    onChange={(event) => setMessage(event.target.value)}
                  />
                </Field>
                {selected && !selected.isPreferred && !sendingToOther ? (
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={savePreferred}
                      disabled={sendMutation.isPending}
                      onCheckedChange={(value) => setSavePreferred(value === true)}
                    />
                    <span>
                      Recordar {channelLabel(selected.channel).toLowerCase()} como el medio preferido de{" "}
                      {recipient.displayName}
                    </span>
                  </label>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  Queda en la conversación de {recipient.displayName}, con el documento adjunto.
                </p>
              </>
            ) : null}
          </div>
        )}
      </FormDrawer>
    </>
  )
}
