import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bell } from "lucide-react"
import { useState } from "react"
import { apiFetch } from "../lib/api"
import type { WorkspaceNotice } from "../lib/workspace"

/**
 * Avisos dirigidos al usuario autenticado. Vive en el pie del sidebar (encima
 * del bloque de usuario): el shell no tiene topbar propia y cada página aporta
 * su único `PageHeader`. El listado se abre en diálogo desde cualquier ancho.
 */
export function WorkspaceNotifications() {
  const [open, setOpen] = useState(false)
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ["workspace-notifications"],
    queryFn: () => apiFetch<{ data: { items: WorkspaceNotice[]; unread: number } }>("/api/workspace/notifications"),
    refetchInterval: 30_000,
  })
  const mark = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/workspace/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["workspace-notifications"] }),
  })
  const data = query.data?.data
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-lg"
        className="elevated relative border border-border bg-card hover:bg-accent/50"
        onClick={() => setOpen(true)}
        aria-label={`Notificaciones${data?.unread ? `: ${data.unread} sin leer` : ""}`}
      >
        <Bell className="size-4" />
        {data && data.unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground px-1 text-xs font-semibold text-background ring-2 ring-canvas">
            {data.unread > 99 ? "99+" : data.unread}
          </span>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Notificaciones</DialogTitle>
            <DialogDescription>Avisos dirigidos a ti. Se muestran los 100 más recientes.</DialogDescription>
          </DialogHeader>
          {query.isError || mark.isError ? (
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
            <p className="py-6 text-sm text-muted-foreground">No tienes notificaciones.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y overflow-y-auto">
              {data.items.map((item) => (
                <li key={item.id} className="py-3">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={item.href} className="min-w-0 hover:underline" onClick={() => setOpen(false)}>
                      <span className={`block ${item.readAt ? "font-medium" : "font-semibold"}`}>{item.title}</span>
                      <span className="mt-1 block text-sm text-muted-foreground">{item.body}</span>
                    </Link>
                    {!item.readAt && (
                      <Button type="button" variant="ghost" size="sm" disabled={mark.isPending} onClick={() => mark.mutate(item.id)}>
                        Marcar leído
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
