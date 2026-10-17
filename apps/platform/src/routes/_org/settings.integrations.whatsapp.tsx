import { Skeleton } from "@odentia/ui"
import { EmptyState, ErrorState, PageHeader } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { MessageCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { IntegrationsCrumb } from "../../components/integrations/integrations-crumb"
import { WhatsAppConnect } from "../../components/integrations/whatsapp/connect"
import { WhatsAppConnection } from "../../components/integrations/whatsapp/connection"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import type { ConnectResult } from "../../lib/whatsapp"

export const Route = createFileRoute("/_org/settings/integrations/whatsapp")({
  // `?mensaje=` abre ese mensaje: «Cambiar el texto» de «Te espera» llega así (ADR 0040).
  validateSearch: (search: Record<string, unknown>) => ({
    mensaje: typeof search.mensaje === "string" && search.mensaje ? search.mensaje : undefined,
  }),
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

/** La página mientras llega la primera respuesta: el título ya está; debajo, la forma de lo que viene. */
function WhatsAppSkeleton() {
  return (
    <>
      <p role="status" className="sr-only">
        Cargando WhatsApp…
      </p>
      <div aria-hidden className="flex flex-col gap-4">
        <div className="elevated flex items-center gap-3.5 rounded-xl border bg-card p-4">
          <Skeleton className="hidden size-11 shrink-0 rounded-xl sm:block" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
          <Skeleton className="h-9 w-28 shrink-0 rounded-full" />
        </div>
        <div className="elevated flex flex-col rounded-xl border bg-card">
          <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-3/5" />
          </div>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 border-t px-4 py-3 sm:px-5">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
              <Skeleton className="h-5 w-24 shrink-0 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/**
 * WhatsApp, la única integración con pantalla propia: además de la conexión
 * tiene sus mensajes. Sin conectar ofrece los dos caminos en una sola pantalla;
 * conectado muestra el número, cómo está y los mensajes que WhatsApp deja
 * enviar, que la clínica puede cambiar.
 */
function WhatsAppPage() {
  const { mensaje } = Route.useSearch()
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
  const connections = useMemo(
    () => (listQuery.data?.data ?? []).filter((connection) => connection.channel === "whatsapp"),
    [listQuery.data],
  )
  const activeCount = connections.filter((connection) => connection.status === "active").length
  const none = listQuery.data !== undefined && connections.length === 0
  // Sin ningún número la página ofrece conectar. El bloque sigue montado hasta que el intento
  // termina, aunque la lista ya traiga la conexión: el botón de Facebook entrega su resultado al final.
  useEffect(() => {
    if (none) setConnectOpen(true)
  }, [none])

  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        <IntegrationsCrumb current={TITLE} />
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const connect = (
    <WhatsAppConnect
      onConnectedWithButton={(result) => {
        setConnectOpen(false)
        setFresh({ result, byButton: true, read: true })
      }}
      onCreated={(result) => {
        setConnectOpen(false)
        setFresh({ result, byButton: false, read: false })
      }}
    />
  )

  return (
    // En teléfono «Nuevo mensaje» queda fijo al pie: el contenido deja ese sitio libre.
    <div className={activeCount === 1 && canWrite ? "flex flex-col gap-4 pb-20 sm:pb-0" : "flex flex-col gap-4"}>
      <IntegrationsCrumb current={TITLE} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {listQuery.isPending ? (
        <WhatsAppSkeleton />
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
                canWrite={canWrite}
                fixedCreate={activeCount === 1}
                initialMessageId={mensaje ?? null}
                onFreshRead={() => setFresh((current) => (current ? { ...current, read: true } : current))}
              />
            )
          })}
          {/* No se ofrece conectar otro número: lo automático sale por uno solo y una conexión
              no pertenece a una sede. Si ya hay varias, se muestran todas. */}
          {canWrite && connectOpen ? connect : null}
        </>
      )}
    </div>
  )
}
