/**
 * El marco del esqueleto de una pantalla mientras llega su código: el mismo
 * `PageShell` y el mismo `PageHeader` de la pantalla, con su título real y las
 * acciones que el rol tendrá, deshabilitadas hasta que llegue la pantalla. Dentro
 * de un layout que ya puso su `PageShell` (Configuración, Servicios) va solo el
 * contenido.
 */
import { PageHeader, type PageHeaderProps, PageShell, SkeletonRegion, useInsidePageShell } from "@odentia/ui-patterns"
import type { ReactNode } from "react"

export function PageLoading({
  title,
  primary,
  secondary,
  menu,
  footer,
  children,
  className,
}: {
  title: string
  primary?: PageHeaderProps["primary"]
  secondary?: PageHeaderProps["secondary"]
  menu?: PageHeaderProps["menu"]
  /** Lo que la pantalla deja fijo abajo en el teléfono; va fuera de la zona de datos, como en ella. */
  footer?: ReactNode
  children: ReactNode
  className?: string
}) {
  const inside = useInsidePageShell()
  const body = <SkeletonRegion message={`Cargando ${title}…`}>{children}</SkeletonRegion>
  if (inside) return body
  return (
    <PageShell className={className ?? "flex flex-col gap-4"}>
      <PageHeader title={title} primary={primary} secondary={secondary} menu={menu} />
      {body}
      {footer}
    </PageShell>
  )
}
