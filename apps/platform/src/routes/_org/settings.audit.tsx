import { Button, Input } from "@odentia/ui"
import { DataTable, LoadingState, PageHeader } from "@odentia/ui-patterns"
import { useInfiniteQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/audit")({ component: AuditPage })
type Cursor = { before: string; beforeId: string } | null
interface AuditResult { items: Array<AuditItem>; next: Cursor }
interface AuditItem { id: string; action: string; entity: string; entityId: string | null; actorName: string | null; createdAt: string }
function AuditPage() {
  const allowed = usePermission("audit.read")
  const [input, setInput] = useState("")
  const [action, setAction] = useState("")
  const query = useInfiniteQuery({ queryKey: ["workspace-audit", action], enabled: allowed, initialPageParam: null as Cursor,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (action) params.set("action", action)
      if (pageParam) { params.set("before", pageParam.before); params.set("beforeId", pageParam.beforeId) }
      return apiFetch<{ data: AuditResult }>(`/api/workspace/audit?${params}`)
    }, getNextPageParam: last => last.data.next ?? undefined })
  const items = query.data?.pages.flatMap(page => page.data.items) ?? []
  const columns = useMemo<ColumnDef<AuditItem>[]>(() => [
    { accessorKey: "createdAt", header: "Fecha", cell: ({ row }) => <span className="whitespace-nowrap">{new Date(row.original.createdAt).toLocaleString()}</span> },
    { accessorKey: "actorName", header: "Responsable", cell: ({ row }) => row.original.actorName ?? "Sistema / integración" },
    { accessorKey: "action", header: "Acción" },
    { accessorKey: "entity", header: "Entidad" },
    { accessorKey: "entityId", header: "Referencia", cell: ({ row }) => <span className="max-w-64 break-all font-mono text-xs">{row.original.entityId ?? "—"}</span> },
  ], [])
  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel() })
  return <div className="flex flex-col gap-5"><PageHeader title="Auditoría" subtitle="Acciones registradas y autoría. El historial no se puede editar desde esta pantalla." />
    {!allowed ? <p>No tienes permiso para consultar la auditoría.</p> : <>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setAction(input.trim()) }}><div className="flex flex-col gap-1"><label htmlFor="audit-action" className="text-sm">Acción exacta (opcional)</label><Input id="audit-action" value={input} maxLength={120} placeholder="Ej.: appointment.created" onChange={event => setInput(event.target.value)} /></div><Button type="submit">Filtrar</Button></form>
      {query.isPending ? <LoadingState /> : query.isError ? <p role="alert">No pudimos cargar la auditoría.</p> : items.length === 0 ? <p className="text-sm text-muted-foreground">Sin eventos para este filtro.</p> : <DataTable table={table} />}
      {query.hasNextPage && <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Cargando…" : "Ver eventos anteriores"}</Button>}
    </>}
  </div>
}
