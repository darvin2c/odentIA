/**
 * Esqueletos de la atención, antes de saber si es un borrador o está cerrada:
 * `EncounterEditor` para quien escribe en la historia (es lo que suele abrir) y
 * la lectura de `patients.$patientId.encounters.$encounterId.tsx` para los demás.
 */
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator, Button, Skeleton } from "@odentia/ui"
import { PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import { HeaderShape, Line } from "./person-parts"

function EncounterCrumbShape() {
  return (
    <div className="min-w-0 basis-full">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>Pacientes</BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <Skeleton className="h-4 w-28" />
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Atención</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  )
}

/** El borrador: alertas, cabecera, bloques, «Agregar si ocurrió», cierre y el pie fijo. */
export function EncounterEditorSkeleton() {
  return (
    <div className="flex flex-col gap-4 pb-20">
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-40 rounded-full" />
        <Skeleton className="h-5 w-28 rounded-full" />
      </div>
      <HeaderShape />
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <EncounterCrumbShape />
        <Line className="w-64" />
        <Skeleton className="h-7 w-28 rounded-full" />
        <Button type="button" size="sm" variant="outline" disabled>
          Antecedentes y última atención
        </Button>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-col gap-4">
          {/* «Dictar la atención» con sus ejemplos: el bloque más alto al llegar. */}
          <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:p-6">
            <Line size="base" className="w-40" />
            <Line className="w-4/5" />
            <Skeleton className="h-9 w-24 rounded-full" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </section>
          {["w-24", "w-40", "w-28", "w-32", "w-28", "w-64"].map((width) => (
            <section key={width} className="flex flex-wrap items-start justify-between gap-3 rounded-sm bg-card p-6">
              <div className="flex min-w-0 flex-col gap-1">
                <Line size="base" className={width} />
                <Line className="w-56" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-8 w-16 rounded-full" />
              </div>
            </section>
          ))}
        </div>
        <section className="flex flex-col gap-3 rounded-sm bg-card p-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-medium">Agregar si ocurrió</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-11 w-28 rounded-full sm:h-8" />
            <Skeleton className="h-11 w-24 rounded-full sm:h-8" />
          </div>
        </section>
        <section className="flex flex-col gap-4 rounded-sm bg-card p-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-heading text-base font-medium">Cierre de la atención</h2>
            <p className="text-sm text-muted-foreground">
              Al cerrar se firma con tu colegiatura y la atención queda inmutable: después solo se agregan adendas.
            </p>
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {[0, 1, 2, 3].map((row) => (
              <li key={row} className="flex flex-wrap items-center gap-2">
                <Skeleton className="size-5 rounded-full" />
                <Line className="w-40" />
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <Line className="w-48" />
        <Button type="button" disabled>
          Finalizar y firmar
        </Button>
      </div>
    </div>
  )
}

/** La atención ya cerrada, para leer: sus datos, sus documentos y los controles. */
export function EncounterDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col">
        <HeaderShape titleClassName="w-64" />
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <EncounterCrumbShape />
          <Line className="w-96" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
            {["Motivo", "Enfermedad actual", "Evolución", "Indicaciones"].map((label) => (
              <div key={label}>
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd>
                  <Line className="w-3/4" />
                  <Line className="w-1/2" />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <section className="flex flex-col gap-3 elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Documentos</h2>
        <Line className="w-2/3" />
        <Line className="w-1/2" />
      </section>
      <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
        <Line size="base" className="w-32" />
        <Line className="w-full" />
      </div>
    </div>
  )
}

/** La pantalla de la atención mientras llegan su código y sus datos. */
export function EncounterPageSkeleton({ draft = true }: { draft?: boolean }) {
  return (
    <PageShell className={draft ? "flex flex-col gap-4" : "flex flex-col gap-6"}>
      <SkeletonRegion message="Cargando atención…">{draft ? <EncounterEditorSkeleton /> : <EncounterDetailSkeleton />}</SkeletonRegion>
    </PageShell>
  )
}
