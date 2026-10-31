/**
 * Esqueleto de la página de una persona: la misma cabecera y las mismas pestañas
 * de `routes/_org/people.$personId.tsx` y `components/patient/patient-header.tsx`,
 * con la sección abierta debajo. Quien lo usa pasa la navegación ya calculada
 * (`components/person/person-loading.tsx`): aquí no se piden datos ni permisos.
 */
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  cn,
  ScrollArea,
  Select,
  SelectTrigger,
  SelectValue,
  SidebarTrigger,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useIsMobile,
  useSidebarOptional,
} from "@odentia/ui"
import {
  HeaderCompactProvider,
  MOBILE_NAV_TRIGGER_CLASS,
  PageHeaderMenu,
  PageShell,
  SkeletonRegion,
  useHeaderUtilities,
} from "@odentia/ui-patterns"
import { MessageCircle, MoreHorizontal } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import type { personHeaderRules } from "../../lib/screen-rules"
import { Line } from "./person-parts"

export interface PersonSkeletonNav {
  /** Las pestañas que el rol ve y la abierta. `unsure`: depende de la persona, y va como hueco hasta saberlo. */
  areas: ReadonlyArray<{ id: string; label: string; target?: string; unsure?: boolean }>
  area: string
  /** Las secciones de la pestaña abierta (Clínica, Datos) y la elegida. */
  entries: ReadonlyArray<{ value: string; label: string; group?: string; unsure?: boolean }>
  current: string
  /** Sus secciones van en el menú lateral (Datos), no en una barra. */
  sideNav: boolean
  /** Lo que dice el selector «Sección» del teléfono. */
  mobileLabel: string
}

/** Una pestaña que depende de la persona, mientras no se sabe: el hueco, sin el nombre. */
function TabSlot() {
  return <Skeleton className="mx-1 h-7 w-20 shrink-0 self-center rounded-full" />
}

/**
 * El enlace de la miga a Pacientes y lo que el rol podrá hacer: los pone quien usa
 * el esqueleto. `unsure`: lo que se le ofrece depende también de la persona
 * (archivada no tiene Escribirle ni Reservar), así que van los huecos, sin nombre.
 */
export function PersonHeaderSkeleton({ crumb, actions, unsure = false }: { crumb?: ReactElement; actions: ReturnType<typeof personHeaderRules>; unsure?: boolean }) {
  const utilities = useHeaderUtilities()
  const sidebar = useSidebarOptional()
  const isMobile = useIsMobile()
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {sidebar ? <SidebarTrigger className={MOBILE_NAV_TRIGGER_CLASS} /> : null}
        <Breadcrumb className="min-w-0 flex-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={crumb}>Pacientes</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>
                <Skeleton className="h-4 w-32" />
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <HeaderCompactProvider value={isMobile}>
          <div className="ml-auto flex shrink-0 items-center gap-1 md:gap-2">
            {utilities?.utilities}
            <PageHeaderMenu />
          </div>
        </HeaderCompactProvider>
      </div>
      <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Skeleton className="size-20 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="my-0.5 h-6 w-48 max-w-full sm:h-7 sm:w-56" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Line className="w-64" />
            </div>
          </div>
          {unsure ? (
            <div className="flex flex-wrap items-center gap-2">
              {actions.message ? <Skeleton className="h-9 w-28 rounded-full" /> : null}
              {actions.book ? <Skeleton className="h-9 w-32 rounded-full" /> : null}
              {actions.primary === "charge" ? <Skeleton className="h-9 w-20 rounded-full" /> : null}
              {actions.encounter ? <Skeleton className="h-9 w-24 rounded-full" /> : null}
              {actions.edit ? <Skeleton className="size-9 rounded-full" /> : null}
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-2">
            {actions.message ? (
              <Button type="button" variant={actions.primary === "write" ? "default" : "outline"} disabled>
                <MessageCircle aria-hidden className="size-4" />
                Escribirle
              </Button>
            ) : null}
            {actions.book ? (
              <Button type="button" variant={actions.primary === "book" ? "default" : "outline"} disabled>
                Reservar cita
              </Button>
            ) : null}
            {actions.primary === "charge" ? (
              <Button type="button" disabled>
                Cobrar
              </Button>
            ) : null}
            {/* Dice «Atender», «Atender (10:00)» o «Continuar la atención»: depende de su cita. */}
            {actions.encounter ? <Skeleton className="h-9 w-24 rounded-full" /> : null}
            {actions.edit ? (
              <Button type="button" variant="outline" size="icon" aria-label="Más acciones" disabled>
                <MoreHorizontal aria-hidden />
              </Button>
            ) : null}
          </div>
          )}
        </div>
      </div>
    </header>
  )
}

