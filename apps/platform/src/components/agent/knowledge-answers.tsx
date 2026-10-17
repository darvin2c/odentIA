import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, type FilterDef, FilterDrawer, LoadingState, SearchInput, useListSearch } from "@odentia/ui-patterns"
import { BookOpen, ChevronRight, SlidersHorizontal } from "lucide-react"
import { useMemo, useState } from "react"
import { QueryErrorState } from "../../lib/query-error"
import {
  branchLabel,
  entrySubtitle,
  expiryLabel,
  KNOWLEDGE_STATES,
  type KnowledgeEntry,
  type KnowledgeState,
  STATE_FILTER_LABEL,
  STATE_LABEL,
  STATE_VARIANT,
} from "./knowledge-model"

/** Respuestas a la vista; el resto, con «Ver las N». */
const PREVIEW = 5
const ALL_BRANCHES = "todas"

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/** Estado de una respuesta: un cambio por aprobar pesa más que su estado de publicación. */
export function KnowledgeStateBadge({ entry }: { entry: KnowledgeEntry }) {
  if (entry.pendingLessonId) return <Badge variant="soft">Cambio por aprobar</Badge>
  return <Badge variant={STATE_VARIANT[entry.state]}>{STATE_LABEL[entry.state]}</Badge>
}

/**
 * «Respuestas oficiales»: buscador, filtro por sede y una fila por respuesta
 * que abre su detalle. El filtro por estado queda dentro de «Filtros» para no
 * competir con el de sede. Búsqueda y filtros viven en la URL (`q`, `sede`,
 * `estado`), como en las demás listas.
 */
