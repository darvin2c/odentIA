/**
 * La ficha de una clínica (`routes/_app/organizations_.$organizationId.tsx`):
 * cabecera, pestañas y una zona por pestaña (Resumen, Gastos, Precio y prueba,
 * Equipo, Actividad y Cargar datos). Pestañas e importes, los del rol de quien
 * mira, con la misma regla que la pantalla (`lib/organization-tabs.ts`).
 */
import { ScrollArea, Skeleton, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import { getRouteApi } from "@tanstack/react-router"
import type { JSX } from "react"
import {
  ORGANIZATION_TAB_NAMES,
  type OrganizationTab,
  openOrganizationTab,
  organizationTabsFor,
} from "../../lib/organization-tabs"
import { useIsAdmin } from "../../lib/session"
import { ControlSkeleton, TextBase, TextSm, TextXs } from "./page-loading"

function Stat({ label, big = false }: { label: string; big?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <Skeleton className={big ? "my-1 h-5 w-24" : "my-1 h-5 w-20"} />
      <TextXs className="w-3/4" />
    </div>
  )
}

function AgentCard({ name, lines, isAdmin }: { name: string; lines: string[]; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-base">{name}</b>
        {isAdmin ? <TextBase className="w-16" /> : null}
      </div>
      <TextSm className="w-40" />
      {lines.map((label) => (
        <div key={label} className="flex justify-between gap-2 text-sm text-muted-foreground">
          <span>{label}</span>
          <TextSm className="w-6" />
        </div>
      ))}
      {isAdmin ? (
        <>
          <div className="flex justify-between gap-2 border-t pt-2 text-sm">
            <span className="text-muted-foreground">Nos costó</span>
            <TextSm className="w-14" />
          </div>
          <TextSm className="w-36" />
        </>
      ) : null}
    </div>
  )
}

/** Resumen (`components/org-summary.tsx`). */
export function OrgSummarySkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3.5 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <TextBase className="w-40" />
            <TextXs className="w-72" />
          </div>
          {isAdmin ? <TextSm className="w-28" /> : null}
        </div>
        {isAdmin ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Stat label="Lo que paga, sin impuestos" big />
              <Stat label="Nos costó" big />
              <Stat label="Margen" big />
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap justify-between gap-2">
                <TextSm className="w-48" />
                <TextSm className="w-32" />
              </div>
              <Skeleton className="h-2.5 rounded-full" />
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Los importes los ve la administración.</p>
        )}
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="text-base font-medium">Lo que hicieron los agentes</h2>
        <div className="grid gap-2.5 md:grid-cols-3">
          <AgentCard name="Sofi" lines={["Informa", "Gestiona", "Subieron a Agenda"]} isAdmin={isAdmin} />
          <AgentCard name="Clío" lines={["Simple", "Estándar", "Completa"]} isAdmin={isAdmin} />
          <AgentCard name="Argos" lines={["Preguntas", "Citas recuperadas"]} isAdmin={isAdmin} />
        </div>
        {isAdmin ? <TextXs className="w-96" /> : null}
      </section>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm">
        <TextSm className="w-72" />
        {isAdmin ? <TextSm className="w-52" /> : null}
      </section>
    </div>
  )
}

function SpendingChips() {
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {["w-20", "w-20", "w-16", "w-20", "w-24"].map((width, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: chips de relleno, siempre los mismos.
        <Skeleton key={index} className={`h-8 rounded-full ${width}`} />
      ))}
    </div>
  )
}

function SpendingMonthTabs() {
  return (
    <Tabs value="actual">
      <TabsList aria-label="Qué mes">
        <TabsTrigger value="actual">Este mes</TabsTrigger>
        <TabsTrigger value="anterior">El anterior</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

/** «Cada acción»: tabla desde tableta, tarjetas en el teléfono. */
function SpendingActions() {
  return (
    <div className="flex flex-col gap-3">
      <div className="hidden max-w-full rounded-xl border bg-card px-2 md:block">
        <div className="flex items-center gap-4 border-b px-2 py-2">
          <TextXs className="w-20" />
          <TextXs className="w-32 flex-1" />
          <TextXs className="w-16" />
          <TextXs className="w-16" />
        </div>
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div key={row} className="flex items-center gap-4 border-b border-border/60 px-2 py-2">
            <TextSm className="w-20" />
            <div className="min-w-0 flex-1">
              <TextSm className="w-3/5" />
            </div>
            <TextSm className="w-16" />
            <TextSm className="w-16" />
          </div>
        ))}
      </div>
      <ul className="flex flex-col gap-2 md:hidden">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-sm">
            <div className="flex justify-between gap-2">
              <TextSm className="w-32" />
              <TextSm className="w-16" />
            </div>
            <TextSm className="w-4/5" />
            <TextXs className="w-3/5" />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Gastos (`components/org-spending.tsx`); `overview` es «Todo», el resto es un agente. */
export function OrgSpendingSkeleton({ overview = true }: { overview?: boolean }) {
  if (!overview) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SpendingChips />
          <SpendingMonthTabs />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <div key={card} className="flex flex-col gap-0.5 rounded-xl border bg-card p-3">
              <TextXs className="w-24" />
              <Skeleton className="my-1 h-5 w-20" />
              <TextXs className="w-3/4" />
            </div>
          ))}
        </div>
        <section className="flex flex-col gap-3">
          <TextBase className="w-48" />
          <SpendingActions />
        </section>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SpendingMonthTabs />
        <p className="text-xs text-muted-foreground">Solo lo ve la administración</p>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Lo que paga, sin impuestos" />
        <Stat label="Nos costó" />
        <Stat label="Margen" />
        <Stat label="Alarma interna" />
      </div>
      <section className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3">
        <h2 className="text-base font-medium">Costo de IA por día</h2>
        <Skeleton className="h-40 w-full" />
      </section>
      <section className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3">
        <h2 className="px-1 text-base font-medium">Por agente y tipo</h2>
        <div>
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="flex items-center gap-4 border-b border-border/60 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <TextSm className="w-32" />
              </div>
              <TextSm className="w-10" />
              <TextSm className="w-12" />
              <TextSm className="w-12 max-sm:hidden" />
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-medium">Cada acción</h2>
          <SpendingChips />
        </div>
        <SpendingActions />
      </section>
    </div>
  )
}