function SideNavShape({ entries, current }: { entries: PersonSkeletonNav["entries"]; current: string }) {
  const groups: Array<{ title: string | null; items: Array<PersonSkeletonNav["entries"][number]> }> = []
  for (const entry of entries) {
    const title = entry.group ?? null
    const last = groups[groups.length - 1]
    if (last && last.title === title) last.items.push(entry)
    else groups.push({ title, items: [entry] })
  }
  return (
    <div className="hidden shrink-0 flex-col gap-0.5 sm:flex sm:w-44 lg:w-52">
      {groups.map((group) => (
        <div key={group.title ?? "secciones"} className="flex flex-col gap-0.5">
          {group.title && group.items.every((item) => item.unsure) ? (
            <Skeleton className="mt-3 mb-1 ml-3 h-4 w-32" />
          ) : group.title ? (
            <p className="mt-3 mb-1 px-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.title}</p>
          ) : null}
          {group.items.map((item) => item.unsure ? (
            <span key={item.value} className="flex min-h-9 items-center px-3 py-2">
              <Skeleton className="h-4 w-28 max-w-full" />
            </span>
          ) : (
            <span
              key={item.value}
              className={cn(
                "flex min-h-9 items-center rounded-lg px-3 py-2 text-left text-sm",
                item.value === current ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground",
              )}
            >
              {item.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/** La página entera, con el esqueleto de la sección abierta como `children`. */
export function PersonPageSkeleton({
  nav,
  crumb,
  actions,
  actionsUnsure,
  onOpen,
  children,
}: {
  nav: PersonSkeletonNav
  crumb?: ReactElement
  actions: ReturnType<typeof personHeaderRules>
  actionsUnsure?: boolean
  /** Las pestañas ya a la vista responden aunque sus datos no hayan llegado. */
  onOpen?: (section: string) => void
  children: ReactNode
}) {
  const body =
    nav.entries.length > 1 && nav.sideNav ? (
      <div className="flex min-w-0 flex-col gap-6 sm:flex-row sm:items-start">
        <SideNavShape entries={nav.entries} current={nav.current} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    ) : nav.entries.length > 1 ? (
      <Tabs className="min-w-0 w-full gap-4" value={nav.current} onValueChange={(value) => onOpen?.(String(value))}>
        <ScrollArea horizontal className="hidden sm:block max-w-full pb-1">
          <TabsList className="w-max flex-nowrap justify-start" aria-label="Secciones de la página">
            {nav.entries.map((item) =>
              item.unsure ? (
                <TabSlot key={item.value} />
              ) : (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ),
            )}
          </TabsList>
        </ScrollArea>
        <TabsContent value={nav.current}>{children}</TabsContent>
      </Tabs>
    ) : (
      children
    )
  return (
    <PageShell className="flex min-w-0 flex-col gap-6">
      <SkeletonRegion message="Cargando…" className="flex min-w-0 flex-col gap-6">
        <PersonHeaderSkeleton crumb={crumb} actions={actions} unsure={actionsUnsure} />
        <Tabs
          className="min-w-0 w-full"
          value={nav.area}
          onValueChange={(value) => {
            const target = nav.areas.find((area) => area.id === value)?.target
            if (target) onOpen?.(target)
          }}
        >
          <div className="sm:hidden">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Sección</span>
            <Select disabled items={{ [nav.current]: nav.mobileLabel }} value={nav.current}>
              <SelectTrigger aria-label="Sección" className="w-full">
                <SelectValue />
              </SelectTrigger>
            </Select>
          </div>
          <ScrollArea horizontal className="hidden sm:block max-w-full pb-1">
            <TabsList className="w-max flex-nowrap justify-start" aria-label="Pestañas de la página">
              {nav.areas.map((area) =>
                area.unsure ? (
                  <TabSlot key={area.id} />
                ) : (
                  <TabsTrigger key={area.id} value={area.id}>
                    {area.label}
                  </TabsTrigger>
                ),
              )}
            </TabsList>
          </ScrollArea>
          <TabsContent value={nav.area} className="pt-4">
            {body}
          </TabsContent>
        </Tabs>
      </SkeletonRegion>
    </PageShell>
  )
}
