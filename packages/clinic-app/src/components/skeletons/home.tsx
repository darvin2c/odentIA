/**
 * Esqueleto de Inicio: «Te espera» a la izquierda y la tarjeta de hoy a la
 * derecha, con las clases de `home/waiting-list.tsx` y `home/today.tsx`; en el
 * teléfono se apilan solas y las acciones rápidas bajan bajo su fila.
 */
import { Skeleton } from "@odentia/ui"
import { useCan, useMyRole } from "../../lib/crm"
import { homeToday } from "../../lib/screen-rules"
import { PageLoading } from "./page-loading"

/** Como `PHONE_ROWS` de `lib/home`: en el teléfono no se ven las demás. */
const PHONE_ROWS = 5
/** Cuáles traen una acción rápida («Tomar», «Hecha»). */
const WAITING_ROWS = [
  { title: "w-3/5", detail: "w-4/5", action: true },
  { title: "w-2/5", detail: "w-3/5", action: false },
  { title: "w-1/2", detail: "w-3/4", action: true },
  { title: "w-3/5", detail: "w-1/2", action: false },
  { title: "w-2/5", detail: "w-2/3", action: true },
  { title: "w-1/2", detail: "w-3/5", action: false },
]
const TODAY_ROWS = ["w-3/5", "w-1/2", "w-2/3", "w-2/5", "w-1/2"]

function WaitingRowSkeleton({ row, phone }: { row: (typeof WAITING_ROWS)[number]; phone: boolean }) {
  return (
    <li className={phone ? "flex flex-wrap items-center gap-2" : "hidden flex-wrap items-center gap-2 sm:flex"}>
      <div className="flex h-auto min-h-[60px] w-full min-w-0 flex-1 items-center justify-start gap-3 rounded-lg px-2 py-2">
        <Skeleton className="size-9 shrink-0 rounded-full" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 items-center">
            <Skeleton className={`h-3.5 ${row.title}`} />
          </span>
          <span className="flex h-5 items-center">
            <Skeleton className={`h-3 ${row.detail}`} />
          </span>
        </span>
        <Skeleton className="hidden h-3.5 w-12 shrink-0 sm:block" />
      </div>
      {row.action ? (
        <span className="flex shrink-0 flex-col gap-1.5 max-sm:basis-full max-sm:w-full max-sm:flex-row sm:flex-row sm:items-center">
          <Skeleton className="h-11 w-16 shrink-0 rounded-full max-sm:flex-1 sm:h-8" />
        </span>
      ) : null}
    </li>
  )
}

const TODAY_CARD = "elevated flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 sm:p-5"
const TODAY_TITLE = "flex min-w-0 flex-1 items-center gap-2 text-[17px] font-bold tracking-tight"

/** Una fila de la tarjeta: lo que la abre a todo lo ancho. */
function TodayRow({ width }: { width: string }) {
  return (
    <li className="flex items-center gap-2 py-0.5">
      <div className="flex h-auto min-h-11 w-full min-w-0 flex-1 items-center justify-start gap-2.5 rounded-lg px-2.5 py-1.5">
        <Skeleton className="h-3.5 w-12 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
          <Skeleton className={`h-3.5 ${width}`} />
          <Skeleton className="h-3 w-4/5" />
        </span>
        <Skeleton className="h-3.5 w-16 shrink-0" />
      </div>
    </li>
  )
}

/** «Agenda de hoy»: el resumen, cuánto se atendió, las citas y el enlace, que dice cuántas son. */
function TodayAgendaSkeleton() {
  return (
    <section className={TODAY_CARD}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className={TODAY_TITLE}>Agenda de hoy</h2>
      </div>
      <span className="flex h-6 items-center">
        <Skeleton className="h-3.5 w-3/4" />
      </span>
      <div aria-hidden className="h-1.5 rounded-full bg-muted" />
      <ul className="flex flex-col divide-y">
        {TODAY_ROWS.map((width) => (
          <TodayRow key={width} width={width} />
        ))}
      </ul>
      <span className="inline-flex min-h-11 items-center self-start sm:min-h-8">
        <Skeleton className="h-3.5 w-40" />
      </span>
    </section>
  )
}

