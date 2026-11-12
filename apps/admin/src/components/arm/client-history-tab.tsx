/**
 * Historial de la ficha del cliente: una sola línea de tiempo, de lo más nuevo
 * a lo más viejo, armada por el servidor desde sus fuentes (la solicitud, lo
 * anotado, las tareas hechas, la venta, la cuenta, los pagos, soporte, lo que
 * hizo Kairós). Cada entrada dice quién la hizo; nada se borra. El filtro vive
 * en la dirección (`?historial=`) y «Ver más» trae lo anterior. Soporte no
 * recibe lo «solo administración» ni importes (lo filtra el servidor).
 */
import { Badge, Button } from "@odentia/ui"
import {
  AgentMark,
  EmptyState,
  ErrorState,
  LoadingState,
  PersonAvatar,
  useListSearch,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useInfiniteQuery } from "@tanstack/react-query"
import { Cog, History } from "lucide-react"
import { api } from "../../lib/api"
import { CLIENT_HISTORY_FILTERS, type ClientHistoryFilter } from "../../lib/list-search"
import type { ClientTabProps } from "./account-tabs"
import {
  HISTORY_CATEGORY_WORDS,
  type TimelineEntry,
  timelineSchema,
  whenWords,
  wordOf,
} from "./client-model"
import { clientQueryKeys } from "./client-queries"

const FILTER_WORDS: Record<ClientHistoryFilter, string> = {
  todo: "Todo",
  contactos: "Contactos",
  venta: "Venta",
  cuenta: "Cuenta y pagos",
  soporte: "Soporte",
}
const PAGE = 30

export function ClientHistoryTab({ clientId }: ClientTabProps) {
  const { get, setParam } = useListSearch()
  const raw = get("historial")
  const filter: ClientHistoryFilter = (CLIENT_HISTORY_FILTERS as readonly string[]).includes(
    raw ?? "",
  )
    ? (raw as ClientHistoryFilter)
    : "todo"
  const history = useInfiniteQuery({
    queryKey: clientQueryKeys.history(clientId, filter),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ filter, limit: String(PAGE) })
      if (pageParam) params.set("before", pageParam)
      return timelineSchema.parse(
        await api<unknown>(`/api/admin/clients/${encodeURIComponent(clientId)}/timeline?${params}`),
      )
    },
    getNextPageParam: (last) => last.nextBefore,
  })
  const entries = history.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section aria-labelledby="historial-titulo" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 id="historial-titulo" className="text-base font-semibold">
          Historial{" "}
          <span className="font-normal text-muted-foreground">
            · de lo más nuevo a lo más viejo
          </span>
        </h2>
        <ViewTabs
          label="Qué ver del historial"
          value={filter}
          options={CLIENT_HISTORY_FILTERS.map((value) => ({ value, label: FILTER_WORDS[value] }))}
          onValueChange={(next) =>
            setParam("historial", next === "todo" ? undefined : next, { replace: true })
          }
        />
      </div>

      {history.isPending ? (
        <LoadingState message="Cargando el historial…" />
      ) : history.isError && !history.data ? (
        <ErrorState
          title="No pude cargar el historial"
          error={history.error}
          onRetry={() => void history.refetch()}
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={History}
          title={
            filter === "todo"
              ? "Aún no hay nada en su historial"
              : `Nada en «${FILTER_WORDS[filter]}»`
          }
          description="Aquí queda todo lo que pasa con la clínica: lo que se anota, lo que hizo Kairós, su cuenta, sus pagos y su soporte."
          {...(filter === "todo"
            ? {}
            : {
                actionLabel: "Ver todo",
                onAction: () => setParam("historial", undefined, { replace: true }),
              })}
        />
      ) : (
        <>
          <ol
            aria-label="Historial del cliente"
            className="flex flex-col divide-y rounded-xl border bg-card"
          >
            {entries.map((entry) => (
              <HistoryEntry key={entry.id} entry={entry} />
            ))}
          </ol>
          {history.hasNextPage ? (
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {history.isFetchingNextPage ? "Cargando…" : "Ver más"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Eso es todo: aquí empezó su ficha.</p>
          )}
          {history.isFetchNextPageError ? (
            <p role="alert" className="text-sm text-destructive">
              No pude traer lo anterior. Vuelve a intentarlo con «Ver más».
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function HistoryEntry({ entry }: { entry: TimelineEntry }) {
  const kairos = entry.who.kind === "kairos"
  return (
    <li className="flex gap-3 p-4">
      {kairos ? (
        <AgentMark size="sm" className="mt-0.5" />
      ) : entry.who.kind === "sistema" ? (
        <span
          aria-hidden
          className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <Cog className="size-3.5" />
        </span>
      ) : (
        <PersonAvatar name={entry.who.name} className="mt-0.5 size-6" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{kairos ? "Kairós" : entry.who.name}</span>
          <span className="text-muted-foreground">{whenWords(entry.at)}</span>
          <Badge variant="outline">{wordOf(HISTORY_CATEGORY_WORDS, entry.category, "Otro")}</Badge>
          {entry.adminOnly ? (
            <span className="text-xs text-muted-foreground">Solo administración</span>
          ) : null}
        </div>
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{entry.title}</p>
        {entry.detail ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {entry.detail}
          </p>
        ) : null}
      </div>
    </li>
  )
}
