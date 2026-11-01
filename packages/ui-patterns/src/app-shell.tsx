import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  KbdGroup,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
  useSidebar,
} from "@odentia/ui"
import { ChevronDown, ExternalLink, LogOut } from "lucide-react"
import { RiSideBarLine } from "@remixicon/react"
import * as React from "react"
import { PersonAvatar } from "./person-avatar.js"
import { type ThemeMode, ThemeTabs, useTheme } from "./theme.js"
// ----- Types -----
/**
 * Icono decorativo de la navegación: sirve cualquier componente que pinte un svg
 * con `className` (lucide `LucideIcon`, `@remixicon/react`, un svg propio). Lo
 * comparten el menú del `AppShell` y la navegación de sección para que el mismo
 * icono valga en los dos.
 */
export type NavIcon = React.ComponentType<{ className?: string }>

export type AppShellNavItem = {
  label: string
  to: string
  icon: NavIcon
  badge?: string | number
  /** Qué cuenta el número, para el lector de pantalla y el tooltip del menú en íconos. */
  badgeLabel?: string
  external?: boolean
}

export type AppShellNavGroup = {
  label: string
  icon?: NavIcon
  children: AppShellNavItem[]
  defaultOpen?: boolean
}

export type AppShellNavEntry = AppShellNavItem | AppShellNavGroup

export type AppShellUser = {
  name: string
  email?: string
  avatarUrl?: string | null
  /** Nombres y apellidos por separado: las iniciales del avatar salen exactas. */
  givenNames?: string | null
  familyName?: string | null
}

/**
 * Ítem del menú de usuario. `to` navega dentro de la app con el link del router;
 * `href` lleva a otra aplicación (otro origen) con un enlace normal.
 */
export type AppShellUserMenuItem = { label: string; icon: NavIcon } & (
  | { to: string; search?: Record<string, string>; href?: undefined }
  | { href: string; to?: undefined; search?: undefined }
)

/**
 * Contrato del link que aporta el router (TanStack `Link` en panel/platform).
 * Lo comparten `AppShell` y `SectionNav`: el mismo componente de router sirve
 * en el shell y en la navegación de sección, sin adaptadores.
 */
export type ShellLinkComponent = React.ComponentType<{
  to: string
  search?: Record<string, string>
  className?: string
  children: React.ReactNode
  title?: string
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
}>

export interface AppShellProps {
  items: AppShellNavEntry[]
  LinkComponent: ShellLinkComponent
  pathname: string
  user: AppShellUser
  userMenuItems?: AppShellUserMenuItem[]
  onSignOut: () => void
  theme?: ThemeMode
  defaultTheme?: ThemeMode
  onThemeChange?: (mode: ThemeMode) => void
  brand: React.ReactNode
  /** Marca compacta del riel colapsado; al hover troca al icono de expandir. */
  brandIcon?: React.ReactNode
  /** Selector de contexto (organización) bajo la marca; se oculta en el riel colapsado. */
  switcher?: React.ReactNode
  sidebarFooter?: React.ReactNode
  /** Ítems de navegación anclados al pie del sidebar, encima del bloque de
   * usuario (ajustes de la organización, por ejemplo). Mismo ítem que el nav
   * principal: activo por URL, badge y cierre del drawer móvil. */
  footerItems?: AppShellNavItem[]
  /**
   * La franja de avisos (`NoticeStrip`): arriba de todo, también de la barra
   * lateral, que se corre lo que la franja mide (`--notice-strip-h`).
   */
  notice?: React.ReactNode
  children: React.ReactNode
}

export function isNavItemActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/"
  if (pathname === to) return true
  return pathname.startsWith(`${to}/`)
}

/**
 * Destino activo entre todos los del shell: gana el más específico, así
 * `/agent/approvals` no marca a la vez `/agent` y su ruta hermana.
 */
function resolveActiveTo(pathname: string, items: AppShellNavItem[]): string | undefined {
  let best: string | undefined
  for (const item of items) {
    if (!isNavItemActive(pathname, item.to)) continue
    if (best === undefined || item.to.length > best.length) best = item.to
  }
  return best
}

