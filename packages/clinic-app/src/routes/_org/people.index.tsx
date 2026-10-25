import { documentText } from "@odentia/clinical"
import {
  Badge,
  Button,
  buttonVariants,
  Spinner,
  Tabs,
  TabsTrigger,
} from "@odentia/ui"
import {
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  FilterBar,
  type FilterDef,
  internationalText,
  PageHeader,
  PageShell,
  PersonAvatar,
  ScrollingTabsList,
  useListSearch,
} from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { NewPatientDrawer, type NewPatientTarget } from "../../components/patient/new-patient-drawer"
import { NewPersonDrawer } from "../../components/person/new-person-drawer"
import { apiFetch } from "../../lib/api"
import { timeAgo, useCan, usePermission } from "../../lib/crm"
import { fetchLockedRecords, LOCKED_RECORDS_KEY } from "../../lib/locked-records"
import { channelLabel } from "../../lib/channels"
import { activeOrgLocale } from "../../lib/locale"
import { hcLabel } from "../../lib/patients"
import {
  isPeopleShortcut,
  isPeopleView,
  PEOPLE_SHORTCUTS,
  PEOPLE_VIEWS,
  PERSON_KIND_LABELS,
  type PeopleShortcutCounts,
  type PeopleView,
  type PersonListItem,
  attentionWords,
  daysSince,
  situationAction,
  situationText,
} from "../../lib/people"

const PAGE_LIMIT = 30
const NEW_PATIENT: NewPatientTarget = { kind: "new" }

/**
 * Una lista y un buscador (ADR 0029): todas las personas de la clínica, con
 * «Pacientes» por defecto y las vistas Contactos nuevos, Archivados y Todos. Busca por nombre, teléfono o documento en el servidor,
 * con páginas del servidor. Cada fila abre la página de la persona.
 */
export const Route = createFileRoute("/_org/people/")({
  // `nuevo`: abre «Nuevo paciente» con ese nombre (lo usa el buscador rápido cuando no encuentra a alguien).
  validateSearch: (search: Record<string, unknown>): { ver?: PeopleView; q?: string; nuevo?: string } => ({
    ...search,
    ver: isPeopleView(search.ver) ? search.ver : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    nuevo: typeof search.nuevo === "string" ? search.nuevo : undefined,
  }),
  component: PeoplePage,
})

/** La segunda línea de cada fila: lo que sirve para reconocer a la persona. */
function rowDetail(row: PersonListItem): string {
  const parts: string[] = []
  if (row.patient) parts.push(hcLabel(row.patient.patientNumber))
  if (row.age !== null) parts.push(`${row.age} años`)
  if (row.vinculos.length > 0) parts.push(vinculosText(row))
  if (row.docNumber) parts.push(documentText(row.docType, row.docNumber))
  if (row.phone) parts.push(internationalText(row.phone))
  return parts.join(" · ") || "Sin datos todavía"
}

/** «Madre de Mateo Vargas», y cuántos más; el contacto de emergencia se dice como tal (decisión 16). */
function vinculosText(row: PersonListItem): string {
  const more = row.vinculoCount - row.vinculos.length
  return `${row.vinculos.join(", ")}${more > 0 ? ` y ${more} más` : ""}`
}

/** «Ya la invité»: anota la invitación que se hizo por teléfono o en persona (issue 139, decisión 15). */
function InvitedToReturnButton({ personId }: { personId: string }) {
  const queryClient = useQueryClient()
  const invited = useMutation({
    mutationFn: () => apiFetch(`/api/people/${personId}/invited-to-return`, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["people"] }),
  })
  return (
    <Button type="button" size="sm" variant="outline" disabled={invited.isPending} onClick={() => invited.mutate()}>
      Ya la invité
    </Button>
  )
}

