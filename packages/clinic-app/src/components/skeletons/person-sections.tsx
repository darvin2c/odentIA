/**
 * Esqueletos de cada sección de la página de la persona. Cada uno copia las
 * clases del componente real (dicho en su comentario) y pinta reales sus títulos
 * y rótulos. Se usan al esperar la página, el código de la sección y sus datos.
 */
import { ParamTabs } from "./param-tabs"
import { Skeleton, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { ScrollingTabsList } from "@odentia/ui-patterns"
import { ChevronDown } from "lucide-react"
import type { ReactNode } from "react"
import { ButtonBar, Line, RowsShape, SummaryCardShape, TableShape, WaitingButton } from "./person-parts"

/** Lo que el rol de quien mira decide en las secciones. */
export type SkeletonCan = (permission: string) => boolean

function Fact({ label, width = "w-32" }: { label: string; width?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd>
        <Line className={width} />
      </dd>
    </div>
  )
}

/** `PlanNextCard`: la franja «Qué sigue». */
export function PlanNextSkeleton() {
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Qué sigue</span>
        <Line size="base" className="w-3/4" />
        <Line className="w-1/2" />
      </div>
      <Skeleton className="h-9 w-28 shrink-0 rounded-full" />
    </section>
  )
}

/** Las líneas de «Última atención» mientras llega el resumen clínico. */
export function LastVisitLinesSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      <Line className="w-40" />
      <Line className="w-full" />
      <Line className="w-2/3" />
    </div>
  )
}

/** `PersonNotes`: una lista de notas. */
export function NotesListSkeleton() {
  return (
    <ul className="flex flex-col divide-y">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
          <Line size="xs" className="w-40" />
          <Line className={row === 0 ? "w-full" : "w-3/4"} />
        </li>
      ))}
    </ul>
  )
}

/**
 * `PersonSummary`: las cuatro tarjetas de quien lee la clínica, los datos, pendientes, notas y lo que recuerda.
 * `unknown`: quien lee la clínica abre a alguien que quizá aún no es paciente; arriba, sin títulos que luego se vayan.
 */
export function PersonSummarySkeleton({ clinical, can }: { clinical: boolean | "unknown"; can: SkeletonCan }) {
  const chats = can("conversations.read")
  const crm = can("crm.read")
  const finance = can("finance.read")
  const showFacts = clinical !== "unknown" && (!clinical || finance || chats || crm)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {clinical === "unknown" ? (
        <section className="elevated grid min-w-0 grid-cols-1 gap-x-8 gap-y-4 rounded-xl border bg-card p-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((slot) => (
            <div key={slot} className="flex flex-col gap-1">
              <Line size="xs" className="w-20" />
              <Line className="w-40" />
            </div>
          ))}
        </section>
      ) : clinical ? (
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <SummaryCardShape title="Alergias y alertas" action={<WaitingButton>Antecedentes</WaitingButton>}>
            <ul className="flex flex-col gap-2">
              <li className="rounded-lg border border-dashed px-3 py-2">
                <Line className="w-40" />
              </li>
            </ul>
          </SummaryCardShape>
          <PlanNextSkeleton />
          <SummaryCardShape title="Última atención">
            <LastVisitLinesSkeleton />
          </SummaryCardShape>
          <SummaryCardShape title="Próxima cita">
            <LastVisitLinesSkeleton />
          </SummaryCardShape>
        </div>
      ) : null}
      {showFacts ? (
        <section className="elevated rounded-xl border bg-card p-6">
          <dl className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {clinical ? null : <Fact label="Teléfono" />}
            {!clinical && (can("clinical.alerts") || can("clinical.read")) ? <Fact label="Alergias" /> : null}
            {!clinical && can("appointments.read") ? <Fact label="Próxima cita" width="w-48" /> : null}
            {finance ? <Fact label="Saldo" /> : null}
            {chats ? <Fact label="Conversación" width="w-44" /> : null}
            {crm ? <Fact label="Oportunidad" /> : null}
          </dl>
        </section>
      ) : null}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <SummaryCardShape title="Pendientes" action={can("tasks.write") ? <WaitingButton>Nueva tarea</WaitingButton> : undefined}>
            <RowsShape rows={2} />
          </SummaryCardShape>
          {crm ? (
            <SummaryCardShape title="Notas" action={can("crm.write") ? <WaitingButton>Nueva nota</WaitingButton> : undefined}>
              <NotesListSkeleton />
            </SummaryCardShape>
          ) : null}
        </div>
        {chats || crm ? (
          <div className="flex min-w-0 flex-col gap-4">
            <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-agent-border bg-agent-soft p-6">
              <Line size="base" className="w-48" />
              <div className="flex flex-col gap-1">
                <Line className="w-full" />
                <Line className="w-2/3" />
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** `PersonConversations`: la lista de conversaciones. */
export function ConversationRowsSkeleton() {
  return <RowsShape rows={2} />
}

/** `PersonConversations`: la lista de oportunidades. */
export function OpportunityRowsSkeleton() {
  return (
    <ul className="flex flex-col divide-y">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Line className="w-48" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </span>
        </li>
      ))}
    </ul>
  )
}

