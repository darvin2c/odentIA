import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical"
import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import { ErrorState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { AccesosPanel } from "../../components/patient/accesos-panel"
import { ActividadPanel } from "../../components/patient/actividad-panel"
import { AntecedentesTab } from "../../components/patient/antecedentes-tab"
import { AtencionesTab } from "../../components/patient/atenciones-tab"
import { CitasPanel } from "../../components/patient/citas-panel"
import { ControlesPanel, RecetasPanel } from "../../components/patient/clinical-panels"
import { ConsentimientosTab } from "../../components/patient/consentimientos-tab"
import { CoordinacionPanel } from "../../components/patient/coordinacion-panel"
import { CuentaTab } from "../../components/patient/cuenta-tab"
import { DocumentosPanel } from "../../components/patient/documentos-panel"
import { FiliacionPanel } from "../../components/patient/filiacion-panel"
import { FormulariosTab } from "../../components/patient/formularios-tab"
import { HistoriaTab } from "../../components/patient/historia-tab"
import { ImagenesTab } from "../../components/patient/imagenes-tab"
import { OdontogramaTab } from "../../components/patient/odontograma-tab"
import { OrdenesTab } from "../../components/patient/ordenes-tab"
import { PatientContactSection } from "../../components/patient/patient-contact-section"
import { PatientHeader } from "../../components/patient/patient-header"
import { PlanTab } from "../../components/patient/plan-tab"
import { RecorridoClinicoTab } from "../../components/patient/recorrido-tab"
import { ResponsablesTab } from "../../components/patient/responsables-tab"
import { ResumenTab } from "../../components/patient/resumen-tab"
import { SeguimientoPanel } from "../../components/patient/seguimiento-panel"
import { PatientPortalAccessSection } from "../../components/portal/portal-access-section"
import { apiFetch } from "../../lib/api"
import { useCan } from "../../lib/crm"
import {
  areaNav,
  isPatientSectionId,
  type PatientSectionId,
  resolveSection,
  PATIENT_AREAS,
  sectionOf,
  visibleAreas,
  visibleSections,
} from "../../lib/patient-areas"

const areaLabel = (id: string) => PATIENT_AREAS.find((area) => area.id === id)?.label ?? id
import type { PatientFull, PatientSummary, PlanItem } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"

const searchId = (value: unknown): string | undefined =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined
const FILTER_KEYS = [
  "q",
  "sort",
  "estado",
  "decision",
  "ejecucion",
  "categoria",
  "atencion",
  "tratamiento",
  "etiqueta",
] as const
type PatientSearch = {
  /** Sección abierta. El área se deriva de ella (ver `lib/patient-areas`). */
  tab?: PatientSectionId
  tooth?: number
  planId?: string
  budgetId?: string
  documentId?: string
  itemId?: string
} & Partial<Record<(typeof FILTER_KEYS)[number], string>>
export const Route = createFileRoute("/_org/patients/$patientId")({
  validateSearch: (search: Record<string, unknown>): PatientSearch => {
    const tab = isPatientSectionId(search.tab) ? search.tab : undefined
    const tooth = Number(search.tooth)
    const filters = Object.fromEntries(
      FILTER_KEYS.flatMap((key) =>
        typeof search[key] === "string" && search[key].length <= 200 ? [[key, search[key]]] : [],
      ),
    )
    return {
      ...filters,
      ...(tab ? { tab } : {}),
      ...(FDI_ADULT.includes(tooth) || FDI_CHILD.includes(tooth) ? { tooth } : {}),
      planId: searchId(search.planId),
      budgetId: searchId(search.budgetId),
      documentId: searchId(search.documentId),
      itemId: searchId(search.itemId),
    }
  },
  component: PatientRoute,
})

function PatientRoute() {
  const childRoutes = useChildMatches({
    select: (matches) => matches.map((match) => match.routeId),
  })
  return childRoutes.length > 0 ? <Outlet /> : <PatientDetailPage />
}

/** Áreas: pocas y cortas; pueden envolver. La altura fija de la primitiva se libera para no solapar. */
const TAB_LIST_CLASS = "group-data-horizontal/tabs:h-auto max-w-full flex-wrap justify-start"
/** Secciones: una sola fila con scroll horizontal propio; en móvil no empujan ni tapan el contenido. */
const SECTION_SCROLL_CLASS = "max-w-full overflow-x-auto pb-1"
const SECTION_LIST_CLASS = "w-max flex-nowrap justify-start"

function PatientDetailPage() {
  const { patientId } = Route.useParams()
  const { tab, tooth, planId, budgetId, documentId, itemId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const can = useCan()
  const canClinical = can("clinical.read")
  const section = resolveSection(tab, can)
  const detail = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: section !== null,
    retry: false,
  })
  const summary = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canClinical,
    retry: false,
  })
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canClinical,
    retry: false,
  })
  const openTab = (
    next: PatientSectionId,
    nextTooth?: number,
    nextItemId?: string,
    nextPlanId?: string,
    nextBudgetId?: string,
  ) => {
    void navigate({
      search: {
        tab: next,
        ...(nextTooth ? { tooth: nextTooth } : {}),
        ...(nextItemId ? { itemId: nextItemId } : {}),
        ...(nextPlanId ? { planId: nextPlanId } : {}),
        ...(nextBudgetId ? { budgetId: nextBudgetId } : {}),
      },
    })
  }
  const openItem = (nextItemId: string) => openTab("recorrido", undefined, nextItemId)

  if (section === null)
    return (
      <PageShell>
        <ErrorState
          title="Sin acceso"
          message="No tienes permiso para consultar esta ficha. Solicita acceso a la administración."
        />
      </PageShell>
    )
  if (detail.isPending)
    return (
      <PageShell>
        <LoadingState message="Cargando paciente…" />
      </PageShell>
    )
  if (detail.isError)
    return (
      <PageShell>
        <QueryErrorState
          error={detail.error}
          onRetry={() => {
            void detail.refetch()
          }}
          notFound="El paciente solicitado no existe o ya no está disponible. Vuelve a la lista de pacientes."
        />
      </PageShell>
    )

  const patient = detail.data.data
  const current = sectionOf(section)
  const areas = visibleAreas(can)
  const entries = areaNav(current.area, can)
  const entry = entries.find((item) => item.value === (current.group ?? current.id))
  const openEncounterId = summary.data?.data.openEncounterId ?? undefined

  /** Paneles que listan por tratamiento: esperan el plan y el resumen clínico. */
  const withPlan = (render: (items: PlanItem[]) => ReactNode): ReactNode => {
    if (planItems.isPending || summary.isPending)
      return <LoadingState message="Cargando tratamientos…" />
    if (planItems.isError)
      return (
        <QueryErrorState
          error={planItems.error}
          onRetry={() => {
            void planItems.refetch()
          }}
        />
      )
    if (summary.isError)
      return (
        <QueryErrorState
          error={summary.error}
          onRetry={() => {
            void summary.refetch()
          }}
        />
      )
    return render(planItems.data.data)
  }
  const itemFilterNotice = (label: string, target: PatientSectionId) =>
    itemId ? (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
        <span className="text-muted-foreground">
          Mostrando solo {label} del tratamiento abierto.
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => openTab(target)}>
          Ver todo
        </Button>
      </div>
    ) : null

  const content = (): ReactNode => {
    switch (section) {
      case "resumen":
        return (
          <ResumenTab
            patientId={patientId}
            detail={patient}
            summary={summary.data?.data}
            onTabChange={openTab}
          />
        )
      case "odontograma":
        return (
          <OdontogramaTab
            patientId={patientId}
            initialTooth={tooth}
            birthDate={patient.patient.birthDate}
            onOpenItem={openItem}
            onOpenPlans={() => openTab("plan")}
          />
        )
      case "recorrido":
        return (
          <RecorridoClinicoTab
            patientId={patientId}
            initialItemId={itemId}
            onChangeItem={openItem}
            onTabChange={(target, destination) =>
              openTab(
                target,
                destination?.tooth,
                destination?.itemId,
                destination?.planId,
                destination?.budgetId,
              )
            }
          />
        )
      case "plan":
        return <PlanTab patientId={patientId} initialPlanId={planId} initialBudgetId={budgetId} />
      case "controles":
        return (
          <>
            {itemFilterNotice("los controles", "controles")}
            {withPlan((items) => (
              <ControlesPanel
                patientId={patientId}
                itemId={itemId}
                items={items}
                encounterId={openEncounterId}
              />
            ))}
          </>
        )
      case "atenciones":
        return <AtencionesTab patientId={patientId} />
      case "historia":
        return (
          <HistoriaTab
            patientId={patientId}
            initialTooth={tooth}
            onOdontogramSelect={(next) => openTab("odontograma", next)}
          />
        )
      case "antecedentes":
        return <AntecedentesTab patientId={patientId} />
      case "documentos":
        return (
          <DocumentosPanel
            patientId={patientId}
            onOpen={(target, nextDocumentId) =>
              void navigate({
                search: { tab: target, ...(nextDocumentId ? { documentId: nextDocumentId } : {}) },
              })
            }
          />
        )
      case "imagenes":
        return (
          <ImagenesTab patientId={patientId} initialTooth={tooth} initialDocumentId={documentId} />
        )
      case "recetas":
        return (
          <>
            {itemFilterNotice("las recetas", "recetas")}
            {withPlan((items) => (
              <RecetasPanel
                patientId={patientId}
                itemId={itemId}
                items={items}
                encounterId={openEncounterId}
              />
            ))}
          </>
        )
      case "ordenes":
        return <OrdenesTab patientId={patientId} encounterId={openEncounterId} />
      case "formularios":
        return <FormulariosTab patientId={patientId} encounterId={openEncounterId} />
      case "consentimientos":
        return (
          <ConsentimientosTab
            patientId={patientId}
            encounterId={openEncounterId}
            planItemId={itemId}
          />
        )
      case "actividad":
        return <ActividadPanel patientId={patientId} detail={patient} onSection={openTab} />
      case "seguimiento":
        return <SeguimientoPanel detail={patient} />
      case "citas":
        return <CitasPanel patientId={patientId} />
      case "coordinacion":
        return <CoordinacionPanel patientId={patientId} />
      case "contactos":
        return <PatientContactSection detail={patient} />
      case "cuenta":
        return <CuentaTab patientId={patientId} />
      case "filiacion":
        return <FiliacionPanel detail={patient} />
      case "responsables":
        return <ResponsablesTab patientId={patientId} />
      case "portal":
        return <PatientPortalAccessSection patientId={patientId} />
      case "accesos":
        return <AccesosPanel patientId={patientId} />
    }
  }

  const sectionBody =
    entry && entry.members.length > 1 ? (
      <Tabs
        className="min-w-0 w-full"
        value={section}
        onValueChange={(value) => {
          if (isPatientSectionId(value)) openTab(value)
        }}
      >
        <div className={`hidden sm:block ${SECTION_SCROLL_CLASS}`}>
          <TabsList
            className={SECTION_LIST_CLASS}
            variant="line"
            aria-label={`Tipo de ${entry.label}`}
          >
            {entry.members.map((member) => (
              <TabsTrigger key={member.id} value={member.id}>
                {member.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={section} className="pt-4">
          {content()}
        </TabsContent>
      </Tabs>
    ) : (
      content()
    )

  // En móvil las tres filas de pestañas ocupan media pantalla: un único
  // selector de sección agrupado por área las reemplaza (mismo ?tab=).
  const allSections = visibleSections(can)
  const mobileNav = (
    <div className="sm:hidden">
      <label htmlFor="patient-section-mobile" className="mb-1 block text-xs font-medium text-muted-foreground">
        Sección de la ficha
      </label>
      <Select
        items={Object.fromEntries(
          allSections.map((s) => [
            s.id,
            s.group ? `${areaLabel(s.area)} · Documentos · ${s.label}` : `${areaLabel(s.area)} · ${s.label}`,
          ]),
        )}
        value={section}
        onValueChange={(value) => {
          if (isPatientSectionId(value)) openTab(value)
        }}
      >
        <SelectTrigger id="patient-section-mobile" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {areas.map((area) => (
            <SelectGroup key={area.id}>
              <SelectLabel>{area.label}</SelectLabel>
              {allSections
                .filter((s) => s.area === area.id)
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.group ? `Documentos · ${s.label}` : s.label}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <PageShell className="flex min-w-0 flex-col gap-6">
      <PatientHeader
        detail={patient}
        summary={canClinical && summary.isSuccess ? summary.data.data : undefined}
        onAntecedentes={canClinical ? () => openTab("antecedentes") : undefined}
        onSection={openTab}
      />
      <Tabs
        className="min-w-0 w-full"
        value={current.area}
        onValueChange={(value) => {
          const target = areas.find((area) => area.id === value)?.target
          if (target) openTab(target)
        }}
      >
        {mobileNav}
        <div className="hidden max-w-full overflow-x-auto border-b pb-1 sm:block">
          <TabsList className={TAB_LIST_CLASS} variant="line" aria-label="Áreas de la ficha">
            {areas.map((area) => (
              <TabsTrigger key={area.id} value={area.id}>
                {area.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={current.area} className="pt-4">
          {entries.length > 1 && entry ? (
            <Tabs
              className="min-w-0 w-full gap-4"
              value={entry.value}
              onValueChange={(value) => {
                const target = entries.find((item) => item.value === value)?.target
                if (target) openTab(target)
              }}
            >
              <div className={`hidden sm:block ${SECTION_SCROLL_CLASS}`}>
                <TabsList
                  className={SECTION_LIST_CLASS}
                  aria-label={`Secciones de ${areas.find((area) => area.id === current.area)?.label ?? "la ficha"}`}
                >
                  {entries.map((item) => (
                    <TabsTrigger key={item.value} value={item.value}>
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value={entry.value}>{sectionBody}</TabsContent>
            </Tabs>
          ) : (
            sectionBody
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
