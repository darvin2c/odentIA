/**
 * Los esqueletos de las pantallas del agente: las mismas tarjetas, rejillas y
 * clases responsive de cada pantalla, con lo fijo escrito y barras solo en lo
 * que depende de los datos. `XSkeleton` es la zona de datos, la que usa la
 * pantalla mientras consulta; `XPageSkeleton` añade el marco para el
 * `pendingComponent` de su ruta.
 *
 * Los títulos con nombre de agente se escriben aquí para no traer sus módulos
 * (consultas) con el arranque de la app; las pestañas y lo que el rol ve salen
 * de `lib/screen-rules`. Mientras carga, recepción se llama como en la pantalla
 * real: Sofi.
 */
import { Link } from "@tanstack/react-router"
import { Button, cn, ScrollArea, Skeleton, tabsListVariants, tabsTriggerClassName } from "@odentia/ui"
import { AgentMark, AgentSurface, DataTableSkeleton, SideColumn, SideDockPortal, useDetailMode, useSideColumnWidth, useSideDock } from "@odentia/ui-patterns"
import { ArrowRight, ChevronDown, ChevronRight, Lock } from "lucide-react"
import type { ReactNode } from "react"
import { useCan, usePermission } from "../../lib/crm"
import { agentTabsFor, canCorrectAgent, RECEPTION_TEST_COLUMN } from "../../lib/screen-rules"
import { PageLoading } from "./page-loading"

/** Una línea de `text-sm`: la barra más su aire mide lo mismo que el renglón. */
function Line({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-4", className)} />
}

/** Una línea de texto base (24 px de renglón). */
function BaseLine({ className }: { className?: string }) {
  return <Skeleton className={cn("my-1 h-4", className)} />
}

function slots(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

/** La fila de contexto de `PageHeader`, que el marco de carga no pinta. */
function Subtitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <p className="min-w-0">{children}</p>
    </div>
  )
}