export function PersonConversationsSkeleton({ can }: { can: SkeletonCan }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {can("conversations.read") ? (
        <SummaryCardShape title="Conversaciones" action={can("conversations.write") ? <ButtonBar className="w-28" /> : undefined}>
          <ConversationRowsSkeleton />
        </SummaryCardShape>
      ) : null}
      {can("crm.read") ? (
        <SummaryCardShape title="Oportunidades" action={can("crm.write") ? <WaitingButton>Nueva oportunidad</WaitingButton> : undefined}>
          <OpportunityRowsSkeleton />
        </SummaryCardShape>
      ) : null}
    </div>
  )
}

function AppointmentRows({ rows }: { rows: number }) {
  return (
    <ul className="mt-2 flex flex-col divide-y">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
        <li key={index} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div className="flex min-w-0 flex-col">
            <Line className="w-48" />
            <Line className="w-56" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <WaitingButton>Ver cita</WaitingButton>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** `CitasPanel`: Próximas citas y Citas anteriores. */
export function CitasSkeleton({ action }: { action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <section className="elevated rounded-xl border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-base font-medium">Próximas citas</h2>
          {action}
        </div>
        <AppointmentRows rows={1} />
      </section>
      <section className="elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Citas anteriores</h2>
        <AppointmentRows rows={3} />
      </section>
    </div>
  )
}

/** `AntecedentesTab`: la revisión, la tarjeta de alergias y el resumen de antecedentes. */
export function AntecedentesSkeleton({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Line className="w-56" />
        {canWrite ? <Skeleton className="h-9 w-40 rounded-full" /> : null}
      </div>
      <section className="elevated flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="font-heading text-base font-medium">Alergias</h3>
            <Line className="w-56" />
          </div>
          {canWrite ? <WaitingButton>Agregar alergia</WaitingButton> : null}
        </div>
        <Line className="w-64" />
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {["Grupo sanguíneo", "Condiciones", "Medicación vigente"].map((title) => (
          <div key={title} className="flex flex-col gap-1 elevated rounded-xl border bg-card p-4">
            <span className="font-heading text-sm font-medium">{title}</span>
            <Line className="w-32" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Tarjetas de `Timeline` por día: la línea con su punto, el día y sus hechos. */
export function TimelineItemsSkeleton() {
  return (
    <>
      {[2, 1].map((cards) => (
        <section key={cards} className="relative flex flex-col gap-3 border-l-2 border-border pl-4 sm:pl-5">
          <span aria-hidden="true" className="absolute -left-[7px] top-1 size-3 rounded-full border-2 border-primary bg-background" />
          <Line className="w-32" />
          {Array.from({ length: cards }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tarjetas de relleno, siempre las mismas.
            <div key={index} className="flex flex-col gap-2 elevated rounded-xl border bg-card p-6">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="ml-auto h-3 w-16" />
              </div>
              <Line className="w-2/3" />
              <Line className="w-full" />
            </div>
          ))}
        </section>
      ))}
    </>
  )
}

const HISTORY_FILTERS = ["Todo", "Atenciones", "Plan", "Notas clínicas"]

function FixedTabs({ label, options }: { label: string; options: readonly string[] }) {
  return (
    <Tabs className="min-w-0 max-w-full" value={options[0]}>
      <ScrollingTabsList aria-label={label}>
        {options.map((option) => (
          <TabsTrigger key={option} value={option} disabled={option !== options[0]} className="shrink-0 min-h-11 sm:min-h-9">
            {option}
          </TabsTrigger>
        ))}
      </ScrollingTabsList>
    </Tabs>
  )
}

/** `HistoriaTab` y `Timeline`: lo fijo de arriba y los hechos. */
export function HistoriaSkeleton({ placeLabel, canNote }: { placeLabel?: string; canNote: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Qué pasó y cuándo</p>
        {canNote ? <ButtonBar className="w-28" /> : null}
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <FixedTabs label="Filtrar historia clínica" options={HISTORY_FILTERS} />
          <div className="flex flex-wrap items-center gap-2">
            <FixedTabs label="Agrupar historia clínica" options={["Día", "Atención"]} />
            <FixedTabs label="Orden de historia clínica" options={["Recientes", "Antiguos"]} />
          </div>
        </div>
        {placeLabel ? (
          <div className="flex max-w-64 flex-col gap-2">
            <span className="text-sm font-medium">{placeLabel}</span>
            <Skeleton className="h-9 w-full rounded-3xl" />
          </div>
        ) : null}
        <TimelineItemsSkeleton />
      </div>
    </div>
  )
}

/** `DocumentosSection`: los filtros de tipo, la cuenta y las filas separadas por mes. */
export function DocumentRowsSkeleton() {
  return (
    <>
      <div className="flex gap-2 overflow-hidden sm:flex-wrap">
        <Skeleton className="h-8 w-14 shrink-0 rounded-full" />
        <Skeleton className="h-8 w-36 shrink-0 rounded-full" />
        <Skeleton className="h-8 w-20 shrink-0 rounded-full" />
        <Skeleton className="h-8 w-24 shrink-0 rounded-full" />
      </div>
      <Line className="w-32" />
      <div className="elevated rounded-xl border bg-card px-4 sm:px-6">
        {[3, 2].map((rows) => (
          <section key={rows}>
            <div className="pt-4 pb-1">
              <Line size="xs" className="w-24" />
            </div>
            <ul className="flex flex-col divide-y">
              {Array.from({ length: rows }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
                <li key={index} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <Skeleton className="size-9 shrink-0 rounded-lg" />
                  <div className="flex min-w-0 flex-1 basis-48 flex-col">
                    <Line className="w-44" />
                    <Line className="w-56" />
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <ButtonBar />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}

export function DocumentosSkeleton({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 min-w-0 flex-1 basis-56 rounded-3xl" />
        <Skeleton className="h-9 w-40 rounded-3xl" />
        {canWrite ? (
          <div className="ml-auto">
            <Skeleton className="h-9 w-24 rounded-full" />
          </div>
        ) : null}
      </div>
      <DocumentRowsSkeleton />
    </div>
  )
}

/** `PlanPhases`: la tarjeta de los tratamientos por fase. */
export function PlanPhasesSkeleton() {
  return (
    <section className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1">
        <Line size="base" className="w-40" />
        <Line className="w-2/3" />
      </div>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Line className="w-56" />
          <ol className="flex flex-col divide-y rounded-lg border">
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="w-5 text-sm tabular-nums text-muted-foreground">{row + 1}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <Line className="w-48" />
                  <Line size="xs" className="w-56" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
                <ButtonBar className="w-14" />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

/** `BudgetCard` cerrada: una tarjeta por presupuesto, con «Ver». */
export function BudgetListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Line size="base" className="w-56" />
            <Skeleton className="h-5 w-32 rounded-full" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ButtonBar className="w-28" />
            <WaitingButton>Ver</WaitingButton>
          </div>
        </div>
      </section>
    </div>
  )
}

/** Las filas de `ControlesPanel`. */
export function ControlRowsSkeleton() {
  return (
    <ul className="flex flex-col divide-y">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Line size="base" className="w-44" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Line className="w-56" />
        </li>
      ))}
    </ul>
  )
}

/** Los tratamientos o controles que ve recepción (`plan-coordination`). */
export function CoordinationRowsSkeleton() {
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
          <Line className="w-48" />
          <span className="flex flex-wrap gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </span>
        </li>
      ))}
    </ul>
  )
}

function PlanSectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="font-heading text-base font-medium">{title}</h2>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  )
}

/** `PlanTab`: «Qué sigue», tratamientos, presupuesto y controles, según lo que ve el rol. */
export function PlanSkeleton({ can, budgetOptional }: { can: SkeletonCan; budgetOptional: boolean }) {
  const clinical = can("clinical.read")
  const agenda = can("appointments.read")
  return (
    <div className="flex flex-col gap-6">
      <PlanNextSkeleton />
      {clinical ? (
        <section className="flex flex-col gap-3">
          <PlanSectionTitle
            title="Tratamientos"
            description="Por fases y en orden. Se indican dentro de una atención; «Ver» abre su recorrido al lado."
          />
          <PlanPhasesSkeleton />
        </section>
      ) : agenda ? (
        <section className="flex flex-col gap-3">
          <PlanSectionTitle title="Tratamientos" description="Títulos y estados, para agendar y hacer seguimiento." />
          <CoordinationRowsSkeleton />
        </section>
      ) : null}
      {can("budgets.read") ? (
        <section className="flex flex-col gap-3">
          <PlanSectionTitle
            title="Presupuesto"
            description={budgetOptional ? "Opcional: lo indicado ya queda aceptado. Prepáralo si la persona quiere saber cuánto costará." : undefined}
          />
          <BudgetListSkeleton />
        </section>
      ) : null}
      {clinical ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <h3 className="font-heading text-base font-medium">Controles</h3>
                <p className="text-sm text-muted-foreground">
                  Un control programado no equivale a un control realizado: se completa contra una atención finalizada y deja su
                  resultado en la historia.
                </p>
              </div>
            </div>
            <ControlRowsSkeleton />
          </div>
        </section>
      ) : agenda ? (
        <section className="flex flex-col gap-3">
          <PlanSectionTitle title="Controles" />
          <CoordinationRowsSkeleton />
        </section>
      ) : null}
    </div>
  )
}

function AccountRows({ rows, ticket }: { rows: number; ticket?: boolean }) {
  return (
    <ul className="flex flex-col divide-y">
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
        <li key={index} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
          <div className="min-w-0 flex-1 basis-56">
            <Line size="base" className="w-48" />
            <Line className="w-56" />
          </div>
          <Line size="base" className="w-20" />
          {ticket ? <WaitingButton>Ver ticket</WaitingButton> : null}
        </li>
      ))}
    </ul>
  )
}

