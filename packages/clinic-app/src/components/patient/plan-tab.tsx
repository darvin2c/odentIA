/**
 * La pestaña «Plan» de la persona (tablero 3, ADR 0034): una sola sección, sin
 * subpestañas. De arriba abajo: «Qué sigue», los tratamientos por fases con su
 * recorrido al lado, el presupuesto, los controles y, plegados, los planes
 * anteriores. Cada rol ve lo suyo:
 * - quien lee la clínica (odontólogo, propietario): todo, con piezas y precios;
 * - recepción: los tratamientos con su título y estado (`treatment-coordination`),
 *   el presupuesto como lo ve la persona y los controles;
 * - caja: el presupuesto y lo aceptado.
 * La autorización real la hace el servidor bloque por bloque.
 */
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@odentia/ui"
import { DetailDrawer, EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, ClipboardList } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { fetchTreatmentPlans } from "../../lib/budgets"
import { usePermission } from "../../lib/crm"
import type { PatientSummary, PlanItem } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { productUi } from "../../product/product-ui"
import { ControlesPanel } from "./clinical-panels"
import { NewEncounterButton } from "./new-encounter-button"
import { PlanBudgets, useScheduleAccepted } from "./plan/plan-budgets"
import { CoordinationControls, CoordinationTreatments } from "./plan/plan-coordination"
import { PlanNextCard, usePlanNextStep } from "./plan/plan-next"
import { PlanPhases } from "./plan-fases"
import { RecorridoClinicoTab } from "./recorrido-tab"

export { treatmentSiteLabel } from "./plan/budget-parts"

