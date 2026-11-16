import { EmptyState, ErrorState, PageHeader, SkeletonRegion, ViewTabs } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { MessageCircle } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { IntegrationsCrumbWithText } from "../../components/integrations/integrations-crumb"
import { WhatsAppConnect } from "../../components/integrations/whatsapp/connect"
import { WhatsAppConnection } from "../../components/integrations/whatsapp/connection"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import { type ConnectResult, whatsappNumbers } from "../../lib/whatsapp"
import { WhatsAppPageSkeleton, WhatsAppSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/integrations/whatsapp")({
  // `?mensaje=` abre ese mensaje: «Cambiar el texto» del panel de «Te espera» llega así (ADR 0040).
  // `?conectado=` lo pone el panel al volver de «Conectar con Facebook» (issue 166).
  validateSearch: (search: Record<string, unknown>): { mensaje: string | undefined; conectado?: string } => ({
    mensaje: typeof search.mensaje === "string" && search.mensaje ? search.mensaje : undefined,
    ...(typeof search.conectado === "string" && search.conectado ? { conectado: search.conectado } : {}),
  }),
  pendingComponent: WhatsAppPageSkeleton,
  component: WhatsAppPage,
})

const TITLE = "WhatsApp"
const SUBTITLE = "El número de la clínica y los mensajes que WhatsApp deja enviar."

/** Lo que se conectó en esta visita: de ahí sale lo que la página dice al terminar. */
interface Fresh {
  result: ConnectResult
  /** Con el botón de Facebook; si no, con los datos de la app de Meta. */
  byButton: boolean
  /** A mano: ya se leyó qué número se encontró. */
  read: boolean
}

/**
 * WhatsApp, la única integración con pantalla propia: además de la conexión
 * tiene sus mensajes. Sin conectar ofrece los dos caminos en una sola pantalla;
 * conectado muestra el número, cómo está y los mensajes que WhatsApp deja
 * enviar, que la clínica puede cambiar.
 */