/** `AccountTab`: el saldo, lo pendiente y los cobros; en el teléfono, el botón de cobro fijo abajo. */
export function AccountSkeleton({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <section className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <dl className="grid grid-cols-3 gap-3">
          {["Debe", "A favor", "Saldo"].map((label) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="my-0.5">
                <Skeleton className="h-5 w-4/5 sm:my-0.5 sm:h-6" />
              </dd>
            </div>
          ))}
        </dl>
        {canWrite ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Skeleton className="hidden h-9 w-36 rounded-full sm:inline-flex" />
          </div>
        ) : null}
      </section>
      <section className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <h2 className="font-heading text-base font-medium">Pendiente</h2>
        <div className="mt-3">
          <AccountRows rows={2} />
        </div>
      </section>
      <section className="elevated rounded-xl border bg-card p-4 sm:p-6">
        <h2 className="font-heading text-base font-medium">Cobros</h2>
        <div className="mt-3">
          <AccountRows rows={3} ticket />
        </div>
      </section>
      {canWrite ? (
        <div className="sticky bottom-3 z-10 sm:hidden">
          <Skeleton className="min-h-12 w-full rounded-full" />
        </div>
      ) : null}
    </div>
  )
}

function DataCard({ title, labels, canEdit }: { title: string; labels: readonly string[]; canEdit: boolean }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        {canEdit ? <WaitingButton>Editar</WaitingButton> : null}
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {labels.map((label) => (
          <Fact key={label} label={label} />
        ))}
      </dl>
    </section>
  )
}