function Section({
  title,
  description,
  children,
  sectionRef,
}: {
  title: string
  description?: string
  children: React.ReactNode
  sectionRef?: React.Ref<HTMLElement>
}): React.JSX.Element {
  const id = useId()
  return (
    <section ref={sectionRef} aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="font-heading text-base font-medium">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function PlanTab({
  patientId,
  patientName,
  initialBudgetId,
  initialItemId,
}: {
  patientId: string
  /** Para «Nueva cita»: la persona ya puesta. */
  patientName: string
  /** Planes anteriores: un enlace guardado con `planId` abre la pestaña igual. */
  initialPlanId?: string
  /** Apertura directa desde enlace ?tab=plan&budgetId=:id (la ruta valida el uuid). */
  initialBudgetId?: string
  /** El recorrido de un tratamiento: ?tab=plan&itemId=:id. */
  initialItemId?: string
}): React.JSX.Element {
  const canClinical = usePermission("clinical.read")
  const canBudgets = usePermission("budgets.read")
  const canAgenda = usePermission("appointments.read")
  const controlsRef = useRef<HTMLElement | null>(null)

  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled: canClinical,
  })
  const itemsQuery = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canClinical,
  })
  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canClinical,
  })

  const [focusBudgetId, setFocusBudgetId] = useState<string | undefined>(initialBudgetId)
  const [journeyItemId, setJourneyItemId] = useState<string | null>(initialItemId ?? null)
  useEffect(() => setFocusBudgetId(initialBudgetId), [initialBudgetId])
  useEffect(() => setJourneyItemId(initialItemId ?? null), [initialItemId])

  const plans = plansQuery.data?.data ?? []
  const items = useMemo(() => itemsQuery.data?.data ?? [], [itemsQuery.data])
  const openPlan = plans.find((row) => row.isOpen) ?? plans.at(-1) ?? null
  const openItems = openPlan ? items.filter((item) => item.planId === openPlan.plan.id) : []
  const previous = plans.filter((row) => row.plan.id !== openPlan?.plan.id && row.totalItems > 0)
  const schedule = useScheduleAccepted({ id: patientId, name: patientName })
  // La misma regla de «Qué sigue»: lo aceptado sin cita también se agenda desde la tarjeta del presupuesto.
  const nextStep = usePlanNextStep(patientId).data?.data ?? null



  const journeyItem = items.find((item) => item.id === journeyItemId) ?? null
  const summary = summaryQuery.data?.data ?? null

  return (
    <div className="flex flex-col gap-6">
      <PlanNextCard patientId={patientId} patientName={patientName} />

      {canClinical ? (
        <Section
          title="Tratamientos"
          description="Por fases y en orden. Se indican dentro de una atención; «Ver» abre su recorrido al lado."
        >
          {itemsQuery.isPending || plansQuery.isPending ? (
            <LoadingState message="Cargando tratamientos…" />
          ) : itemsQuery.isError ? (
            <QueryErrorState error={itemsQuery.error} onRetry={() => void itemsQuery.refetch()} />
          ) : openItems.length === 0 ? (
            // Vacío con su acción: los tratamientos se indican dentro de una atención («Atender»).
            <Empty className="rounded-lg border border-dashed border-border bg-surface p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon" aria-hidden>
                  <ClipboardList />
                </EmptyMedia>
                <EmptyTitle>Todavía no tiene tratamientos indicados</EmptyTitle>
                <EmptyDescription>
                  Se indican dentro de una atención, en «Plan y controles»: el plan se abre solo con el primero.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <NewEncounterButton patientId={patientId} variant="outline" />
              </EmptyContent>
            </Empty>
          ) : (
            <PlanPhases
              patientId={patientId}
              items={openItems}
              journeys={summary?.treatmentJourneys ?? []}
              selectedId={journeyItemId ?? ""}
              onSelect={(itemId) => setJourneyItemId(itemId)}
            />
          )}
        </Section>
      ) : canAgenda ? (
        <Section title="Tratamientos" description="Títulos y estados, para agendar y hacer seguimiento.">
          <CoordinationTreatments patientId={patientId} />
        </Section>
      ) : null}

      {canBudgets ? (
        <Section
          title="Presupuesto"
          description={
            productUi().plan.budgetRequired
              ? undefined
              : "Opcional: lo indicado ya queda aceptado. Prepáralo si la persona quiere saber cuánto costará."
          }
        >
          <PlanBudgets
            patientId={patientId}
            planItems={canClinical ? items : null}
            focusBudgetId={focusBudgetId}
            scheduleItemIds={nextStep?.kind === "agendar" ? (nextStep.action?.planItemIds ?? []) : []}
            onSchedule={(planItemIds, serviceId) => schedule(planItemIds, serviceId)}
          />
        </Section>
      ) : null}

      {canClinical ? (
        // ControlesPanel trae su propio título «Controles» y «Indicar control».
        <section ref={controlsRef} aria-label="Controles" className="flex flex-col gap-3">
          <ControlesPanel
            patientId={patientId}
            items={items}
            encounterId={summary?.openEncounterId ?? undefined}
          />
        </section>
      ) : canAgenda ? (
        <Section title="Controles" sectionRef={controlsRef}>
          <CoordinationControls patientId={patientId} scheduleFollowUpId={null} />
        </Section>
      ) : null}

      {canClinical && previous.length > 0 ? (
        <Collapsible className="flex flex-col gap-3">
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto self-start p-0">
                Planes anteriores ({previous.length})
                <ChevronDown
                  aria-hidden
                  className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                />
              </Button>
            }
          />
          <CollapsibleContent className="flex flex-col gap-3">
            <PlanPhases
              patientId={patientId}
              items={items.filter((item) => previous.some((row) => row.plan.id === item.planId))}
              journeys={summary?.treatmentJourneys ?? []}
              selectedId={journeyItemId ?? ""}
              onSelect={(itemId) => setJourneyItemId(itemId)}
            />
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {canClinical ? (
        <DetailDrawer
          open={journeyItem != null}
          size="xl"
          title={journeyItem ? `Recorrido · ${journeyItem.title}` : "Recorrido"}
          description="Qué se observó, qué se propuso, qué se decidió, qué se hizo y qué falta."
          onClose={() => setJourneyItemId(null)}
        >
          {journeyItem ? (
            <RecorridoClinicoTab
              patientId={patientId}
              initialItemId={journeyItem.id}
              showPhases={false}
              onChangeItem={(itemId) => setJourneyItemId(itemId)}
              onTabChange={(target, destination) => {
                // Dentro del Plan: el presupuesto y los controles están en esta misma pestaña.
                setJourneyItemId(null)
                if (target === "plan" && destination?.budgetId) setFocusBudgetId(destination.budgetId)
                if (target === "controles") controlsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" })
              }}
            />
          ) : null}
        </DetailDrawer>
      ) : null}

      {!canClinical && !canBudgets && !canAgenda ? (
        <EmptyState title="Sin acceso al plan" description="Tu rol no ve el plan de tratamiento de esta persona." />
      ) : null}
    </div>
  )
}