function isGroup(entry: AppShellNavEntry): entry is AppShellNavGroup {
  return (
    (entry as AppShellNavGroup).children !== undefined &&
    Array.isArray((entry as AppShellNavGroup).children)
  )
}

// ----- Navegación -----

/**
 * Item de navegación. Enchufa el `LinkComponent` del router en
 * `SidebarMenuButton` vía el prop `render` de Base UI (mismo mecanismo que
 * `DropdownMenuItem` en el footer). Conserva el evento para que el router
 * intercepte la navegación y respete los bloqueos por cambios sin guardar.
 */
function NavItemButton({
  item,
  activeTo,
  LinkComponent,
}: {
  item: AppShellNavItem
  activeTo: string | undefined
  LinkComponent: AppShellProps["LinkComponent"]
}) {
  const { setOpenMobile } = useSidebar()
  const active = item.to === activeTo
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.badge && item.badgeLabel ? `${item.label}: ${item.badge} ${item.badgeLabel}` : item.label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "h-10 [&>svg]:text-muted-foreground",
          // El activo se distingue por fondo, peso e icono relleno, no solo por color.
          active &&
            "data-active:bg-primary-soft data-active:font-semibold data-active:text-primary-soft-foreground hover:bg-primary-soft hover:text-primary-soft-foreground [&>svg]:fill-primary/25 [&>svg]:text-primary",
        )}
        render={(props) => {
          const { onClick, children, ...rest } = props
          return (
            <LinkComponent
              to={item.to}
              {...rest}
              onClick={(event) => {
                setOpenMobile(false)
                onClick?.(event)
              }}
            >
              {children as React.ReactNode}
            </LinkComponent>
          )
        }}
      >
        <item.icon />
        <span>{item.label}</span>
        {item.external ? <ExternalLink className="ml-auto size-3 opacity-60" /> : null}
      </SidebarMenuButton>
      {item.badge ? (
        <>
          <SidebarMenuBadge className="top-2.5! h-5 min-w-5 rounded-full bg-secondary px-1.5 text-xs font-semibold">
            {item.badge}
            {item.badgeLabel ? <span className="sr-only"> {item.badgeLabel}</span> : null}
          </SidebarMenuBadge>
          {/* Con el menú en íconos el número no cabe: queda un punto sobre el icono. */}
          <span aria-hidden className="pointer-events-none absolute top-1.5 right-1.5 hidden size-2 rounded-full bg-primary group-data-[collapsible=icon]:block" />
        </>
      ) : null}
    </SidebarMenuItem>
  )
}

