import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@odentia/ui"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { MessageCircle, Send } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../lib/api"
import { type ConnectionItem, type ContactFull, timeAgo } from "../lib/crm"

export interface ConversationDialogContact {
  contactId: string
  displayName: string
  isPreferred?: boolean
}

interface ContactConversationDialogProps {
  open: boolean
  onClose: () => void
  contacts: ConversationDialogContact[]
  prepareRegistration?: boolean
}

function channelLabel(channel: string): string {
  return channel === "whatsapp" ? "WhatsApp" : channel === "telegram" ? "Telegram" : channel
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "La acción omnicanal aún no está disponible en la API."
    return err.message || fallback
  }
  return err instanceof Error ? err.message : fallback
}

/**
 * Selector compartido persona → conversación/canal. Toda navegación a la
 * bandeja es una acción explícita del operador; nunca crea enlaces de
 * registro (los tokens solo se crean desde la bandeja).
 */
export function ContactConversationDialog({
  open,
  onClose,
  contacts,
  prepareRegistration = false,
}: ContactConversationDialogProps) {
  const navigate = useNavigate()
  const defaultId = useMemo(() => {
    if (contacts.length === 0) return ""
    return contacts.find((c) => c.isPreferred)?.contactId ?? contacts[0].contactId
  }, [contacts])
  const [selectedId, setSelectedId] = useState(defaultId)
  const [identityId, setIdentityId] = useState("")
  const [connectionId, setConnectionId] = useState("")

  useEffect(() => {
    if (open) {
      setSelectedId(defaultId)
      setIdentityId("")
      setConnectionId("")
      startMutation.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultId])

  const detailQuery = useQuery({
    queryKey: ["contact", selectedId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${selectedId}`),
    enabled: open && selectedId !== "",
  })
  // Metadatos de uso (conversations.read): el listado admin exige settings.read.
  type UsableConnection = Pick<
    ConnectionItem,
    "id" | "channel" | "provider" | "displayName" | "externalId" | "status" | "capabilities"
  >
  const connectionsQuery = useQuery({
    queryKey: ["connections", "usable"],
    queryFn: () => apiFetch<{ data: UsableConnection[] }>("/api/channels/connections/usable"),
    enabled: open,
  })

  const detail = detailQuery.data?.data
  const identities = detail?.identities ?? []
  const conversations = detail?.conversations ?? []
  const connections = useMemo(
    () => connectionsQuery.data?.data ?? [],
    [connectionsQuery.data],
  )
  const selectedIdentity = identities.find((i) => i.id === identityId)
  const availableConnections = useMemo(
    () =>
      selectedIdentity
        ? connections.filter(
            (c) => c.channel === selectedIdentity.channel && c.status === "active",
          )
        : [],
    [connections, selectedIdentity],
  )
  const isArchived = detail ? !detail.contact.isActive : false

  const startMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { id: string; status: string; created: boolean } }>(
        `/api/contacts/${selectedId}/conversations`,
        {
          method: "POST",
          body: JSON.stringify({ identityId, connectionId }),
        },
      ),
    onSuccess: (created) => {
      goToConversation(created.data.id)
    },
  })

  function goToConversation(conversationId: string) {
    onClose()
    void navigate({
      to: "/inbox",
      search: prepareRegistration
        ? { conversation: conversationId, prepareRegistration: true as const }
        : { conversation: conversationId },
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {prepareRegistration ? "Enviar registro" : "Conversar"}
          </DialogTitle>
          <DialogDescription>
            {prepareRegistration
              ? "Elige la persona y la conversación donde se preparará el enlace de registro. El enlace se crea y revisa en la bandeja antes de enviar."
              : "Elige la persona y el canal. Si hay varias personas, confirma conscientemente el destino antes de abrir la bandeja."}
          </DialogDescription>
        </DialogHeader>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay contactos para conversar. Vincula o crea un contacto primero.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {contacts.length > 1 && (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">Persona</span>
                <select
                  aria-label="Persona"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={selectedId}
                  onChange={(e) => {
                    setSelectedId(e.target.value)
                    setIdentityId("")
                    setConnectionId("")
                    startMutation.reset()
                  }}
                >
                  {contacts.map((c) => (
                    <option key={c.contactId} value={c.contactId}>
                      {c.displayName}
                      {c.isPreferred ? " · preferente" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {detailQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando canales…</p>
            ) : detail ? (
              <>
                {isArchived && (
                  <p className="rounded-md border border-warning/30 bg-warning-soft p-2 text-sm">
                    Contacto archivado: reactívalo desde su ficha para iniciar nuevas
                    conversaciones. Las conversaciones existentes siguen accesibles.
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">Conversaciones existentes</span>
                  {conversations.length === 0 && (
                    <p className="text-sm text-muted-foreground">Sin conversaciones.</p>
                  )}
                  {conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm">
                        {conv.channel === "whatsapp" ? (
                          <MessageCircle className="size-4 shrink-0 text-success" />
                        ) : (
                          <Send className="size-4 shrink-0 text-primary" />
                        )}
                        <span className="truncate">
                          {channelLabel(conv.channel)}
                          {conv.connectionName ? ` · ${conv.connectionName}` : ""}
                        </span>
                        <Badge
                          variant="secondary"
                          className={conv.status === "open" ? "border-success/30 bg-success-soft text-success" : undefined}
                        >
                          {conv.status}
                        </Badge>
                        <span className="shrink-0 text-muted-foreground">
                          {timeAgo(conv.lastMessageAt)}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => goToConversation(conv.id)}
                      >
                        Abrir
                      </Button>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">Iniciar conversación</span>
                  {identities.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No hay un canal disponible para este contacto. Gestiona sus canales
                      desde la ficha antes de iniciar una conversación.
                    </p>
                  ) : (
                    <>
                      <select
                        aria-label="Identidad de canal"
                        className="rounded-md border bg-background px-2 py-1.5 text-sm"
                        value={identityId}
                        onChange={(e) => {
                          setIdentityId(e.target.value)
                          setConnectionId("")
                          startMutation.reset()
                        }}
                      >
                        <option value="">Elige identidad…</option>
                        {identities.map((ident) => (
                          <option key={ident.id} value={ident.id}>
                            {channelLabel(ident.channel)} ·{" "}
                            {ident.displayName ?? ident.externalUserId}
                          </option>
                        ))}
                      </select>
                      {selectedIdentity && availableConnections.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No hay una conexión activa de{" "}
                          {channelLabel(selectedIdentity.channel)}. Revisa la
                          configuración de canales.
                        </p>
                      )}
                      {availableConnections.length > 0 && (
                        <select
                          aria-label="Conexión"
                          className="rounded-md border bg-background px-2 py-1.5 text-sm"
                          value={connectionId}
                          onChange={(e) => {
                            setConnectionId(e.target.value)
                            startMutation.reset()
                          }}
                        >
                          <option value="">Elige conexión…</option>
                          {availableConnections.map((conn) => (
                            <option key={conn.id} value={conn.id}>
                              {conn.displayName}
                            </option>
                          ))}
                        </select>
                      )}
                      {startMutation.error && (
                        <p role="alert" className="text-sm text-destructive">
                          {errorMessage(startMutation.error, "No se pudo iniciar la conversación.")}
                        </p>
                      )}
                      <div>
                        <Button
                          type="button"
                          disabled={
                            !identityId || !connectionId || isArchived || startMutation.isPending
                          }
                          onClick={() => startMutation.mutate()}
                        >
                          {startMutation.isPending ? "Iniciando…" : "Iniciar y abrir"}
                        </Button>
                      </div>
                      {selectedIdentity?.channel === "telegram" && (
                        <p className="text-xs text-muted-foreground">
                          Telegram exige que la persona haya escrito antes al bot; sin
                          conversación previa no se puede iniciar.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : detailQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(detailQuery.error, "No se pudo cargar el contacto.")}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
