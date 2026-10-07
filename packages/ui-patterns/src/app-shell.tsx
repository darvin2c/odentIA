import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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
  external?: boolean
}

export type AppShellNavGroup = {
  label: string
  icon?: NavIcon
  children: AppShellNavItem[]
  defaultOpen?: boolean
}

export type AppShellNavEntry = AppShellNavItem | AppShellNavGroup

export type AppShellUser = { name: string; email?: string; avatarUrl?: string }

export type AppShellUserMenuItem = {
  label: string
  icon: NavIcon
  to: string
  search?: Record<string, string>
}

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
  sidebarFooter?: React.ReactNode
  /** Ítems de navegación anclados al pie del sidebar, encima del bloque de
   * usuario (ajustes de la organización, por ejemplo). Mismo ítem que el nav
   * principal: activo por URL, badge y cierre del drawer móvil. */
  footerItems?: AppShellNavItem[]
  children: React.ReactNode
}

export function isNavItemActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/"
  if (pathname === to) return true
  return pathname.startsWith(`${to}/`)
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
  pathname,
  LinkComponent,
}: {
  item: AppShellNavItem
  pathname: string
  LinkComponent: AppShellProps["LinkComponent"]
}) {
  const { setOpenMobile } = useSidebar()
  const active = isNavItemActive(pathname, item.to)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.label}
        aria-current={active ? "page" : undefined}
        className={
          active
            ? "[&>span]:underline [&>span]:underline-offset-4 group-data-[collapsible=icon]:outline-1 group-data-[collapsible=icon]:outline-sidebar-foreground group-data-[collapsible=icon]:outline-offset-[-2px]"
            : undefined
        }
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
      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  )
}

function NavGroup({
  group,
  pathname,
  LinkComponent,
}: {
  group: AppShellNavGroup
  pathname: string
  LinkComponent: AppShellProps["LinkComponent"]
}) {
  const [open, setOpen] = React.useState(group.defaultOpen ?? true)
  const Icon = group.icon
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        render={
          <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} />
        }
        className="w-full justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          {Icon ? <Icon className="size-4 shrink-0" /> : null}
          <span className="truncate">{group.label}</span>
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 opacity-60 transition-transform", !open && "-rotate-90")}
        />
      </SidebarGroupLabel>
      {open ? (
        <SidebarGroupContent>
          <SidebarMenu>
            {group.children.map((child) => (
              <NavItemButton
                key={child.to}
                item={child}
                pathname={pathname}
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
  pathname,
  LinkComponent,
}: {
  items: AppShellNavEntry[]
  pathname: string
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
              pathname={pathname}
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
                      pathname={pathname}
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

/**
 * Cabecera del sidebar, patrón ChatGPT sin search: expandido muestra la marca
 * a la izquierda y el colapso a la derecha; en el riel colapsado la marca se
 * vuelve el botón superior y al pasar el hover troca al icono de expandir.
 * Ambos estados con tooltip. En móvil el drawer lo dispara el `PageHeader`,
 * así que aquí no se monta nada por debajo de `md`.
 */
function ShellSidebarHeader({
  brand,
  brandIcon,
}: {
  brand: React.ReactNode
  brandIcon?: React.ReactNode
}) {
  const { toggleSidebar } = useSidebar()
  return (
    <SidebarHeader>
      <div className="flex min-w-0 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center">
        <div className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">{brand}</div>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTrigger
                aria-label="Contraer el panel lateral"
                className="hidden md:inline-flex group-data-[collapsible=icon]:hidden"
              />
            }
          />
          <TooltipContent side="bottom" sideOffset={8}>
            Contraer el panel lateral
          </TooltipContent>
        </Tooltip>
        {brandIcon ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => toggleSidebar()}
                  aria-label="Expandir el panel lateral"
                  className="group/rail relative hidden size-8 cursor-ew-resize items-center justify-center rounded-md text-sidebar-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring md:group-data-[collapsible=icon]:flex"
                >
                  <span className="flex items-center justify-center transition-opacity group-hover/rail:opacity-0">
                    {brandIcon}
                  </span>
                  <RiSideBarLine className="absolute size-4 opacity-0 transition-opacity group-hover/rail:opacity-100" />
                </button>
              }
            />
            <TooltipContent side="right" align="center">
              Expandir el panel lateral
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger
                  aria-label="Expandir el panel lateral"
                  className="hidden md:group-data-[collapsible=icon]:inline-flex"
                />
              }
            />
            <TooltipContent side="right" align="center">
              Expandir el panel lateral
            </TooltipContent>
          </Tooltip>
        )}
      </div>
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
    sidebarFooter,
    footerItems,
    children,
  } = props
  const { mode: themeMode, setMode: setThemeMode } = useTheme({
    value: theme,
    defaultValue: defaultTheme,
    onChange: onThemeChange,
  })
  const initial = user.name?.trim().charAt(0).toUpperCase() || "U"

  const userMenuContent = (
    <>
      {userMenuItems?.map((item) => (
        <DropdownMenuItem
          key={item.label}
          render={(menuProps) => {
            const { onClick, ...rest } = menuProps
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
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <ShellSidebarHeader brand={brand} brandIcon={brandIcon} />
          <SidebarNav items={items} pathname={pathname} LinkComponent={LinkComponent} />
          <SidebarFooter>
            {sidebarFooter}
            {footerItems?.length ? (
              <>
                <SidebarMenu>
                  {footerItems.map((item) => (
                    <NavItemButton
                      key={item.to}
                      item={item}
                      pathname={pathname}
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
                className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar className="size-8">
                  {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
                  <AvatarFallback>{initial}</AvatarFallback>
                </Avatar>
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
        <SidebarInset className="min-h-svh">{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