function NavGroup({
  group,
  activeTo,
  LinkComponent,
}: {
  group: AppShellNavGroup
  activeTo: string | undefined
  LinkComponent: AppShellProps["LinkComponent"]
}) {
  const [open, setOpen] = React.useState(group.defaultOpen ?? true)
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        render={
          <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
        }
        className="group/label w-full justify-between text-xs font-bold tracking-wider text-muted-foreground uppercase hover:text-sidebar-accent-foreground"
      >
        <span className="truncate">{group.label}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 opacity-0 transition-[opacity,transform] group-hover/label:opacity-70 group-focus-visible/label:opacity-70",
            !open && "-rotate-90 opacity-70",
          )}
        />
      </SidebarGroupLabel>
      {open ? (
        <SidebarGroupContent>
          <SidebarMenu>
            {group.children.map((child) => (
              <NavItemButton
                key={child.to}
                item={child}
                activeTo={activeTo}
                LinkComponent={LinkComponent}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
    </SidebarGroup>
  )
}

/**
 * Items sueltos y grupos en su orden original, ya dentro del `SidebarProvider`.
 * Los items planos contiguos se agrupan en un solo `SidebarMenu` (los `li`
 * exigen el `ul` padre); un grupo interrumpe la corrida.
 */
function SidebarNav({
  items,
  activeTo,
  LinkComponent,
}: {
  items: AppShellNavEntry[]
  activeTo: string | undefined
  LinkComponent: AppShellProps["LinkComponent"]
}) {
  const runs: AppShellNavEntry[][] = []
  for (const entry of items) {
    if (isGroup(entry)) {
      runs.push([entry])
    } else {
      const last = runs[runs.length - 1]
      if (last && !isGroup(last[0]!)) last.push(entry)
      else runs.push([entry])
    }
  }

  return (
    <SidebarContent role="navigation" aria-label="Principal">
      {runs.map((run, runIndex) => {
        const first = run[0]!
        if (isGroup(first)) {
          return (
            <NavGroup
              key={`g-${first.label}-${runIndex}`}
              group={first}
              activeTo={activeTo}
              LinkComponent={LinkComponent}
            />
          )
        }
        return (
          <SidebarGroup key={`run-${runIndex}`}>
            <SidebarGroupContent>
              <SidebarMenu>
                {run.map((entry) => {
                  const item = entry as AppShellNavItem
                  return (
                    <NavItemButton
                      key={item.to}
                      item={item}
                      activeTo={activeTo}
                      LinkComponent={LinkComponent}
                    />
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )
      })}
    </SidebarContent>
  )
}

/** Atajo del `Sidebar` de shadcn (Ctrl/⌘ + B), escrito como lo pulsa cada equipo. */
function SidebarShortcut() {
  const [mac, setMac] = React.useState(false)
  React.useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))
  }, [])
  return (
    <KbdGroup>
      <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
      <Kbd>B</Kbd>
    </KbdGroup>
  )
}

/**
 * En tableta, el menú abierto flota sobre la página: al cambiar de página se
 * cierra solo, para no dejarlo tapando lo que se acaba de elegir.
 */
function CloseFloatingSidebarOnNavigate({ pathname }: { pathname: string }) {
  const sidebar = useSidebar()
  const overlayRef = React.useRef(sidebar.overlay)
  overlayRef.current = sidebar.overlay
  const lastPathname = React.useRef(pathname)
  const { setOpen } = sidebar
  React.useEffect(() => {
    if (lastPathname.current === pathname) return
    lastPathname.current = pathname
    if (overlayRef.current) setOpen(false)
  }, [pathname, setOpen])
  return null
}

/**
 * Cabecera del sidebar, patrón ChatGPT sin search: expandido muestra la marca
 * a la izquierda y el icono de panel lateral a la derecha; en el riel colapsado
 * la marca se vuelve el botón superior y al pasar el hover troca al mismo icono.
 * Un solo icono para contraer y expandir, en el mismo sitio, y el mismo que
 * abre el menú en móvil (`PageHeader`); la flecha queda para navegar. Ambos
 * estados con tooltip y el atajo. En móvil el drawer lo dispara el
 * `PageHeader`, así que aquí no se monta nada por debajo de `md`.
 */
function ShellSidebarHeader({
  brand,
  brandIcon,
  switcher,
}: {
  brand: React.ReactNode
  brandIcon?: React.ReactNode
  switcher?: React.ReactNode
}) {
  const { toggleSidebar } = useSidebar()
  const tip = (label: string) => (
    <TooltipContent side="right" align="center" className="flex items-center gap-2">
      {label}
      <SidebarShortcut />
    </TooltipContent>
  )
  return (
    <SidebarHeader>
      <div className="flex min-w-0 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center">
        <div className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{brand}</div>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTrigger
                aria-label="Contraer el panel lateral"
                aria-keyshortcuts="Control+B Meta+B"
                className="hidden shrink-0 text-muted-foreground hover:text-foreground md:inline-flex group-data-[collapsible=icon]:hidden"
              />
            }
          />
          {tip("Contraer el panel lateral")}
        </Tooltip>
        {brandIcon ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => toggleSidebar()}
                  aria-label="Expandir el panel lateral"
                  aria-keyshortcuts="Control+B Meta+B"
                  className="group/rail relative hidden size-8 cursor-ew-resize items-center justify-center rounded-md text-sidebar-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring md:group-data-[collapsible=icon]:flex"
                >
                  <span className="flex items-center justify-center transition-opacity group-hover/rail:opacity-0 group-focus-visible/rail:opacity-0">
                    {brandIcon}
                  </span>
                  <RiSideBarLine className="absolute size-4 opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-visible/rail:opacity-100" />
                </button>
              }
            />
            {tip("Expandir el panel lateral")}
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger
                  aria-label="Expandir el panel lateral"
                  aria-keyshortcuts="Control+B Meta+B"
                  className="hidden md:group-data-[collapsible=icon]:inline-flex"
                />
              }
            />
            {tip("Expandir el panel lateral")}
          </Tooltip>
        )}
      </div>
      {switcher ? <div className="group-data-[collapsible=icon]:hidden">{switcher}</div> : null}
    </SidebarHeader>
  )
}

