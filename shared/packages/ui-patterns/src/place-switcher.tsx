import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  BRAND_NAMES,
  BRAND_PLACES,
  BRANDS,
  type BrandId,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { Check, ChevronsUpDown } from "lucide-react"
import { Fragment, type ReactNode } from "react"

/**
 * Un lugar donde trabaja la persona: una clínica dental, un consultorio, una óptica o una
 * tienda. Llega ya armado por la app: el selector no construye direcciones ni conoce dominios.
 */
export interface Place {
  id: string
  name: string
  /** La app del lugar: dice qué es («Clínica dental»), su grupo y su color. */
  brand: BrandId
  /** El rol de la persona ahí, ya en palabras («Recepción», «Dueña»). */
  role: string
  /** Su dirección: cada fila es un enlace real (Ctrl+clic abre otra pestaña). */
  href: string
  logo?: string | null
}

/** Algo que pide actuar en el lugar actual («Pago pendiente»): punto sobre el logo y la insignia de su acción. */
export interface PlaceAlert {
  label: string
  tone: "warning" | "danger"
}

/** Una acción del lugar actual («Plan y pagos») o del pie («Cambiar de clínica»). */
export interface PlaceAction {
  label: string
  icon?: ReactNode
  href?: string
  onSelect?: () => void
  badge?: PlaceAlert
}

export interface PlaceSwitcherProps {
  /** El lugar donde está ahora. */
  current: Omit<Place, "href">
  /** Todos los lugares de la cuenta, el actual incluido o no, en el orden en que se muestran. */
  places: readonly Place[]
  /** Lo del lugar actual, arriba. */
  actions?: readonly PlaceAction[]
  /** Lo que va al final, tras los lugares. */
  footerActions?: readonly PlaceAction[]
  alert?: PlaceAlert
  /** El final del nombre accesible del botón: «Menú de la clínica», «Menú de la tienda». */
  menuLabel: string
}

/** «Clínica dental · Recepción»: qué es el lugar y qué es la persona ahí. */
export function placeLine(place: Pick<Place, "brand" | "role">): string {
  return `${BRAND_PLACES[place.brand].one} · ${place.role}`
}

/**
 * Los lugares por app, con el del lugar actual primero y las demás en el orden de las marcas.
 * Un solo grupo cuando todos son del mismo tipo.
 */
export function groupPlaces(
  places: readonly Place[],
  first: BrandId,
): Array<{ brand: BrandId; places: Place[] }> {
  const order = [first, ...BRANDS.filter((brand) => brand !== first)]
  return order
    .map((brand) => ({ brand, places: places.filter((place) => place.brand === brand) }))
    .filter((group) => group.places.length > 0)
}

const ALERT_DOT: Record<PlaceAlert["tone"], string> = {
  danger: "bg-destructive",
  warning: "bg-warning-strong",
}
const ALERT_BADGE: Record<PlaceAlert["tone"], string> = {
  danger: "bg-destructive text-destructive-foreground",
  warning: "bg-warning-strong text-warning-strong-foreground",
}

function ActionItem({ action }: { action: PlaceAction }) {
  const content = (
    <>
      {action.icon}
      <span className="flex-1">{action.label}</span>
      {action.badge ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
            ALERT_BADGE[action.badge.tone],
          )}
        >
          {action.badge.label}
        </span>
      ) : null}
    </>
  )
  if (action.href !== undefined) {
    const href = action.href
    return (
      <DropdownMenuItem
        render={(menuProps) => (
          <a href={href} {...menuProps}>
            {menuProps.children}
          </a>
        )}
        onClick={action.onSelect}
      >
        {content}
      </DropdownMenuItem>
    )
  }
  return <DropdownMenuItem onClick={action.onSelect}>{content}</DropdownMenuItem>
}