export function KnowledgeAnswers({
  entries,
  total,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  isPending,
  error,
  onRetry,
  branches,
  canWrite,
  canStartBasics,
  activeId,
  onOpen,
  onCreate,
  onStartBasics,
}: {
  entries: KnowledgeEntry[]
  /** Todas las que hay (con la búsqueda), no solo las cargadas. */
  total?: number
  /** Hay más páginas en el servidor. */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  isPending: boolean
  error: unknown
  onRetry: () => void
  branches: Array<{ id: string; name: string }>
  canWrite: boolean
  /** Quedan preguntas básicas sin responder: el vacío ofrece empezar por ellas. */
  canStartBasics: boolean
  /** Respuesta abierta en el detalle. */
  activeId: string | null
  onOpen: (entry: KnowledgeEntry) => void
  onCreate: () => void
  onStartBasics: () => void
}) {
  const { get, setParam, setParams } = useListSearch()
  const [showAll, setShowAll] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const search = get("q") ?? ""
  const branchId = get("sede")
  const state = KNOWLEDGE_STATES.find((value) => value === get("estado"))
  const hasCriteria = search !== "" || branchId !== undefined || state !== undefined

  const visible = useMemo(() => {
    const wanted = normalize(search.trim())
    return entries.filter(
      (entry) =>
        (!state || entry.state === state) &&
        // Lo que vale en esa sede: lo suyo y lo que vale en todas.
        (!branchId || entry.branchId === null || entry.branchId === branchId) &&
        (!wanted || [entry.title, entry.body, ...entry.askForms].some((text) => normalize(text).includes(wanted))),
    )
  }, [entries, state, branchId, search])
  const shown = showAll || hasCriteria ? visible : visible.slice(0, PREVIEW)

  const stateFilter: FilterDef = {
    key: "estado",
    label: "Estado",
    type: "select",
    options: KNOWLEDGE_STATES.map((value: KnowledgeState) => ({
      value,
      label: STATE_FILTER_LABEL[value],
      count: entries.filter((entry) => entry.state === value).length,
    })),
  }
  const branchName = branches.find((branch) => branch.id === branchId)?.name

  return (
    <section aria-labelledby="respuestas" className="elevated flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-4 pb-3 sm:px-5">
        <h2 id="respuestas" className="min-w-0 flex-1 basis-48 font-heading text-base font-semibold">
          Respuestas oficiales{(total ?? entries.length) > 0 ? ` · ${total ?? entries.length}` : ""}
        </h2>
        {entries.length > 0 ? (
          <>
            <SearchInput
              placeholder="Buscar una respuesta"
              className="min-w-0 basis-full sm:w-56 sm:basis-auto [&_[data-slot=input-group]]:h-11 sm:[&_[data-slot=input-group]]:h-9"
            />
            {branches.length > 1 || branchId ? (
              <Select
                value={branchId ?? ALL_BRANCHES}
                onValueChange={(value) => setParam("sede", !value || value === ALL_BRANCHES ? undefined : value)}
              >
                <SelectTrigger aria-label="Sede" className="min-w-0 flex-1 data-[size=default]:h-11 sm:flex-none sm:data-[size=default]:h-9">
                  <SelectValue>{branchId ? (branchName ?? "Sede") : "Todas las sedes"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BRANCHES}>Todas las sedes</SelectItem>
                  {branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              aria-label={state ? `Filtros: ${STATE_FILTER_LABEL[state]}` : "Filtros"}
              onClick={() => setFiltersOpen(true)}
            >
              <SlidersHorizontal aria-hidden />
              {state ? STATE_FILTER_LABEL[state] : "Filtros"}
            </Button>
          </>
        ) : null}
        {canWrite ? (
          // En teléfono la acción va fija al pie de la página.
          <Button type="button" className="hidden sm:inline-flex" onClick={onCreate}>
            Nueva respuesta
          </Button>
        ) : null}
      </div>
      {isPending ? (
        <div className="px-4 pb-4 sm:px-5">
          <LoadingState message="Cargando respuestas…" />
        </div>
      ) : error ? (
        <div className="px-4 pb-4 sm:px-5">
          <QueryErrorState error={error} onRetry={onRetry} />
        </div>
      ) : entries.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5">
          <EmptyState
            icon={BookOpen}
            title="Todavía no le has enseñado nada"
            description="Empieza por las preguntas que casi todos los pacientes hacen."
            {...(canWrite
              ? canStartBasics
                ? { actionLabel: "Empezar con lo básico", onAction: onStartBasics }
                : { actionLabel: "Nueva respuesta", onAction: onCreate }
              : {})}
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="px-4 pb-4 sm:px-5">
          <EmptyState
            title="Sin resultados"
            description="Ninguna respuesta coincide con la búsqueda o los filtros elegidos."
            actionLabel="Ver todas"
            onAction={() => setParams({ q: undefined, sede: undefined, estado: undefined })}
          />
        </div>
      ) : (
        <ul className="flex flex-col">
          {shown.map((entry) => {
            const subtitle = entrySubtitle(entry)
            const expires = entry.validUntil !== null && entry.state === "vigente"
            return (
              <li key={entry.id} className="border-t">
                <Button
                  type="button"
                  variant="ghost"
                  aria-current={activeId === entry.id ? "true" : undefined}
                  className="h-auto min-h-14 w-full justify-start gap-x-4 rounded-none px-4 py-2 text-left font-normal whitespace-normal aria-[current]:bg-muted sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_9.5rem] sm:px-5"
                  onClick={() => onOpen(entry)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-semibold [overflow-wrap:anywhere]">{entry.title}</span>
                    {subtitle ? <span className="hidden text-sm text-muted-foreground [overflow-wrap:anywhere] sm:block">{subtitle}</span> : null}
                    {/* En teléfono, una sola línea: el vencimiento si lo tiene; si no, estado y sede. */}
                    <span className={`text-sm sm:hidden ${expires ? "font-semibold text-warning" : "text-muted-foreground"}`}>
                      {expires
                        ? expiryLabel(entry)
                        : `${entry.pendingLessonId ? "Cambio por aprobar" : STATE_LABEL[entry.state]} · ${entry.branchName ?? "todas las sedes"}`}
                    </span>
                  </span>
                  <span className="hidden min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere] sm:block">{branchLabel(entry)}</span>
                  <span className={`hidden min-w-0 text-sm sm:block ${expires ? "font-semibold text-warning" : "text-muted-foreground"}`}>
                    {expiryLabel(entry)}
                  </span>
                  <span className="hidden justify-end sm:flex">
                    <KnowledgeStateBadge entry={entry} />
                  </span>
                  <ChevronRight aria-hidden className="text-muted-foreground sm:hidden" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
      {!hasCriteria && visible.length > PREVIEW ? (
        <div className="border-t px-4 py-1 sm:px-5 sm:py-2">
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto min-h-11 p-0 sm:min-h-8"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Ver menos" : `Ver las ${visible.length}`}
          </Button>
        </div>
      ) : null}
      {hasMore && onLoadMore && (showAll || hasCriteria) ? (
        <div className="border-t px-4 py-2 sm:px-5">
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Cargando…" : `Cargar más (${entries.length} de ${total ?? entries.length})`}
          </Button>
        </div>
      ) : null}
      <FilterDrawer filters={[stateFilter]} open={filtersOpen} onOpenChange={setFiltersOpen} />
    </section>
  )
}