function WhatsAppPage() {
  const { mensaje, conectado } = Route.useSearch()
  const navigate = Route.useNavigate()
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const [fresh, setFresh] = useState<Fresh | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  // Abre siempre en «Conexión»: lo de hoy. Lo desconectado va aparte para no interrumpir.
  const [tab, setTab] = useState<"conexion" | "desconectados">("conexion")

  const listQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
    enabled: canRead,
    retry: 1,
  })
  const { ordered: connections, activeCount, offerConnect } = useMemo(
    () => whatsappNumbers((listQuery.data?.data ?? []).filter((connection) => connection.channel === "whatsapp")),
    [listQuery.data],
  )
  const activeConnections = connections.filter((connection) => connection.status === "active")
  const disconnected = connections.filter((connection) => connection.status !== "active")
  const offering = listQuery.data !== undefined && offerConnect
  // Sin ningún número conectado la página ofrece conectar uno: la clínica sin números y la que
  // desconectó el suyo, que así puede poner otro. El bloque sigue montado hasta que el intento
  // termina, aunque la lista ya traiga la conexión: el botón de Facebook entrega su resultado al final.
  useEffect(() => {
    if (offering) setConnectOpen(true)
  }, [offering])
  // De vuelta del panel con la conexión hecha con el botón: se dice como si se hubiera hecho aquí.
  // Lo pendiente y los mensajes los lee la tarjeta del servidor; `conectado` solo dice cuál fue.
  // Un número se desconectó o volvió a conectarse: su tarjeta cambia de pestaña. La página
  // lo dice arriba y muestra la pestaña donde quedó, para que no desaparezca sin explicación.
  const [moved, setMoved] = useState<string | null>(null)
  const statuses = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (listQuery.data === undefined) return
    const now = new Map(connections.map((connection) => [connection.id, connection.status]))
    const before = statuses.current
    statuses.current = now
    if (!before) return
    for (const [id, status] of now) {
      const was = before.get(id)
      if (!was || was === status) continue
      if (status === "active") {
        setTab("conexion")
        setMoved("WhatsApp volvió a conectarse.")
      } else {
        setMoved("WhatsApp quedó desconectado. Sus conversaciones se guardan; el número está en «Desconectados».")
      }
    }
  }, [connections, listQuery.data])
  // Sin desconectados no hay pestaña que ver.
  useEffect(() => {
    if (disconnected.length === 0 && tab === "desconectados") setTab("conexion")
  }, [disconnected.length, tab])
  useEffect(() => {
    if (!conectado || listQuery.data === undefined) return
    if (connections.some((connection) => connection.id === conectado)) {
      setTab("conexion")
      setConnectOpen(false)
      setFresh({ result: { id: conectado }, byButton: true, read: true })
    }
    void navigate({ search: ({ conectado: _shown, ...rest }) => rest, replace: true, resetScroll: false })
  }, [conectado, connections, listQuery.data, navigate])

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={TITLE} subtitle={<IntegrationsCrumbWithText current={TITLE} text={SUBTITLE} />} />
        <SettingsNoAccess />
      </div>
    )
  }

  const connect = (
    <WhatsAppConnect
      another={activeCount > 0}
      onCreated={(result) => {
        setConnectOpen(false)
        setFresh({ result, byButton: false, read: false })
      }}
    />
  )

  return (
    // En teléfono «Nuevo mensaje» queda fijo al pie: el contenido deja ese sitio libre.
    <div className={activeCount === 1 && canWrite ? "flex flex-col gap-4 pb-20 sm:pb-0" : "flex flex-col gap-4"}>
      <PageHeader title={TITLE} subtitle={<IntegrationsCrumbWithText current={TITLE} text={SUBTITLE} />} />

      {listQuery.isPending ? (
        <SkeletonRegion message="Cargando WhatsApp…">
          <WhatsAppSkeleton />
        </SkeletonRegion>
      ) : listQuery.isError && listQuery.data === undefined ? (
        <ErrorState
          title="No pudimos cargar WhatsApp"
          message="Comprueba tu conexión y vuelve a intentarlo."
          onRetry={() => void listQuery.refetch()}
        />
      ) : connections.length === 0 ? (
        canWrite ? (
          connect
        ) : (
          <EmptyState
            icon={MessageCircle}
            title="WhatsApp todavía no está conectado"
            description="Lo conecta quien administra la clínica. Cuando lo haga, aquí verás el número y sus mensajes."
          />
        )
      ) : (
        <>
          {moved ? (
            <p role="status" className="text-sm font-medium text-success">
              {moved}
            </p>
          ) : null}
          {disconnected.length > 0 ? (
            <ViewTabs
              label="Qué ver de WhatsApp"
              value={tab}
              onValueChange={setTab}
              options={[
                { value: "conexion", label: "Conexión" },
                { value: "desconectados", label: "Desconectados", count: disconnected.length },
              ]}
            />
          ) : null}
          {(tab === "conexion" ? activeConnections : disconnected).map((connection) => {
            const own = fresh?.result.id === connection.id ? fresh : null
            return (
              <WhatsAppConnection
                key={connection.id}
                connection={connection}
                fresh={own?.result ?? null}
                freshRead={own?.read ?? false}
                freshByButton={own?.byButton ?? false}
                showAccount={connections.length > 1}
                otherActive={connection.status !== "active" && activeCount > 0}
                canWrite={canWrite}
                fixedCreate={activeCount === 1}
                initialMessageId={mensaje ?? null}
                onFreshRead={() => setFresh((current) => (current ? { ...current, read: true } : current))}
              />
            )
          })}
          {tab === "conexion" && activeCount > 0 && canWrite ? (
            <p className="text-sm text-muted-foreground">
              Solo un WhatsApp a la vez: para conectar otro número, primero desconecta este. Sus conversaciones se guardan.
            </p>
          ) : null}
          {tab === "desconectados" && activeCount === 0 && canWrite ? (
            <p className="text-sm text-muted-foreground">Vuelve a conectar uno de estos números, o conecta otro en «Conexión».</p>
          ) : null}
          {/* Con un número conectado no se ofrece otro: lo automático sale por uno solo y una conexión
              no pertenece a una sede. Quien lo desconecta puede conectar otro; el anterior queda en «Desconectados». */}
          {tab === "conexion" && canWrite && connectOpen && offerConnect ? connect : null}
          {tab === "conexion" && activeCount === 0 && !canWrite ? (
            <EmptyState
              icon={MessageCircle}
              title="WhatsApp no está conectado"
              description="Lo conecta quien administra la clínica. Los números anteriores están en «Desconectados»."
            />
          ) : null}
        </>
      )}
    </div>
  )
}
