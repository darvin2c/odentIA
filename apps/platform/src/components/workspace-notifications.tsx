import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bell } from "lucide-react"
import { useState } from "react"
import { apiFetch } from "../lib/api"
import { timeAgo } from "../lib/crm"
import type { WorkspaceNotice } from "../lib/workspace"

/** «Hace 10 min», «Ayer»…: cuándo llegó, con mayúscula inicial. */
function arrived(iso: string): string {
  const text = timeAgo(iso)
  if (!text || text === "ahora") return "Hace un momento"
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * La campana es para enterarse, no para trabajar: trae lo que no pide trabajo
 * (un consentimiento firmado, la caja que cerró con diferencia, WhatsApp que
 * aprobó un mensaje). Lo que hay que hacer está en «Te espera» y no se repite
 * aquí. Abrir un aviso lo marca leído; «Marcar todo leído» los marca todos; y
 * un aviso se retira solo cuando su asunto se resuelve (lo decide el servidor).
 * Vive en las utilidades de la cabecera y se abre en diálogo desde cualquier ancho.
 */
export function WorkspaceNotifications() {
  const [open, setOpen] = useState(false)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ["workspace-notifications"],
    queryFn: () => apiFetch<{ data: { items: WorkspaceNotice[]; unread: number } }>("/api/workspace/notifications"),
    refetchInterval: 30_000,
  })
  const refresh = () => client.invalidateQueries({ queryKey: ["workspace-notifications"] })
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
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="elevated relative border border-border bg-card hover:bg-accent/50"
        onClick={() => setOpen(true)}
        aria-label={`Avisos${unread ? `: ${unread} sin leer` : ""}`}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-xs font-semibold text-background ring-2 ring-canvas">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <div className="flex flex-wrap items-center justify-between gap-2 pr-8">
              <DialogTitle>Avisos</DialogTitle>
              {unread > 0 ? (
                <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={markAll.isPending} onClick={() => markAll.mutate()}>
                  Marcar todo leído
                </Button>
              ) : null}
            </div>
            <DialogDescription>Lo que pasó y conviene saber. Lo que hay que hacer está en «Te espera», en Inicio.</DialogDescription>
          </DialogHeader>
          {query.isError || mark.isError || markAll.isError ? (
            <p role="alert">
              No pudimos actualizar los avisos.{" "}
              <button type="button" className="underline" onClick={() => void query.refetch()}>
                Volver a intentar
              </button>
            </p>
          ) : null}
          {query.isPending ? (
            <p>Cargando…</p>
          ) : !data?.items.length ? (
            <p className="py-6 text-sm text-muted-foreground">No tienes avisos.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {data.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={item.href}
                    className="flex items-start gap-3 rounded-md py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      // Abrir un aviso lo da por leído.
                      if (!item.readAt) mark.mutate(item.id)
                      setOpen(false)
                    }}
                  >
                    <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-primary"}`} />
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
        </DialogContent>
      </Dialog>
    </>
  )
}
