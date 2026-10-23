import { Button, DrawerDescription, DrawerTitle, ScrollArea } from "@odentia/ui"
import { EmptyState, LoadingState, useHeaderCompact } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bell } from "lucide-react"
import { apiFetch } from "../lib/api"
import { timeAgo } from "../lib/crm"
import type { WorkspaceNotice } from "../lib/workspace"
import { type HeaderPanelFrame, useNoticesPanel } from "./agent-panel"

/** «Hace 10 min», «Ayer»…: cuándo llegó, con mayúscula inicial. */
function arrived(iso: string): string {
  const text = timeAgo(iso)
  if (!text || text === "ahora") return "Hace un momento"
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const NOTICES_KEY = ["workspace-notifications"]

function useNotices() {
  return useQuery({
    queryKey: NOTICES_KEY,
    queryFn: () => apiFetch<{ data: { items: WorkspaceNotice[]; unread: number } }>("/api/workspace/notifications"),
    refetchInterval: 30_000,
  })
}

/**
 * La campana es para enterarse, no para trabajar: trae lo que no pide trabajo
 * (un consentimiento firmado, la caja que cerró con diferencia, WhatsApp que
 * aprobó un mensaje). Lo que hay que hacer está en «Te espera» y no se repite
 * aquí. Abrir un aviso lo marca leído; «Marcar todo leído» los marca todos; y
 * un aviso se retira solo cuando su asunto se resuelve (lo decide el servidor).
 *
 * Vive en las utilidades de la cabecera y se abre en la misma columna derecha
 * que el Agente (issue 93): uno a la vez, sin tapar la página; donde no cabe,
 * con el mismo cajón. El contenido es `NoticesPanel`, que monta el layout.
 */
export function WorkspaceNotifications() {
  const { open, setOpen } = useNoticesPanel()
  const unread = useNotices().data?.data.unread ?? 0
  const compact = useHeaderCompact()
  return (
    <Button
      type="button"
      variant="ghost"
      className={`elevated relative h-9 gap-2 rounded-full border border-border px-3 hover:bg-accent/50 max-md:size-11 ${compact ? "w-9 gap-0 px-0" : ""} ${open ? "bg-accent" : "bg-card"}`}
      onClick={() => setOpen(!open)}
      aria-label={`Avisos${unread ? `: ${unread} sin leer` : ""}`}
      aria-expanded={open}
    >
      <Bell className="size-4" />
      {compact ? null : <span className="hidden md:inline">Avisos</span>}
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-xs font-semibold text-background ring-2 ring-canvas">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Button>
  )
}

/** Contenido de Avisos en la columna o el cajón: misma cabecera y mismo «×» que el Agente. */
export function NoticesPanel({ overlay, onClose }: HeaderPanelFrame) {
  const client = useQueryClient()
  const query = useNotices()
  const refresh = () => client.invalidateQueries({ queryKey: NOTICES_KEY })
  const mark = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/workspace/notifications/${id}/read`, { method: "POST" }),
    onSuccess: refresh,
  })
  const markAll = useMutation({
    mutationFn: () => apiFetch("/api/workspace/notifications/read-all", { method: "POST" }),
    onSuccess: refresh,
  })
  const data = query.data?.data
  const unread = data?.unread ?? 0
  const description = (
    <>
      Lo que pasó y conviene saber. Lo que hay que hacer está en{" "}
      <Link to="/home" className="font-semibold text-primary hover:underline">
        «Te espera»
      </Link>
      , en Inicio.
    </>
  )
  return (
    <>
      <div className="flex items-start gap-3 border-b p-4 sm:p-5">
        <span
          aria-hidden
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground [&>svg]:size-5"
        >
          <Bell />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          {overlay ? (
            <>
              <DrawerTitle className="text-[17px] font-bold tracking-tight">Avisos</DrawerTitle>
              <DrawerDescription className="text-xs">{description}</DrawerDescription>
            </>
          ) : (
            <>
              <h2 className="text-[17px] font-bold tracking-tight">Avisos</h2>
              <p className="text-xs text-muted-foreground">{description}</p>
            </>
          )}
        </div>
        <Button type="button" variant="ghost" size="icon-lg" aria-label="Cerrar los avisos" onClick={onClose}>
          <span aria-hidden className="text-lg leading-none">
            ×
          </span>
        </Button>
      </div>
      {unread > 0 ? (
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2 sm:px-5">
          <span className="text-sm text-muted-foreground">
            {unread} sin leer
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Marcar todo leído
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4 sm:p-5">
          {query.isError || mark.isError || markAll.isError ? (
            <div role="alert" className="mb-3 flex flex-col items-start gap-2 text-sm">
              <p>No pudimos actualizar los avisos.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
                Volver a intentar
              </Button>
            </div>
          ) : null}
          {query.isPending ? (
            <LoadingState />
          ) : !data?.items.length ? (
            query.isError ? null : (
              <EmptyState
                icon={Bell}
                title="No tienes avisos"
                description="Aquí llega lo que pasó y conviene saber, como un consentimiento firmado o la caja que cerró con diferencia."
              />
            )
          ) : (
            <ul className="divide-y">
              {data.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={item.href}
                    className="flex items-start gap-3 rounded-md py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      // Abrir un aviso lo da por leído. La columna acompaña la
                      // navegación; el cajón se cierra cuando la navegación se confirma.
                      if (!item.readAt) mark.mutate(item.id)
                    }}
                  >
                    <span
                      aria-hidden
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-primary"}`}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className={item.readAt ? "font-medium" : "font-semibold"}>{item.title}</span>
                      {item.body ? <span className="text-sm text-muted-foreground">{item.body}</span> : null}
                      <span className="text-xs text-muted-foreground">
                        {arrived(item.createdAt)}
                        {item.readAt ? " · leído" : <span className="sr-only"> · sin leer</span>}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
    </>
  )
}
