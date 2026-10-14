import { Badge, Field, FieldLabel, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { DataTable, DataTableSkeleton, EmptyState, PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useInfiniteQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { History } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { activeOrgTimeZone, useOrgLocale } from "../../lib/locale"

interface AuditSearch {
  /** Área elegida en el filtro; sin ella, todas. */
  area?: string
}

export const Route = createFileRoute("/_org/settings/audit")({
  validateSearch: (search: Record<string, unknown>): AuditSearch =>
    typeof search.area === "string" && /^[a-z]{1,40}$/.test(search.area) ? { area: search.area } : {},
  component: TeamActivityPage,
})

const TITLE = "Actividad del equipo"
const SUBTITLE = "Quién hizo qué y cuándo. Es una consulta: desde aquí no se cambia nada."

type Cursor = { before: string; beforeId: string } | null

/** Una fila tal como la entrega el servidor: ya viene dicha con palabras. */
interface ActivityItem {
  id: string
  /** Qué pasó: «Reservó una cita». */
  what: string
  /** La persona del equipo o, sin ella, quién fue según el registro. */
  who: string
  areaLabel: string
  createdAt: string
}

interface ActivityPage {
  items: ActivityItem[]
  next: Cursor
  areas: Array<{ id: string; label: string }>
}

const ALL = "todas"

/** Fecha y hora en el formato y la zona de la clínica, no en los del navegador. */
function formatWhen(iso: string, locale: string | undefined, timeZone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(date)
}

/**
 * Actividad del equipo: lo que quedó registrado, de lo más reciente a lo más
 * antiguo. El servidor entrega cada hecho con palabras y el nombre de su área;
 * la pantalla no traduce códigos ni muestra identificadores.
 */
function TeamActivityPage() {
  const allowed = usePermission("audit.read")
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const locale = useOrgLocale()
  const area = search.area ?? ALL

  const query = useInfiniteQuery({
    queryKey: ["workspace-audit", area],
    enabled: allowed,
    retry: 1,
    initialPageParam: null as Cursor,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams()
      if (area !== ALL) params.set("area", area)
      if (pageParam) {
        params.set("before", pageParam.before)
        params.set("beforeId", pageParam.beforeId)
      }
      return apiFetch<{ data: ActivityPage }>(`/api/workspace/audit?${params}`)
    },
    getNextPageParam: (last) => last.data.next ?? undefined,
  })

  const items = useMemo(() => query.data?.pages.flatMap((page) => page.data.items) ?? [], [query.data])
  // Las áreas se conservan al cambiar de filtro: el selector no se desmonta mientras carga la otra lista.
  const loadedAreas = query.data?.pages[0]?.data.areas
  const [areas, setAreas] = useState<ActivityPage["areas"]>([])
  useEffect(() => {
    if (loadedAreas) setAreas(loadedAreas)
  }, [loadedAreas])

  // Un área mal escrita en el enlace no rompe la pantalla: se muestran todas.
  const unknownArea = area !== ALL && query.error instanceof ApiError && query.error.status === 400
  useEffect(() => {
    if (unknownArea) void navigate({ search: {}, replace: true })
  }, [unknownArea, navigate])

  const columns = useMemo<ColumnDef<ActivityItem>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "Cuándo",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{formatWhen(row.original.createdAt, locale, activeOrgTimeZone())}</span>
        ),
      },
      { accessorKey: "who", header: "Quién", meta: { view: { primary: true } } },
      {
        accessorKey: "what",
        header: "Qué hizo",
        meta: { view: { role: "title" } },
        cell: ({ row }) => <span className="font-medium">{row.original.what}</span>,
      },
      {
        accessorKey: "areaLabel",
        header: "Área",
        cell: ({ row }) => <Badge variant="secondary">{row.original.areaLabel}</Badge>,
      },
    ],
    [locale],
  )
  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel() })

  if (!allowed) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const setArea = (next: string) =>
    void navigate({ search: next === ALL ? {} : { area: next }, replace: true })
  const neverLoaded = query.isError && query.data === undefined

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {/* El filtro sale de las áreas que entrega el servidor: aparece cuando ya se conocen. */}
      {areas.length > 0 ? (
        <Field className="max-w-xs">
          <FieldLabel htmlFor="actividad-area">Área</FieldLabel>
          <Select
            value={area}
            items={{ [ALL]: "Todas las áreas", ...Object.fromEntries(areas.map((item) => [item.id, item.label])) }}
            onValueChange={(value: string | null) => setArea(value ?? ALL)}
          >
            <SelectTrigger id="actividad-area">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas las áreas</SelectItem>
              {areas.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      {query.isPending ? (
        <DataTableSkeleton columnCount={4} rowCount={8} label="Cargando la actividad del equipo…" />
      ) : neverLoaded ? (
        <SettingsLoadError what="la actividad del equipo" onRetry={() => void query.refetch()} />
      ) : (
        <>
          {query.isError ? (
            <SettingsLoadError
              stale
              what="la actividad del equipo"
              onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())}
            />
          ) : null}
          {items.length === 0 ? (
            area === ALL ? (
              <EmptyState
                icon={History}
                title="Aún no hay actividad"
                description="Aquí aparece lo que hace tu equipo: citas, cobros, cambios en la configuración."
              />
            ) : (
              <EmptyState
                icon={History}
                title="Sin actividad en esta área"
                description="Nadie ha registrado nada en esta área todavía."
                actionLabel="Ver todas las áreas"
                onAction={() => setArea(ALL)}
              />
            )
          ) : (
            <>
              <DataTable
                table={table}
                isFetching={query.isFetching && !query.isFetchingNextPage}
                refreshMessage="Actualizando la actividad…"
              />
              <p className="text-sm text-muted-foreground">
                «Automático» es lo que no hizo una persona del equipo: lo deja el sistema, o alguien desde un enlace
                de la clínica.
              </p>
              {query.hasNextPage ? (
                <div>
                  <SubmitButton
                    variant="outline"
                    pending={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    Ver actividad anterior
                  </SubmitButton>
                </div>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  )
}
