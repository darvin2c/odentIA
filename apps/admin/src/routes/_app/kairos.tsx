import { Button, toast } from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  SkeletonRegion,
  submitErrorMessage,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { RefreshCw } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { ClientName, invalidateArm } from "../../components/arm/hoy-links"
import { kairosSearchOf } from "../../components/arm/hoy-search"
import {
  KairosItemCard,
  KairosUnconfirmed,
  kairosItemsSchema,
} from "../../components/arm/kairos-items"
import { type ProductChoice, ProductFilter } from "../../components/product"
import {
  KAIROS_SUBTITLE,
  KAIROS_TITLE,
  KairosDoneSkeleton,
  KairosItemsSkeleton,
  KairosPageSkeleton,
} from "../../components/skeletons/kairos"
import { api } from "../../lib/api"
import { useIsAdmin } from "../../lib/session"
import { supportDay, supportTime } from "../../lib/support-words"

export const Route = createFileRoute("/_app/kairos")({
  validateSearch: kairosSearchOf,
  pendingComponent: KairosPageSkeleton,
  component: KairosPage,
})

/**
 * Kairós (`/api/admin/kairos`): lo que preparó y espera tu sí, con su por
 * qué, con qué datos y cuándo vence, y «Lo que hizo» solo, con Deshacer
 * cuando se puede. Soporte no ve lo que es solo de Administración (el
 * servidor tampoco se lo da). «Correr ahora» hace a pedido la pasada que el
 * worker corre cada 5 minutos: solo Administración.
 */

const undoSchema = z
  .object({
    kind: z.string(),
    taskId: z.string().optional(),
    clientId: z.string().optional(),
    field: z.string().optional(),
  })
  .nullable()
