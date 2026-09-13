import * as React from "react";
import {
 ChevronDown,
 ChevronUp,
 ExternalLink,
 LogOut,
 Menu,
 PanelLeft,
 Search,
 SlidersHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
 DropdownMenu,
 DropdownMenuContent,
 DropdownMenuItem,
 DropdownMenuTrigger,
 Separator,
 Sheet,
 SheetContent,
 SheetTrigger,
 cn,
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

export interface AppShellProps {
 items: AppShellNavEntry[];
 LinkComponent: React.ComponentType<{
 to: string;
 className?: string;
 children: React.ReactNode;
 title?: string;
 onClick?: () => void;
 }>;
 pathname: string;
 user: AppShellUser;
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
 return ((entry as AppShellNavGroup).children !== undefined &&
 Array.isArray((entry as AppShellNavGroup).children)
 );
}

// ----- PageHeader — header por página, no global -----
export function PageHeader(props: {
 title: string;
 subtitle?: string;
 actions?: React.ReactNode;
}): React.JSX.Element {
 return (<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
 <div className="min-w-0">
 <h1 className="text-xl font-semibold tracking-tight text-foreground">{props.title}</h1>
 {props.subtitle ? <p className="mt-1 text-sm text-muted-foreground">{props.subtitle}</p> : null}
 </div>
 {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
 </div>
 );
}

// ----- Helpers — estilos QwenCloud solo visual (DESIGN tokens), sin contenido dummy -----
function NavIcon({ Icon, className }: { Icon: LucideIcon; className?: string }) {
 return <Icon className={cn("size-4 shrink-0", className)} />;
}

function SidebarNavItem({
 item,
 pathname,
 LinkComponent,
 onNavigate,
}: {
 item: AppShellNavItem;
 pathname: string;
 LinkComponent: AppShellProps["LinkComponent"];
 onNavigate?: () => void;
}) {
 const active = isNavItemActive(pathname, item.to);
 const base = "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium leading-none";
 const activeCls = "bg-surface-muted text-foreground";
 const inactiveCls = "text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground";
 return (<LinkComponent
 to={item.to}
 className={cn(base, active ? activeCls : inactiveCls)}
 onClick={onNavigate}
 >
 <NavIcon Icon={item.icon} className="size-[15px] opacity-90" />
 <span className="flex-1 truncate">{item.label}</span>
 {item.badge ? (<span className="ml-auto rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
 {item.badge}
 </span>
 ) : null}
 {item.external ? <ExternalLink className="ml-auto size-3 opacity-60" /> : null}
 </LinkComponent>
 );
}

function RailNavItem({
 item,
 pathname,
 LinkComponent,
}: {
 item: AppShellNavItem;
 pathname: string;
 LinkComponent: AppShellProps["LinkComponent"];
}) {
 const active = isNavItemActive(pathname, item.to);
 const base = "relative flex size-9 items-center justify-center rounded-md";
 const activeCls = "bg-surface-muted text-foreground";
 const inactiveCls = "text-muted-foreground hover:bg-surface-muted hover:text-foreground";
 return (<LinkComponent to={item.to} title={item.label} className={cn(base, active ? activeCls : inactiveCls)}>
 <NavIcon Icon={item.icon} className="size-[18px]" />
 {item.badge ? (<span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent" aria-hidden />
 ) : null}
 </LinkComponent>
 );
}

function SidebarGroup({
 group,
 pathname,
 LinkComponent,
 onNavigate,
}: {
 group: AppShellNavGroup;
 pathname: string;
 LinkComponent: AppShellProps["LinkComponent"];
 onNavigate?: () => void;
}) {
 const [open, setOpen] = React.useState(group.defaultOpen ?? true);
 const Icon = group.icon;
 return (<div className="flex flex-col gap-0.5">
 <button
 type="button"
 onClick={() => setOpen((v) => !v)}
 className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-surface-muted/60 hover:text-foreground"
 >
 {Icon ? <NavIcon Icon={Icon} className="size-[15px]" /> : <span className="size-[15px] shrink-0" />}
 <span className="flex-1 truncate text-left">{group.label}</span>
 {open ? (<ChevronUp className="size-3.5 shrink-0 opacity-60" />
 ) : (<ChevronDown className="size-3.5 shrink-0 opacity-60" />
 )}
 </button>
 {open ? (<div className="flex flex-col gap-0.5 pl-2">
 {group.children.length === 0 ? null : (<>
 {group.children.map((child) => (<div key={child.to} className="ml-3 border-l border-border pl-2">
 <SidebarNavItem
 item={child}
 pathname={pathname}
 LinkComponent={LinkComponent}
 onNavigate={onNavigate}
 />
 </div>
 ))}
 </>
 )}
 </div>
 ) : null}
 </div>
 );
}

function RailGroup({
 group,
 pathname,
 LinkComponent,
}: {
 group: AppShellNavGroup;
 pathname: string;
 LinkComponent: AppShellProps["LinkComponent"];
}) {
 if (group.children.length === 0) return null;
 return (<>
 {group.children.map((child) => (<RailNavItem key={child.to} item={child} pathname={pathname} LinkComponent={LinkComponent} />
 ))}
 </>
 );
}

// ----- AppShell — sin header blanco global; header es por página (PageHeader). Usuario en footer -----
export function AppShell(props: AppShellProps): React.JSX.Element {
 const { items, LinkComponent, pathname, user, onSignOut, brand, sidebarFooter, fluid, children } =
   props;
 const [mobileOpen, setMobileOpen] = React.useState(false);

 const hasItems = items.length > 0;

 const sidebarNav = hasItems ? (<nav className="flex flex-1 flex-col gap-0.5">
 {items.map((entry, idx) => {
 if (isGroup(entry)) {
 return (<SidebarGroup
 key={`g-${entry.label}-${idx}`}
 group={entry}
 pathname={pathname}
 LinkComponent={LinkComponent}
 onNavigate={() => setMobileOpen(false)}
 />
 );
 }
 return (<SidebarNavItem
 key={entry.to}
 item={entry}
 pathname={pathname}
 LinkComponent={LinkComponent}
 onNavigate={() => setMobileOpen(false)}
 />
 );
 })}
 </nav>
 ) : null;

 const railNav = hasItems ? (<nav className="flex flex-1 flex-col items-center gap-1">
 {items.map((entry, idx) => {
 if (isGroup(entry)) {
 return (<RailGroup
 key={`rg-${entry.label}-${idx}`}
 group={entry}
 pathname={pathname}
 LinkComponent={LinkComponent}
 />
 );
 }
 return <RailNavItem key={entry.to} item={entry} pathname={pathname} LinkComponent={LinkComponent} />;
 })}
 </nav>
 ) : null;

 const drawerNav = hasItems ? (<nav className="flex flex-col gap-0.5">
 {items.map((entry, idx) => {
 if (isGroup(entry)) {
 return (<SidebarGroup
 key={`dg-${entry.label}-${idx}`}
 group={entry}
 pathname={pathname}
 LinkComponent={LinkComponent}
 onNavigate={() => setMobileOpen(false)}
 />
 );
 }
 return (<SidebarNavItem
 key={entry.to}
 item={entry}
 pathname={pathname}
 LinkComponent={LinkComponent}
 onNavigate={() => setMobileOpen(false)}
 />
 );
 })}
 </nav>
 ) : null;

 const initial = user.name?.trim().charAt(0).toUpperCase() || "U";

 const userAvatar = user.avatarUrl ? (<img src={user.avatarUrl} alt={user.name} className="size-8 rounded-full object-cover" />
 ) : (<div className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
 {initial}
 </div>
 );

 const userRowContent = (<>
 {userAvatar}
 <div className="min-w-0 flex-1 text-left">
 <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
 {user.email ? <p className="truncate text-xs text-muted-foreground">{user.email}</p> : null}
 </div>
 </>
 );

 return (<div className="flex min-h-screen bg-background text-foreground">
 {/* Sidebar — estilo limpio imagen referencia */}
 <aside className="hidden w-[260px] shrink-0 flex-col border-r border-border bg-sidebar px-3 py-3 xl:flex">
 <div className="mb-3 flex items-center justify-between px-1">
 <div className="flex items-center gap-2">{brand}</div>
 <div className="flex items-center gap-1">
 <button
 type="button"
 className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground"
 aria-label="Toggle sidebar"
 >
 <PanelLeft className="size-4" />
 </button>
 <button
 type="button"
 className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground"
 aria-label="Buscar"
 >
 <Search className="size-4" />
 </button>
 </div>
 </div>
 <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">{sidebarNav}</div>
 {sidebarFooter ? (<>
 <Separator className="my-3" />
 <div>{sidebarFooter}</div>
 </>
 ) : null}
 {/* Footer — usuario per conocimiento, estilo imagen: Upgrade + usuario con Dropdown */}
 <div className="mt-auto pt-3">
 <Separator className="mb-3" />
 <div className="mb-2 flex items-center justify-center rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted">
 <span className="inline-flex items-center gap-1.5">
 <SlidersHorizontal className="size-3.5" />
 Upgrade to Pro
 </span>
 </div>
 <DropdownMenu>
 <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-muted motion-safe:hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft">
 {userRowContent}
 </DropdownMenuTrigger>
 <DropdownMenuContent align="end" side="top" className="w-56">
 <DropdownMenuItem onClick={onSignOut}>
 <LogOut />
 Cerrar sesión
 </DropdownMenuItem>
 </DropdownMenuContent>
 </DropdownMenu>
 </div>
 </aside>

 {/* Rail 64px — tablet */}
 <aside className="hidden w-16 shrink-0 flex-col items-center border-r border-border bg-sidebar py-3 md:flex xl:hidden">
 <div className="mb-4 flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
 {initial}
 </div>
 {railNav}
 <div className="mt-auto flex flex-col items-center gap-2">
 <Separator className="my-2 w-8" />
 <DropdownMenu>
 <DropdownMenuTrigger className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft motion-safe:hover:opacity-80">
 {initial}
 </DropdownMenuTrigger>
 <DropdownMenuContent align="end" side="right" className="w-48">
 <DropdownMenuItem onClick={onSignOut}>
 <LogOut />
 Cerrar sesión
 </DropdownMenuItem>
 </DropdownMenuContent>
 </DropdownMenu>
 </div>
 </aside>

 {/* Main — sin header blanco global */}
 <div className="flex min-w-0 flex-1 flex-col">
 {/* Solo trigger móvil, sin header blanco */}
 <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:hidden">
 <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
 <SheetTrigger
 className="inline-flex size-9 items-center justify-center rounded-md hover:bg-surface-muted"
 aria-label="Abrir menú"
 >
 <Menu className="size-5" />
 </SheetTrigger>
 <SheetContent side="left" className="w-[280px] bg-sidebar p-3">
 <div className="mb-4 flex items-center gap-2 px-1">
 <div className="flex min-w-0 items-center gap-2">{brand}</div>
 </div>
 {drawerNav}
 {sidebarFooter ? (<>
 <Separator className="my-3" />
 <div>{sidebarFooter}</div>
 </>
 ) : null}
 <div className="mt-auto pt-3">
 <Separator className="mb-3" />
 <DropdownMenu>
 <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-muted motion-safe:hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft">
 {userAvatar}
 <div className="min-w-0 flex-1">
 <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
 {user.email ? (<p className="truncate text-xs text-muted-foreground">{user.email}</p>
 ) : null}
 </div>
 </DropdownMenuTrigger>
 <DropdownMenuContent align="end" side="top" className="w-56">
 <DropdownMenuItem onClick={onSignOut}>
 <LogOut />
 Cerrar sesión
 </DropdownMenuItem>
 </DropdownMenuContent>
 </DropdownMenu>
 </div>
 </SheetContent>
 </Sheet>
 <div className="flex items-center gap-2">{brand}</div>
 </div>

 <main className="flex-1 overflow-auto bg-background p-4 md:p-6">
   <div className={fluid ? "w-full max-w-none" : "mx-auto max-w-[1280px]"}>{children}</div>
 </main>
 </div>
 </div>
 );
}
