/**
 * Esqueleto de la Bandeja, con las clases de `inbox/conversation-list.tsx`,
 * `inbox/thread-view.tsx` y `routes/_org/inbox.tsx`. Desde 1280 px (`xl`, el corte
 * de `useDetailMode`) van la lista y el hilo lado a lado; por debajo, una vista
 * por vez: el hilo si el enlace ya trae una conversación y, si no, la lista.
 */
import { ParamTabs } from "./param-tabs"
import { Button, cn, InputGroup, InputGroupAddon, InputGroupTextarea, Skeleton, Tabs, TabsTrigger } from "@odentia/ui"
import { EmptyState, FilterBar, PageHeader, PageShell, ScrollingTabsList, SkeletonRegion, useListSearch } from "@odentia/ui-patterns"
import { Ban, ChevronLeft } from "lucide-react"
import { useCan } from "../../lib/crm"
import { inboxPrimary } from "../../lib/screen-rules"

const ROWS = [
  { name: "w-32", line: "w-4/5" },
  { name: "w-40", line: "w-3/5" },
  { name: "w-28", line: "w-3/4" },
  { name: "w-36", line: "w-2/3" },
  { name: "w-24", line: "w-4/5" },
  { name: "w-40", line: "w-1/2" },
  { name: "w-32", line: "w-3/4" },
  { name: "w-28", line: "w-3/5" },
  { name: "w-36", line: "w-4/5" },
  { name: "w-32", line: "w-2/3" },
]

