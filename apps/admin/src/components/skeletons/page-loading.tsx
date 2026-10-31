/**
 * El marco del esqueleto de una pantalla de la administración, mientras llega su
 * código: el mismo `PageShell` y el mismo `PageHeader`, con su título real. Aquí
 * también están las piezas que comparten: líneas con el alto de cada tamaño de
 * letra, para que nada salte al llegar el texto.
 */
import { cn, Skeleton } from "@odentia/ui"
import { PageHeader, PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import type { ComponentProps, ReactNode } from "react"

type HeaderProps = ComponentProps<typeof PageHeader>

export function PageLoading({
  title,
  subtitle,
  primary,
  secondary,
  menu,
  className = "flex flex-col gap-6",
  bodyClassName = "flex flex-col gap-6",
  children,
}: {
  title: string
  subtitle?: HeaderProps["subtitle"]
  primary?: HeaderProps["primary"]
  secondary?: HeaderProps["secondary"]
  menu?: HeaderProps["menu"]
  /** Las mismas clases del `PageShell` de la pantalla. */
  className?: string
  /** El mismo espacio entre bloques que la pantalla. */
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <PageShell className={className}>
      <PageHeader title={title} subtitle={subtitle} primary={primary} secondary={secondary} menu={menu} />
      <SkeletonRegion message={`Cargando ${title}…`} className={bodyClassName}>
        {children}
      </SkeletonRegion>
    </PageShell>
  )
}

/** Una línea de letra base (24 px de alto). */
export function TextBase({ className }: { className?: string }) {
  return <Skeleton className={cn("my-1 h-4 max-w-full", className)} />
}

/** Una línea de `text-sm` (20 px de alto). */
export function TextSm({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-4 max-w-full", className)} />
}

/** Una línea de `text-xs` (16 px de alto). */
export function TextXs({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-3 max-w-full", className)} />
}

/** Un `Input` o el disparador de un `Select`. */
export function ControlSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-9 rounded-3xl", className)} />
}

/**
 * La fila de las listas de Cobros y Comisiones: nombre y detalle, a veces un
 * importe y sus botones. Las mismas clases, así que en el teléfono se parte igual.
 */
export function RowSkeleton({ value = false, actions = [] }: { value?: boolean; actions?: string[] }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4">
      <div className="min-w-0 flex-1 basis-56">
        <TextSm className="w-48" />
        <TextXs className="w-64" />
      </div>
      {value ? <TextSm className="w-16" /> : null}
      {actions.length > 0 ? (
        <div className="flex gap-2">
          {actions.map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: botones de relleno, siempre los mismos.
            <Skeleton key={index} className={cn("h-8 rounded-3xl", width)} />
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** `KpiCard` con su título real y la cifra por llegar. */
export function KpiSkeleton({ title, description = false }: { title: string; description?: boolean }) {
  return (
    <div className="elevated h-full rounded-xl border bg-card p-5">
      <span className="block truncate text-sm font-medium text-muted-foreground">{title}</span>
      <Skeleton className="mt-3 h-[30px] w-16" />
      {description ? <TextXs className="mt-2.5 w-3/4" /> : null}
    </div>
  )
}

/**
 * El filtro «Producto» mientras llega la pantalla: mismas medidas y mismos
 * nombres, sin interacción. Empieza en «Todos», como el de verdad.
 */
export function ProductFilterSkeleton() {
  const item = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-3xl px-3.5 py-1.5 text-sm font-semibold text-foreground"
  return (
    <div aria-hidden className="flex w-fit flex-row flex-wrap items-center gap-1 rounded-3xl border bg-muted p-1">
      <span className={cn(item, "bg-background shadow-xs")}>Todos</span>
      <span className={item}>
        <span className="inline-block size-2 shrink-0 rounded-full bg-[var(--product-dental)]" />
        odentIA
      </span>
      <span className={item}>
        <span className="inline-block size-2 shrink-0 rounded-full bg-[var(--product-medical)]" />
        latidIA
      </span>
    </div>
  )
}