/** `FiliacionPanel`: Identidad y Contacto, «Más datos» plegado y Datos y consentimiento. */
export function FiliacionSkeleton({ canEdit }: { canEdit: boolean }) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h2 className="text-base font-semibold">Datos personales</h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <DataCard title="Identidad" labels={["Nombres", "Apellidos", "Documento", "Nacimiento", "Sexo"]} canEdit={canEdit} />
        <DataCard title="Contacto" labels={["Teléfono", "Correo", "Dirección", "Contacto de emergencia"]} canEdit={canEdit} />
      </div>
      <div className="elevated rounded-xl border bg-card p-5">
        <span className="flex items-center gap-1 text-sm font-medium">
          Más datos <ChevronDown aria-hidden className="size-4" />
        </span>
      </div>
      <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-5">
        <h3 className="font-heading text-sm font-medium">Datos y consentimiento</h3>
        <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Fact label="Sede de registro" />
          <Fact label="Registrado" />
        </dl>
        <Line className="w-2/3" />
        <Line className="w-1/2" />
      </section>
    </section>
  )
}

/** `PersonLinks`: quién habla por ella y a quiénes tiene a su cargo. */
export function PersonLinksSkeleton({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SummaryCardShape title="Quién habla por ella" action={canWrite ? <WaitingButton>Vincular a una persona</WaitingButton> : undefined}>
        <RowsShape rows={1} />
      </SummaryCardShape>
      <SummaryCardShape title="A su cargo" action={canWrite ? <WaitingButton>Vincular a un paciente</WaitingButton> : undefined}>
        <RowsShape rows={1} />
      </SummaryCardShape>
    </div>
  )
}

