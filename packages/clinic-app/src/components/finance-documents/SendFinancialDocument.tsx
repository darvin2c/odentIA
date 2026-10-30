import { Button, cn, FieldLabel, RadioGroup, RadioGroupItem, Textarea } from "@odentia/ui"
import {
  applySubmitError,
  clearSubmitErrors,
  DataRefreshMarker,
  ErrorState,
  FormDrawer,
  SubmitButton,
  setSubmitErrors,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { FileText, Send } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { apiFetch, apiFetchBytes } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage, financeFormMessage } from "../../lib/finance"
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVALID_EMAIL = "Escribe un correo válido."

/**
 * El borrador del envío, con los nombres del cuerpo de la petición (así cada
 * rechazo del servidor cae en su campo). `""`/`null` = lo que propone el
 * servidor (destinatario, canal, mensaje). `email` es «Agregar correo».
 */
interface SendDraft {
  recipientContactId: string
  connectionId: string
  message: string | null
  otherEmail: string
  confirmOtherEmail: boolean
  savePreferredChannel: boolean
  email: string
}

const EMPTY_DRAFT: SendDraft = {
  recipientContactId: "",
  connectionId: "",
  message: null,
  otherEmail: "",
  confirmOtherEmail: false,
  savePreferredChannel: false,
  email: "",
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
  const navigate = useNavigate()
  const canConfigure = usePermission("settings.read")
  const canInbox = usePermission("conversations.read")
  const [open, setOpen] = useState(false)
  const [choosingRecipient, setChoosingRecipient] = useState(false)
  const [sent, setSent] = useState<SendResult | null>(null)
  const [viewing, setViewing] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  // Correo escrito en el momento: para enviarlo ahí esta vez, o para guardarlo en sus datos.
  const [emailMode, setEmailMode] = useState<"otro" | "agregar" | null>(null)

  // Lo que la validación y el envío leen de la pantalla (canal elegido, si se están buscando canales).
  const live = useRef<{
    selected: ChannelOption | null
    recipient: RecipientOption | null
    sendingToOther: boolean
    refreshing: boolean
    proposedMessage: string
  }>({ selected: null, recipient: null, sendingToOther: false, refreshing: false, proposedMessage: "" })

  const sendMutation = useMutation({
    mutationFn: (input: {
      connectionId: string
      recipientContactId: string
      message: string
      savePreferredChannel: boolean
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
          savePreferredChannel: input.savePreferredChannel,
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

  const form = useAppForm({
    defaultValues: EMPTY_DRAFT,
    validators: {
      onSubmit: ({ value }) => {
        const now = live.current
        const fields: Partial<Record<keyof SendDraft, string>> = {}
        if (now.refreshing) fields.connectionId = "Espera: se están buscando sus canales."
        else if (!now.selected) fields.connectionId = "Elige por dónde enviarlo."
        if (now.sendingToOther) {
          if (!EMAIL_PATTERN.test(value.otherEmail.trim())) fields.otherEmail = INVALID_EMAIL
          if (!value.confirmOtherEmail) fields.confirmOtherEmail = "Marca la confirmación para enviarlo a ese correo."
        }
        if ((value.message ?? now.proposedMessage).trim().length > MAX_MESSAGE)
          fields.message = `El mensaje admite hasta ${MAX_MESSAGE} caracteres.`
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const now = live.current
      if (!now.recipient || !now.selected) return
      await sendMutation.mutateAsync({
        connectionId: now.selected.connectionId,
        recipientContactId: now.recipient.contactId,
        message: (value.message ?? now.proposedMessage).trim(),
        savePreferredChannel: value.savePreferredChannel && !now.selected.isPreferred && !now.sendingToOther,
        otherEmail: now.sendingToOther ? value.otherEmail.trim() : null,
      })
    },
  })
  const surface = useFormSurface(form, { formMessage: financeFormMessage })
  const recipientId = useStore(form.store, (state) => state.values.recipientContactId) || null
  const connectionId = useStore(form.store, (state) => state.values.connectionId)

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

  const saveEmailMutation = useMutation({
    mutationFn: (input: { recipientContactId: string; email: string }) =>
      apiFetch(`/api/patients/${patientId}/financial-documents/recipient-email`, {
        method: "POST",
        body: JSON.stringify({ documentType, ...input }),
      }),
  })

  // Cada apertura (o documento) es un intento nuevo: borrador limpio y clave nueva.
  useEffect(() => {
    if (!open) return
    form.reset(EMPTY_DRAFT)
    setChoosingRecipient(false)
    setSent(null)
    setViewError(null)
    setEmailMode(null)
    setRequestId(crypto.randomUUID())
    resetSend()
  }, [open, patientId, documentType, documentId, resetSend, form])

  const recipient = options?.recipient ?? null
  const channels = options?.channels ?? []
  const emailChannel = channels.find((item) => item.channel === "email") ?? null
  // Con otro correo se envía por el buzón de la clínica aunque la persona no tenga uno registrado.
  const sendingToOther = emailMode === "otro" && emailChannel !== null
  const selected = sendingToOther
    ? emailChannel
    : (channels.find((item) => item.connectionId === connectionId && item.usable) ??
      (options?.proposed && options.proposed.usable ? options.proposed : null))
  const usableCount = channels.filter((item) => item.usable).length
  const canSend = usableCount > 0 || sendingToOther

  const proposedMessage = options?.message ?? ""
  live.current = { selected, recipient, sendingToOther, refreshing, proposedMessage }

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
      setViewError(financeErrorMessage(err))
    } finally {
      setViewing(false)
    }
  }

  // «Guardar correo»: su error va al campo del correo (o junto a los botones si no es de él).
  const saveEmail = async () => {
    if (!recipient) return
    const email = form.getFieldValue("email").trim()
    form.setFieldMeta("email", (meta) => ({ ...meta, isBlurred: true }))
    if (!EMAIL_PATTERN.test(email)) {
      setSubmitErrors(form, { fields: { email: INVALID_EMAIL } })
      return
    }
    clearSubmitErrors(form)
    try {
      await saveEmailMutation.mutateAsync({ recipientContactId: recipient.contactId, email })
    } catch (err) {
      applySubmitError(form, err, { formMessage: financeFormMessage })
      return
    }
    setEmailMode(null)
    form.setFieldValue("email", "")
    form.setFieldValue("connectionId", "")
    void optionsQuery.refetch()
  }

  const leaveEmailMode = () => {
    setEmailMode(null)
    form.setFieldValue("email", "")
    form.setFieldValue("otherEmail", "")
    form.setFieldValue("confirmOtherEmail", false)
    clearSubmitErrors(form)
  }

  const close = () => {
    if (!surface.isSubmitting) setOpen(false)
  }

  const channelTitle = (item: ChannelOption) =>
    channels.filter((other) => other.channel === item.channel).length > 1
      ? `${channelLabel(item.channel)} · ${item.connectionName}`
      : channelLabel(item.channel)
  const channelAddress = (item: ChannelOption) =>
    item.channel === "email" ? recipient?.email : item.channel === "whatsapp" ? recipient?.phone : null
  const busy = surface.isSubmitting || saveEmailMutation.isPending
  // Enter en un correo no envía el documento.
  const keepEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") event.preventDefault()
  }

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
        {...surface}
        isDirty={!sent && surface.isDirty}
        error={sent ? null : surface.error}
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
        hideSubmit={sent !== null || !options || !canSend}
        submitLabel={selected ? `Enviar por ${channelLabel(selected.channel).toLowerCase()}` : "Enviar"}
        cancelLabel={sent ? "Listo" : undefined}
        onClose={close}
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
            message={financeErrorMessage(optionsQuery.error)}
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
              {channels.length === 0 ? (
                <>
                  <span className="text-sm font-semibold">Por dónde</span>
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
                </>
              ) : (
                <form.AppField name="connectionId">
                  {(field) => (
                    <field.Group legend="Por dónde">
                      {(control) => (
                        <>
                          {refreshing ? <DataRefreshMarker message="Buscando sus canales" /> : null}
                          <RadioGroup
                            name={control.name}
                            aria-invalid={control.invalid || undefined}
                            aria-describedby={control.describedBy}
                            value={selected?.connectionId ?? ""}
                            disabled={sendingToOther}
                            onValueChange={(next) => field.handleChange(String(next))}
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
                                  onBlur={control.onBlur}
                                  disabled={!item.usable || refreshing || busy}
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
                        </>
                      )}
                    </field.Group>
                  )}
                </form.AppField>
              )}
              {emailChannel && !recipient.email && emailMode === null ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">{recipient.displayName} no tiene correo registrado.</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      form.setFieldValue("email", "")
                      setEmailMode("agregar")
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
                  {emailMode === "agregar" ? (
                    <form.AppField name="email">
                      {(field) => (
                        <field.TextField
                          label={`Correo de ${recipient.displayName}`}
                          description="Se guarda en sus datos y queda para los próximos envíos."
                          type="email"
                          inputMode="email"
                          autoComplete="off"
                          autoFocus
                          maxLength={200}
                          disabled={busy}
                          onKeyDown={keepEnter}
                        />
                      )}
                    </form.AppField>
                  ) : (
                    <>
                      <form.AppField name="otherEmail">
                        {(field) => (
                          <field.TextField
                            label="Otro correo"
                            description="Solo para este envío: no cambia el correo registrado. Queda anotado a qué dirección se envió y quién lo decidió."
                            type="email"
                            inputMode="email"
                            autoComplete="off"
                            autoFocus
                            maxLength={200}
                            disabled={busy}
                            onKeyDown={keepEnter}
                          />
                        )}
                      </form.AppField>
                      <form.AppField name="confirmOtherEmail">
                        {(field) => (
                          <field.CheckboxField
                            label={`Confirmo que ${recipient.displayName} pidió recibirlo en este correo`}
                            disabled={busy}
                          />
                        )}
                      </form.AppField>
                    </>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {emailMode === "agregar" ? (
                      <SubmitButton size="sm" pending={saveEmailMutation.isPending} onClick={() => void saveEmail()}>
                        Guardar correo
                      </SubmitButton>
                    ) : null}
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={leaveEmailMode}>
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
                    form.setFieldValue("otherEmail", "")
                    form.setFieldValue("confirmOtherEmail", false)
                    setEmailMode("otro")
                  }}
                >
                  Enviar a otro correo
                </Button>
              ) : null}
              {options.recipients.length > 1 ? (
                choosingRecipient ? (
                  <form.AppField name="recipientContactId">
                    {(field) => (
                      <field.Control
                        label="A quién se lo envías"
                        description="Solo el paciente y sus responsables vigentes pueden recibirlo."
                      >
                        {(control) => (
                          <ChoiceSelect
                            {...control.props}
                            value={recipient.contactId}
                            disabled={busy}
                            onChange={(event) => {
                              // Otra persona, otros canales: se vuelven a pedir al servidor.
                              field.handleChange(event.target.value)
                              form.setFieldValue("connectionId", "")
                              form.setFieldValue("savePreferredChannel", false)
                            }}
                          >
                            {options.recipients.map((item) => (
                              <option key={item.contactId} value={item.contactId}>
                                {item.displayName}, {RELATION_LABELS[item.relation] ?? item.relation}
                              </option>
                            ))}
                          </ChoiceSelect>
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
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
                <form.AppField name="message">
                  {(field) => (
                    <field.Control label="Mensaje">
                      {(control) => (
                        <Textarea
                          {...control.props}
                          rows={4}
                          maxLength={MAX_MESSAGE}
                          value={field.state.value ?? proposedMessage}
                          disabled={busy}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
                {selected && !selected.isPreferred && !sendingToOther ? (
                  <form.AppField name="savePreferredChannel">
                    {(field) => (
                      <field.CheckboxField
                        label={`Recordar ${channelLabel(selected.channel).toLowerCase()} como el medio preferido de ${recipient.displayName}`}
                        disabled={busy}
                      />
                    )}
                  </form.AppField>
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
