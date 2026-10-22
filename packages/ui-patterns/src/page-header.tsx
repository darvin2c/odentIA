import {
  Button,
  buttonVariants,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SidebarTrigger,
  useSidebarOptional,
} from "@odentia/ui"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"
import { useHeaderUtilities } from "./header-utilities.js"

/**
 * Encabezado por página (ADR de la opción 1): una sola línea en todos los
 * anchos. Orden fijo: título (se recorta con puntos suspensivos), utilidades
 * globales, una acción principal y el menú ⋯ con lo demás.
 *
 * - Teléfono (<768 px): utilidades y acción principal solo con icono.
 * - Tableta (768–1023 px) y web: con icono y texto; «Ayuda» pasa a ⋯ en tableta.
 * - El contexto de la página (sede, fecha, recuento) no va en el encabezado: es
 *   una fila propia bajo él, en el contenido.
 *
 * El disparador del sidebar vive aquí solo en móvil (`md:hidden`).
 */

export interface PageHeaderPrimary {
  /** Nombre visible desde tableta y accesible en el teléfono. */
  label: string
  icon: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  /** Un enlace (`<Link to=…>`) con el mismo estilo que el botón. */
  render?: React.ReactElement<{ className?: string; children?: React.ReactNode }>
}

export interface PageHeaderMenuItem {
  label: string
  icon?: React.ReactNode
  onSelect?: () => void
  disabled?: boolean
}

const PRIMARY_CLASS = "shrink-0 gap-2 max-md:size-9 max-md:rounded-full max-md:px-0"

/**
 * El menú ⋯ del encabezado. Sin opciones de la página, solo aparece bajo web
 * (ahí está «Ayuda» en la fila); en web sin nada que ofrecer no se dibuja.
 */
export function PageHeaderMenu({
  items = [],
  className,
}: {
  items?: PageHeaderMenuItem[]
  className?: string
}) {
  const utilities = useHeaderUtilities()
  const extra = utilities?.menuItems
  const hasItems = items.length > 0
  if (!hasItems && !extra) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Más opciones"
            className={cn("size-9 shrink-0 rounded-full", !hasItems && "lg:hidden", className)}
          />
        }
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem key={item.label} disabled={item.disabled} onClick={item.onSelect}>
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
        {hasItems && extra ? <DropdownMenuSeparator /> : null}
        {extra}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface PageHeaderProps {
  /** Título de la página. Es el `h1` del bloque, no un rótulo de sección. */
  title: string
  /**
   * Contexto de la página, en una fila propia bajo el encabezado: sede,
   * recuentos, fecha. Admite un control (el selector de sede).
   */
  subtitle?: React.ReactNode
  /** La acción principal de la página, con su icono. */
  primary?: PageHeaderPrimary
  /** Lo demás que la página ofrece: va en el menú ⋯. */
  menu?: PageHeaderMenuItem[]
  className?: string
}

export function PageHeader({ title, subtitle, primary, menu, className }: PageHeaderProps): React.JSX.Element {
  const sidebar = useSidebarOptional()
  const utilities = useHeaderUtilities()
  const navTrigger = sidebar ? <SidebarTrigger className="-ml-2 size-11 shrink-0 md:hidden" /> : null

  const primaryContent = primary ? (
    <>
      {primary.icon}
      <span className="max-md:sr-only">{primary.label}</span>
    </>
  ) : null

  return (
    <>
      <header className={cn("flex min-w-0 flex-nowrap items-center gap-2", className)}>
        {navTrigger}
        <h1 className="min-w-0 flex-1 truncate text-xl font-bold tracking-tight text-foreground md:text-2xl">{title}</h1>
        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          {utilities?.utilities}
          {primary ? (
            primary.render ? (
              React.cloneElement(
                primary.render,
                { className: cn(buttonVariants(), PRIMARY_CLASS, primary.render.props.className) },
                primaryContent,
              )
            ) : (
              <Button type="button" className={PRIMARY_CLASS} onClick={primary.onClick} disabled={primary.disabled}>
                {primaryContent}
              </Button>
            )
          ) : null}
          <PageHeaderMenu items={menu} />
        </div>
      </header>
      {subtitle ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {typeof subtitle === "string" ? <p className="min-w-0">{subtitle}</p> : subtitle}
        </div>
      ) : null}
    </>
  )
}
