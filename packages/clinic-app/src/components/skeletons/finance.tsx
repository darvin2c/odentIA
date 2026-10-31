/**
 * Los esqueletos de Finanzas: Caja, Cobros, Deudas, Gastos y Cierres (Comisiones
 * comparte los de `commissions.tsx`), con las mismas clases que cada sección. Las piezas por consulta las
 * usa la pantalla real mientras espera; las de sección entera, la ruta.
 */
import { ParamTabs } from "./param-tabs"
import { Button, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, useIsMobile } from "@odentia/ui"
import { ArrowLeft } from "lucide-react"
import { useCan, useMyUserId, useOrgMembers } from "../../lib/crm"
import { commissionsHeading, COMMISSIONS_ADMIN_SUBTITLE, financeAccess, financeHeader, financePhoneActions } from "../../lib/screen-rules"
import { CommissionsMonthSkeleton, MyCommissionsSkeleton } from "./commissions"
import { LabeledTableSkeleton } from "./labeled-table"
import { FilterBarShell, TextLine, TextLines, useSearchValue } from "./list-bar"
import { PageLoading } from "./page-loading"

export type FinanceStrip = "caja" | "cobros" | "deudas" | "gastos" | "comisiones" | "cierres"

function times(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

function Right({ width = "w-16" }: { width?: string }) {
  return (
    <div className="flex h-5 items-center justify-end">
      <Skeleton className={`h-3.5 ${width}`} />
    </div>
  )
}

// --- Caja -----------------------------------------------------------------------------------

/** «Efectivo en caja», un medio de pago y lo cobrado hoy. */
export function CashFiguresSkeleton() {
  return (
    <div className="flex flex-wrap gap-3">
      <div className="elevated min-w-0 grow-[2] basis-full rounded-xl border bg-card p-4 sm:basis-80 sm:p-5">
        <h2 className="text-sm font-medium text-muted-foreground">Efectivo en caja</h2>
        <Skeleton className="mt-1 h-9 w-36" />
        <TextLine width="w-4/5" className="mt-2" />
      </div>
      {times(2).map((box) => (
        <div key={box} className="elevated min-w-36 flex-1 rounded-xl border bg-card p-4 sm:p-5">
          <TextLine width="w-24" />
          <Skeleton className="mt-1 h-7 w-24" />
          <TextLine width="w-20" className="mt-1" />
        </div>
      ))}
    </div>
  )
}

/** «Por cobrar ahora»: quién, qué, desde cuándo, cuánto y «Cobrar» (desde `sm`). */
export function AttendedRowsSkeleton({ rows = 2 }: { rows?: number }) {
  const { write: canWrite } = financeAccess(useCan())
  return (
    <ul className="mt-1 divide-y">
      {times(rows).map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <div className="min-w-0 flex-1 basis-56">
            <TextLine width="w-40" height="h-6" />
            <TextLine width="w-48" />
            <TextLine width="w-44" />
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            <Skeleton className="h-4 w-16" />
            {canWrite ? <Skeleton className="h-9 w-20 rounded-full max-sm:hidden" /> : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** «Movimientos de hoy»: hora, qué fue, importe y «Ver ticket». */
export function MovementRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {times(rows).map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <TextLine width="w-10" className="w-14 shrink-0" />
          <div className="min-w-0 flex-1 basis-40">
            <TextLine width="w-40" height="h-6" />
            <TextLine width="w-48" />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-20" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function CashTabSkeleton() {
  const { write: canWrite } = financeAccess(useCan())
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Skeleton className="h-4 w-56 max-w-full" />
        <span className="text-sm font-medium text-primary-soft-foreground">Cierres</span>
      </div>
      <CashFiguresSkeleton />
      <section className="elevated rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="font-heading text-base font-medium">Por cobrar ahora</h2>
        <AttendedRowsSkeleton />
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div>
            <h2 className="font-heading text-base font-medium">Movimientos de hoy</h2>
            <TextLine width="w-32" />
          </div>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled className="md:hidden">
                Registrar gasto
              </Button>
              <Button variant="outline" size="sm" disabled>
                Ingresar o retirar efectivo
              </Button>
            </div>
          ) : null}
        </div>
        <MovementRowsSkeleton />
      </section>
    </div>
  )
}

// --- Cobros ---------------------------------------------------------------------------------

/** La línea de totales y la tabla de cobros (filas en el teléfono). */
export function TicketRowsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <TextLine width="w-48" />
        <TextLine width="w-64" />
      </div>
      <div className="flex flex-col gap-2">
        <LabeledTableSkeleton
          columns={[
            { label: "Ticket", cell: <TextLine width="w-14" /> },
            { label: "Fecha", cell: <TextLine width="w-24" /> },
            { label: "Paciente", cell: <TextLines widths={["w-36", "w-24"]} /> },
            { label: "Lo que pagó", cell: <TextLine width="w-44" /> },
            { label: "Medio de pago", cell: <TextLine width="w-16" /> },
            { label: "Cobró", cell: <TextLine width="w-24" /> },
            { label: "Total", cell: <Right /> },
          ]}
          title={<TextLine width="w-40" />}
          summary={
            <>
              <TextLine width="w-14" />
              <TextLine width="w-24" />
              <TextLine width="w-16" />
            </>
          }
        />
        <TextLine width="w-48" />
      </div>
    </div>
  )
}

function TicketsTabSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <FilterBarShell searchLabel="Buscar en cobros" searchPlaceholder="Buscar por paciente, documento o N.º de ticket" filters={["Fecha", "Medio de pago", "Cobró", "Estado"]} sort />
      <TicketRowsSkeleton />
    </div>
  )
}

// --- Deudas ---------------------------------------------------------------------------------

/** Lo que se debe en la sede y la tabla de deudas (filas en el teléfono). */
export function DebtRowsSkeleton() {
  const access = financeAccess(useCan())
  // «Escribirle» y «Cobrar»: la columna siempre está, y sin ninguno de los dos queda vacía.
  const hasAction = access.message || access.write
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <TextLine width="w-52" />
        <TextLine width="w-72" />
      </div>
      <div className="flex flex-col gap-2">
        <LabeledTableSkeleton
          columns={[
            { label: "Paciente", cell: <TextLines widths={["w-36", "w-24"]} /> },
            { label: "Lo que debe", cell: <TextLines widths={["w-44", "w-28"]} /> },
            { label: "Desde", cell: <TextLine width="w-32" /> },
            { label: "Próxima cita", cell: <TextLine width="w-28" /> },
            { label: "Debe", cell: <Right /> },
            { label: " ", cell: <div className="flex justify-end">{hasAction ? <Skeleton className="h-8 w-20" /> : null}</div> },
          ]}
          title={<TextLine width="w-40" />}
          summary={
            <>
              <TextLine width="w-32" />
              <TextLine width="w-16" />
            </>
          }
        />
        <TextLine width="w-48" />
      </div>
    </div>
  )
}

function DebtsTabSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <FilterBarShell searchLabel="Buscar en deudas" searchPlaceholder="Buscar por paciente o documento" filters={["Antigüedad"]} sort />
      <DebtRowsSkeleton />
      <p className="text-sm text-muted-foreground">Lo aceptado en un presupuesto que todavía no se atiende no aparece aquí: no es deuda.</p>
    </div>
  )
}

// --- Gastos ---------------------------------------------------------------------------------