/** Las filas de dos líneas: van dentro de la tarjeta de la lista. */
export function ConversationRowsSkeleton() {
  return (
    <div className="flex flex-col divide-y">
      {ROWS.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
        <div key={index} className="flex min-w-0 flex-1 gap-2.5 px-3.5 py-2.5">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex h-5 min-w-0 items-center gap-1.5">
              <Skeleton className={cn("h-3.5 min-w-0", row.name)} />
              <span className="flex flex-1 items-center gap-1">
                <Skeleton className="size-3.5 shrink-0 rounded-full" />
              </span>
              <Skeleton className="h-3 w-10 shrink-0" />
            </span>
            <span className="flex h-5 min-w-0 items-center gap-1.5">
              <Skeleton className={cn("h-3", row.line)} />
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** De quién es cada burbuja y lo largo de sus líneas: como una conversación corriente. */
const BUBBLES = [
  { out: false, lines: ["w-48"] },
  { out: true, lines: ["w-60", "w-40"] },
  { out: false, lines: ["w-36"] },
  { out: true, lines: ["w-52"] },
  { out: false, lines: ["w-56", "w-32"] },
  { out: true, lines: ["w-44"] },
]

/**
 * El hilo: cabecera, burbujas y la caja de escribir. `onBack` es la flecha real
 * dentro de la pantalla; sin él (cuando aún no llega el código) su lugar queda
 * reservado solo en el ancho donde existe.
 */
export function ThreadSkeleton({ showBack, onBack }: { showBack?: boolean; onBack?: () => void }) {
  return (
    <SkeletonRegion
      message="Cargando la conversación…"
      className="elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        {showBack && onBack ? (
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Volver">
            <ChevronLeft className="size-4" />
          </Button>
        ) : showBack === undefined ? (
          <Skeleton className="size-9 shrink-0 rounded-full xl:hidden" />
        ) : null}
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5 py-0.5">
          <Skeleton className="h-4 w-40 max-w-full" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Skeleton className="hidden h-8 w-24 rounded-full xl:block" />
          <Skeleton className="size-9 rounded-full" />
        </div>
      </div>
      <div className="flex min-h-32 flex-1 basis-1/2 flex-col justify-end gap-2 overflow-hidden bg-canvas/60 p-4">
        <div className="flex justify-center py-1">
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        {BUBBLES.map((bubble, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: burbujas de relleno, siempre las mismas.
          <div key={index} className={cn("flex w-full max-w-[95%] flex-col gap-2", bubble.out && "ml-auto")}>
            <div
              className={cn(
                "flex w-fit max-w-full flex-col gap-1.5 rounded-2xl px-3.5 py-2.5",
                bubble.out ? "ml-auto rounded-br-md bg-secondary" : "rounded-bl-md border bg-card",
              )}
            >
              {bubble.lines.map((width) => (
                <Skeleton key={width} className={cn("h-3 max-w-full", width)} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* La caja se pinta tal cual; es lo único de abajo que no depende de la conversación. */}
      <div className="border-t" aria-hidden>
        <div className="flex flex-col gap-1.5 p-3">
          <InputGroup className="h-auto min-h-10 items-end overflow-hidden bg-background">
            <InputGroupTextarea
              disabled
              rows={1}
              tabIndex={-1}
              className="field-sizing-content max-h-48 min-h-16 max-sm:min-h-10"
              placeholder="Escribe un mensaje… (Enter para enviar)"
            />
            <InputGroupAddon align="block-end" className="justify-between gap-1">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="size-8 rounded-full" />
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Skeleton className="size-8 rounded-full" />
              </div>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </SkeletonRegion>
  )
}

/** Lista e hilo. `open`: el enlace ya trae una conversación. */
export function InboxSkeleton({ open }: { open: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row xl:gap-0">
      <div className={cn("min-h-0 flex-1 flex-col xl:w-[22rem] xl:flex-none xl:shrink-0", open ? "hidden xl:flex" : "flex")}>
        <SkeletonRegion
          message="Cargando conversaciones…"
          className="elevated min-h-0 flex-1 overflow-hidden rounded-xl border bg-card"
        >
          <ConversationRowsSkeleton />
        </SkeletonRegion>
      </div>
      <div aria-hidden className="hidden w-3 shrink-0 xl:block" />
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", open ? "flex" : "hidden xl:flex")}>
        {open ? (
          <ThreadSkeleton />
        ) : (
          <EmptyState title="Selecciona una conversación" description="Elige un hilo de la lista para verlo aquí." />
        )}
      </div>
    </div>
  )
}

/** Las pestañas de `VIEW_CHIPS` en `routes/_org/inbox.tsx`; la del agente lleva su nombre, que espera. */
const CHIPS = [
  { value: "attend", label: "Por atender" },
  { value: "agent", label: "Las atiende" },
  { value: "awaiting_patient", label: "Esperan al paciente" },
  { value: "closed", label: "Cerradas" },
]

export function InboxPageSkeleton() {
  const { get } = useListSearch()
  const open = Boolean(get("conversation"))
  const can = useCan()
  // En angosto, con un hilo abierto, la pantalla es del hilo: la cabecera y los filtros vuelven con la lista.
  const listOnly = open ? "max-xl:hidden" : undefined
  return (
    <PageShell fill className={cn("gap-3 sm:p-4", open && "max-sm:p-1.5")}>
      <div className={listOnly}>
        <PageHeader title="Bandeja" primary={inboxPrimary(can)} />
      </div>
      <div className={cn("flex min-w-0 flex-col gap-2 md:flex-row md:items-center md:gap-3", listOnly)}>
        <ParamTabs param="view" fallback="attend" value={get("view") ?? "attend"} className="min-w-0 shrink-0 max-md:w-full md:max-w-[70%]">
          <ScrollingTabsList aria-label="Vista de la bandeja">
            {CHIPS.map((chip) => (
              <TabsTrigger key={chip.value} value={chip.value} className="shrink-0 min-h-11 px-3 sm:min-h-9">
                {chip.label}
                {chip.value === "agent" ? <Skeleton className="h-3.5 w-8" /> : null}
              </TabsTrigger>
            ))}
            <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
            <TabsTrigger value="spam" className="shrink-0 min-h-11 px-3 text-muted-foreground sm:min-h-9">
              Spam
            </TabsTrigger>
            <TabsTrigger value="blocked" className="shrink-0 min-h-11 px-3 text-muted-foreground sm:min-h-9">
              <Ban className="size-4" aria-hidden />
              <span className="sr-only">Bloqueados</span>
            </TabsTrigger>
          </ScrollingTabsList>
        </ParamTabs>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <FilterBar
            filters={[{ key: "channel", label: "Canal", type: "select", options: [] }]}
            className="min-w-0 flex-1 bg-transparent p-0 [&>[data-filter-row=desktop]]:justify-end min-[1536px]:[&_[data-filter-row=desktop]>div:first-child]:w-52 [&_[data-filter-row=desktop]>div:first-child]:w-10 [&_[data-filter-row=desktop]>div:first-child]:focus-within:w-56"
            sortOptions={[]}
            searchPlaceholder="Buscar por nombre o teléfono"
            searchLabel="Buscar en la Bandeja"
            resetKeys={["channel", "q"]}
          />
          <Button type="button" variant="outline" className="min-h-11 shrink-0 sm:min-h-9">
            Solo las mías
          </Button>
        </div>
      </div>
      <InboxSkeleton open={open} />
    </PageShell>
  )
}