const doneMemberSchema = z.object({
  id: z.string(),
  words: z.string(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  undo: undoSchema,
})
const doneSchema = z.object({
  items: z.array(
    doneMemberSchema.extend({
      at: z.string(),
      // Lo repetido de una pasada, en una frase; cada ficha con su Deshacer.
      members: z.array(doneMemberSchema).optional(),
    }),
  ),
  nextBefore: z.string().nullable().optional(),
})
type DoneEntry = z.infer<typeof doneSchema>["items"][number]
type DoneMember = z.infer<typeof doneMemberSchema>
const DONE_PAGE = 50

const runSchema = z.object({
  tasks: z.number(),
  items: z.number(),
  signals: z.number(),
  drafted: z.number(),
  draftsFailed: z.number(),
})

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function KairosPage() {
  const isAdmin = useIsAdmin()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const view = search.vista === "hizo" ? "hizo" : "espera"
  const product: ProductChoice = search.producto ?? "todos"
  const queryClient = useQueryClient()
  const waiting = useQuery({
    queryKey: ["admin", "kairos", "items", "espera"],
    queryFn: async () =>
      kairosItemsSchema.parse(
        await api<unknown>("/api/admin/kairos/items?status=espera&limit=100"),
      ),
  })
  const run = useMutation({
    mutationFn: async () =>
      runSchema.parse(
        await api<unknown>("/api/admin/kairos/run", { method: "POST", body: JSON.stringify({}) }),
      ),
    onSuccess: (result) => {
      invalidateArm(queryClient)
      const said = `Kairós revisó todo: ${plural(result.items, "cosa nueva", "cosas nuevas")} para decidir, ${plural(result.tasks, "tarea", "tareas")} y ${plural(result.drafted, "borrador", "borradores")}.`
      if (result.draftsFailed > 0)
        toast.warning(
          `${said} No pudo redactar ${plural(result.draftsFailed, "borrador", "borradores")}: lo intenta en la próxima pasada.`,
        )
      else toast.success(said)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const setSearch = (next: Partial<typeof search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
  const now = new Date()
  const items = (waiting.data?.items ?? []).filter(
    (item) => product === "todos" || item.product === product,
  )

  return (
    <PageShell className="space-y-6">
      <PageHeader
        title={KAIROS_TITLE}
        subtitle={KAIROS_SUBTITLE}
        primary={
          isAdmin
            ? {
                label: run.isPending ? "Corriendo…" : "Correr ahora",
                icon: <RefreshCw aria-hidden />,
                onClick: () => run.mutate(),
                disabled: run.isPending,
              }
            : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <ViewTabs
          label="Qué ver de Kairós"
          value={view}
          options={[
            {
              value: "espera",
              label: "Espera tu sí",
              ...(waiting.data ? { count: waiting.data.total } : {}),
            },
            { value: "hizo", label: "Lo que hizo" },
          ]}
          onValueChange={(next) => setSearch({ vista: next === "hizo" ? "hizo" : undefined })}
        />
        {view === "espera" ? (
          <ProductFilter
            value={product}
            onChange={(next) => setSearch({ producto: next === "todos" ? undefined : next })}
          />
        ) : null}
      </div>

      {view === "espera" ? (
        <>
          <KairosUnconfirmed product={product === "todos" ? undefined : product} />
          {waiting.isPending ? (
            <SkeletonRegion message="Consultando lo que espera tu sí…">
              <KairosItemsSkeleton />
            </SkeletonRegion>
          ) : waiting.isError ? (
            <ErrorState error={waiting.error} onRetry={() => void waiting.refetch()} />
          ) : waiting.data.items.length === 0 ? (
            <EmptyState
              title="Nada espera tu sí"
              description="Cuando Kairós prepare un mensaje, una propuesta o un dato, sale aquí con su por qué. Lo que no decidas vence a las 48 horas."
            />
          ) : items.length === 0 ? (
            <EmptyState
              title="Nada de este producto espera tu sí"
              description="Lo que espera es de otros productos."
              actionLabel="Ver todos"
              onAction={() => setSearch({ producto: undefined })}
            />
          ) : (
            <AgentSurface aria-label="Espera tu sí" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Lo que vence antes va arriba. Enviar o aprobar hace lo mismo que el botón de la
                ficha; «Ahora no» lo deja.
                {waiting.data.total > waiting.data.items.length
                  ? ` Se muestran ${waiting.data.items.length} de ${waiting.data.total}.`
                  : ""}
              </p>
              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <KairosItemCard key={item.id} item={item} isAdmin={isAdmin} now={now} />
                ))}
              </ul>
            </AgentSurface>
          )}
        </>
      ) : (
        <KairosDone />
      )}
    </PageShell>
  )
}

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Lima",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** «Lo que hizo»: frases por día, lo último arriba, con «Cargar más». */
function KairosDone() {
  const done = useInfiniteQuery({
    queryKey: ["admin", "kairos", "done"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      doneSchema.parse(
        await api<unknown>(
          `/api/admin/kairos/done?limit=${DONE_PAGE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        ),
      ),
    // Agrupar acorta la página: la siguiente la dice el servidor, no el largo.
    getNextPageParam: (last) => last.nextBefore ?? null,
  })
  if (done.isPending)
    return (
      <SkeletonRegion message="Consultando lo que hizo Kairós…">
        <KairosDoneSkeleton />
      </SkeletonRegion>
    )
  if (done.isError) return <ErrorState error={done.error} onRetry={() => void done.refetch()} />
  const entries = done.data.pages.flatMap((page) => page.items)
  if (entries.length === 0)
    return (
      <EmptyState
        title="Kairós todavía no hizo nada solo"
        description="Cuando ponga una tarea, complete un dato vacío o avise de un cliente que se enfría, queda aquí con Deshacer cuando se puede."
      />
    )
  const todayKey = dayKeyFormat.format(new Date())
  const days: { key: string; label: string; entries: DoneEntry[] }[] = []
  for (const entry of entries) {
    const key = dayKeyFormat.format(new Date(entry.at))
    const last = days.at(-1)
    if (last?.key === key) last.entries.push(entry)
    else
      days.push({
        key,
        label: key === todayKey ? `Hoy · ${supportDay(entry.at)}` : supportDay(entry.at),
        entries: [entry],
      })
  }
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Lo que Kairós hizo solo: tareas, datos vacíos y avisos. Lo que preparó para decidir está en
        «Espera tu sí».
      </p>
      {days.map((day) => (
        <section key={day.key} aria-labelledby={`dia-${day.key}`} className="space-y-3">
          <h2 id={`dia-${day.key}`} className="text-base font-semibold first-letter:uppercase">
            {day.label}
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {day.entries.map((entry) => (
              <DoneRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      ))}
      {done.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          disabled={done.isFetchingNextPage}
          onClick={() => void done.fetchNextPage()}
        >
          {done.isFetchingNextPage ? "Cargando…" : "Cargar más"}
        </Button>
      ) : null}
    </div>
  )
}

/** Una frase de lo que hizo, con su cliente y Deshacer si todavía se puede. */
function DoneRow({ entry }: { entry: DoneEntry }) {
  const [open, setOpen] = useState(false)
  const members = entry.members ?? []
  if (members.length > 1)
    return (
      <li className="flex flex-wrap items-start gap-3 p-4">
        <span className="w-11 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
          {supportTime(entry.at)}
        </span>
        <AgentMark size="sm" />
        <div className="min-w-0 flex-1 basis-56 space-y-2">
          <p className="text-sm [overflow-wrap:anywhere]">{entry.words}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={open}
            aria-controls={`hizo-${entry.id}`}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Ocultar cada una" : `Ver cada una (${members.length})`}
          </Button>
          {open ? (
            <ul id={`hizo-${entry.id}`} className="divide-y rounded-lg border">
              {members.map((member) => (
                <DoneMemberRow key={member.id} member={member} />
              ))}
            </ul>
          ) : null}
        </div>
      </li>
    )
  return <DoneSingleRow entry={entry} />
}

/** Una ficha de un grupo: su frase, su cliente y su Deshacer. */
function DoneMemberRow({ member }: { member: DoneMember }) {
  const { canUndo, undo } = useDoneUndo(member)
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm [overflow-wrap:anywhere]">{member.words}</p>
        {member.clientId && member.clientName ? (
          <p className="text-xs text-muted-foreground">
            <ClientName clientId={member.clientId} tab="historial">
              {member.clientName}
            </ClientName>
          </p>
        ) : null}
      </div>
      {canUndo ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={undo.isPending}
          onClick={() => undo.mutate()}
        >
          Deshacer
        </Button>
      ) : null}
    </li>
  )
}

/** Deshacer lo que hizo Kairós con la operación de siempre: cancelar la tarea o vaciar el dato. */
function useDoneUndo(entry: DoneMember) {
  const queryClient = useQueryClient()
  const undo = useMutation({
    mutationFn: async () => {
      const how = entry.undo
      if (how?.kind === "cancelar_tarea" && how.taskId)
        return api(`/api/admin/clients/tasks/${how.taskId}/cancel`, {
          method: "POST",
          body: JSON.stringify({}),
        })
      if (how?.kind === "vaciar_dato" && how.clientId && how.field)
        return api(`/api/admin/clients/${how.clientId}`, {
          method: "PATCH",
          body: JSON.stringify({ [how.field]: null }),
        })
      throw new Error("Esto ya no se puede deshacer")
    },
    onSuccess: () => {
      invalidateArm(queryClient, entry.clientId ?? entry.undo?.clientId)
      toast.success("Deshecho")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const canUndo =
    (entry.undo?.kind === "cancelar_tarea" && Boolean(entry.undo.taskId)) ||
    (entry.undo?.kind === "vaciar_dato" && Boolean(entry.undo.clientId && entry.undo.field))
  return { canUndo, undo }
}

function DoneSingleRow({ entry }: { entry: DoneEntry }) {
  const { canUndo, undo } = useDoneUndo(entry)
  return (
    <li className="flex flex-wrap items-start gap-3 p-4">
      <span className="w-11 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
        {supportTime(entry.at)}
      </span>
      <AgentMark size="sm" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm [overflow-wrap:anywhere]">{entry.words}</p>
        {entry.clientId && entry.clientName ? (
          <p className="text-xs text-muted-foreground">
            <ClientName clientId={entry.clientId} tab="historial">
              {entry.clientName}
            </ClientName>
          </p>
        ) : null}
      </div>
      {canUndo ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={undo.isPending}
          onClick={() => undo.mutate()}
        >
          Deshacer
        </Button>
      ) : null}
    </li>
  )
}