/** «Gastado en el mes» con su reparto por tipo. */
export function ExpensesTotalSkeleton() {
  return (
    <div className="elevated rounded-xl border bg-card p-4 sm:p-5">
      <TextLine width="w-36" />
      <Skeleton className="mt-1 h-9 w-36" />
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3 lg:grid-cols-5">
        {times(5).map((item) => (
          <div key={item}>
            <TextLine width="w-20" />
            <TextLine width="w-14" height="h-6" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** La tabla de gastos del mes (filas en el teléfono). */
export function ExpenseRowsSkeleton() {
  const { write: canWrite } = financeAccess(useCan())
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "Fecha", cell: <TextLine width="w-14" /> },
        { label: "Concepto", cell: <TextLines widths={["w-44", "w-24"]} /> },
        { label: "Tipo", cell: <TextLine width="w-20" /> },
        { label: "Comprobante", cell: <TextLine width="w-28" /> },
        { label: "Salió de", cell: <TextLine width="w-28" /> },
        { label: "Monto", cell: <Right /> },
        { label: " ", cell: <div className="flex justify-end">{canWrite ? <Skeleton className="h-8 w-16" /> : null}</div> },
      ]}
      title={<TextLine width="w-44" />}
      summary={
        <>
          <TextLine width="w-14" />
          <TextLine width="w-16" />
        </>
      }
    />
  )
}

function ExpensesTabSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <FilterBarShell searchLabel="Buscar en gastos" searchPlaceholder="Buscar por concepto, proveedor o comprobante" filters={["Tipo"]} />
      <ExpensesTotalSkeleton />
      <ExpenseRowsSkeleton />
      <p className="text-sm text-muted-foreground">Un gasto se anula con motivo y queda en el historial; no se borra.</p>
    </div>
  )
}

// --- Cierres --------------------------------------------------------------------------------

/** Un cierre por fila: cuándo, quién, lo contado, la diferencia y «Ver hoja». */
export function ClosureRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {times(rows).map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1 basis-64">
            <TextLine width="w-52" height="h-6" />
            <TextLine width="w-72" />
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <div className="flex flex-col items-end">
              <TextLine width="w-24" />
              <TextLine width="w-20" />
            </div>
            <Skeleton className="h-8 w-20 rounded-full" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function ClosuresTabSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <span className="-ml-2 inline-flex h-8 items-center gap-1.5 px-2 text-sm font-medium [&_svg]:size-4">
          <ArrowLeft aria-hidden />
          Volver a Caja
        </span>
      </div>
      <TextLine width="w-48" height="h-6" bar="h-4" />
      <FilterBarShell filters={["Resultado"]} />
      <ClosureRowsSkeleton />
      <p className="text-sm text-muted-foreground">Un cierre no se edita. Lo que se corrija después queda como movimiento del día en que se corrige.</p>
    </div>
  )
}

// --- La sección -----------------------------------------------------------------------------

/** Lo mismo que elige la pantalla: el mes de la clínica, «Mis comisiones» o, sin permiso, nada que esperar. */
function CommissionsSectionSkeleton() {
  const access = financeAccess(useCan())
  if (!access.commissions) return null
  return access.commissionsWrite ? <CommissionsMonthSkeleton /> : <MyCommissionsSkeleton />
}

function SectionBody({ view }: { view: FinanceStrip }) {
  if (view === "cobros") return <TicketsTabSkeleton />
  if (view === "deudas") return <DebtsTabSkeleton />
  if (view === "gastos") return <ExpensesTabSkeleton />
  if (view === "comisiones") return <CommissionsSectionSkeleton />
  if (view === "cierres") return <ClosuresTabSkeleton />
  return <CashTabSkeleton />
}

/** Gastos y Comisiones van por mes: se elige bajo el título en el escritorio y junto a las pestañas en el teléfono. */
function isByMonth(view: FinanceStrip, commissions: boolean): boolean {
  return view === "gastos" || (view === "comisiones" && commissions)
}

const MONTH_PICKER = "h-9 w-40 rounded-full"

