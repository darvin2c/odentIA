import { documentText } from "@odentia/clinical"
import { Badge, Button, Spinner } from "@odentia/ui"
import {
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  FilterBar,
  internationalText,
  PageHeader,
  PageShell,
  useListSearch,
} from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { NewPersonDrawer } from "../../components/person/new-person-drawer"
import { apiFetch } from "../../lib/api"
import { timeAgo, useCan, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { hcLabel } from "../../lib/patients"
import {
  isPeopleView,
  PEOPLE_VIEWS,
  PERSON_KIND_LABELS,
  type PeopleView,
  type PersonListItem,
} from "../../lib/people"

const PAGE_LIMIT = 30

/**
 * Una lista y un buscador (ADR 0029): todas las personas de la clínica, con
 * «Pacientes» por defecto y las vistas Por registrar, Responsables,
 * Archivados y Todos. Busca por nombre, teléfono o documento en el servidor,
 * con páginas del servidor. Cada fila abre la página de la persona.
 */
export const Route = createFileRoute("/_org/people/")({
  validateSearch: (search: Record<string, unknown>): { ver?: PeopleView; q?: string } => ({
    ...search,
    ver: isPeopleView(search.ver) ? search.ver : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  component: PeoplePage,
})

/** La segunda línea de cada fila: lo que sirve para reconocer a la persona. */
function rowDetail(row: PersonListItem): string {
  if (row.kind === "responsable" && !row.patient) {
    const names = row.responsibleFor.join(", ")
    const more = row.responsibleCount - row.responsibleFor.length
    return `Responsable de ${names}${more > 0 ? ` y ${more} más` : ""}`
  }
  const parts: string[] = []
  if (row.patient) parts.push(hcLabel(row.patient.patientNumber))
  if (row.docNumber) parts.push(documentText(row.docType, row.docNumber))
  if (!row.patient && row.phone) parts.push(internationalText(row.phone))
  if (row.nextAppointmentAt)
    parts.push(
      `próxima cita ${new Date(row.nextAppointmentAt).toLocaleDateString(activeOrgLocale(), { weekday: "short", day: "numeric" })}`,
    )
  else if (!row.patient && row.lastInteractionAt)
    parts.push(`escribió ${timeAgo(row.lastInteractionAt)}`)
  return parts.join(" · ") || "Sin datos todavía"
}

function PeoplePage() {
  const canView = usePermission("patients.read")
  const can = useCan()
  const canCreate = can("patients.write") || can("crm.write")
  const listSearch = useListSearch()
  // Quien aún no es paciente solo lo ven recepción y quien dirige; caja y odontología, solo pacientes.
  const seesAll = can("crm.read")
  const views = PEOPLE_VIEWS.filter(
    (item) => seesAll || (item.id !== "por_registrar" && item.id !== "responsables"),
  )
  const view: PeopleView = ((v) =>
    isPeopleView(v) && views.some((item) => item.id === v) ? v : "pacientes")(listSearch.get("ver"))
  const search = listSearch.get("q") ?? ""
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1) ?? null
  const [creating, setCreating] = useState(false)
  // Otra vista u otra búsqueda vuelven a la primera página.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar los filtros
  useEffect(() => setCursors([]), [view, search])

  const query = useQuery({
    queryKey: ["people", view, search.trim(), cursor],
    queryFn: () => {
      const params = new URLSearchParams({ ver: view, limit: String(PAGE_LIMIT) })
      if (search.trim()) params.set("q", search.trim())
      if (cursor) params.set("cursor", cursor)
      return apiFetch<{
        data: PersonListItem[]
        nextCursor: string | null
        counts: { porRegistrar: number }
      }>(`/api/people?${params}`)
    },
    enabled: canView,
    placeholderData: keepPreviousData,
  })
  const rows = query.data?.data ?? []
  const nextCursor = query.data?.nextCursor ?? null
  const porRegistrar = query.data?.counts.porRegistrar

  const columns = useMemo<ColumnDef<PersonListItem>[]>(
    () => [
      {
        id: "name",
        header: "Persona",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <Link
              to="/people/$personId"
              params={{ personId: row.original.id }}
              className="font-medium text-primary hover:underline"
            >
              {row.original.displayName}
            </Link>
            <span className="text-sm text-muted-foreground">{rowDetail(row.original)}</span>
          </span>
        ),
      },
      {
        id: "kind",
        header: "Qué es",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <Badge variant={row.original.kind === "por_registrar" ? "warning" : "secondary"}>
              {PERSON_KIND_LABELS[row.original.kind]}
            </Badge>
            {row.original.archived ? <Badge variant="outline">Archivada</Badge> : null}
            {/* Spam y bloqueados no son contactos nuevos: se encuentran aquí con su estado (ADR 0054). */}
            {row.original.screen === "spam" ? <Badge variant="outline">Spam</Badge> : null}
            {row.original.screen === "blocked" ? <Badge variant="destructive">Bloqueado</Badge> : null}
          </span>
        ),
      },
    ],
    [],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  const filtered = Boolean(search.trim())

  return (
    <PageShell>
      <PageHeader
        title="Pacientes"
        subtitle={
          seesAll
            ? "Todas las personas de la clínica: pacientes, quienes aún no se registran y sus responsables"
            : "Los pacientes de la clínica"
        }
        actions={
          canCreate ? (
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              Nueva persona
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-2 py-4">
        <fieldset className="flex min-w-0 flex-wrap gap-1.5">
          <legend className="sr-only">Qué personas ver</legend>
          {views.map((item) => {
            const pressed = view === item.id
            return (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant={pressed ? "default" : "outline"}
                aria-pressed={pressed}
                className="min-h-11 rounded-full sm:min-h-9"
                onClick={() =>
                  listSearch.setParam("ver", item.id === "pacientes" ? undefined : item.id, {
                    replace: true,
                  })
                }
              >
                {item.label}
                {item.id === "por_registrar" && porRegistrar !== undefined
                  ? ` · ${porRegistrar}`
                  : ""}
              </Button>
            )
          })}
        </fieldset>
        <FilterBar
          filters={[]}
          sortOptions={[]}
          searchPlaceholder="Buscar por nombre, teléfono o documento"
          searchPending={query.isFetching && filtered}
        />
        <p className="text-xs text-muted-foreground">Una sola búsqueda en toda la clínica.</p>
      </div>
      {query.isPending && rows.length === 0 ? (
        <DataTableSkeleton label="Cargando personas…" />
      ) : query.isError && rows.length === 0 ? (
        <ErrorState
          error={query.error instanceof Error ? query.error : String(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            filtered
              ? "Nadie coincide con la búsqueda"
              : view === "pacientes"
                ? "Sin pacientes todavía"
                : "Nadie en esta vista"
          }
          description={
            filtered
              ? "Prueba con otra parte del nombre, el teléfono o el documento, o mira en «Todos»."
              : "Cuando alguien escriba o lo registres, aparece aquí."
          }
          actionLabel={canCreate ? "Nueva persona" : undefined}
          onAction={canCreate ? () => setCreating(true) : undefined}
        />
      ) : (
        <>
          <div aria-busy={query.isPlaceholderData === true}>
            <DataTable table={table} isFetching={query.isFetching} />
          </div>
          {query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conserva la página cargada.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <p className="text-xs text-muted-foreground">
              Página {cursors.length + 1}
              {nextCursor ? " · hay más" : " · fin de la lista"}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cursors.length === 0 || query.isFetching}
                onClick={() => setCursors((stack) => stack.slice(0, -1))}
              >
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!nextCursor || query.isFetching}
                onClick={() => nextCursor && setCursors((stack) => [...stack, nextCursor])}
              >
                {query.isFetching && cursors.length > 0 ? (
                  <Spinner className="size-4" aria-hidden />
                ) : null}
                Siguiente
              </Button>
            </div>
          </div>
        </>
      )}
      <NewPersonDrawer open={creating} onClose={() => setCreating(false)} />
    </PageShell>
  )
}
