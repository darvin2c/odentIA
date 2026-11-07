import { Button, cn, FieldLabel, RadioGroup, RadioGroupItem, Textarea, useIsMobile } from "@odentia/ui"
import {
  applySubmitError,
  clearSubmitErrors,
  DataRefreshMarker,
  ErrorState,
  FormDrawer,
  internationalText,
  isUnconfirmedSubmit,
  SubmitButton,
  setSubmitErrors,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { FileText, Send } from "lucide-react"
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { apiFetch, apiFetchBytes } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { HealthDocumentType } from "../../lib/encounter-documents"
import { financeErrorMessage, financeFormMessage } from "../../lib/finance"
import { ChoiceSelect } from "../ui/choice-select"

/**
 * Qué se envía: un documento de cobro (ticket, presupuesto, devolución), con
 * las rutas y permisos de caja y presupuestos, o un papel de salud (receta,
 * orden, descanso, hoja de atención, consentimiento firmado), con los de la
 * historia. El cajón es el mismo para todos (ADR 0150): a quién, por dónde y
 * qué le llega, y si nada sirve, imprimir.
 */
export type SendDocumentSource =
  /** «return»: la devolución de un cobro (ADR 0068), de caja como el ticket. */
  | { kind: "finance"; documentType: "ticket" | "budget" | "return" }
  | { kind: "health"; documentType: HealthDocumentType }

export interface SendFinancialDocumentProps {
  patientId: string
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
  /** Qué le llega si sale por aquí, en palabras de la clínica. */
  note?: string | null
  /** Pasaron 24 horas: sale con el mensaje aprobado para documentos. */
  viaTemplate?: boolean
  hasThread?: boolean
  isPreferred?: boolean
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
  recipient: RecipientOption | null
  channels: ChannelOption[]
  proposed: ChannelOption | null
  document: { type: string; label: string; statusLabel?: string; isDraft?: boolean }
  /** Mensaje propuesto por el servidor; aquí solo se edita. */
  message: string
  /** Papel de salud sin nadie a quien enviarlo: solo se imprime, con el porqué. */
  printOnly?: string | null
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
  paciente: "la propia persona",
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

/** «Receta N.º 3» → «receta N.º 3», para «Enviar receta N.º 3». */
function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVALID_EMAIL = "Escribe un correo válido."

/** Las rutas de cada tipo de documento: las de caja y presupuestos, o las de la historia. */
function endpoints(patientId: string, source: SendDocumentSource, documentId: string) {
  const base = `/api/patients/${patientId}`
  const query = new URLSearchParams({ documentType: source.documentType, documentId })
  return source.kind === "health"
    ? {
        options: `${base}/health-document-options?${query}`,
        pdf: `${base}/health-document-pdf?${query}`,
        send: `${base}/health-documents/send`,
        email: `${base}/health-documents/recipient-email`,
      }
    : {
        options: `${base}/financial-document-options?${query}`,
        pdf: `${base}/financial-document-pdf?${query}`,
        send: `${base}/financial-documents/send`,
        email: `${base}/financial-documents/recipient-email`,
      }
}

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

/** Imprime un PDF sin salir de la página; si el navegador no deja, lo abre aparte. */
function printPdf(bytes: ArrayBuffer | Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes], { type: "application/pdf" }))
  const frame = document.createElement("iframe")
  frame.style.position = "fixed"
  frame.style.width = "0"
  frame.style.height = "0"
  frame.style.border = "0"
  frame.src = url
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
    } catch {
      window.open(url, "_blank", "noopener")
    }
  }
  document.body.appendChild(frame)
  window.setTimeout(() => {
    frame.remove()
    URL.revokeObjectURL(url)
  }, 5 * 60_000)
}

