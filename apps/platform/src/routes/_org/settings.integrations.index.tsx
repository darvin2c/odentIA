import { Alert, AlertDescription } from "@odentia/ui"
import { ErrorState, PageHeader } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { ChannelPanel } from "../../components/integrations/channel-panel"
import {
  type IntegrationAction,
  IntegrationBlock,
  IntegrationRow,
  IntegrationRowsSkeleton,
} from "../../components/integrations/integration-list"
import { MailPanel } from "../../components/integrations/mail-panel"
import { SettingsNoAccess } from "../../components/settings/no-access"
import type { AgentModelStatus } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import {
  type ChannelRow,
  channelRows,
  INTEGRATIONS,
  isPanelChannel,
  type MailboxProvider,
  type MailRow,
  type MailState,
  mailNotice,
  mailRows,
  modelRow,
  type PanelChannel,
  sinceWords,
  validateIntegrationsSearch,
  type WebchatRow,
  type WebchatSummary,
  webchatRows,
} from "../../lib/integrations"
import { activeOrgTimeZone, useOrgLocale } from "../../lib/locale"

export const Route = createFileRoute("/_org/settings/integrations/")({
  // El proveedor de correo vuelve aquí tras autorizar, con el resultado en la dirección.
  validateSearch: validateIntegrationsSearch,
  component: IntegrationsPage,
})

const orgRouteApi = getRouteApi("/_org")

/** Lo que está abierto al lado: un canal de mensajería o un buzón. */
type OpenPanel =
  | {
      kind: "channel"
      channel: PanelChannel
      connectionId: string | null
      /** Cada apertura es una superficie nueva; conectar dentro de ella no la reinicia. */
      opening: number
    }
  | { kind: "mail"; provider: MailboxProvider; connectionId: string }
  | null

/** Lo que la página mira de cada consulta, sea cual sea su dato. */
interface LoadState {
  isError: boolean
  isPending: boolean
  data: unknown
  refetch: () => unknown
}

const SUBTITLE = "Lo que se conecta una vez. Cada fila dice para qué sirve, con qué cuenta y cómo está."
const SUBTITLE_SHORT = "Lo que se conecta una vez: para qué sirve y cómo está."

const MESSAGING_NOTE =
  "Lo automático sale por WhatsApp y, si no se puede, por correo. Instagram, Messenger y Telegram solo responden a quien escribió primero."

/**
 * Integraciones: una página con lo que la clínica conecta una vez —mensajería,
 * el chat de su sitio, el correo y el modelo del agente—, una fila por
 * integración. WhatsApp, Chat web y el modelo abren su pantalla; los demás, su
 * detalle al lado (o en el cajón si no cabe).
 */
