import * as React from "react";
import { ChevronDown, ExternalLink, LogOut } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
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
  SidebarTrigger,
  TooltipProvider,
  cn,
  useSidebar,
} from "@odentia/ui";
// ----- Types -----
export type AppShellNavItem = {
  label: string;
  to: string;
  icon: LucideIcon;
  badge?: string | number;
  external?: boolean;
};

export type AppShellNavGroup = {
  label: string;
  icon?: LucideIcon;
  children: AppShellNavItem[];
  defaultOpen?: boolean;
};

export type AppShellNavEntry = AppShellNavItem | AppShellNavGroup;

export type AppShellUser = { name: string; email?: string; avatarUrl?: string };

export type AppShellUserMenuItem = {
  label: string;
  icon: LucideIcon;
  to: string;
  search?: Record<string, string>;
};

export interface AppShellProps {
  items: AppShellNavEntry[];
  LinkComponent: React.ComponentType<{
    to: string;
    search?: Record<string, string>;
    className?: string;
    children: React.ReactNode;
    title?: string;
    onClick?: () => void;
  }>;
  pathname: string;
  user: AppShellUser;
  userMenuItems?: AppShellUserMenuItem[];
  onSignOut: () => void;
  brand: React.ReactNode;
  searchSlot?: React.ReactNode;
  topbarActions?: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  /** Pantallas operativas densas (POS, KDS, tablas): usa todo el ancho. Default contenido 1280px. */
  fluid?: boolean;
  children: React.ReactNode;
}

export function isNavItemActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  if (pathname === to) return true;
  return pathname.startsWith(`${to}/`);
}

function isGroup(entry: AppShellNavEntry): entry is AppShellNavGroup {
  return (
    (entry as AppShellNavGroup).children !== undefined &&
    Array.isArray((entry as AppShellNavGroup).children)
  );
}

// ----- PageHeader — header por página, no global -----
export function PageHeader(props: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{props.title}</h1>
        {props.subtitle ? (
          <p className="mt-1 text-sm text-muted-foreground">{props.subtitle}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex shrink-0 items-center gap-2">{props.actions}</div>
      ) : null}
    </div>
  );
}

// ----- Navegación -----

/**
 * Item de navegación. Enchufa el `LinkComponent` del router en
 * `SidebarMenuButton` vía el prop `render` de Base UI (mismo mecanismo que
 * `DropdownMenuItem` en el footer). `onClick` llega tipado sin args pero
 * React lo invoca con el evento real, así que el reenvío es seguro en runtime.
 */
function NavItemButton({
  item,
  pathname,
  LinkComponent,
}: {
  item: AppShellNavItem;
  pathname: string;
  LinkComponent: AppShellProps["LinkComponent"];
}) {
  const { setOpenMobile } = useSidebar();
  const active = isNavItemActive(pathname, item.to);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.label}
        aria-current={active ? "page" : undefined}
        render={(props) => {
          const { onClick, children, ...rest } = props;
          return (
            <LinkComponent
              to={item.to}
              {...rest}
              onClick={() => {
                setOpenMobile(false);
                (onClick as unknown as (event?: unknown) => void)?.();
              }}
            >
              {children as React.ReactNode}
            </LinkComponent>
          );
        }}
      >
        <item.icon />
        <span>{item.label}</span>
        {item.external ? <ExternalLink className="ml-auto size-3 opacity-60" /> : null}
      </SidebarMenuButton>
      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  );
}

function NavGroup({
  group,
  pathname,
  LinkComponent,
}: {
  group: AppShellNavGroup;
  pathname: string;
  LinkComponent: AppShellProps["LinkComponent"];
}) {
  const [open, setOpen] = React.useState(group.defaultOpen ?? true);
  const Icon = group.icon;
  return (
    <SidebarGroup>
      <SidebarGroupLabel
        render={
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          />
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
  );
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
  items: AppShellNavEntry[];
  pathname: string;
  LinkComponent: AppShellProps["LinkComponent"];
}) {
  const runs: AppShellNavEntry[][] = [];
  for (const entry of items) {
    if (isGroup(entry)) {
      runs.push([entry]);
    } else {
      const last = runs[runs.length - 1];
      if (last && !isGroup(last[0]!)) last.push(entry);
      else runs.push([entry]);
    }
  }

  return (
    <SidebarContent>
      {runs.map((run, runIndex) => {
        const first = run[0]!;
        if (isGroup(first)) {
          return (
            <NavGroup
              key={`g-${first.label}-${runIndex}`}
              group={first}
              pathname={pathname}
              LinkComponent={LinkComponent}
            />
          );
        }
        return (
          <SidebarGroup key={`run-${runIndex}`}>
            <SidebarGroupContent>
              <SidebarMenu>
                {run.map((entry) => {
                  const item = entry as AppShellNavItem;
                  return (
                    <NavItemButton
                      key={item.to}
                      item={item}
                      pathname={pathname}
                      LinkComponent={LinkComponent}
                    />
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </SidebarContent>
  );
}

// ----- AppShell — layout estándar sobre Sidebar: el primitivo resuelve las
// tres variantes responsive (sidebar escritorio, rail solo-iconos al colapsar
// y drawer móvil vía Sheet). El header es por página (PageHeader).
// `searchSlot`/`topbarActions` siguen en la API pública sin renderizar, igual
// que antes de la migración. -----
export function AppShell(props: AppShellProps): React.JSX.Element {
  const { items, LinkComponent, pathname, user, userMenuItems, onSignOut, brand, sidebarFooter, fluid, children } =
    props;
  const initial = user.name?.trim().charAt(0).toUpperCase() || "U";

  const userMenuContent = (
    <>
      {userMenuItems?.map((item) => (
        <DropdownMenuItem
          key={item.label}
          render={(menuProps) => {
            const { onClick, ...rest } = menuProps;
            return (
              <LinkComponent
                to={item.to}
                search={item.search}
                {...rest}
                onClick={onClick as unknown as () => void}
              >
                {menuProps.children}
              </LinkComponent>
            );
          }}
        >
          <item.icon />
          {item.label}
        </DropdownMenuItem>
      ))}
      {userMenuItems?.length ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onClick={onSignOut}>
        <LogOut />
        Cerrar sesión
      </DropdownMenuItem>
    </>
  );

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <div className="flex min-w-0 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center">
              {brand}
            </div>
          </SidebarHeader>
          <SidebarNav items={items} pathname={pathname} LinkComponent={LinkComponent} />
          <SidebarFooter>
            {sidebarFooter}
            <DropdownMenu>
              <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar className="size-8">
                  {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={user.name} /> : null}
                  <AvatarFallback>{initial}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium text-sidebar-foreground">{user.name}</p>
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
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
            <SidebarTrigger aria-label="Abrir menú" className="size-9" />
            <div className="flex min-w-0 items-center gap-2">{brand}</div>
          </header>
          <div className="flex-1 overflow-auto p-4 md:p-6">
            <div className={fluid ? "w-full max-w-none" : "mx-auto max-w-[1280px]"}>{children}</div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