/** Fecha corta en la zona y el idioma de la clínica. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(activeOrgLocale(), { weekday: "short", day: "numeric", month: "short" })
}

function PeoplePage() {
  const canView = usePermission("patients.read")
  const can = useCan()
  const canCreate = can("patients.write") || can("crm.write")
  // Registrar un paciente es el botón principal; un contacto (aún no es paciente), su menú.
  const canRegister = can("patients.write")
  const [registering, setRegistering] = useState(false)
  const [registerTarget, setRegisterTarget] = useState<NewPatientTarget>(NEW_PATIENT)
  const listSearch = useListSearch()
  const { nuevo } = Route.useSearch()
  const navigate = Route.useNavigate()
  useEffect(() => {
    if (nuevo === undefined) return
    if (canRegister) {
      setRegisterTarget({ kind: "new", name: nuevo })
      setRegistering(true)
    }
    void navigate({ search: (previous) => ({ ...previous, nuevo: undefined }), replace: true })
  }, [nuevo, canRegister, navigate])
  // Quien aún no es paciente solo lo ven recepción y quien dirige; caja y odontología, solo pacientes.
  const seesAll = can("crm.read")
  const views = PEOPLE_VIEWS.filter((item) => seesAll || item.id !== "por_registrar")
  const view: PeopleView = ((v) =>
    isPeopleView(v) && views.some((item) => item.id === v) ? v : "pacientes")(listSearch.get("ver"))
  const search = listSearch.get("q") ?? ""
  const atajoParam = listSearch.get("atajo")
  const atajo = view === "pacientes" && isPeopleShortcut(atajoParam) ? atajoParam : undefined
  const atajoLabel = PEOPLE_SHORTCUTS.find((item) => item.id === atajo)?.label ?? ""
  const [cursors, setCursors] = useState<string[]>([])
  const cursor = cursors.at(-1) ?? null
  const [creating, setCreating] = useState(false)
  // Otra vista u otra búsqueda vuelven a la primera página.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar los filtros
  useEffect(() => setCursors([]), [view, search, atajo])

  const query = useQuery({
    queryKey: ["people", view, search.trim(), atajo, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ ver: view, limit: String(PAGE_LIMIT) })
      if (search.trim()) params.set("q", search.trim())
      if (atajo) params.set("atajo", atajo)
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
  // Las cuentas de cada atajo, aparte: recorren a toda la clínica y la lista no las espera.
  // Bajo ["people"] para que lo que cambia la lista (p. ej. «Ya la invité») también las renueve.
  const shortcutsQuery = useQuery({
    queryKey: ["people", "atajos"],
    queryFn: () => apiFetch<{ data: PeopleShortcutCounts }>("/api/people/shortcuts").then((body) => body.data),
    enabled: canView && view === "pacientes",
    staleTime: 60_000,
  })
  const rows = query.data?.data ?? []
  const nextCursor = query.data?.nextCursor ?? null
  const porRegistrar = query.data?.counts.porRegistrar
  const shortcuts = shortcutsQuery.data ?? null
  // Los atajos viven en un solo filtro «Qué necesita algo», con su cuenta en cada opción.
  const shortcutFilters: FilterDef[] =
    view === "pacientes" && shortcuts
      ? [
          {
            type: "select",
            key: "atajo",
            label: "Qué necesita algo",
            options: PEOPLE_SHORTCUTS.flatMap((item) =>
              shortcuts[item.id] === null ? [] : [{ value: item.id, label: item.label, count: shortcuts[item.id] ?? undefined }],
            ),
          },
        ]
      : []

  const columns = useMemo<ColumnDef<PersonListItem>[]>(() => {
    // En el atajo «Por invitar a volver», anotar la invitación que se hizo por teléfono o en persona.
    const invitedColumn: ColumnDef<PersonListItem>[] =
      atajo === "por_invitar_a_volver"
        ? [
            {
              id: "invited",
              header: "Invitación",
              cell: ({ row }) => <InvitedToReturnButton personId={row.original.id} />,
            },
          ]
        : []
    const persona: ColumnDef<PersonListItem> = {
      id: "name",
      header: "Persona",
      meta: { view: { role: "title" } },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-3">
          <PersonAvatar
            name={row.original.displayName}
            familyName={row.original.familyName}
            className="size-9 shrink-0"
            fallbackClassName="text-xs"
            decorative
          />
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
        </span>
      ),
    }
    if (view === "pacientes")
      return [
        persona,
        {
          id: "next",
          header: "Próxima cita",
          cell: ({ row }) => (
            <span className="text-sm">
              {row.original.nextAppointmentAt ? shortDate(row.original.nextAppointmentAt) : "—"}
            </span>
          ),
        },
        {
          id: "last",
          header: "Última visita",
          cell: ({ row }) => (
            <span className="text-sm">{row.original.lastVisitAt ? shortDate(row.original.lastVisitAt) : "—"}</span>
          ),
        },
        {
          id: "step",
          header: "Qué sigue",
          meta: { view: { primary: true } },
          cell: ({ row }) => {
            const step = row.original.nextStep
            if (!step) return <span className="text-sm text-muted-foreground">—</span>
            const who = attentionWords(row.original.attention)
            return (
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm">{step.text}</span>
                  {row.original.missingData ? <Badge variant="warning">Faltan datos</Badge> : null}
                  {step.actionLabel ? (
                    <Link
                      to="/people/$personId"
                      params={{ personId: row.original.id }}
                      className={buttonVariants({ size: "sm", variant: "outline" })}
                    >
                      {step.actionLabel}
                    </Link>
                  ) : null}
                </span>
                {who ? <span className="text-xs text-muted-foreground">{who}</span> : null}
              </span>
            )
          },
        },
      ...invitedColumn,
      ]
    if (view === "por_registrar")
      return [
        persona,
        {
          id: "how",
          header: "Cómo llegó",
          cell: ({ row }) => {
            const first = row.original.firstContact
            if (!first) return <span className="text-sm">Lo registró el equipo</span>
            const channel = first.channel ? channelLabel(first.channel) : "Lo registró el equipo"
            const isNew = (daysSince(first.at) ?? Number.POSITIVE_INFINITY) < 7
            return (
              <span className="flex flex-wrap items-center gap-2 text-sm">
                {`${channel} · ${timeAgo(first.at)}`}
                {isNew ? <Badge variant="secondary">Nueva</Badge> : null}
              </span>
            )
          },
        },
        {
          id: "situation",
          header: "En qué está",
          meta: { view: { primary: true } },
          cell: ({ row }) => <span className="text-sm font-medium">{situationText(row.original)}</span>,
        },
        {
          id: "step",
          header: "Siguiente paso",
          cell: ({ row }) => (
            <Link
              to="/people/$personId"
              params={{ personId: row.original.id }}
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              {situationAction(row.original.situation)}
            </Link>
          ),
        },
      ]
    return [
      persona,
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
    ]
  }, [view, atajo])
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  const filtered = Boolean(search.trim())

  return (
    <PageShell>
      <PageHeader
        title="Pacientes"
        subtitle={
          seesAll
            ? "Todas las personas de la clínica: pacientes, contactos nuevos y sus familiares"
            : "Los pacientes de la clínica"
        }
        primary={
          canRegister
            ? { label: "Nuevo paciente", icon: <Plus aria-hidden />, onClick: () => setRegistering(true) }
            : canCreate
              ? { label: "Nuevo contacto", icon: <Plus aria-hidden />, onClick: () => setCreating(true) }
              : undefined
        }
        menu={canRegister ? [{ label: "Nuevo contacto", onSelect: () => setCreating(true) }] : undefined}
      />
      <div className="flex flex-col gap-2 py-4">
        {/* Elegir qué personas ver cambia la lista entera: es pestaña, igual que Finanzas. */}
        <Tabs
          value={view}
          onValueChange={(next) =>
            listSearch.setParam("ver", String(next) === "pacientes" ? undefined : String(next), {
              replace: true,
            })
          }
        >
          <ScrollingTabsList aria-label="Qué personas ver">
            {views.map((item) => (
              <TabsTrigger key={item.id} value={item.id} className="shrink-0 min-h-11 sm:min-h-9">
                {item.label}
                {item.id === "por_registrar" && porRegistrar !== undefined
                  ? ` · ${porRegistrar}`
                  : ""}
              </TabsTrigger>
            ))}
          </ScrollingTabsList>
        </Tabs>
        <FilterBar
          filters={shortcutFilters}
          resetKeys={["atajo"]}
          sortOptions={[]}
          searchPlaceholder="Buscar por nombre, teléfono o documento" searchLabel="Buscar en pacientes"
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
              : atajo
                ? `Nadie en «${atajoLabel}». ¡Al día!`
              : view === "pacientes"
                ? "Sin pacientes todavía"
                : view === "por_registrar"
                  ? "Nadie nuevo por ahora"
                  : "Nadie en esta vista"
          }
          description={
            filtered
              ? "Prueba con otra parte del nombre, el teléfono o el documento, o mira en «Todos»."
              : "Cuando alguien escriba o lo registres, aparece aquí."
          }
          actionLabel={atajo ? "Ver todos" : canRegister ? "Nuevo paciente" : canCreate ? "Nuevo contacto" : undefined}
          onAction={
            atajo
              ? () => listSearch.setParam("atajo", undefined, { replace: true })
              : canRegister
                ? () => setRegistering(true)
                : canCreate
                  ? () => setCreating(true)
                  : undefined
          }
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
      <LockedRecordsLink />
      <NewPatientDrawer
        open={registering}
        onClose={() => {
          setRegistering(false)
          setRegisterTarget(NEW_PATIENT)
        }}
        target={registerTarget}
      />
      <NewPersonDrawer open={creating} onClose={() => setCreating(false)} />
    </PageShell>
  )
}

/** «Historias bloqueadas (3)», al final y solo para Administración (ADR 0080); sin ninguna, no aparece. */
function LockedRecordsLink() {
  const canSee = usePermission("patients.erase")
  const query = useQuery({ queryKey: LOCKED_RECORDS_KEY, queryFn: fetchLockedRecords, enabled: canSee, retry: false })
  const count = query.data?.length ?? 0
  if (!canSee || count === 0) return null
  return (
    <Link to="/people/locked" className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline">
      Historias bloqueadas ({count})
    </Link>
  )
}