/** Las filas de `PersonChannels`: su canal, su cuenta y cuántas conversaciones. */
export function ChannelRowsSkeleton() {
  return (
    <ul className="flex flex-col divide-y">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <Skeleton className="size-4 shrink-0 rounded-full" />
            <Line className="w-24" />
            <Line className="w-28" />
            <Skeleton className="h-5 w-24 shrink-0 rounded-full max-sm:hidden" />
          </span>
          <ButtonBar className="w-36" />
        </li>
      ))}
    </ul>
  )
}

export function PersonChannelsSkeleton({ canChange }: { canChange: boolean }) {
  return (
    <SummaryCardShape title="Canales" action={canChange ? <WaitingButton>Agregar canal</WaitingButton> : undefined}>
      <ChannelRowsSkeleton />
    </SummaryCardShape>
  )
}

/** Las filas de `ResponsablesTab`. */
export function ResponsibleRowsSkeleton() {
  return (
    <ul className="flex flex-col divide-y">
      {[0, 1].map((row) => (
        <li key={row} className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Line size="base" className="w-40" />
            <Skeleton className="h-5 w-28 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Line className="w-40" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ResponsablesSkeleton({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Responsables</div>
          <p className="text-sm text-muted-foreground">
            El representante legal vigente puede decidir por el paciente; el responsable económico responde por la cuenta. Los
            roles se otorgan con vigencia y se revocan con motivo.
          </p>
        </div>
        {canWrite ? <WaitingButton>Asignar responsabilidad</WaitingButton> : null}
      </div>
      <ResponsibleRowsSkeleton />
    </div>
  )
}

/** `PatientPortalAccessSection`: una fila por quien entra. */
export function PortalAccessSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y rounded-lg border">
        <li className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Line className="w-56" />
            <Line className="w-72" />
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonBar className="w-36" />
            <ButtonBar />
            <ButtonBar className="w-24" />
          </div>
        </li>
      </ul>
    </section>
  )
}

/** `AccesosPanel`: la tarjeta con su explicación y la tabla de consultas. */
export function AccessLogSkeleton() {
  return (
    <section className="elevated rounded-xl border bg-card p-6">
      <h2 className="font-heading text-base font-medium">Consultas a la historia clínica</h2>
      <div className="mt-1">
        <Line className="w-full" />
        <Line className="w-2/3" />
      </div>
      <div className="mt-4">
        <TableShape
          columns={["Quién", "Qué consultó", "Última consulta", "Veces en la hora"]}
          rows={5}
          cell={(column) => <Line className={["w-32", "w-36", "w-28", "w-8"][column]} />}
          listTitle={<Line className="w-32" />}
          listSummary={<Line className="w-40" />}
        />
      </div>
    </section>
  )
}

/** `DataRequestsPanel`: su encabezado y los pedidos. */
export function DataRequestsSkeleton() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Pedidos sobre sus datos</h2>
          <Line className="w-96" />
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonBar className="w-36" />
        </div>
      </div>
      <div className="elevated rounded-xl border bg-card p-5">
        <RowsShape rows={2} />
      </div>
    </section>
  )
}

