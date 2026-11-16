import { Alert, AlertDescription, Button, Skeleton } from "@odentia/ui"
import { EmptyState, ErrorState, PageHeader, SkeletonRegion, ViewTabs } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { MessageCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { type ConnectionItem, usePermission } from "../../lib/crm"
import {
  channelAccountRows,
  INTEGRATIONS,
  type PanelChannel,
  sinceWords,
} from "../../lib/integrations"
import { activeOrgTimeZone, useOrgLocale } from "../../lib/locale"
import { SettingsNoAccess } from "../settings/no-access"
import { ChannelPanel } from "./channel-panel"
import { ChooseFacebookPage, MetaConnectButton, useMetaConnect } from "./facebook-pages-button"
import { IntegrationBlock, IntegrationRow, IntegrationRowsSkeleton } from "./integration-list"
import { IntegrationsCrumbWithText } from "./integrations-crumb"

type Tab = "conexion" | "desconectados"

/** Lo que está abierto al lado: una cuenta, o conectar una nueva (`null`). */
type Open = { connectionId: string | null; opening: number } | null

/**
 * La página de Instagram, Messenger o Telegram, como la de WhatsApp: en
 * «Conexión», las cuentas activas (varias, como el correo) o cómo conectar una; en
 * «Desconectados», las anteriores, que guardan sus conversaciones. Conectar,
 * cambiar la clave y desconectar siguen en su panel al lado.
 */
export interface ChannelSearch {
  /** «elegir»: volvió de Facebook con varias páginas marcadas; `pick` es la elección guardada. */
  facebook?: string
  pick?: string
  /** La vuelta de «Conectar con Instagram». */
  conectado?: string
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/** Lo que trae la dirección al volver de Facebook o de Instagram. */
export function validateChannelSearch(search: Record<string, unknown>): ChannelSearch {
  const facebook = text(search.facebook)
  const pick = text(search.pick)
  const conectado = text(search.conectado)
  return { ...(facebook ? { facebook } : {}), ...(pick ? { pick } : {}), ...(conectado ? { conectado } : {}) }
}

/** La vuelta de «Conectar con Instagram», dicha sin códigos. */
export function instagramArrival(result: string | undefined): { tone: "success" | "danger" | "info"; text: string } | null {
  if (!result) return null
  if (result === "ok") return { tone: "success", text: "Instagram quedó conectado: lo que te escriban por mensaje directo ya entra a la Bandeja." }
  if (result === "cancelado") return { tone: "info", text: "No se conectó nada: cerraste la ventana de Instagram antes de terminar." }
  if (result === "sin-sesion") return { tone: "danger", text: "Tu sesión se cerró mientras estabas en Instagram. Entra y vuelve a conectar." }
  if (result === "otra") return { tone: "danger", text: "Esa cuenta de Instagram ya está conectada en otra clínica: no se tocó." }
  return { tone: "danger", text: "No pudimos conectar Instagram. Vuelve a intentarlo." }
}

export function ChannelPage({ channel, search = {} }: { channel: PanelChannel; search?: ChannelSearch }) {
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  const locale = useOrgLocale()
  const name = INTEGRATIONS[channel].name
  const [tab, setTab] = useState<Tab>("conexion")
  const [open, setOpen] = useState<Open>(null)
  const openings = useRef(0)
  // Instagram entra con Instagram (o por su página); Messenger, con Facebook. «Con tu propia app» queda de segunda.
  const meta = useMetaConnect(channel, canWrite)
  const way = meta.way
  const viaWords = way === "instagram" ? "Instagram" : "Facebook"
  // Varias páginas marcadas en Facebook: se elige una, aquí mismo.
  const [pick, setPick] = useState<string | null>(search.facebook === "elegir" && search.pick ? search.pick : null)
  const [arrival, setArrival] = useState(() => instagramArrival(search.conectado))

  const listQuery = useQuery({
    queryKey: ["connections"],
    queryFn: () => apiFetch<{ data: ConnectionItem[] }>("/api/channels/connections"),
    enabled: canRead,
    retry: 1,
  })
  const since = (iso: string) => sinceWords(iso, Date.now(), locale, activeOrgTimeZone())
  const { active, disconnected } = channelAccountRows(listQuery.data?.data ?? [], channel, since)
  const hasActive = active.length > 0
  // Sin desconectadas no hay pestaña que ver: vuelve a «Conexión».
  useEffect(() => {
    if (disconnected.length === 0 && tab === "desconectados") setTab("conexion")
  }, [disconnected.length, tab])

  const show = (connectionId: string | null) => {
    openings.current += 1
    setOpen({ connectionId, opening: openings.current })
  }
  const openRow = open?.connectionId
    ? ([...active, ...disconnected].find((row) => row.connection?.id === open.connectionId) ?? null)
    : null
  const openGone =
    open?.connectionId != null &&
    openRow === null &&
    !listQuery.isFetching &&
    listQuery.data !== undefined
  useEffect(() => {
    if (openGone) setOpen(null)
  }, [openGone])
  // La cuenta abierta se desconectó o volvió a conectarse: la pestaña la sigue, para que al
  // cerrar el panel siga a la vista.
  const openStatus = openRow?.connection?.status
  useEffect(() => {
    if (openStatus === "active") setTab("conexion")
    else if (openStatus) setTab("desconectados")
  }, [openStatus])

  const header = (
    <PageHeader
      title={name}
      subtitle={<IntegrationsCrumbWithText current={name} text={INTEGRATIONS[channel].purpose} />}
    />
  )
  if (!canRead) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <SettingsNoAccess />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {header}
      {arrival ? (
        <Alert
          variant={arrival.tone === "danger" ? "destructive" : "default"}
          className={arrival.tone === "success" ? "border-success/30 bg-success-soft" : undefined}
        >
          <AlertDescription className={arrival.tone === "success" ? "text-foreground" : undefined}>{arrival.text}</AlertDescription>
        </Alert>
      ) : null}
      {pick && canWrite ? (
        <ChooseFacebookPage
          pick={pick}
          onDone={(done) => {
            setPick(null)
            if (done) setArrival({ tone: "success", text: done })
          }}
        />
      ) : null}
      {listQuery.isError && listQuery.data === undefined ? (
        <ErrorState
          title={`No pudimos cargar ${name}`}
          message="Comprueba tu conexión y vuelve a intentarlo."
          onRetry={() => void listQuery.refetch()}
        />
      ) : listQuery.isPending ? (
        <SkeletonRegion message={`Cargando ${name}…`}>
          <IntegrationBlock title={name}>
            <IntegrationRowsSkeleton rows={1} />
          </IntegrationBlock>
        </SkeletonRegion>
      ) : (
        <>
          {disconnected.length > 0 ? (
            <ViewTabs
              label={`Qué ver de ${name}`}
              value={tab}
              onValueChange={setTab}
              options={[
                { value: "conexion", label: "Conexión" },
                { value: "desconectados", label: "Desconectados", count: disconnected.length },
              ]}
            />
          ) : null}
          {tab === "conexion" && hasActive ? (
            <IntegrationBlock title="Conectadas">
              {active.map((row) => (
                <IntegrationRow
                  key={row.key}
                  row={row}
                  open={open?.connectionId === row.connection?.id}
                  actions={[
                    {
                      label:
                        row.tone === "attention" ? "Revisar" : canWrite ? "Administrar" : "Ver",
                      emphasis: row.tone === "attention" ? "primary" : "secondary",
                      onSelect: () => show(row.connection?.id ?? null),
                    },
                  ]}
                />
              ))}
            </IntegrationBlock>
          ) : null}
          {tab === "conexion" && hasActive && canWrite ? (
            // Como varios buzones de correo: otra cuenta se suma a las que ya están.
            <div className="flex flex-wrap items-start gap-2">
              {way ? <MetaConnectButton way={way} label={`Conectar otra con ${viaWords}`} variant="outline" /> : null}
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => show(null)}
              >
                {way ? "Con tu propia app de Meta" : "Conectar otra cuenta"}
              </Button>
            </div>
          ) : null}
          {tab === "conexion" && !hasActive ? (
            canWrite ? (
              <section
                aria-label={`Conecta ${name}`}
                className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4"
              >
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold">Conecta {name}</h2>
                  <p className="text-sm text-muted-foreground">
                    <strong className="font-semibold text-foreground">Para conectar:</strong>{" "}
                    {way === "instagram"
                      ? "entra con la cuenta profesional de Instagram de la clínica, tenga o no página de Facebook."
                      : way === "facebook"
                        ? channel === "instagram"
                          ? "entra con el Facebook de quien administra la página unida al Instagram de la clínica y elige esa página."
                          : "entra con el Facebook de quien administra la página de la clínica. Si marcas varias, eliges una; también puedes conectar su Instagram."
                        : INTEGRATIONS[channel].toConnect}
                    {disconnected.length > 0
                      ? " También puedes volver a conectar una cuenta anterior en «Desconectados»."
                      : null}
                  </p>
                </div>
                {meta.pending ? (
                  <Skeleton className="h-9 w-44 rounded-3xl" aria-label="Cargando cómo conectar" />
                ) : way ? (
                  <div className="flex flex-wrap items-start gap-2">
                    <MetaConnectButton way={way} label={`Conectar con ${viaWords}`} />
                    <Button type="button" variant="outline" className="self-start" onClick={() => show(null)}>
                      Con tu propia app de Meta
                    </Button>
                  </div>
                ) : meta.failed ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm text-muted-foreground">No pudimos saber si está «Conectar con Facebook».</p>
                    <Button type="button" variant="outline" size="sm" onClick={meta.retry}>
                      Reintentar
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => show(null)}>
                      Con tu propia app de Meta
                    </Button>
                  </div>
                ) : (
                  <Button type="button" className="self-start" onClick={() => show(null)}>
                    Conectar
                  </Button>
                )}
              </section>
            ) : (
              <EmptyState
                icon={MessageCircle}
                title={`${name} todavía no está conectado`}
                description="Lo conecta quien administra la clínica."
              />
            )
          ) : null}
          {tab === "desconectados" ? (
            <IntegrationBlock title="Desconectados" note="Sus conversaciones siguen en la Bandeja.">
              {disconnected.map((row) => (
                <IntegrationRow
                  key={row.key}
                  row={row}
                  open={open?.connectionId === row.connection?.id}
                  actions={[
                    {
                      label: canWrite ? "Administrar" : "Ver",
                      emphasis: "secondary",
                      onSelect: () => show(row.connection?.id ?? null),
                    },
                  ]}
                />
              ))}
            </IntegrationBlock>
          ) : null}
          {listQuery.data === undefined ? <IntegrationRowsSkeleton rows={1} /> : null}
        </>
      )}

      {/* Una sola superficie lateral a la vez; `key` la reinicia al abrir otra. */}
      {open ? (
        <ChannelPanel
          key={open.opening}
          channel={channel}
          row={openRow}
          loading={open.connectionId !== null && openRow === null}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
          onConnected={(connectionId) => {
            setOpen({ ...open, connectionId })
            setTab("conexion")
          }}
        />
      ) : null}
    </div>
  )
}
