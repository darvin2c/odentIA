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
  useIsMobile,
  useSidebarOptional,
} from "@odentia/ui"
import { MoreHorizontal } from "lucide-react"
import * as React from "react"
import { HeaderCompactProvider, useHeaderCompact, useHeaderFit, useHeaderUtilities } from "./header-utilities.js"

/**
 * Encabezado por página (ADR de la opción 1): una sola línea en todos los
 * anchos. Orden fijo: título (se recorta con puntos suspensivos), utilidades
 * globales, una acción principal y el menú ⋯ con lo demás.
 *
 * - Teléfono (<768 px): botones de 44 px solo con icono; «Agente» y «Ayuda» en ⋯.
 * - Desde 768 px: con icono y texto. Si la fila no cabe (panel lateral abierto,
 *   zoom), queda compacta: utilidades solo en íconos y «Ayuda» en ⋯.
 * - El contexto de la página (sede, fecha, recuento) no va en el encabezado: es
 *   una fila propia bajo él, en el contenido.
 *
 * El disparador del sidebar vive aquí solo en móvil (`md:hidden`), pegado al
 * título para no perder ancho.
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

const PRIMARY_CLASS = "shrink-0 gap-2 max-md:size-11 max-md:rounded-full max-md:px-0"

/** Disparador del menú lateral en el teléfono: icono grande y pegado al título. */
export const MOBILE_NAV_TRIGGER_CLASS = "-ml-2.5 -mr-1.5 size-11 shrink-0 md:hidden [&_svg]:size-[26px]!"

/**
 * El menú ⋯ del encabezado. Sin opciones de la página, solo aparece cuando la
 * fila está compacta (ahí recibe «Ayuda» y, en el teléfono, «Agente»).
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
  const compact = useHeaderCompact()
  const hasItems = items.length > 0
  if (!hasItems && !(extra && compact)) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Más opciones"
            className={cn("size-9 shrink-0 rounded-full max-md:size-11", className)}
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
  /**
   * Una segunda acción a la vista, junto a la principal y con borde. En el
   * teléfono no cabe: pasa al menú ⋯.
   */
  secondary?: { label: string; icon: React.ReactNode; onClick: () => void }
  /** Lo demás que la página ofrece: va en el menú ⋯. */
  menu?: PageHeaderMenuItem[]
  className?: string
}

export function PageHeader({ title, subtitle, primary, secondary, menu, className }: PageHeaderProps): React.JSX.Element {
  const sidebar = useSidebarOptional()
  const utilities = useHeaderUtilities()
  const navTrigger = sidebar ? <SidebarTrigger className={MOBILE_NAV_TRIGGER_CLASS} /> : null
  const isMobile = useIsMobile()
  const fit = useHeaderFit<HTMLHeadingElement, HTMLDivElement>(
    `${title}|${Boolean(primary)}|${Boolean(secondary)}`,
  )
  const menuItems =
    secondary && isMobile
      ? [{ label: secondary.label, icon: secondary.icon, onSelect: secondary.onClick }, ...(menu ?? [])]
      : menu

  const primaryContent = primary ? (
    <>
      {primary.icon}
      <span className="max-md:sr-only">{primary.label}</span>
    </>
  ) : null

  return (
    <HeaderCompactProvider value={isMobile || fit.compact}>
      <header className={cn("@container/page-header flex min-w-0 flex-nowrap items-center gap-2", className)}>
        {navTrigger}
        <h1 ref={fit.titleRef} className="min-w-0 flex-1 truncate text-[17px] font-bold tracking-tight text-foreground md:text-2xl">
          {title}
        </h1>
        <div ref={fit.actionsRef} className="flex shrink-0 items-center gap-1 md:gap-2">
          {utilities?.utilities}
          {secondary && !isMobile ? (
            <Button
              type="button"
              variant="outline"
              title={secondary.label}
              className="shrink-0 gap-2 @max-4xl/page-header:size-9 @max-4xl/page-header:rounded-full @max-4xl/page-header:px-0"
              onClick={secondary.onClick}
            >
              {secondary.icon}
              <span className="@max-4xl/page-header:sr-only">{secondary.label}</span>
            </Button>
          ) : null}
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
          <PageHeaderMenu items={menuItems} />
        </div>
      </header>
      {subtitle ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {typeof subtitle === "string" ? <p className="min-w-0">{subtitle}</p> : subtitle}
        </div>
      ) : null}
    </HeaderCompactProvider>
  )
}
