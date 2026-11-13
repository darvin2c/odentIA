/**
 * La ficha de un cliente (`routes/_app/clients_.$clientId.tsx`): cabecera,
 * próximo paso, pestañas y el Resumen. Las pestañas de siempre van con su
 * nombre; las que dependen de que tenga cuenta (Alta, Plan y pagos, Uso,
 * Soporte) aún no se saben y van como huecos sin nombre.
 */
import { cn, Skeleton } from "@odentia/ui"
import { PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import { useSearch } from "@tanstack/react-router"
import type { JSX } from "react"
import { CLIENT_TAB_NAMES } from "../arm/client-tabs"
import { ControlSkeleton, TextBase, TextSm, TextXs } from "./page-loading"

const tab = "inline-flex min-h-11 shrink-0 items-center px-3 text-sm font-medium sm:min-h-9"

function TabsSkeleton({ active }: { active: string }) {
  const named = ["resumen", "historial", "contactos", "venta"] as const
  return (
    <div
      aria-hidden
      className="flex min-w-0 max-w-full gap-1 overflow-hidden rounded-lg bg-muted p-[3px]"
    >
      {named.map((value) => (
        <span
          key={value}
          className={cn(
            tab,
            value === active ? "rounded-md bg-background shadow-xs" : "text-muted-foreground",
          )}
        >
          {CLIENT_TAB_NAMES[value]}
        </span>
      ))}
      <Skeleton className="my-1.5 h-6 w-16 shrink-0 rounded-md" />
      <Skeleton className="my-1.5 h-6 w-16 shrink-0 rounded-md" />
      <span
        className={cn(
          tab,
          active === "documentos" ? "rounded-md bg-background shadow-xs" : "text-muted-foreground",
        )}
      >
        {CLIENT_TAB_NAMES.documentos}
      </span>
    </div>
  )
}

function Card({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border bg-card p-4", className)}>
      <TextBase className="w-40" />
      {Array.from({ length: lines }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: líneas de relleno, siempre las mismas.
        <TextSm key={index} className={index % 2 ? "w-2/3" : "w-full"} />
      ))}
    </div>
  )
}

/** El cuerpo mientras llega: dos columnas en escritorio, una en el teléfono, como el Resumen. */
export function ClientBodySkeleton() {
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card lines={4} className="border-agent-border bg-agent-soft" />
        <Card lines={4} />
        <Card lines={3} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card lines={3} />
        <Card lines={2} />
      </div>
    </div>
  )
}

export function ClientDetailSkeleton({ wanted }: { wanted?: string | undefined }) {
  return (
    <SkeletonRegion message="Cargando la ficha del cliente…" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <TextXs className="w-32" />
        <Skeleton className="h-7 w-72 max-w-full md:h-8" />
        <TextSm className="w-full max-w-xl" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <TextXs className="w-24" />
          <TextBase className="w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <ControlSkeleton className="w-20" />
          <ControlSkeleton className="w-32" />
        </div>
      </div>
      <TabsSkeleton active={wanted ?? "resumen"} />
      <ClientBodySkeleton />
    </SkeletonRegion>
  )
}

/** Para la ruta: «← Clientes» aún sin enlace; la pantalla real lo pone al llegar. */
export function ClientDetailPageSkeleton(): JSX.Element {
  const search = useSearch({ strict: false }) as { tab?: unknown }
  return (
    <PageShell className="flex flex-col gap-4">
      <span className="self-start text-sm text-muted-foreground">← Clientes</span>
      <ClientDetailSkeleton wanted={typeof search.tab === "string" ? search.tab : undefined} />
    </PageShell>
  )
}
