import { Badge, cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageNotice,
  PageShell,
  SkeletonRegion,
  UnsavedDialog,
  useDraftBlocker,
  ViewTabs,
} from "@odentia/ui-patterns"
import { createFileRoute, Link } from "@tanstack/react-router"
import { AtSign, Mail, MessageCircle, MessagesSquare, Paperclip } from "lucide-react"
import { useRef, useState } from "react"
import { ChatPane } from "../../components/arm/chat-drawer"
import { momentWords } from "../../components/arm/chat-api"
import { EmailThreadView } from "../../components/arm/email-thread"
import {
  CLIENT_PHASE_WORDS,
  CLIENT_PHASES,
  type ClientPhase,
  INBOX_CHANNEL_WORDS,
  INBOX_CHANNELS,
  INBOX_STATE_WORDS,
  type InboxChannel,
  type InboxItem,
  inboxItemPath,
  inboxTargetOf,
  useInbox,
} from "../../components/arm/inbox-api"
import { useIsAdmin } from "../../lib/session"

/*
 * La Bandeja (ADR 0196): lo que nos escriben desde fuera de la app, una conversación por persona y
 * canal, con su estado. A la izquierda la lista con sus filtros; a la derecha la conversación
 * abierta (`?c=chat:<id>` o `?c=correo:<id>`), la misma que el cajón de la ficha. En el teléfono se
 * ve una cosa a la vez. Solo Administración: Soporte sigue en su cola.
 */

const VIEWS = ["te_toca", "kairos", "respondida", "sin_cliente", "todas"] as const
type InboxView = (typeof VIEWS)[number]

const VIEW_WORDS: Record<InboxView, string> = {
  te_toca: "Te toca",
  kairos: "Kairós respondió",
  respondida: "Respondidas",
  sin_cliente: "Sin cliente",
  todas: "Todas",
}