function PlaceItem({ place, current }: { place: Place; current: boolean }) {
  // El nombre accesible dice lo mismo que la fila: el lugar, su rol y si es el actual. Qué es
  // el lugar lo dice el nombre del grupo, o el botón cuando todos son del mismo tipo.
  const label = `${place.name}, ${place.role}${current ? ", lugar actual" : ""}`
  return (
    <DropdownMenuItem
      aria-label={label}
      aria-current={current ? "true" : undefined}
      className={cn("min-h-11 sm:min-h-9", current && "bg-primary-soft/60")}
      render={(menuProps) => (
        <a href={place.href} {...menuProps}>
          {menuProps.children}
        </a>
      )}
    >
      {/* El nombre entero, en dos líneas si hace falta: cortado, dos clínicas parecidas se confunden. */}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{place.name}</span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground">{place.role}</span>
      {current ? (
        <Check aria-hidden className="text-primary" />
      ) : (
        <span aria-hidden className="size-4" />
      )}
    </DropdownMenuItem>
  )
}

/**
 * El selector de lugares de la barra lateral (`switcher` de `AppShell`), igual en todas las apps
 * (lienzo «Una cuenta, todas las apps», tablero 7). El botón dice dónde está la persona: el nombre
 * del lugar y, debajo, qué es y su rol («Clínica dental · Recepción»). Al abrirlo, primero lo del
 * lugar actual, después sus lugares: agrupados por app, con el nombre del grupo en palabras y el
 * color de su app, cuando tiene lugares de más de un tipo; con uno solo, la lista simple. Cada
 * fila es un enlace, así Ctrl+clic abre el lugar en otra pestaña.
 */
export function PlaceSwitcher({
  current,
  places,
  actions = [],
  footerActions = [],
  alert,
  menuLabel,
}: PlaceSwitcherProps) {
  const initial = current.name.trim().charAt(0).toUpperCase() || "·"
  // Sin otro lugar adonde ir, la lista no se muestra: solo diría el lugar actual otra vez.
  const showPlaces = places.some((place) => place.id !== current.id)
  const groups = groupPlaces(places, current.brand)
  const grouped = groups.length > 1
  const sections: ReactNode[] = []
  if (actions.length > 0)
    sections.push(actions.map((action) => <ActionItem key={action.label} action={action} />))
  if (showPlaces) {
    sections.push(
      grouped
        ? groups.map((group) => (
            <DropdownMenuGroup key={group.brand}>
              <DropdownMenuLabel
                className="flex items-center gap-2 pt-2 pb-1 text-xs font-semibold"
                style={{ color: `var(--app-${group.brand})` }}
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: `var(--app-${group.brand})` }}
                />
                {BRAND_PLACES[group.brand].many} · {BRAND_NAMES[group.brand]}
              </DropdownMenuLabel>
              {group.places.map((place) => (
                <PlaceItem key={place.id} place={place} current={place.id === current.id} />
              ))}
            </DropdownMenuGroup>
          ))
        : places.map((place) => (
            <PlaceItem key={place.id} place={place} current={place.id === current.id} />
          )),
    )
  }
  if (footerActions.length > 0)
    sections.push(footerActions.map((action) => <ActionItem key={action.label} action={action} />))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${current.name}, ${BRAND_PLACES[current.brand].one}, ${current.role}${alert ? `, ${alert.label}` : ""}. ${menuLabel}`}
        className="elevated flex min-h-14 w-full items-center gap-2.5 rounded-xl border bg-card px-2.5 py-2 transition-colors outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="relative shrink-0">
          <Avatar className="size-9 rounded-[10px]">
            {current.logo ? (
              <AvatarImage src={current.logo} alt="" className="rounded-[10px]" />
            ) : null}
            <AvatarFallback className="rounded-[10px] bg-primary-soft font-semibold text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          {alert ? (
            <span
              aria-hidden
              className={cn(
                "absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card",
                ALERT_DOT[alert.tone],
              )}
            />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
          <span className="truncate text-sm font-semibold">{current.name}</span>
          <span className="truncate text-xs text-muted-foreground">{placeLine(current)}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--anchor-width) min-w-64">
        {sections.map((section, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: las secciones van siempre en el mismo orden.
          <Fragment key={index}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {section}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