/**
 * «Enviar»: el mismo cajón para todos los papeles (ADR 0150). Dice a quién va,
 * por dónde y qué le llega por cada canal, con el motivo de los que no sirven
 * en palabras de la clínica. Manda el PDF (el mismo que se imprime) y lo deja
 * en la conversación de la persona; pasadas las 24 horas de WhatsApp, con el
 * mensaje aprobado para documentos. Si nada sirve, el botón principal es
 * «Imprimir» y queda «Agregar correo». Cada apertura lleva su clave: reintentar
 * o un doble clic no lo manda dos veces. Lo que responde el servidor es «en
 * cola»: nunca se presenta como entregado.
 */
export function DocumentSendDrawer({
  open,
  patientId,
  source,
  documentId,
  onClose,
  onSent,
}: {
  open: boolean
  patientId: string
  source: SendDocumentSource
  documentId: string
  onClose: () => void
  onSent?: (info: { conversationId: string; messageId: string }) => void
}) {
  const navigate = useNavigate()
  const mobile = useIsMobile() === true
  const canConfigure = usePermission("settings.read")
  const canInbox = usePermission("conversations.read")
  const health = source.kind === "health"
  const routes = endpoints(patientId, source, documentId)
  const [choosingRecipient, setChoosingRecipient] = useState(false)
  const [sent, setSent] = useState<SendResult | null>(null)
  const [viewing, setViewing] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  // Correo escrito en el momento: para enviarlo ahí esta vez (solo cobros), o para guardarlo en sus datos.
  const [emailMode, setEmailMode] = useState<"otro" | "agregar" | null>(null)

  // Lo que la validación y el envío leen de la pantalla (canal elegido, si se están buscando canales).
  const live = useRef<{
    selected: ChannelOption | null
    recipient: RecipientOption | null
    sendingToOther: boolean
    refreshing: boolean
    proposedMessage: string
    printing: boolean
  }>({ selected: null, recipient: null, sendingToOther: false, refreshing: false, proposedMessage: "", printing: false })

  const sendMutation = useMutation({
    mutationFn: (input: {
      connectionId: string
      recipientContactId: string
      message: string
      savePreferredChannel: boolean
      otherEmail: string | null
    }) =>
      apiFetch<{ data: SendResult }>(routes.send, {
        method: "POST",
        body: JSON.stringify(
          health
            ? {
                documentType: source.documentType,
                documentId,
                recipientContactId: input.recipientContactId,
                connectionId: input.connectionId,
                message: input.message || null,
                requestId,
              }
            : {
                documentType: source.documentType,
                documentId,
                recipientContactId: input.recipientContactId,
                connectionId: input.connectionId,
                message: input.message || null,
                savePreferredChannel: input.savePreferredChannel,
                requestId,
                ...(input.otherEmail ? { otherEmail: input.otherEmail, confirmOtherEmail: true } : {}),
              },
        ),
      }),
    onSuccess: (result) => {
      setSent(result.data)
      onSent?.({ conversationId: result.data.conversationId, messageId: result.data.messageId })
    },
  })
  const resetSend = sendMutation.reset

  const print = async () => {
    setViewError(null)
    try {
      const bytes = await apiFetchBytes(routes.pdf)
      if (mobile) {
        // En el teléfono no hay impresión de la página: se descarga y se imprime desde el archivo.
        const url = URL.createObjectURL(new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes], { type: "application/pdf" }))
        window.open(url, "_blank", "noopener")
        window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
      } else printPdf(bytes)
    } catch (err) {
      setViewError(financeErrorMessage(err))
    }
  }

  const form = useAppForm({
    defaultValues: EMPTY_DRAFT,
    validators: {
      onSubmit: ({ value }) => {
        const now = live.current
        if (now.printing) return undefined
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
      // Nada sirve: el botón principal imprime en vez de enviar.
      if (now.printing) {
        await print()
        return
      }
      if (!now.recipient || !now.selected) return
      await sendMutation.mutateAsync({
        connectionId: now.selected.connectionId,
        recipientContactId: now.recipient.contactId,
        message: (value.message ?? now.proposedMessage).trim(),
        savePreferredChannel:
          !health && value.savePreferredChannel && !now.selected.isPreferred && !now.sendingToOther,
        otherEmail: now.sendingToOther ? value.otherEmail.trim() : null,
      })
    },
  })
  // El envío conserva su identificador: reintentar sin respuesta no lo manda dos veces, y así se dice.
  const surface = useFormSurface(form, {
    formMessage: (error) =>
      isUnconfirmedSubmit(error)
        ? "No pudimos confirmar el envío. Tu mensaje se conserva: puedes intentarlo otra vez sin que se envíe dos veces."
        : financeFormMessage(error),
  })
  const recipientId = useStore(form.store, (state) => state.values.recipientContactId) || null
  const connectionId = useStore(form.store, (state) => state.values.connectionId)

  const optionsQuery = useQuery({
    queryKey: [health ? "health-document-options" : "financial-document-options", patientId, source.documentType, documentId, recipientId],
    queryFn: () =>
      apiFetch<{ data: SendOptions }>(
        recipientId ? `${routes.options}&recipientContactId=${encodeURIComponent(recipientId)}` : routes.options,
      ),
    enabled: open,
    // Al cambiar de destinatario se conserva la lista mientras llegan sus canales.
    placeholderData: keepPreviousData,
  })
  const options = optionsQuery.data?.data ?? null
  const refreshing = optionsQuery.isPlaceholderData

  const saveEmailMutation = useMutation({
    mutationFn: (input: { recipientContactId: string; email: string }) =>
      apiFetch(routes.email, {
        method: "POST",
        body: JSON.stringify(health ? input : { documentType: source.documentType, ...input }),
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
  }, [open, patientId, source.documentType, documentId, resetSend, form])

  const recipient = options?.recipient ?? null
  const channels = options?.channels ?? []
  const emailChannel = channels.find((item) => item.channel === "email") ?? null
  // Con otro correo se envía por el buzón de la clínica aunque la persona no tenga uno registrado (solo cobros).
  const sendingToOther = !health && emailMode === "otro" && emailChannel !== null
  const selected = sendingToOther
    ? emailChannel
    : (channels.find((item) => item.connectionId === connectionId && item.usable) ??
      (options?.proposed && options.proposed.usable ? options.proposed : null))
  const usableCount = channels.filter((item) => item.usable).length
  const canSend = usableCount > 0 || sendingToOther
  // Sin canal que sirva (o un papel de salud sin a quién enviarlo) el principal es imprimir.
  const printing = !!options && !sent && !canSend && emailMode === null

  const proposedMessage = options?.message ?? ""
  live.current = { selected, recipient, sendingToOther, refreshing, proposedMessage, printing }

  const viewPdf = async () => {
    if (viewing) return
    // La pestaña se abre en el clic para que el navegador no la bloquee.
    const tab = window.open("", "_blank")
    if (tab) tab.opener = null
    setViewing(true)
    setViewError(null)
    try {
      const bytes = await apiFetchBytes(routes.pdf)
      const url = URL.createObjectURL(new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes], { type: "application/pdf" }))
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
    if (!surface.isSubmitting) onClose()
  }

  const channelTitle = (item: ChannelOption) =>
    channels.filter((other) => other.channel === item.channel).length > 1
      ? `${channelLabel(item.channel)} · ${item.connectionName}`
      : channelLabel(item.channel)
  const channelAddress = (item: ChannelOption) =>
    item.channel === "email"
      ? recipient?.email
      : item.channel === "whatsapp" && recipient?.phone
        ? internationalText(recipient.phone)
        : null
  const busy = surface.isSubmitting || saveEmailMutation.isPending
  // Enter en un correo no envía el documento.
  const keepEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter") event.preventDefault()
  }
  const label = options?.document.label ?? ""
  const recipientWords = recipient
    ? `Para ${recipient.displayName} · ${RELATION_LABELS[recipient.relation] ?? recipient.relation}`
    : null

  return (
    <FormDrawer
      {...surface}
      isDirty={!sent && surface.isDirty}
      error={sent ? null : surface.error}
      open={open}
      title={label ? `Enviar ${lowerFirst(label)}` : "Enviar"}
      headerContent={
        recipientWords ? <p className="break-words text-sm text-muted-foreground">{recipientWords}</p> : undefined
      }
      isLoading={optionsQuery.isPending}
      hideSubmit={sent !== null || !options || (!canSend && !printing)}
      submitLabel={
        printing
          ? mobile
            ? "Descargar PDF"
            : "Imprimir"
          : selected
            ? `Enviar por ${channelLabel(selected.channel).toLowerCase()}`
            : "Enviar"
      }
      cancelLabel={sent ? "Listo" : undefined}
      onClose={close}
    >
      {sent ? (
        <div className="flex flex-col gap-3" role="status">
          <p className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
            {`Quedó en cola para enviarse por ${channelLabel(sent.channel).toLowerCase()}${sent.sentToEmail ? ` a ${sent.sentToEmail}` : ""}. Todavía no está entregado: la conversación mostrará si llegó.`}
          </p>
          {canInbox ? (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => {
                onClose()
                void navigate({ to: "/inbox", search: { conversation: sent.conversationId } })
              }}
            >
              Ver en la bandeja
            </Button>
          ) : null}
        </div>
      ) : optionsQuery.isError || !options ? (
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

          {!recipient ? (
            // Un papel de salud sin nadie que lo reciba (un menor sin representante legal vigente).
            <p role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-sm">
              {options.printOnly ?? "No hay a quién enviárselo"}. Puedes imprimirlo.
            </p>
          ) : (
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
                          onClose()
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
                                  <span className="font-medium">
                                    {channelTitle(item)}
                                    {channelAddress(item) ? (
                                      <span className="font-normal text-muted-foreground"> · {channelAddress(item)}</span>
                                    ) : null}
                                  </span>
                                  {item.usable && item.note ? (
                                    <span className="text-muted-foreground">{item.note}</span>
                                  ) : null}
                                  {!item.usable && item.reason ? (
                                    <span className="text-muted-foreground">{item.reason}</span>
                                  ) : null}
                                </span>
                                {item.usable && item.isPreferred ? (
                                  <span className="shrink-0 text-xs text-muted-foreground">Su medio preferido</span>
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
                  Por ahora no hay por dónde enviárselo a {recipient.displayName}: puedes imprimirlo.
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
              {/* Un papel de salud va solo a la dirección de su ficha: no a otro correo escrito en el momento. */}
              {!health && emailChannel && emailMode === null ? (
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
                        description={
                          health
                            ? "Un documento de salud solo va a la propia persona o a su representante legal, nunca a otro número."
                            : "Solo el paciente y sus responsables vigentes pueden recibirlo."
                        }
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
          )}

          {canSend && recipient ? (
            <>
              <form.AppField name="message">
                {(field) => (
                  <field.Control
                    label="Mensaje"
                    description={
                      selected?.viaTemplate
                        ? "Pasaron 24 horas: le llega el mensaje aprobado para documentos, con el PDF. Este texto queda en la conversación."
                        : undefined
                    }
                  >
                    {(control) => (
                      <Textarea
                        {...control.props}
                        rows={4}
                        maxLength={MAX_MESSAGE}
                        value={field.state.value ?? proposedMessage}
                        disabled={busy || !!selected?.viaTemplate}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
              {!health && selected && !selected.isPreferred && !sendingToOther ? (
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
  )
}

/**
 * «Enviar al paciente» de un documento de cobro: el botón que abre el cajón
 * común de envío (`DocumentSendDrawer`).
 */
export function SendFinancialDocument({
  patientId,
  documentType,
  documentId,
  trigger,
  onSent,
  className,
}: SendFinancialDocumentProps) {
  const [open, setOpen] = useState(false)
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
      <DocumentSendDrawer
        open={open}
        patientId={patientId}
        source={{ kind: "finance", documentType }}
        documentId={documentId}
        onClose={() => setOpen(false)}
        {...(onSent ? { onSent } : {})}
      />
    </>
  )
}