/** Las pestañas de la sección, inertes hasta que llega la pantalla: las mismas de `AgentTabs` para ese rol. */
function TabsLoading({ active }: { active: ReturnType<typeof agentTabsFor>[number]["key"] }) {
  const tabs = agentTabsFor(useCan())
  if (tabs.length === 0) return null
  return (
    <ScrollArea horizontal className="-mt-2 min-w-0">
      <nav aria-label="Secciones del agente" className={cn(tabsListVariants(), "h-11 max-w-full justify-start")}>
        {tabs.map((tab) => (
          // Responden aunque la pantalla no haya llegado: un control a la vista nunca es un control muerto.
          <Link
            key={tab.key}
            to={tab.to}
            data-active={tab.key === active ? "" : undefined}
            aria-current={tab.key === active ? "page" : undefined}
            className={cn(tabsTriggerClassName, "shrink-0 min-h-11 sm:min-h-9")}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </ScrollArea>
  )
}

/** El enlace de vuelta, con las clases del real. */
function BackLink() {
  return <span className="-mt-3 inline-flex min-h-11 w-fit items-center text-sm font-semibold text-primary sm:min-h-8">Volver al resumen del agente</span>
}

// ---------------------------------------------------------------------------
// Agente: resumen
// ---------------------------------------------------------------------------

const NEED_TILES = ["Respuestas por revisar", "Lecciones por aprobar"]

export function AgentOverviewSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-6">
      <AgentSurface className="flex flex-col gap-2 p-3 sm:gap-3.5 sm:p-5">
        <div className="flex items-center gap-3">
          <AgentMark className="max-sm:hidden" />
          <div>
            <h2 className="font-heading text-base font-bold sm:text-lg">Necesita de ti</h2>
            <p className="text-sm text-muted-foreground max-sm:hidden">Lo que solo una persona puede decidir.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          {NEED_TILES.map((title) => (
            <div key={title} className="flex min-h-11 flex-col rounded-xl border bg-card px-3 py-2.5 sm:gap-0.5 sm:p-4">
              <Skeleton className="my-1 h-6 w-8 sm:h-7" />
              <span className="text-sm font-semibold sm:text-base sm:font-bold">{title}</span>
              <Line className="w-4/5 max-sm:hidden" />
            </div>
          ))}
        </div>
      </AgentSurface>

      <section className="elevated flex flex-col rounded-xl border bg-card">
        <h2 className="px-4 pt-3 font-heading text-base font-bold sm:px-6 sm:pt-5 sm:text-lg">Tus agentes</h2>
        <div className="mx-4 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-muted/60 px-3.5 py-2 sm:mx-6 sm:mt-3 sm:py-3">
          <div className="min-w-0 flex-1 basis-36 sm:basis-48">
            <p className="font-bold">La base que comparten los tres</p>
            <p className="text-sm text-muted-foreground max-sm:hidden">
              Quién es, cómo decide y la voz de tu clínica. Lo demás es de cada agente y no se mezcla.
            </p>
          </div>
          <span className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary sm:min-h-9">
            Ver la base <ArrowRight className="size-4" aria-hidden />
          </span>
        </div>
        <ul className="flex flex-col divide-y sm:mt-1">
          {slots(3).map((row) => (
            <li key={row} className="px-4 sm:px-6">
              <div className="flex min-h-13 items-center gap-2.5 sm:hidden">
                <span className="flex min-w-0 flex-1 flex-col">
                  <BaseLine className="w-24" />
                  <Line className="w-32" />
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </div>
              <div className="flex flex-wrap items-center gap-3 py-4 max-sm:hidden">
                <Skeleton className="size-10 shrink-0 rounded-xl" />
                <div className="min-w-0 flex-1 basis-56">
                  <BaseLine className="w-40" />
                  <Line className="w-3/4" />
                </div>
                <Skeleton className="h-9 w-24 rounded-md" />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="elevated flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:p-6">
        <div className="min-w-0">
          <h2 className="font-heading text-base font-bold sm:text-lg">Horario de recontacto</h2>
          <Line className="w-full" />
          <Line className="w-4/5" />
        </div>
        <div className="flex flex-col gap-1">
          {slots(3).map((row) => (
            <Line key={row} className="w-56 max-w-full" />
          ))}
        </div>
        <Line className="w-full" />
        <Line className="w-3/5" />
      </section>

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <section className="elevated flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 sm:gap-3 sm:p-6">
          <div>
            <h2 className="font-heading text-base font-bold sm:text-lg">
              <span className="sm:hidden">Esta semana</span>
              <span className="max-sm:hidden">Cómo le fue esta semana</span>
            </h2>
            <Line className="w-3/5" />
          </div>
          <Skeleton className="h-3 w-full rounded-full sm:h-3.5" />
          <div className="flex flex-col gap-1 sm:gap-1.5">
            {slots(3).map((row) => (
              <Line key={row} className="w-full" />
            ))}
          </div>
        </section>
        <section className="elevated flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:p-6">
          <div>
            <h2 className="font-heading text-base font-bold sm:text-lg">Lo que aprendió esta semana</h2>
            <Line className="w-3/5" />
          </div>
          <span className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm font-semibold text-primary sm:min-h-8">
            Ver todo lo aprendido <ArrowRight className="size-4" aria-hidden />
          </span>
        </section>
      </div>

      <span className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-muted-foreground underline sm:min-h-8">
        Registro técnico: ejecuciones, costo y proveedor del modelo
      </span>
    </div>
  )
}

export function AgentOverviewPageSkeleton() {
  return (
    <PageLoading title="Agente" className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">
        <Subtitle>Cómo va y qué necesita de ti.</Subtitle>
        <TabsLoading active="resumen" />
        <AgentOverviewSkeleton />
      </div>
    </PageLoading>
  )
}

// ---------------------------------------------------------------------------
// Sofi: recepción
// ---------------------------------------------------------------------------

/** La tarjeta de recepción: en el teléfono, con `phone`, se resume en una fila. */
function ReceptionCard({ title, hint, phone = false, children }: { title: ReactNode; hint: ReactNode; phone?: boolean; children: ReactNode }) {
  return (
    <section className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 max-sm:gap-3 sm:p-6">
      {phone ? (
        <div className="flex min-h-11 w-full items-center gap-3 sm:hidden">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-heading text-base font-semibold text-foreground">{title}</span>
            <Line className="w-4/5" />
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      ) : null}
      <div className={phone ? "max-sm:hidden" : undefined}>
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        <div className="text-sm text-muted-foreground max-sm:hidden">{hint}</div>
      </div>
      <div className={cn("flex min-w-0 flex-col gap-4", phone && "max-sm:hidden")}>{children}</div>
    </section>
  )
}

const ENTRY_ROW = "flex min-h-13 w-full items-center gap-3 px-4 py-2 text-left text-sm"

function ReceptionEntry({ label }: { label: string }) {
  return (
    <li>
      <div className={ENTRY_ROW}>
        <span className="min-w-0 flex-[1_1_9rem] font-semibold">{label}</span>
        <span className="min-w-0 flex-[1_1_9rem]">
          <Line className="w-3/4" />
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
    </li>
  )
}

/** «Probar» va en la columna lateral cuando cabe; si no, es un botón. */
function useReceptionTestDocked(): boolean {
  const dock = useSideDock()
  return useDetailMode() === "panel" && dock.available
}

export function ReceptionSkeleton() {
  const canWrite = usePermission("agent.write")
  const docked = useReceptionTestDocked()
  return (
    <div aria-hidden className="flex flex-col gap-6">
      {/* La fila de contexto: camino de vuelta, porqué del nombre e interruptor. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <Line className="w-24" />
        <Line className="w-96 max-w-full max-sm:hidden" />
        <Line className="w-44 sm:hidden" />
        {canWrite ? (
          <span className="flex min-h-11 items-center gap-2 sm:min-h-8">
            <Line className="w-16 max-sm:hidden" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </span>
        ) : (
          <Skeleton className="h-5 w-16 rounded-full max-sm:hidden" />
        )}
      </div>

      <section className="elevated flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm max-sm:hidden sm:px-6">
        <h2 className="font-heading text-base font-semibold">Hoy</h2>
        <BaseLine className="w-44" />
        <BaseLine className="w-36" />
        <BaseLine className="w-40" />
        <span className="ml-auto inline-flex min-h-8 items-center gap-1 font-medium text-primary">
          Ver qué hizo <ArrowRight className="size-4" aria-hidden />
        </span>
        {canWrite && !docked ? (
          <Button type="button" size="sm" className="min-h-8" disabled>
            Probar
          </Button>
        ) : null}
      </section>

      <div className="flex min-w-0 flex-col gap-6 max-sm:gap-4">
        <ReceptionCard title="Qué hace" hint="Sus funciones. Apaga la que no quieras que haga: pierde esa capacidad, no solo la instrucción.">
          <ul className="flex flex-col divide-y">
            {slots(5).map((row) => (
              <li key={row} className="py-3 first:pt-0 last:pb-0 max-sm:py-1.5">
                <div className="flex items-start gap-3 max-sm:items-center">
                  <div className="min-w-0 flex-1">
                    <BaseLine className="w-48 max-w-full" />
                    <Line className="w-4/5 max-sm:hidden" />
                    <span className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary sm:min-h-8">
                      Ver cómo trabaja <ChevronDown className="size-4" aria-hidden />
                    </span>
                  </div>
                  <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground max-sm:hidden">
            Los pasos son los mismos que usa tu equipo. Tú eliges qué funciones tiene; antes de una cita siempre confirma el paciente.
          </p>
        </ReceptionCard>

        <ReceptionCard title="Límites" hint="Siempre responde al momento. Aquí decides cuándo pasa el caso a una persona y cuánto puede hacer al día.">
          <div className="overflow-hidden rounded-xl border sm:hidden">
            <div className={ENTRY_ROW}>
              <span className="min-w-0 flex-[1_1_9rem] font-semibold">Límites y cuándo pasa a una persona</span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </div>
          </div>
          <div className="flex flex-col gap-4 max-sm:hidden">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Pasa a una persona cuando</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-7 w-44 rounded-full" />
                <Skeleton className="h-7 w-48 rounded-full" />
                <Skeleton className="h-7 w-36 rounded-full" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Límites que aplica el sistema</h3>
              <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
                <ReceptionEntry label="Cerrar la conversación" />
              </ul>
            </div>
            <div className="flex items-start gap-3 rounded-xl bg-muted/60 p-4 text-sm">
              <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">Nunca, y no se puede cambiar</p>
                <Line className="w-4/5" />
              </div>
            </div>
          </div>
        </ReceptionCard>

        <ReceptionCard title="Qué sabe" hint="Lee tus datos en el momento y lo que le enseñaste. Si algo no está, lo dice y pasa a una persona." phone>
          <ul className="flex flex-col divide-y overflow-hidden rounded-xl border">
            <ReceptionEntry label="Respuestas oficiales" />
            <ReceptionEntry label="Servicios y precios" />
            <ReceptionEntry label="Horario y sedes" />
            <ReceptionEntry label="Lo que aprendió de tus correcciones" />
          </ul>
          <div className="flex flex-col gap-1 rounded-xl bg-muted/60 p-4 text-sm">
            <h3 className="font-semibold">Lo que recuerda de cada persona</h3>
            <p className="text-muted-foreground">
              Pocos datos prácticos, cada uno con su origen, a la vista en la ficha de cada contacto. Los puedes corregir o quitar. Nunca guarda
              información clínica.
            </p>
          </div>
        </ReceptionCard>

        <ReceptionCard title="Cómo se comporta" hint={<Line className="w-3/5" />} phone>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4">
            <div className="min-w-0 flex-1 basis-48 text-sm">
              <p className="font-semibold">Usa la base de tu clínica</p>
              <Line className="w-4/5" />
              <p className="text-muted-foreground">La comparten todos tus agentes.</p>
            </div>
            <Skeleton className="h-11 w-32 rounded-md sm:h-8" />
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-agent-border bg-agent-soft p-4">
            <span className="text-xs font-semibold text-primary-soft-foreground">Así sonaría</span>
            <Line className="w-full" />
          </div>
        </ReceptionCard>

        <section className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <BaseLine className="w-52 max-w-full" />
              <p className="text-sm text-muted-foreground">
                Lo que le pide la clínica y lo que aprendió de sus correcciones, en una sola lista. Los datos concretos (precios, horarios) van en
                Conocimiento.
              </p>
            </div>
            {canWrite ? <Skeleton className="h-11 w-28 rounded-md sm:h-9" /> : null}
          </div>
          <Skeleton className="h-11 w-72 max-w-full rounded-lg sm:h-9" />
          <ul className="flex flex-col divide-y rounded-xl border">
            {slots(3).map((row) => (
              <li key={row} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
                <BaseLine className="w-3/4" />
                <Line className="w-1/2" />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

/** La columna de «Probar», con su ancho guardado: la página no salta cuando llega el chat. */
function ReceptionTestColumnLoading() {
  const [width, resize] = useSideColumnWidth("odentia.side-panel.probar", RECEPTION_TEST_COLUMN)
  return (
    <SideColumn
      aria-labelledby="probar-cargando"
      width={width}
      onResize={resize}
      bounds={RECEPTION_TEST_COLUMN}
      pageMinWidth={512}
      resizeLabel="Cambiar el ancho de Probar"
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex shrink-0 flex-col bg-primary py-3 pr-2 pl-5 text-primary-foreground">
          <h2 id="probar-cargando" className="font-heading text-base font-semibold">
            Probar
          </h2>
          <p className="text-sm opacity-90">Escribe como un paciente</p>
        </header>
        <div className="mt-auto p-3">
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      </div>
    </SideColumn>
  )
}

export function ReceptionPageSkeleton() {
  const canWrite = usePermission("agent.write")
  const docked = useReceptionTestDocked()
  return (
    <PageLoading
      title="Sofi, tu agente de recepción"
      className={cn("flex flex-col gap-6", canWrite && "max-sm:pb-24")}
      footer={
        canWrite ? (
          <>
            <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-canvas px-4 py-3 sm:hidden">
              <Button type="button" className="h-12 w-full" disabled>
                Probar
              </Button>
            </div>
            {docked ? (
              <SideDockPortal fallback={null}>
                <ReceptionTestColumnLoading />
              </SideDockPortal>
            ) : null}
          </>
        ) : null
      }
    >
      <ReceptionSkeleton />
    </PageLoading>
  )
}

// ---------------------------------------------------------------------------
// Fichas de los agentes: Argos y Clío
// ---------------------------------------------------------------------------

const ROLE_CARD = "elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6"

function RoleCard({ title, hint, children }: { title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <section className={ROLE_CARD}>
      <div>
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        {typeof hint === "string" ? <p className="text-sm text-muted-foreground">{hint}</p> : hint}
      </div>
      {children}
    </section>
  )
}

/** Dos datos del rol uno al lado del otro; en el teléfono, uno debajo del otro. */
function RoleFacts({ left, right }: { left: string; right: string }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {[left, right].map((label) => (
        <div key={label}>
          <dt className="font-semibold">{label}</dt>
          <dd>
            <Line className="w-full" />
            <Line className="w-3/5" />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RoleBehaves({ label }: { label: string }) {
  return (
    <>
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-semibold">La base</p>
        {slots(3).map((row) => (
          <Line key={row} className="w-4/5" />
        ))}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-semibold">{label}</p>
        <Line className="w-full" />
      </div>
    </>
  )
}

/** La línea con lo que hace el agente, debajo del enlace de vuelta. */
function RoleLine() {
  return <Line className="-mt-2 w-[32rem] max-w-full" />
}

export function AdministratorSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-6">
      <RoleLine />
      <section className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl bg-muted p-4 text-sm">
        <span className="font-semibold">Hoy</span>
        <Line className="w-40" />
        <Line className="w-36" />
        <Line className="w-48" />
      </section>
      {[
        { title: "Prendidas", rows: 3 },
        { title: "Listas para activar", rows: 4 },
      ].map((block) => (
        <section key={block.title} className="flex min-w-0 flex-col gap-3">
          <div>
            <h2 className="font-heading text-base font-semibold">{block.title}</h2>
            <Line className="w-4/5" />
          </div>
          <ul className="elevated flex flex-col divide-y rounded-xl border bg-card">
            {slots(block.rows).map((row) => (
              <li key={row} className="flex flex-col">
                <div className="flex items-start gap-3 p-4">
                  <ChevronDown aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <BaseLine className="w-56 max-w-full" />
                    <Line className="w-4/5" />
                  </span>
                  <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-4 text-sm">
        <div className="min-w-0 flex-1 basis-64">
          <Line className="w-full" />
          <Line className="w-2/3" />
        </div>
        <span className="inline-flex min-h-11 items-center font-semibold text-primary sm:min-h-8">Ver o cambiar</span>
      </section>
      <RoleCard title="Hasta dónde llega solo" hint="Solo hace lo que una persona prendió.">
        <RoleFacts left="Quién decide" right="Nunca" />
      </RoleCard>
      <RoleCard title="Qué sabe" hint="De dónde salen sus números, y lo que no lee.">
        <RoleFacts left="Puede ver" right="No ve" />
        <p className="text-sm text-muted-foreground">
          Cada persona ve solo lo de aquello que su rol ya puede ver: caja no ve atenciones y recepción no ve cobranza.
        </p>
      </RoleCard>
      <RoleCard title="Cómo se comporta" hint="Primero la base que comparten todos los agentes; después cómo trabaja él.">
        <RoleBehaves label="Al trabajar" />
      </RoleCard>
      <RoleCard title="Cómo se prueba" hint={<Line className="w-3/5" />}>
        <p className="text-sm text-muted-foreground">
          Cada línea apagada dice cuántos casos tendría hoy, y al abrirla se ve su flujo entero antes de prenderla.
        </p>
      </RoleCard>
      <RoleCard title="Qué aprende, y de quién es" hint="Lo que cambia con el uso, y a quién le pertenece.">
        <RoleFacts left="Qué aprende" right="De quién es" />
      </RoleCard>
    </div>
  )
}

export function AdministratorPageSkeleton() {
  return (
    <PageLoading title="Argos, tu agente administrador" className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">
        <Subtitle>El gigante de los cien ojos: ve toda la clínica y no deja a ningún paciente atrás.</Subtitle>
        <BackLink />
        <AdministratorSkeleton />
      </div>
    </PageLoading>
  )
}

export function ClinicalAssistantSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-6">
      <RoleLine />
      <RoleCard title="Qué hace" hint={<Line className="w-4/5" />}>
        <ul className="flex flex-col divide-y">
          {slots(3).map((row) => (
            <li key={row} className="py-3 first:pt-0 last:pb-0">
              <BaseLine className="w-48 max-w-full" />
              <Line className="w-4/5" />
            </li>
          ))}
        </ul>
      </RoleCard>
      <RoleCard title="Hasta dónde llega solo" hint="Nunca guarda: siempre sugiere. No tiene niveles.">
        <RoleFacts left="Quién confirma" right="Nunca" />
      </RoleCard>
      <RoleCard title="Qué sabe" hint="Lo que recibe para ordenar un dictado, y lo que no.">
        <RoleFacts left="Puede ver" right="No ve" />
        <p className="text-sm text-muted-foreground">
          Lo dictado se envía al proveedor del modelo configurado para ordenarlo. El dictado completo no se guarda: de cada sugerencia queda solo
          la frase que la originó.
        </p>
      </RoleCard>
      <RoleCard title="Cómo se comporta" hint="Primero la base que comparten todos los agentes; después cómo ordena un dictado.">
        <RoleBehaves label="Al ordenar un dictado" />
      </RoleCard>
      <RoleCard title="Cómo se prueba" hint={<Line className="w-3/5" />}>
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-11 w-40 rounded-md sm:h-9" />
      </RoleCard>
      <RoleCard title="Qué aprende, y de quién es" hint="Lo que cambia con el uso, y a quién le pertenece.">
        <RoleFacts left="Qué aprende" right="De quién es" />
      </RoleCard>
    </div>
  )
}

export function ClinicalAssistantPageSkeleton() {
  return (
    <PageLoading title="Clío, tu agente clínico" className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">
        {/* El porqué del nombre nombra a quien atiende, y eso lo decide el producto. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Line className="w-96 max-w-full" />
        </div>
        <BackLink />
        <ClinicalAssistantSkeleton />
      </div>
    </PageLoading>
  )
}

// ---------------------------------------------------------------------------
// Aprender
// ---------------------------------------------------------------------------

/**
 * Una sección que en la pantalla real se pliega en el teléfono: la decide
 * `useIsMobile` (768 px), aquí el mismo corte con `md`.
 */
function LearnFoldSection({ title, hint, phoneHint, agent = false, children }: { title: string; hint: string; phoneHint: string; agent?: boolean; children: ReactNode }) {
  return (
    <>
      <section className="min-w-0 md:hidden">
        <div className={cn("relative flex min-h-16 items-center gap-2.5 rounded-xl border px-3.5 py-2.5", agent ? "border-agent-border bg-agent-soft" : "bg-card")}>
          <div className="min-w-0 flex-1">
            <h2 className="font-heading text-base font-bold">{title}</h2>
            <p className="text-sm text-muted-foreground">{phoneHint}</p>
          </div>
          <ChevronRight className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      </section>
      <section className="hidden min-w-0 flex-col gap-2.5 md:flex">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="font-heading text-base font-bold">{title}</h2>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {children}
      </section>
    </>
  )
}

export function LearnSkeleton() {
  const canCorrect = canCorrectAgent(useCan())
  return (
    <div aria-hidden className="flex flex-col gap-5">
      <section className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="font-heading text-base font-bold">Por revisar</h2>
          <p className="text-sm text-muted-foreground">Las que algo hizo dudar y una muestra al azar.</p>
        </div>
        <ul className="flex flex-col gap-2.5">
          {slots(3).map((row) => (
            <li key={row} className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-sm">
              <div className="flex items-start gap-2 pt-2.5 md:hidden">
                <Skeleton className="h-5.5 w-44 rounded-full" />
              </div>
              <div className="flex flex-col gap-1 md:hidden">
                <Line className="w-4/5" />
                <Line className="w-full" />
              </div>
              <div className="hidden flex-wrap items-center gap-2 md:flex">
                <Skeleton className="h-5.5 w-28 rounded-full" />
                <Line className="w-56" />
              </div>
              <div className="hidden gap-1.5 md:grid">
                <div className="flex gap-2.5">
                  <span className="w-18 shrink-0 text-muted-foreground">Escribió</span>
                  <Line className="min-w-0 flex-1" />
                </div>
                <div className="flex gap-2.5">
                  <span className="w-18 shrink-0 text-muted-foreground">Respondió</span>
                  <Line className="min-w-0 flex-1" />
                </div>
              </div>
              {canCorrect ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Skeleton className="h-11 flex-1 rounded-md sm:h-9 sm:w-28 sm:flex-none" />
                  <Skeleton className="h-11 flex-1 rounded-md sm:h-9 sm:w-24 sm:flex-none" />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <LearnFoldSection
        title="Lecciones por aprobar"
        hint="Lo que propone aprender. Nada cambia hasta que apruebes."
        phoneHint="Nada cambia hasta que apruebes."
        agent
      >
        <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-3">
          {slots(2).map((card) => (
            <li key={card} className="min-w-0">
              <AgentSurface className="flex h-full flex-col items-start gap-2 p-4 text-sm">
                <Skeleton className="h-5.5 w-20 rounded-full" />
                <BaseLine className="w-3/4" />
                <Line className="w-full" />
                <Skeleton className="h-11 w-32 rounded-md sm:h-9" />
              </AgentSurface>
            </li>
          ))}
        </ul>
      </LearnFoldSection>

      <LearnFoldSection
        title="Lo aprendido"
        hint="Cada una dice cuánto se usa. Cualquiera se puede retirar."
        phoneHint="Cualquiera se puede retirar."
      >
        <div className="elevated flex flex-col rounded-xl border bg-card">
          <ul className="flex flex-col">
            {slots(4).map((row) => (
              <li key={row} className="flex min-h-13 flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-4 py-2 first:border-t-0 sm:px-5">
                <Skeleton className="h-3.5 w-full sm:w-32 sm:shrink-0" />
                <BaseLine className="min-w-0 flex-1 basis-56" />
                <Skeleton className="h-5.5 w-24 rounded-full" />
                <Line className="sm:w-32 sm:shrink-0" />
                <Skeleton className="ml-auto h-8 w-20 rounded-md" />
              </li>
            ))}
          </ul>
        </div>
      </LearnFoldSection>
    </div>
  )
}

export function LearnPageSkeleton() {
  return (
    <PageLoading title="Agente" className="flex flex-col gap-5">
      <div className="flex flex-col gap-5">
        {/* Dice el nombre de recepción de la clínica: se pinta con él al llegar. */}
        <Line className="w-[36rem] max-w-full" />
        <TabsLoading active="aprender" />
        <LearnSkeleton />
      </div>
    </PageLoading>
  )
}

// ---------------------------------------------------------------------------
// Conocimiento
// ---------------------------------------------------------------------------

/** Las filas de «Respuestas oficiales»: una fila en el teléfono, la rejilla de cuatro desde `sm`. */
export function KnowledgeAnswerRowsSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {slots(5).map((row) => (
        <li key={row} className="border-t">
          <div className="flex min-h-14 w-full items-center justify-start gap-x-4 px-4 py-2 sm:grid sm:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_9.5rem] sm:px-5">
            <span className="flex min-w-0 flex-1 flex-col">
              <BaseLine className="w-3/4" />
              <Line className="w-1/2" />
            </span>
            <span className="hidden min-w-0 sm:block">
              <Line className="w-3/4" />
            </span>
            <span className="hidden min-w-0 sm:block">
              <Line className="w-3/5" />
            </span>
            <span className="hidden justify-end sm:flex">
              <Skeleton className="h-5.5 w-20 rounded-full" />
            </span>
            <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground sm:hidden" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** «Lo que solo tú sabes»: la cifra, solo desde `sm`, la barra y las ocho etiquetas. */
export function KnowledgeBasicsSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Skeleton className="my-1 hidden h-6 w-48 sm:block" />
        <Skeleton className="h-2 w-full rounded-full sm:h-2.5" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {slots(8).map((row) => (
          <Skeleton key={row} className="h-7 w-28 rounded-full" />
        ))}
      </div>
    </div>
  )
}

/** Las filas de «Lo que toma de tus datos», con su título y dónde se edita: lo que dice cada una llega con los datos. */
const KNOWLEDGE_SOURCE_ROWS = [
  { title: "Horario de atención", action: "Horarios y ausencias" },
  { title: "Feriados y cierres", action: "Horarios y ausencias" },
  { title: "Sedes", action: "Sedes" },
  { title: "Equipo", action: "Equipo" },
  { title: "Servicios y precios", action: "Servicios" },
  { title: "Promociones", action: "Promociones" },
  { title: "Medios de pago", action: "Medios de pago" },
  { title: "Teléfono de urgencias", action: "Datos de la clínica" },
]

export function KnowledgePageSkeleton() {
  const canWrite = usePermission("agent.write")
  return (
    <PageLoading
      title="Agente"
      className={cn("flex flex-col gap-6", canWrite && "max-sm:pb-24")}
      footer={
        canWrite ? (
          <div className="fixed inset-x-0 bottom-0 z-10 border-t bg-canvas px-4 py-3 sm:hidden">
            <Button type="button" className="h-12 w-full text-base" disabled>
              Nueva respuesta
            </Button>
          </div>
        ) : null
      }
    >
      <div aria-hidden className="flex flex-col gap-6">
        {/* Dicen el nombre de recepción de la clínica: se pintan con él al llegar. */}
        <Line className="w-[36rem] max-w-full" />
        <TabsLoading active="conocimiento" />
        <Line className="-mt-2 w-96 max-w-full" />
        <section className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
          <div className="min-w-0">
            <h2 className="font-heading text-base font-semibold">Lo que solo tú sabes</h2>
            <p className="text-sm text-muted-foreground">Lo que preguntan seguido y no está en tus datos. Es opcional.</p>
          </div>
          <KnowledgeBasicsSkeleton />
        </section>
        <section className="elevated flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2.5 px-4 pt-4 pb-3 sm:px-5">
            <h2 className="min-w-0 flex-1 basis-48 font-heading text-base font-semibold">Respuestas oficiales</h2>
            {canWrite ? (
              <Button type="button" className="hidden sm:inline-flex" disabled>
                Nueva respuesta
              </Button>
            ) : null}
          </div>
          <KnowledgeAnswerRowsSkeleton />
        </section>
        <section className="elevated flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="px-4 pt-4 pb-2.5 sm:px-6">
            <h2 className="font-heading text-base font-semibold">Lo que toma de tus datos</h2>
            <p className="text-sm text-muted-foreground">Siempre al día: no se copia, se lee en el momento. Se edita donde vive.</p>
          </div>
          <ul className="flex flex-col">
            {KNOWLEDGE_SOURCE_ROWS.map((row) => (
              <li key={row.title} className="border-t">
                <div className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-2.5 sm:grid-cols-[13rem_minmax(0,1fr)_auto] sm:px-6">
                  <span className="font-semibold">{row.title}</span>
                  <ChevronRight aria-hidden className="size-4 text-primary sm:hidden" />
                  <span className="col-span-2 sm:col-span-1">
                    <Line className="w-3/4" />
                  </span>
                  <span className="hidden items-center gap-1.5 text-sm font-semibold text-primary sm:inline-flex">
                    {row.action}
                    <ArrowRight aria-hidden className="size-3.5" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t bg-muted/60 px-4 py-3 text-sm text-muted-foreground sm:px-6">
            De cada persona, solo mientras le escribe: sus citas, su presupuesto, su saldo y lo que la clínica anotó de ella. Nada de su historia
            clínica.
          </p>
        </section>
      </div>
    </PageLoading>
  )
}

// ---------------------------------------------------------------------------
// Registro técnico
// ---------------------------------------------------------------------------

const KPI_TITLES = ["Ejecuciones", "Por conversación", "Latencia media", "Tokens (entrada/salida)"]

/** Las cifras: las mismas tarjetas con su rótulo; solo el valor es barra. */
export function AgentLogStatsSkeleton() {
  return (
    <div aria-hidden className="flex min-w-0 flex-col gap-6">
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {KPI_TITLES.map((title) => (
        <div key={title} className="elevated h-full rounded-xl border bg-card p-5">
          <span className="block truncate text-sm font-medium text-muted-foreground">{title}</span>
          <Skeleton className="mt-3 h-[1.875rem] w-20" />
        </div>
      ))}
      <div className="elevated rounded-xl border bg-card p-6">
        <div className="text-sm font-medium text-muted-foreground">Por estado</div>
        <div className="mt-3 flex flex-wrap gap-1">
          <Skeleton className="h-5.5 w-24 rounded-full" />
          <Skeleton className="h-5.5 w-16 rounded-full" />
        </div>
      </div>
    </div>
    <div className="elevated rounded-xl border bg-card p-6">
      <div className="text-sm font-medium text-muted-foreground">Herramientas más usadas</div>
      <div className="mt-3 flex flex-wrap gap-1">
        <Skeleton className="h-5.5 w-28 rounded-full" />
        <Skeleton className="h-5.5 w-36 rounded-full" />
        <Skeleton className="h-5.5 w-32 rounded-full" />
      </div>
    </div>
    </div>
  )
}

export function AgentRunsSkeleton() {
  return <DataTableSkeleton columnCount={8} rowCount={6} label="Cargando las ejecuciones…" />
}

export function AgentDecisionsSkeleton() {
  return (
    <ul aria-hidden className="mt-3 flex flex-col divide-y">
      {slots(4).map((row) => (
        <li key={row} className="flex flex-col gap-1 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-5.5 w-20 rounded-full" />
            <Skeleton className="h-5.5 w-16 rounded-full" />
            <Skeleton className="h-3.5 w-40" />
          </div>
          <Line className="w-4/5" />
        </li>
      ))}
    </ul>
  )
}

export function AgentLogPageSkeleton() {
  const canWrite = usePermission("agent.write")
  return (
    <PageLoading title="Registro técnico" className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">
        <Subtitle>Ejecuciones registradas y simulación sin cambios; una ejecución correcta no equivale a un caso resuelto.</Subtitle>
        <span className="-mt-3 inline-flex min-h-11 w-fit items-center text-sm font-semibold text-primary sm:min-h-0">Volver al resumen del agente</span>
        <AgentLogStatsSkeleton />
        <div className="elevated rounded-xl border bg-card p-6">
          <h2 className="font-heading text-base font-medium">Últimas 50 ejecuciones</h2>
          <AgentRunsSkeleton />
        </div>
        <section className="elevated rounded-xl border bg-card p-6">
          <h2 className="font-heading text-base font-medium">Decisiones del modelo de decisión</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Lo que decidió sobre cada mensaje entrante y con qué confianza. Elegir el camino o el conocimiento sí cambia la
            respuesta; «en sombra» solo se registra. Ninguna acredita acierto por sí sola.
          </p>
          <AgentDecisionsSkeleton />
        </section>
        {canWrite ? (
          <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
            <div className="font-heading text-base font-medium">Simular instrucciones</div>
            <Line className="w-full" />
            <Line className="w-4/5" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : null}
      </div>
    </PageLoading>
  )
}