// ----- AppShell — layout estándar sobre Sidebar: el primitivo resuelve las
// tres variantes responsive (sidebar escritorio, rail solo-iconos al colapsar
// y drawer móvil vía Sheet). Cada página conserva su propio PageHeader.
export function AppShell(props: AppShellProps): React.JSX.Element {
  const {
    items,
    LinkComponent,
    pathname,
    user,
    userMenuItems,
    onSignOut,
    theme,
    defaultTheme,
    onThemeChange,
    brand,
    brandIcon,
    switcher,
    sidebarFooter,
    footerItems,
    notice,
    children,
  } = props
  const { mode: themeMode, setMode: setThemeMode } = useTheme({
    value: theme,
    defaultValue: defaultTheme,
    onChange: onThemeChange,
  })
  const activeTo = resolveActiveTo(pathname, [
    ...items.flatMap((entry) => (isGroup(entry) ? entry.children : [entry])),
    ...(footerItems ?? []),
  ])

  const userMenuContent = (
    <>
      {userMenuItems?.map((item) => (
        <DropdownMenuItem
          key={item.label}
          render={(menuProps) => {
            const { onClick, ...rest } = menuProps
            if (item.href !== undefined) {
              return (
                <a href={item.href} {...rest} onClick={onClick}>
                  {menuProps.children}
                </a>
              )
            }
            return (
              <LinkComponent to={item.to} search={item.search} {...rest} onClick={onClick}>
                {menuProps.children}
              </LinkComponent>
            )
          }}
        >
          <item.icon />
          {item.label}
        </DropdownMenuItem>
      ))}
      {userMenuItems?.length ? <DropdownMenuSeparator /> : null}
      <div className="px-2 py-1.5">
        <p className="mb-1.5 px-1 text-xs text-muted-foreground">Apariencia</p>
        <ThemeTabs value={themeMode} onValueChange={setThemeMode} />
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onSignOut}>
        <LogOut />
        Cerrar sesión
      </DropdownMenuItem>
    </>
  )

  return (
    <TooltipProvider>
      {notice}
      <SidebarProvider className="min-h-[calc(100svh-var(--notice-strip-h,0px))]">
        <CloseFloatingSidebarOnNavigate pathname={pathname} />
        <Sidebar
          collapsible="icon"
          className="top-[var(--notice-strip-h,0px)] h-[calc(100svh-var(--notice-strip-h,0px))]"
        >
          <ShellSidebarHeader brand={brand} brandIcon={brandIcon} switcher={switcher} />
          <SidebarNav items={items} activeTo={activeTo} LinkComponent={LinkComponent} />
          <SidebarFooter>
            {sidebarFooter}
            {footerItems?.length ? (
              <>
                <SidebarMenu>
                  {footerItems.map((item) => (
                    <NavItemButton
                      key={item.to}
                      item={item}
                      activeTo={activeTo}
                      LinkComponent={LinkComponent}
                    />
                  ))}
                </SidebarMenu>
                {/* Separa el menú anclado del bloque de usuario. */}
                <SidebarSeparator />
              </>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Menú de ${user.name || "usuario"}`}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
              >
                <PersonAvatar
                  name={user.name}
                  givenNames={user.givenNames}
                  familyName={user.familyName}
                  src={user.avatarUrl}
                  className="size-8"
                  fallbackClassName="text-xs"
                  decorative
                />
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium text-sidebar-foreground">
                    {user.name}
                  </p>
                  {user.email ? (
                    <p className="truncate text-xs text-sidebar-foreground/70">{user.email}</p>
                  ) : null}
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-56">
                {userMenuContent}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        {/* `SidebarInset` ya renderiza el landmark `<main>`: un `<main>`
            anidado sería HTML inválido y duplicaría el landmark para lectores
            de pantalla. El alto mínimo vive ahora en el propio inset. */}
        <SidebarInset className="min-h-[calc(100svh-var(--notice-strip-h,0px))]">{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