/** «Mis pacientes de hoy»: su cuenta y sus pacientes; qué grupos hay depende de cómo va el día. */
function TodayPatientsSkeleton() {
  return (
    <section className={TODAY_CARD}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className={TODAY_TITLE}>
          Mis pacientes de hoy
          <Skeleton className="h-5 w-7 rounded-full" />
        </h2>
      </div>
      <ul className="flex flex-col divide-y">
        {TODAY_ROWS.map((width) => (
          <TodayRow key={width} width={width} />
        ))}
      </ul>
      <span className="inline-flex min-h-11 items-center self-start font-semibold text-primary underline underline-offset-4 sm:min-h-8">Ver mi agenda</span>
    </section>
  )
}

/** La tarjeta de quien dirige y atiende: hasta saber si hoy tiene citas propias, sin título ni enlace que luego cambien. */
function TodayUndecidedSkeleton() {
  return (
    <section className={TODAY_CARD}>
      <div className="flex h-[26px] items-center">
        <Skeleton className="h-4 w-40" />
      </div>
      <ul className="flex flex-col divide-y">
        {TODAY_ROWS.map((width) => (
          <TodayRow key={width} width={width} />
        ))}
      </ul>
      <span className="inline-flex min-h-11 items-center self-start sm:min-h-8">
        <Skeleton className="h-3.5 w-40" />
      </span>
    </section>
  )
}

/** «Caja de hoy» de quien solo cobra: lo cobrado y a quién falta cobrar. */
function TodayCashSkeleton() {
  return (
    <section className={TODAY_CARD}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className={TODAY_TITLE}>Caja de hoy</h2>
      </div>
      <span className="flex h-6 items-center">
        <Skeleton className="h-3.5 w-3/4" />
      </span>
      <ul className="flex flex-col">
        {TODAY_ROWS.slice(0, 3).map((width) => (
          <li key={width} className="border-b last:border-b-0">
            <div className="flex min-h-11 w-full items-center justify-start gap-3 rounded-lg px-2.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
                <Skeleton className={`h-3.5 ${width}`} />
                <Skeleton className="h-3 w-4/5" />
              </span>
              <Skeleton className="h-3.5 w-14 shrink-0" />
            </div>
          </li>
        ))}
      </ul>
      <span className="inline-flex min-h-11 items-center self-start font-semibold text-primary underline underline-offset-4 sm:min-h-8">Ir a Caja</span>
    </section>
  )
}

/** La caja en una línea, debajo de la agenda, para quien ve las dos. */
function CashLineSkeleton() {
  return (
    <div className="elevated flex min-h-11 w-full items-center justify-start gap-3 rounded-xl border bg-card px-4 py-4 text-sm sm:px-5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[17px] font-bold tracking-tight">Caja de hoy</span>
        <span className="flex h-5 items-center">
          <Skeleton className="h-3.5 w-3/4" />
        </span>
      </span>
      <span className="shrink-0 font-semibold text-primary">Ir a Caja</span>
    </div>
  )
}

export function HomeSkeleton() {
  const today = homeToday(useMyRole(), useCan())
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-[3_1_30rem]">
        <section className="elevated flex min-w-0 flex-col rounded-xl border bg-card p-3 sm:p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 px-2 pb-1.5">
            <h2 className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
              Te espera
              <Skeleton className="h-5 w-7 rounded-full" />
            </h2>
            <p className="text-sm text-muted-foreground">Por orden de urgencia</p>
          </div>
          <ul className="flex flex-col divide-y">
            {WAITING_ROWS.map((row, index) => (
              <WaitingRowSkeleton key={`${row.title}-${row.detail}`} row={row} phone={index < PHONE_ROWS} />
            ))}
          </ul>
          <div className="mt-1 flex min-h-11 w-full items-center justify-center sm:hidden">
            <Skeleton className="h-3.5 w-28" />
          </div>
        </section>
      </div>
      {today.card ? (
        <div className="flex min-w-0 flex-[2_1_21rem] flex-col gap-4">
          {today.card === "patients" ? (
            <TodayPatientsSkeleton />
          ) : today.card === "agenda" ? (
            <TodayAgendaSkeleton />
          ) : today.card === "undecided" ? (
            <TodayUndecidedSkeleton />
          ) : (
            <TodayCashSkeleton />
          )}
          {today.cashLine ? <CashLineSkeleton /> : null}
        </div>
      ) : null}
    </div>
  )
}

export function HomePageSkeleton() {
  return (
    <PageLoading title="Inicio">
      <div className="flex flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <p className="min-w-0">Lo que te toca hoy</p>
        </div>
        <HomeSkeleton />
      </div>
    </PageLoading>
  )
}