/** Precio y prueba (`components/org-billing.tsx`). */
export function OrgBillingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-medium">Precio y prueba</h2>
      <TextSm className="w-96" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Prueba</p>
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <TextSm className="w-24" />
                <ControlSkeleton className="w-full" />
                <TextXs className="w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-28 rounded-3xl" />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Precio negociado</p>
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <TextSm className="w-24" />
                <ControlSkeleton className="w-full" />
              </div>
            ))}
          </div>
          <TextXs className="w-full" />
          <TextXs className="w-3/4" />
          <div className="flex flex-col gap-2 py-1">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex justify-between gap-4">
                <TextSm className="w-24" />
                <TextSm className="w-12" />
              </div>
            ))}
          </div>
          <Skeleton className="h-8 w-32 rounded-3xl" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <TextSm className="w-52" />
        <ControlSkeleton className="w-64" />
      </div>
    </div>
  )
}

/** Equipo: miembros e invitaciones, que llegan con la ficha. */
function OrgTeamSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <TextBase className="w-32" />
        <ul className="flex flex-col divide-y text-sm">
          {[0, 1, 2].map((row) => (
            <li key={row} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
              <TextSm className="w-32" />
              <TextSm className="w-44" />
              <TextSm className="w-20" />
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <h2 className="text-base font-medium">Invitaciones</h2>
        <TextSm className="w-44" />
      </section>
    </div>
  )
}

function OrgActivitySkeleton() {
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <h2 className="text-base font-medium">Lo que se hizo desde la administración</h2>
      <ul className="flex flex-col divide-y text-sm">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="flex flex-wrap justify-between gap-2 py-2">
            <TextSm className="w-52" />
            <TextSm className="w-32" />
          </li>
        ))}
      </ul>
    </section>
  )
}

function OrgImportSkeleton() {
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">Cargar los datos de la clínica</h2>
        <TextSm className="w-full" />
        <TextSm className="w-3/4" />
      </div>
      <ControlSkeleton className="w-44" />
    </section>
  )
}

/** Cabecera, pestañas y la zona de la pestaña que abre la dirección, si ese rol la abre. */
export function OrganizationDetailSkeleton({
  wanted,
  overview,
}: {
  wanted: OrganizationTab | undefined
  overview: boolean
}) {
  const isAdmin = useIsAdmin()
  const tab = openOrganizationTab(wanted, isAdmin)
  return (
    <SkeletonRegion message="Cargando la clínica…" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <TextSm className="w-44" />
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="my-0.5 h-7 w-56 max-w-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <TextSm className="w-52 sm:ml-auto" />
        </div>
        {/* A la administración le suma el plan, el vendedor y el ciclo de cobro. */}
        <TextSm className={isAdmin ? "w-96" : "w-72"} />
      </div>
      <Tabs value={tab}>
        <ScrollArea horizontal className="min-w-0 max-w-full">
          <TabsList aria-label="Secciones de la clínica" className="max-w-full justify-start">
            {organizationTabsFor(isAdmin).map((item) => (
              <TabsTrigger key={item} value={item} disabled>
                {ORGANIZATION_TAB_NAMES[item]}
              </TabsTrigger>
            ))}
          </TabsList>
        </ScrollArea>
      </Tabs>
      {tab === "resumen" ? <OrgSummarySkeleton /> : null}
      {tab === "gastos" ? <OrgSpendingSkeleton overview={overview} /> : null}
      {tab === "precio" ? <OrgBillingSkeleton /> : null}
      {tab === "equipo" ? <OrgTeamSkeleton /> : null}
      {tab === "actividad" ? <OrgActivitySkeleton /> : null}
      {tab === "carga" ? <OrgImportSkeleton /> : null}
    </SkeletonRegion>
  )
}

const detailRoute = getRouteApi("/_app/organizations_/$organizationId")

/** Para la ruta: el «← Organizaciones» aún sin enlace; la pantalla real lo pone al llegar. */
export function OrganizationDetailPageSkeleton(): JSX.Element {
  const search = detailRoute.useSearch()
  return (
    <PageShell className="flex flex-col gap-4">
      <span className="self-start text-sm text-muted-foreground">← Organizaciones</span>
      <OrganizationDetailSkeleton wanted={search.tab} overview={(search.agente ?? "todo") === "todo"} />
    </PageShell>
  )
}