interface InboxSearch {
  /** Sin valor: «Te toca». */
  vista?: Exclude<InboxView, "te_toca"> | undefined
  fase?: ClientPhase | undefined
  canal?: InboxChannel | undefined
  c?: string | undefined
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : undefined

export const Route = createFileRoute("/_app/inbox")({
  validateSearch: (search: Record<string, unknown>): InboxSearch => ({
    vista: oneOf(
      VIEWS.filter((view): view is Exclude<InboxView, "te_toca"> => view !== "te_toca"),
      search.vista,
    ),
    fase: oneOf(CLIENT_PHASES, search.fase),
    canal: oneOf(INBOX_CHANNELS, search.canal),
    c: inboxTargetOf(typeof search.c === "string" ? search.c : undefined) ? String(search.c) : undefined,
  }),
  component: InboxPage,
})

const CHANNEL_ICON = {
  correo: Mail,
  whatsapp: MessageCircle,
  instagram: AtSign,
  messenger: MessagesSquare,
} as const

function InboxPage() {
  const isAdmin = useIsAdmin()
  if (!isAdmin)
    return (
      <PageShell className="flex flex-col gap-5">
        <PageHeader title="Bandeja" />
        <PageNotice tone="aviso" label="La Bandeja es de Administración">
          Lo que nos escriben por correo, WhatsApp, Instagram o Messenger lo atiende Administración. Lo
          tuyo está en <Link to="/support">Soporte</Link>.
        </PageNotice>
      </PageShell>
    )
  return <Inbox />
}

function Inbox() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const view: InboxView = search.vista ?? "te_toca"
  const target = inboxTargetOf(search.c)
  const inbox = useInbox({
    ...(view === "sin_cliente"
      ? { estado: "todas" as const, cliente: "sin" }
      : { estado: view === "todas" ? ("todas" as const) : view }),
    ...(search.fase ? { fase: search.fase } : {}),
    ...(search.canal ? { canal: search.canal } : {}),
    limit: 100,
  })
  // Los números de las vistas son de toda la Bandeja: con un filtro puesto no se muestran.
  const filtered = Boolean(search.fase || search.canal)
  const counts = filtered ? undefined : inbox.data?.counts
  const items = inbox.data?.items ?? []
  const setSearch = (next: Partial<InboxSearch>, replace = true) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace })
  // Lo escrito sin enviar en la conversación abierta: cambiar de conversación pregunta antes.
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const skipGuard = useRef(false)
  const blocker = useDraftBlocker({
    disabled: !dirty,
    enableBeforeUnload: true,
    keptInPage: { unlessChanges: ["c"] },
    shouldBlockFn: () => {
      if (skipGuard.current) {
        skipGuard.current = false
        return false
      }
      return dirtyRef.current
    },
  })
  const open = (item: InboxItem) => setSearch({ c: inboxItemPath(item) }, false)
  // Cerrar desde el panel ya preguntó (su «×» y Escape cuidan lo escrito): no se pregunta dos veces.
  const close = () => {
    skipGuard.current = true
    setSearch({ c: undefined }, false)
  }

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title="Bandeja"
        subtitle="Lo que nos escriben desde fuera de la app: correo, WhatsApp, Instagram y Messenger. La ayuda a quien ya usa su app va por Soporte."
      />
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
        <section
          aria-label="Conversaciones"
          className={cn("flex min-w-0 flex-col gap-3", target && "max-lg:hidden")}
        >
          <ViewTabs
            label="Qué conversaciones ver"
            value={view}
            onValueChange={(next) => setSearch({ vista: next === "te_toca" ? undefined : next })}
            options={VIEWS.map((value) => ({
              value,
              label: VIEW_WORDS[value],
              ...(counts && value === "te_toca" ? { count: counts.teToca } : {}),
              ...(counts && value === "kairos" ? { count: counts.kairos } : {}),
              ...(counts && value === "sin_cliente" ? { count: counts.sinCliente } : {}),
            }))}
          />
          <div className="flex flex-wrap gap-2">
            <Select
              value={search.fase ?? "todas"}
              onValueChange={(value) =>
                setSearch({ fase: value === "todas" ? undefined : (value as ClientPhase) })
              }
            >
              <SelectTrigger aria-label="Fase del cliente" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas las fases</SelectItem>
                {CLIENT_PHASES.map((phase) => (
                  <SelectItem key={phase} value={phase}>
                    {CLIENT_PHASE_WORDS[phase]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={search.canal ?? "todos"}
              onValueChange={(value) =>
                setSearch({ canal: value === "todos" ? undefined : (value as InboxChannel) })
              }
            >
              <SelectTrigger aria-label="Canal" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los canales</SelectItem>
                {INBOX_CHANNELS.map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {INBOX_CHANNEL_WORDS[channel]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {inbox.isPending ? (
            <SkeletonRegion message="Cargando la Bandeja…">
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3].map((index) => (
                  <div key={index} className="h-20 animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            </SkeletonRegion>
          ) : inbox.isError && !inbox.data ? (
            <ErrorState
              title="No pude cargar la Bandeja"
              error={inbox.error}
              onRetry={() => void inbox.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              title={view === "te_toca" ? "Nada te espera" : "No hay conversaciones aquí"}
              description={
                view === "te_toca"
                  ? "Todo lo que nos escribieron tiene respuesta o no la necesita."
                  : "Cambia la vista o quita los filtros."
              }
              {...(view === "te_toca"
                ? { actionLabel: "Ver todas", onAction: () => setSearch({ vista: "todas" }) }
                : {})}
            />
          ) : (
            <>
              <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
                {items.map((item) => (
                  <InboxRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    selected={search.c === inboxItemPath(item)}
                    onOpen={() => open(item)}
                  />
                ))}
              </ul>
              {items.length >= 100 ? (
                <p className="text-xs text-muted-foreground">
                  Se ven las 100 primeras. Usa la fase o el canal para encontrar las demás.
                </p>
              ) : null}
            </>
          )}
        </section>

        <section
          aria-label="Conversación abierta"
          className={cn("min-w-0", !target && "max-lg:hidden")}
        >
          {target?.kind === "chat" ? (
            <ChatPane key={target.chatId} chatId={target.chatId} onClose={close} onDirtyChange={setDirty} />
          ) : target?.kind === "correo" ? (
            <EmailThreadView
              key={target.emailId}
              emailId={target.emailId}
              layout="pane"
              onClose={close}
              onDirtyChange={setDirty}
            />
          ) : (
            <div className="flex h-full min-h-60 items-center justify-center rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              Elige una conversación para leerla y responder.
            </div>
          )}
        </section>
      </div>
      <UnsavedDialog
        open={blocker.status === "blocked"}
        lost="Lo que escribiste en esta conversación se pierde."
        onStay={() => {
          if (blocker.status === "blocked") blocker.reset()
        }}
        onDiscard={() => {
          if (blocker.status === "blocked") blocker.proceed()
        }}
      />
    </PageShell>
  )
}

const STATE_BADGE = {
  te_toca: "warning",
  kairos: "soft",
  respondida: "secondary",
} as const

function InboxRow({
  item,
  selected,
  onOpen,
}: {
  item: InboxItem
  selected: boolean
  onOpen: () => void
}) {
  const Icon = CHANNEL_ICON[item.channel]
  const who = item.who.name ?? item.who.address
  const waiting = item.state === "te_toca"
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1 px-4 py-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
          selected && "bg-muted",
          waiting && "border-l-3 border-l-warning",
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 flex-1 truncate", waiting && "font-semibold")}>{who}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{momentWords(item.lastInboundAt)}</span>
        </span>
        {item.subject ? (
          <span className="truncate text-sm font-medium">{item.subject}</span>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          {item.attachments > 0 ? <Paperclip aria-hidden className="size-3.5 shrink-0" /> : null}
          <span className="truncate">
            {item.preview ??
              (item.attachments > 0
                ? item.attachments === 1
                  ? "Mandó un archivo"
                  : `Mandó ${item.attachments} archivos`
                : "Sin texto")}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant={STATE_BADGE[item.state]}>{INBOX_STATE_WORDS[item.state]}</Badge>
          {item.stateWhy ? <span>{item.stateWhy}</span> : null}
          <span>{INBOX_CHANNEL_WORDS[item.channel]}</span>
          {item.client ? (
            <span className="truncate">
              {item.client.name} · {CLIENT_PHASE_WORDS[item.client.phase]}
            </span>
          ) : (
            <span className="font-medium text-warning">Sin cliente: elegir</span>
          )}
          {item.attendedBy ? <span>· {item.attendedBy.name.trim().split(/\s+/)[0]}</span> : null}
        </span>
      </button>
    </li>
  )
}