/** La fila «Odontograma · Periodontograma» de lo que cuelga de una sección. */
export function SubsectionTabs({ label, value, items }: { label: string; value: string; items: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <ParamTabs param="tab" value={value}>
      <TabsList aria-label={label}>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </ParamTabs>
  )
}

/** Para una sección del producto sin esqueleto propio: un bloque, sin inventar lo que trae. */
export function GenericSectionSkeleton() {
  return (
    <div className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <Line size="base" className="w-40" />
      <Line className="w-full" />
      <Line className="w-3/4" />
    </div>
  )
}

/** El esqueleto de la sección abierta, según lo que el rol ve en ella. */
export function PersonSectionSkeleton({
  section,
  can,
  clinicalSummary,
  placeLabel,
  budgetOptional = false,
  own,
}: {
  section: string
  can: SkeletonCan
  /** El Resumen es el clínico: quien lo ve lee la historia y la persona ya es paciente. `unknown`: aún no se sabe si lo es. */
  clinicalSummary: boolean | "unknown"
  /** Cómo se llama un lugar en el producto («Pieza»), si registra dónde. */
  placeLabel?: string
  /** En este producto el presupuesto es opcional (latidIA). */
  budgetOptional?: boolean
  /** El esqueleto propio de una sección del producto (odentIA: el odontograma). */
  own?: ReactNode
}) {
  const canWritePatient = can("patients.write")
  switch (section) {
    case "resumen":
      return <PersonSummarySkeleton clinical={clinicalSummary} can={can} />
    case "conversaciones":
      return <PersonConversationsSkeleton can={can} />
    case "citas":
      return <CitasSkeleton action={can("appointments.write") ? <WaitingButton>Reservar cita</WaitingButton> : undefined} />
    case "antecedentes":
      return <AntecedentesSkeleton canWrite={can("clinical.write")} />
    case "historia":
      return <HistoriaSkeleton placeLabel={placeLabel} canNote={can("clinical.write")} />
    case "documentos":
      return <DocumentosSkeleton canWrite={can("clinical.write")} />
    case "plan":
      return <PlanSkeleton can={can} budgetOptional={budgetOptional} />
    case "cuenta":
      return <AccountSkeleton canWrite={can("finance.write")} />
    case "filiacion":
      return <FiliacionSkeleton canEdit={canWritePatient || can("crm.write")} />
    case "contactos":
      return <PersonLinksSkeleton canWrite={canWritePatient} />
    case "canales":
      return <PersonChannelsSkeleton canChange={can("conversations.write")} />
    case "responsables":
      return <ResponsablesSkeleton canWrite={canWritePatient} />
    case "portal":
      return <PortalAccessSkeleton />
    case "accesos":
      return <AccessLogSkeleton />
    case "pedidos":
      return <DataRequestsSkeleton />
    default:
      return own ?? <GenericSectionSkeleton />
  }
}
