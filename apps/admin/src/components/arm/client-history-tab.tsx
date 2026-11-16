/**
 * Historial de la ficha del cliente (ADR 0196): una sola línea de tiempo, de lo más nuevo a lo
 * más viejo, armada por el servidor desde sus fuentes y ordenada por lo que pasó: Conversaciones,
 * Venta, Alta, Plan y pagos (solo Administración, como su pestaña) y Soporte. Una línea por
 * entrada (la hora, el ícono de su canal o de lo que es, el título con un poco de detalle y su
 * categoría), agrupadas por día de Lima. Toda fila abre algo: el correo o el chat en su
 * conversación (`ConversationDrawer`), un envío, lo anotado, una tarea, un documento, un informe o
 * una carga en su cajón, la propuesta, el caso en la cola de soporte o la pestaña que toca. El
 * filtro vive en la dirección (`?historial=`) y «Ver más» trae lo anterior. Soporte no recibe lo
 * «solo administración», importes ni conversaciones (lo filtra el servidor).
 */
import { Button, cn } from "@odentia/ui"
import {
  AgentMark,
  EmptyState,
  ErrorState,
  LoadingState,
  useListSearch,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useInfiniteQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  BadgeDollarSign,
  CalendarCheck,
  CreditCard,
  FileText,
  FileUp,
  History,
  Instagram,
  LifeBuoy,
  ListChecks,
  Mail,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Phone,
  Presentation,
  Rocket,
  Send,
  UserRound,
  Users,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { api } from "../../lib/api"
import {
  CLIENT_HISTORY_FILTERS,
  type ClientHistoryFilter,
  type ClientTab,
} from "../../lib/list-search"
import type { ClientTabProps } from "./account-tabs"
import {
  CargaDrawer,
  EnvioDrawer,
  HistoryEntryDrawer,
  InformeDrawer,
  TaskDoneDrawer,
} from "./client-history-drawers"
import {
  HISTORY_CATEGORY_WORDS,
  limaDayOf,
  limaTimeOf,
  relativeDayWords,
  type TimelineEntry,
  timelineSchema,
  wordOf,
} from "./client-model"
import { clientQueryKeys } from "./client-queries"
import { CLIENT_TAB_NAMES } from "./client-tabs"
import { type ConversationTarget, ConversationDrawer } from "./conversation-drawer"
import { FileViewerById } from "./file-viewer"
import { ProposalDrawer } from "./proposal-drawer"

const FILTER_WORDS: Record<ClientHistoryFilter, string> = {
  todo: "Todo",
  conversaciones: "Conversaciones",
  venta: "Venta",
  alta: "Alta",
  plan: "Plan y pagos",
  soporte: "Soporte",
}
const PAGE = 30

/** Las pestañas a las que lleva una fila (`pestana`), y quién puede abrir cada una. */
const TAB_LINKS: Record<string, { tab: ClientTab; adminOnly?: boolean }> = {
  resumen: { tab: "resumen" },
  venta: { tab: "venta" },
  alta: { tab: "alta" },
  pagos: { tab: "pagos", adminOnly: true },
  soporte: { tab: "soporte" },
  contactos: { tab: "contactos" },
  documentos: { tab: "documentos" },
}

/** El ícono de cada fila: el canal por donde pasó o lo que es. */
const ICONS: Record<string, typeof Phone> = {
  llamada: Phone,
  whatsapp: MessageCircle,
  instagram: Instagram,
  messenger: MessagesSquare,
  correo: Mail,
  reunion: Users,
  nota: NotebookPen,
  presentacion: Presentation,
  propuesta: FileText,
  solicitud: Send,
  venta: BadgeDollarSign,
  tarea: ListChecks,
  archivo: FileUp,
  persona: UserRound,
  alta: Rocket,
  informe: FileText,
  carga: CalendarCheck,
  pago: CreditCard,
  plan: CreditCard,
  soporte: LifeBuoy,
}

type Opened =
  | { kind: "conversacion"; target: ConversationTarget }
  | { kind: "envio" | "actividad" | "detalle"; entry: TimelineEntry }
  | { kind: "tarea"; taskId: string; entry: TimelineEntry }
  | { kind: "archivo"; fileId: string }
  | { kind: "propuesta"; proposalId: string }
  | { kind: "informe"; orgId: string; number: number }
  | { kind: "carga"; orgId: string; loadId: string }

/** El día de Lima de una fila como encabezado: «Hoy», «Ayer» o «vie 13 nov» (con su año si no es este). */
function dayHeading(iso: string, now: Date): string {
  const day = limaDayOf(new Date(iso))
  const words = relativeDayWords(day, now)
  if (words === "hoy") return "Hoy"
  if (words === "ayer") return "Ayer"
  return day.slice(0, 4) === limaDayOf(now).slice(0, 4) ? words : `${words} ${day.slice(0, 4)}`
}

export function ClientHistoryTab({ clientId, isAdmin }: ClientTabProps) {
  const { get, setParam } = useListSearch()
  const raw = get("historial")
  const filters = CLIENT_HISTORY_FILTERS.filter((value) => isAdmin || value !== "plan")
  const filter: ClientHistoryFilter = (filters as readonly string[]).includes(raw ?? "")
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
  const [opened, setOpened] = useState<Opened | null>(null)
  const close = () => setOpened(null)
  const now = new Date()

  /** Lo que abre una fila con cajón; las que llevan a otra página van con su enlace. */
  const open = (entry: TimelineEntry) => {
    const link = entry.link
    if (!link) return setOpened({ kind: "detalle", entry })
    switch (link.kind) {
      case "correo":
        return setOpened({ kind: "conversacion", target: { kind: "correo", emailId: link.id } })
      case "chat":
        return setOpened({ kind: "conversacion", target: { kind: "chat", chatId: link.id } })
      case "envio":
        return setOpened({ kind: "envio", entry })
      case "actividad":
        return setOpened({ kind: "actividad", entry })
      case "tarea":
        return setOpened({ kind: "tarea", taskId: link.id, entry })
      case "archivo":
        return setOpened({ kind: "archivo", fileId: link.id })
      case "propuesta":
        return setOpened({ kind: "propuesta", proposalId: link.id })
      case "informe":
        return link.orgId && link.number
          ? setOpened({ kind: "informe", orgId: link.orgId, number: link.number })
          : setOpened({ kind: "detalle", entry })
      case "carga":
        return link.orgId && link.loadId
          ? setOpened({ kind: "carga", orgId: link.orgId, loadId: link.loadId })
          : setOpened({ kind: "detalle", entry })
      default:
        return setOpened({ kind: "detalle", entry })
    }
  }

  // Los días, en el orden de las filas: cada uno con su encabezado.
  const days: Array<{ heading: string; items: TimelineEntry[] }> = []
  for (const entry of entries) {
    const heading = dayHeading(entry.at, now)
    const last = days.at(-1)
    if (last?.heading === heading) last.items.push(entry)
    else days.push({ heading, items: [entry] })
  }

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
          options={filters.map((value) => ({ value, label: FILTER_WORDS[value] }))}
          onValueChange={(next) =>
            setParam("historial", next === "todo" ? undefined : next, { replace: true })
          }
        />
        <p className="text-xs text-muted-foreground">
          {isAdmin
            ? "«lo ve Soporte» marca lo que Soporte también ve; lo demás es solo de Administración."
            : "Las conversaciones, los importes y lo que es solo de Administración no salen aquí."}
        </p>
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
          description="Aquí queda todo lo que pasa con la clínica: sus conversaciones, la venta, su alta, su plan y sus pagos, y su soporte."
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
            className="flex flex-col rounded-xl border bg-card"
          >
            {days.map((day) => [
              // El día se dice también en cada fila (para el lector de pantalla): aquí solo se ve.
              <li
                key={`dia-${day.heading}`}
                role="presentation"
                aria-hidden
                className="border-b bg-muted/40 px-4 py-1.5 text-xs font-semibold text-muted-foreground first:rounded-t-xl"
              >
                {day.heading}
              </li>,
              ...day.items.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  day={day.heading}
                  isAdmin={isAdmin}
                  clientId={clientId}
                  onOpen={open}
                />
              )),
            ])}
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

      {opened?.kind === "conversacion" ? (
        <ConversationDrawer target={opened.target} open onClose={close} />
      ) : null}
      {opened?.kind === "envio" ? (
        <EnvioDrawer clientId={clientId} entry={opened.entry} onClose={close} />
      ) : null}
      {opened?.kind === "actividad" || opened?.kind === "detalle" ? (
        <HistoryEntryDrawer entry={opened.entry} onClose={close} />
      ) : null}
      {opened?.kind === "tarea" ? (
        <TaskDoneDrawer
          clientId={clientId}
          taskId={opened.taskId}
          entry={opened.entry}
          onClose={close}
        />
      ) : null}
      <FileViewerById
        clientId={clientId}
        fileId={opened?.kind === "archivo" ? opened.fileId : null}
        open={opened?.kind === "archivo"}
        onClose={close}
        isAdmin={isAdmin}
      />
      {opened?.kind === "propuesta" ? (
        <ProposalDrawer clientId={clientId} open proposalId={opened.proposalId} onClose={close} />
      ) : null}
      {opened?.kind === "informe" ? (
        <InformeDrawer
          clientId={clientId}
          organizationId={opened.orgId}
          number={opened.number}
          onClose={close}
        />
      ) : null}
      {opened?.kind === "carga" ? (
        <CargaDrawer
          organizationId={opened.orgId}
          loadId={opened.loadId}
          onClose={close}
          onOpenReport={(number) => setOpened({ kind: "informe", orgId: opened.orgId, number })}
        />
      ) : null}
    </section>
  )
}