function IntegrationsPage() {
  const { org } = orgRouteApi.useRouteContext()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const canSeeMail = usePermission("conversations.read")
  const canSeeAgent = usePermission("agent.read")
  const locale = useOrgLocale()
  const search = Route.useSearch()
  // El aviso es el de la llegada: no cambia aunque después cambie la dirección.
  const [arrival] = useState(() => mailNotice(search))
  const [panel, setPanel] = useState<OpenPanel>(null)
  const openings = useRef(0)

  const connectionsQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
    enabled: canRead,
    retry: 1,
  })
  const webchatQuery = useQuery({
    queryKey: ["webchat-connections", org.slug],
    queryFn: () => apiFetch<{ data: WebchatSummary[] }>("/api/channels/webchat"),
    enabled: canRead,
    retry: 1,
  })
  const mailQuery = useQuery({
    queryKey: ["mail"],
    queryFn: () => apiFetch<{ data: MailState }>("/api/mail/connections"),
    enabled: canRead && canSeeMail,
    retry: 1,
  })
  // «Responde» o «No responde»: la misma comprobación que el encendido (10 minutos en el servidor).
  const modelQuery = useQuery({
    queryKey: ["agent-model"],
    queryFn: () => apiFetch<{ data: AgentModelStatus }>("/api/agent/model"),
    enabled: canRead && canSeeAgent,
    retry: 1,
    staleTime: 60_000,
  })

  const connectMail = useMutation({
    mutationFn: (provider: MailboxProvider) =>
      apiFetch<{ data: { url: string } }>("/api/mail/oauth/start", { method: "POST", body: JSON.stringify({ provider }) }),
    // Se sale de la página hacia el proveedor; al volver, el aviso llega en la dirección.
    onSuccess: ({ data }) => {
      window.location.href = data.url
    },
  })
  // Tras el visto bueno la página se va: los botones no vuelven a ofrecerse entretanto.
  const leavingToProvider = connectMail.isPending || connectMail.isSuccess

  const since = (iso: string) => sinceWords(iso, Date.now(), locale, activeOrgTimeZone())
  const connections = connectionsQuery.data?.data
  const lastInboundOf = (id: string) => connections?.find((item) => item.id === id)?.lastInboundAt

  const channels = connections ? channelRows(connections, since) : null
  const webchats = webchatQuery.data ? webchatRows(webchatQuery.data.data, lastInboundOf, since) : null
  const mailboxes = mailQuery.data ? mailRows(mailQuery.data.data, lastInboundOf, since) : null
  // Mientras se comprueba, la fila lo dice; la página no espera a la llamada al modelo.
  const model = modelRow(modelQuery.data?.data)

  const panelChannelRow =
    panel?.kind === "channel"
      ? (channels?.find(
          (row) => row.channel === panel.channel && (row.connection?.id ?? null) === panel.connectionId,
        ) ?? null)
      : null
  const panelMailRow =
    panel?.kind === "mail" ? (mailboxes?.find((row) => row.connection?.id === panel.connectionId) ?? null) : null
  // La conexión abierta ya no existe (se quitó aquí o en otra parte): el panel no tiene qué mostrar.
  const panelGone =
    panel?.kind === "channel"
      ? panel.connectionId !== null && panelChannelRow === null && !connectionsQuery.isFetching
      : panel?.kind === "mail" && panelMailRow === null && !mailQuery.isFetching
  useEffect(() => {
    if (panelGone) setPanel(null)
  }, [panelGone])

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Integraciones" />
        <SettingsNoAccess />
      </div>
    )
  }

  // Lo que no llegó nunca; un fallo al actualizar no retira lo que ya estaba en pantalla.
  const neverLoaded = (query: LoadState) => query.isError && query.data === undefined
  const tried: LoadState[] = [
    connectionsQuery,
    webchatQuery,
    ...(canSeeMail ? [mailQuery] : []),
    ...(canSeeAgent ? [modelQuery] : []),
  ]
  const failed = tried.filter(neverLoaded)
  const loading = tried.some((query) => query !== modelQuery && query.isPending)
  const modelFailed = neverLoaded(modelQuery)

  /** Lo que ofrece cada fila. Un enlace o una acción solo se ofrece a quien puede usarla. */
  function channelActions(row: ChannelRow): IntegrationAction[] {
    if (!row.connection && !canWrite) return []
    if (row.channel === "whatsapp") {
      return [
        {
          label: row.connection ? "Abrir" : "Conectar",
          emphasis: row.connection ? "secondary" : "primary",
          to: "/settings/integrations/whatsapp",
        },
      ]
    }
    if (!isPanelChannel(row.channel)) return []
    const channel = row.channel
    const needsStep = !row.connection || row.tone === "attention"
    return [
      {
        label: !row.connection ? "Conectar" : row.tone === "attention" ? "Terminar de conectar" : canWrite ? "Administrar" : "Ver",
        ...(row.connection && row.tone === "attention" ? { short: "Terminar" } : {}),
        emphasis: needsStep ? "primary" : "secondary",
        onSelect: () => {
          openings.current += 1
          setPanel({ kind: "channel", channel, connectionId: row.connection?.id ?? null, opening: openings.current })
        },
      },
    ]
  }

  function webchatActions(row: WebchatRow): IntegrationAction[] {
    if (!row.connection && !canWrite) return []
    return [
      {
        label: !row.connection ? "Conectar" : canWrite ? "Administrar" : "Ver",
        emphasis: row.connection ? "secondary" : "primary",
        to: "/settings/integrations/webchat",
      },
    ]
  }

  function mailActions(row: MailRow): IntegrationAction[] {
    const authorize: IntegrationAction = {
      label: row.connection ? "Volver a conectar" : "Conectar",
      emphasis: "primary",
      onSelect: () => connectMail.mutate(row.provider),
      pending: leavingToProvider,
      disabled: !row.available,
    }
    // Sin buzón, lo único que hay es conectarlo; si no se puede, la fila ya lo dice.
    if (!row.connection) return canWrite && row.available ? [authorize] : []
    const connectionId = row.connection.id
    const detail: IntegrationAction = {
      label: canWrite ? "Administrar" : "Ver",
      emphasis: "secondary",
      onSelect: () => setPanel({ kind: "mail", provider: row.provider, connectionId }),
    }
    // El detalle va al final: es lo que abre la fila corta, y ahí también se vuelve a conectar.
    return row.tone === "attention" && canWrite ? [authorize, detail] : [detail]
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Integraciones"
        subtitle={
          <>
            <span className="sm:hidden">{SUBTITLE_SHORT}</span>
            <span className="max-sm:hidden">{SUBTITLE}</span>
          </>
        }
      />

      {arrival ? (
        <Alert
          variant={arrival.tone === "danger" ? "destructive" : "default"}
          className={arrival.tone === "success" ? "border-success/30 bg-success-soft" : undefined}
        >
          <AlertDescription className={arrival.tone === "success" ? "text-foreground" : undefined}>{arrival.text}</AlertDescription>
        </Alert>
      ) : null}
      {connectMail.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            No pudimos abrir la autorización de{" "}
            {connectMail.variables ? INTEGRATIONS[connectMail.variables].name : "el correo"}. Vuelve a intentarlo.
          </AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <p role="status" className="sr-only">
          Cargando las integraciones…
        </p>
      ) : null}

      {failed.length > 0 ? (
        <ErrorState
          title="No pudimos cargar las integraciones"
          message={
            failed.length === tried.length
              ? "Comprueba tu conexión y vuelve a intentarlo."
              : "Falta una parte de la lista. Lo que sí cargó sigue aquí abajo."
          }
          onRetry={() => {
            for (const query of failed) void query.refetch()
          }}
        />
      ) : null}

      {neverLoaded(connectionsQuery) ? null : (
        <IntegrationBlock title="Mensajería" note={MESSAGING_NOTE}>
          {channels ? (
            channels.map((row) => (
              <IntegrationRow
                key={row.key}
                row={row}
                actions={channelActions(row)}
                open={
                  panel?.kind === "channel" &&
                  panel.channel === row.channel &&
                  panel.connectionId === (row.connection?.id ?? null)
                }
              />
            ))
          ) : (
            <IntegrationRowsSkeleton rows={4} />
          )}
        </IntegrationBlock>
      )}

      {neverLoaded(webchatQuery) ? null : (
        <IntegrationBlock title="Tu sitio web">
          {webchats ? (
            webchats.map((row) => <IntegrationRow key={row.key} row={row} actions={webchatActions(row)} />)
          ) : (
            <IntegrationRowsSkeleton rows={1} />
          )}
        </IntegrationBlock>
      )}

      {!canSeeMail || neverLoaded(mailQuery) ? null : (
        <IntegrationBlock title="Correo de la clínica">
          {mailboxes ? (
            mailboxes.map((row) => (
              <IntegrationRow
                key={row.key}
                row={row}
                actions={mailActions(row)}
                open={panel?.kind === "mail" && panel.connectionId === row.connection?.id}
              />
            ))
          ) : (
            <IntegrationRowsSkeleton rows={2} />
          )}
        </IntegrationBlock>
      )}

      {!canSeeAgent || modelFailed ? null : (
        <IntegrationBlock title="Inteligencia artificial">
          <IntegrationRow row={model} actions={[]} />
        </IntegrationBlock>
      )}

      {/* Una sola superficie lateral a la vez; `key` la reinicia al abrir otra fila. */}
      {panel?.kind === "channel" ? (
        <ChannelPanel
          key={panel.opening}
          channel={panel.channel}
          row={panelChannelRow}
          loading={panel.connectionId !== null && panelChannelRow === null}
          canWrite={canWrite}
          onClose={() => setPanel(null)}
          onConnected={(connectionId) => setPanel({ ...panel, connectionId })}
        />
      ) : null}
      {panel?.kind === "mail" && panelMailRow ? (
        <MailPanel
          key={panelMailRow.key}
          row={panelMailRow}
          canManage={canWrite}
          connecting={leavingToProvider}
          onConnect={() => connectMail.mutate(panel.provider)}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  )
}