/** Las pestañas del rol y la sección elegida. La pantalla lo usa también mientras llega el perfil de la clínica. */
export function FinanceBodySkeleton({ view }: { view: FinanceStrip }) {
  const access = financeAccess(useCan())
  const strip = view === "cierres" ? "caja" : view
  return (
    <ParamTabs param="tab" fallback="caja" className="gap-4" value={strip}>
      <div className="flex flex-wrap items-center gap-2">
        <TabsList aria-label="Secciones de Finanzas" className="max-w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger value="caja" className="shrink-0">
            Caja
          </TabsTrigger>
          <TabsTrigger value="cobros" className="shrink-0">
            Cobros
          </TabsTrigger>
          <TabsTrigger value="deudas" className="shrink-0">
            Deudas
          </TabsTrigger>
          <TabsTrigger value="gastos" className="shrink-0">
            Gastos
          </TabsTrigger>
          {access.commissions ? (
            <TabsTrigger value="comisiones" className="shrink-0">
              Comisiones
            </TabsTrigger>
          ) : null}
        </TabsList>
        {isByMonth(view, access.commissions) ? (
          <div className="ml-auto md:hidden">
            <Skeleton className={MONTH_PICKER} />
          </div>
        ) : null}
        {access.reports ? (
          <span className="ml-auto inline-flex min-h-11 items-center text-sm font-semibold text-primary-soft-foreground sm:min-h-8">Ver el reporte</span>
        ) : null}
      </div>
      <TabsContent value={strip}>
        <SectionBody view={view} />
      </TabsContent>
    </ParamTabs>
  )
}

/** La barra de abajo del teléfono, con los botones que el rol tendrá. */
function PhoneActions({ view }: { view: FinanceStrip }) {
  const access = financeAccess(useCan())
  const actions = financePhoneActions(view, access)
  if (actions.length === 0) return null
  return (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-auto flex gap-2 border-t bg-canvas/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6">
      {actions.map((item) => (
        <Button key={item.key} variant={item.filled ? "default" : "outline"} className="h-12 flex-1 text-base" disabled>
          {item.label}
        </Button>
      ))}
    </div>
  )
}

/** Mientras llega el código de Finanzas: la sección de la dirección, con su título, su sede y lo que el rol puede hacer en ella. */
export function FinancePageSkeleton({ section }: { section?: FinanceStrip } = {}) {
  const wanted = useSearchValue("tab")
  const fromSearch: FinanceStrip = wanted === "cobros" || wanted === "deudas" || wanted === "gastos" || wanted === "comisiones" || wanted === "cierres" ? wanted : "caja"
  const view = section ?? fromSearch
  const access = financeAccess(useCan())
  const isMobile = useIsMobile()
  const header = isMobile ? undefined : financeHeader(view, access)
  return (
    <PageLoading title="Finanzas" primary={header?.primary} menu={header?.menu} footer={isMobile ? <PhoneActions view={view} /> : null}>
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {view === "comisiones" ? (
            <p className="min-w-0">{access.commissionsWrite ? COMMISSIONS_ADMIN_SUBTITLE : "Mis comisiones"}</p>
          ) : (
            <TextLine width="w-32" />
          )}
          {isByMonth(view, access.commissions) ? <Skeleton className={`${MONTH_PICKER} max-md:hidden`} /> : null}
        </div>
        <FinanceBodySkeleton view={view} />
      </div>
    </PageLoading>
  )
}

/**
 * `/commissions`: quien ve Finanzas llega a su sección de Comisiones; quien solo
 * tiene las suyas se queda aquí, con su nombre (ya está en el contexto de la ruta).
 */
export function CommissionsPageSkeleton() {
  const can = useCan()
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const { canWrite, title, subtitle } = commissionsHeading(can, members.find((member) => member.userId === myUserId)?.user.name)
  if (can("finance.read")) return <FinancePageSkeleton section="comisiones" />
  return (
    <PageLoading title={title} className="flex flex-col gap-6">
      <div className="flex flex-col gap-6">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {subtitle ? <p className="min-w-0">{subtitle}</p> : null}
          <Skeleton className={MONTH_PICKER} />
        </div>
        {canWrite ? <CommissionsMonthSkeleton /> : <MyCommissionsSkeleton />}
      </div>
    </PageLoading>
  )
}