const ROW_ACTION =
  "min-w-0 text-left text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]"

/** Lo que dice al lector de pantalla qué abre la fila. */
function openWords(entry: TimelineEntry): string {
  switch (entry.link?.kind) {
    case "correo":
      return ": abrir el correo"
    case "chat":
      return ": abrir la conversación"
    case "archivo":
      return ": ver el documento"
    case "informe":
      return ": ver el informe"
    case "propuesta":
      return ": ver la propuesta"
    default:
      return ": ver el detalle"
  }
}

/**
 * Una fila: la hora (con su día para el lector de pantalla), el ícono, el título que la abre, quién
 * y un poco de detalle, y su categoría. Una propuesta para Soporte, una solicitud, un caso o una
 * pestaña llevan a su lugar con un enlace; lo demás abre su cajón.
 */
function HistoryRow({
  entry,
  day,
  isAdmin,
  clientId,
  onOpen,
}: {
  entry: TimelineEntry
  day: string
  isAdmin: boolean
  clientId: string
  onOpen: (entry: TimelineEntry) => void
}) {
  const kairos = entry.who.kind === "kairos"
  const Icon = ICONS[entry.icon] ?? NotebookPen
  const link = entry.link
  const tab =
    link?.kind === "pestana"
      ? TAB_LINKS[link.id]
      : link?.kind === "solicitud" || (link?.kind === "propuesta" && !isAdmin)
        ? TAB_LINKS.venta
        : undefined
  const title = (
    <>
      {entry.title}
      <span className="sr-only">{openWords(entry)}</span>
    </>
  )
  let action: ReactNode
  if (link?.kind === "soporte")
    action = (
      <Link to="/support" search={{ caso: link.id }} className={ROW_ACTION}>
        {entry.title}
        <span className="sr-only">: abrir el caso en Soporte</span>
      </Link>
    )
  else if (tab && (isAdmin || !tab.adminOnly))
    action = (
      <Link
        to="/clients/$clientId"
        params={{ clientId }}
        search={{ tab: tab.tab === "resumen" ? undefined : tab.tab }}
        className={ROW_ACTION}
      >
        {entry.title}
        <span className="sr-only">: ir a {CLIENT_TAB_NAMES[tab.tab]}</span>
      </Link>
    )
  else
    action = (
      <button
        type="button"
        onClick={() => onOpen(tab ? { ...entry, link: undefined } : entry)}
        className={ROW_ACTION}
      >
        {title}
      </button>
    )

  return (
    <li className="flex items-start gap-3 border-b px-4 py-2.5 last:border-b-0">
      <time
        dateTime={entry.at}
        className="w-11 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
      >
        <span className="sr-only">{day}, </span>
        {limaTimeOf(entry.at)}
      </time>
      {kairos ? (
        <AgentMark size="sm" className="mt-px size-5 shrink-0 rounded-md [&>svg]:size-3" />
      ) : (
        <span
          aria-hidden
          className="mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        >
          <Icon className="size-3" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-2">
        {action}
        <span className="shrink-0 text-xs text-muted-foreground">
          {kairos ? "Kairós" : entry.who.name}
        </span>
        {entry.detail ? (
          <p className="min-w-0 truncate text-sm text-muted-foreground md:flex-1">{entry.detail}</p>
        ) : null}
      </div>
      <span
        className={cn(
          "shrink-0 pt-0.5 text-right text-xs text-muted-foreground",
          "max-sm:max-w-24 max-sm:[overflow-wrap:anywhere]",
        )}
      >
        {wordOf(HISTORY_CATEGORY_WORDS, entry.category, "Otro")}
        {isAdmin && !entry.adminOnly ? <span className="block">lo ve Soporte</span> : null}
      </span>
    </li>
  )
}
