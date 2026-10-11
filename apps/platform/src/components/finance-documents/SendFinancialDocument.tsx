import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@odentia/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { FileText, Loader2, Send } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { ApiError, apiFetch, apiFetchBytes } from "../../lib/api"
import { ChoiceSelect } from "../ui/choice-select"

export interface SendFinancialDocumentProps {
  patientId: string
  documentType: "ticket" | "budget"
  documentId: string
  trigger?: ReactNode
  onSent?: (info: { conversationId: string; messageId: string }) => void
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
}

function channelLabel(channel: string): string {
  if (channel === "email") return "Correo"
  if (channel === "whatsapp") return "WhatsApp"
  if (channel === "telegram") return "Telegram"
  if (channel === "messenger") return "Messenger"
  if (channel === "instagram") return "Instagram"
  return channel
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.shape.message ?? fallback
  return err instanceof Error ? err.message : fallback
}

/**
 * Envío del documento económico (ticket o presupuesto) al paciente, con PDF
 * adjunto generado en el servidor. Propone correo si hay conexión utilizable
 * y si no el medio preferido; sin canal utilizable explica y enlaza a
 * configurar. El resultado es `encolado, pendiente de entrega`: nunca se
 * presenta como entregado.
 */
export function SendFinancialDocument({
  patientId,
  documentType,
  documentId,
  trigger,
  onSent,
}: SendFinancialDocumentProps) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [recipientId, setRecipientId] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [savePreferred, setSavePreferred] = useState(false)
  const [paper, setPaper] = useState<"profile" | "A4" | "Letter">("profile")
  const [sent, setSent] = useState<{ conversationId: string; messageId: string; channel: string } | null>(null)

  const optionsQuery = useQuery({
    queryKey: ["financial-document-options", patientId, documentType, documentId],
    queryFn: () =>
      apiFetch<{ data: SendOptions }>(
        `/api/patients/${patientId}/financial-document-options?documentType=${documentType}&documentId=${documentId}`,
      ),
    enabled: open,
  })

  const options = optionsQuery.data?.data ?? null

  useEffect(() => {
    if (open) {
      setSent(null)
      sendMutation.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patientId, documentType, documentId])

  useEffect(() => {
    if (options && recipientId === null) setRecipientId(options.recipient.contactId)
    if (options && connectionId === null && options.proposed) setConnectionId(options.proposed.connectionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options])

  const pdfQuery = useQuery({
    queryKey: ["financial-document-pdf", patientId, documentType, documentId, paper],
    queryFn: async () => {
      const bytes = await apiFetchBytes(
        `/api/patients/${patientId}/financial-document-pdf?documentType=${documentType}&documentId=${documentId}${paper === "profile" ? "" : `&paper=${paper}`}`,
      )
      return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
    },
    enabled: false,
  })

  useEffect(() => {
    const url = pdfQuery.data
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [pdfQuery.data])

  const sendMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { conversationId: string; messageId: string; status: string; channel: string } }>(
        `/api/patients/${patientId}/financial-documents/send`,
        {
          method: "POST",
          body: JSON.stringify({
            documentType,
            documentId,
            recipientContactId: recipientId,
            connectionId,
            message: message.trim() ? message.trim() : null,
            savePreferredChannel: savePreferred,
            paper: paper === "profile" ? null : paper,
          }),
        },
      ),
    onSuccess: (result) => {
      setSent({
        conversationId: result.data.conversationId,
        messageId: result.data.messageId,
        channel: result.data.channel,
      })
      onSent?.({ conversationId: result.data.conversationId, messageId: result.data.messageId })
    },
  })

  const recipient = options?.recipients.find((r) => r.contactId === recipientId) ?? options?.recipient ?? null
  const selectedChannel = options?.channels.find((ch) => ch.connectionId === connectionId) ?? null
  const usableCount = options?.channels.filter((ch) => ch.usable).length ?? 0

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-flex">
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <Send className="size-4" />
            Enviar al paciente
          </Button>
        )}
      </span>
      <Dialog open={open} onOpenChange={(value) => !sendMutation.isPending && setOpen(value)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Enviar {documentType === "ticket" ? "ticket" : "presupuesto"}</DialogTitle>
            <DialogDescription>
              El documento viaja en PDF adjunto y queda en la conversación de la persona.
            </DialogDescription>
          </DialogHeader>
          {sent ? (
            <div className="flex flex-col gap-3">
              <p className="rounded-md border p-3 text-sm">
                Encolado por {channelLabel(sent.channel)}, pendiente de entrega: el sistema lo envía
                y la conversación mostrará el resultado. Aún no entregado.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    void navigate({ to: "/inbox", search: { conversation: sent.conversationId } })
                  }}
                >
                  Ver en bandeja
                </Button>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cerrar
                </Button>
              </div>
            </div>
          ) : optionsQuery.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Cargando canales…
            </p>
          ) : optionsQuery.isError || !options ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-destructive">
                {errorMessage(optionsQuery.error, "No se pudieron cargar las opciones de envío")}
              </p>
              <Button type="button" variant="outline" onClick={() => optionsQuery.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{options.document.label}</span>
                <span className="text-muted-foreground">· {options.document.statusLabel}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pdfQuery.isFetching}
                  onClick={() => void pdfQuery.refetch()}
                >
                  <FileText className="size-4" />
                  {pdfQuery.isFetching ? "Generando…" : pdfQuery.data ? "Volver a generar" : "Ver PDF"}
                </Button>
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  Papel
                  <ChoiceSelect
                    aria-label="Papel del PDF"
                    className="rounded-md border bg-background px-1.5 py-1 text-xs"
                    value={paper}
                    disabled={pdfQuery.isFetching || sendMutation.isPending}
                    onChange={(e) => setPaper(e.target.value as "profile" | "A4" | "Letter")}
                  >
                    <option value="profile">Térmica del perfil</option>
                    <option value="A4">A4</option>
                    <option value="Letter">Carta</option>
                  </ChoiceSelect>
                </label>
              </div>
              {pdfQuery.data && (
                <a
                  href={pdfQuery.data}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Abrir vista previa del PDF
                </a>
              )}
              {pdfQuery.isError && (
                <p className="text-sm text-destructive">
                  {errorMessage(pdfQuery.error, "No se pudo generar el PDF")}
                </p>
              )}
              {options.document.isDraft && (
                <p className="rounded-md border p-2 text-sm">
                  Está en borrador: al enviar queda entregado (presentado) en la misma operación.
                </p>
              )}
              {options.recipients.length > 1 && (
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Destinatario</span>
                  <ChoiceSelect
                    aria-label="Destinatario"
                    className="rounded-md border bg-background px-2 py-1.5 text-sm"
                    value={recipientId ?? ""}
                    onChange={(e) => {
                      setRecipientId(e.target.value)
                      setConnectionId(null)
                    }}
                  >
                    {options.recipients.map((r) => (
                      <option key={r.contactId} value={r.contactId}>
                        {r.displayName}
                        {r.relation !== "paciente" ? ` · ${r.relation.replace(/_/g, " ")}` : ""}
                      </option>
                    ))}
                  </ChoiceSelect>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">Por dónde</span>
                {options.channels.length === 0 ? (
                  <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                    <p>
                      No hay ningún canal conectado en la clínica: conecta uno para enviar documentos.
                    </p>
                    <Link
                      to="/settings/channels"
                      onClick={() => setOpen(false)}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Conectar un canal
                    </Link>
                  </div>
                ) : (
                  options.channels.map((ch) => (
                    <label
                      key={ch.connectionId}
                      className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm ${ch.usable ? "cursor-pointer" : "opacity-70"}`}
                    >
                      <input
                        type="radio"
                        name="send-channel"
                        className="mt-1"
                        checked={connectionId === ch.connectionId}
                        disabled={!ch.usable || sendMutation.isPending}
                        onChange={() => setConnectionId(ch.connectionId)}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {channelLabel(ch.channel)} · {ch.connectionName}
                          </span>
                          {ch.isProposed && (
                            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                              Propuesto
                            </span>
                          )}
                          {ch.isPreferred && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              Preferido
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {ch.channel === "email" && recipient?.email
                            ? recipient.email
                            : ch.channel === "whatsapp" && recipient?.phone
                              ? recipient.phone
                              : ch.reason ?? (ch.hasThread ? "Con conversación previa" : "Se inicia al enviar")}
                        </span>
                        {!ch.usable && ch.reason && (
                          <span className="text-xs text-muted-foreground">{ch.reason}</span>
                        )}
                      </span>
                    </label>
                  ))
                )}
              </div>
              {usableCount > 0 && (
                <>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="send-message" className="text-sm font-medium">
                      Mensaje <span className="font-normal text-muted-foreground">(opcional)</span>
                    </label>
                    <textarea
                      id="send-message"
                      className="min-h-20 rounded-md border bg-background px-2 py-1.5 text-sm"
                      value={message}
                      maxLength={500}
                      disabled={sendMutation.isPending}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Texto que acompaña al documento"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={savePreferred}
                      disabled={sendMutation.isPending}
                      onChange={(e) => setSavePreferred(e.target.checked)}
                    />
                    Recordar como medio preferido de esta persona
                  </label>
                  {sendMutation.isError && (
                    <p className="text-sm text-destructive">
                      {errorMessage(sendMutation.error, "No se pudo encolar el envío")}: revisa los
                      datos y reintenta. Tu mensaje se conserva.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      disabled={!connectionId || !selectedChannel?.usable || sendMutation.isPending}
                      onClick={() => sendMutation.mutate()}
                    >
                      {sendMutation.isPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Encolando…
                        </>
                      ) : (
                        `Enviar por ${channelLabel(selectedChannel?.channel ?? "email").toLowerCase()}`
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={sendMutation.isPending}
                      onClick={() => setOpen(false)}
                    >
                      Cancelar
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Queda en la conversación de {recipient?.displayName ?? "la persona"}, con el
                    documento adjunto.
                  </p>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
