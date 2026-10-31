import { Skeleton } from "@odentia/ui"
import { EmptyState, ErrorState, PageHeader, SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { MessageCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { IntegrationsCrumbWithText } from "../../components/integrations/integrations-crumb"
import { WhatsAppConnect } from "../../components/integrations/whatsapp/connect"
import { WhatsAppConnection } from "../../components/integrations/whatsapp/connection"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import { type ConnectResult, whatsappNumbers } from "../../lib/whatsapp"
import { WhatsAppPageSkeleton, WhatsAppSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/integrations/whatsapp")({
  // `?mensaje=` abre ese mensaje: «Cambiar el texto» de «Te espera» llega así (ADR 0040).
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
  const offering = listQuery.data !== undefined && offerConnect
  // Sin ningún número conectado la página ofrece conectar uno: la clínica sin números y la que
  // desconectó el suyo, que así puede poner otro. El bloque sigue montado hasta que el intento
  // termina, aunque la lista ya traiga la conexión: el botón de Facebook entrega su resultado al final.
  useEffect(() => {
    if (offering) setConnectOpen(true)
  }, [offering])
  // De vuelta del panel con la conexión hecha con el botón: se dice como si se hubiera hecho aquí.
  // Lo pendiente y los mensajes los lee la tarjeta del servidor; `conectado` solo dice cuál fue.
  useEffect(() => {
    if (!conectado || listQuery.data === undefined) return
    if (connections.some((connection) => connection.id === conectado)) {
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
      another={connections.length > 0}
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
          {connections.map((connection) => {
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
          {/* Con un número conectado no se ofrece otro: lo automático sale por uno solo y una conexión
              no pertenece a una sede. Quien lo desconecta puede conectar otro; el anterior queda de historial. */}
          {canWrite && connectOpen && offerConnect ? connect : null}
        </>
      )}
    </div>
  )
}
