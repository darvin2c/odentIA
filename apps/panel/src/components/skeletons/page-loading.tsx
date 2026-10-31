/**
 * El marco del esqueleto de una pantalla del panel, mientras llega su código: el
 * mismo `PageShell` y el mismo `PageHeader`, con su título real. Aquí también
 * están las líneas con el alto de cada tamaño de letra, para que nada salte al
 * llegar el texto.
 */
import { cn, Skeleton } from "@odentia/ui"
import { PageHeader, PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import type { ReactNode } from "react"

export function PageLoading({
  title,
  subtitle,
  className = "flex flex-col gap-4",
  bodyClassName = "flex flex-col gap-4",
  children,
}: {
  title: string
  subtitle?: string
  /** Las mismas clases del `PageShell` de la pantalla. */
  className?: string
  /** El mismo espacio entre bloques que la pantalla. */
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <PageShell className={className}>
      <PageHeader title={title} subtitle={subtitle} />
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
