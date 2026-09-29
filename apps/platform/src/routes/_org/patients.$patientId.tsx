import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical"
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { EmptyState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router"
import { AntecedentesTab } from "../../components/patient/antecedentes-tab"
import { ControlesPanel, RecetasPanel } from "../../components/patient/clinical-panels"
import { ConsentimientosTab } from "../../components/patient/consentimientos-tab"
import { CuentaTab } from "../../components/patient/cuenta-tab"
import { FormulariosTab } from "../../components/patient/formularios-tab"
import { HistoriaTab } from "../../components/patient/historia-tab"
import { ImagenesTab } from "../../components/patient/imagenes-tab"
import { OdontogramaTab } from "../../components/patient/odontograma-tab"
import { OrdenesTab } from "../../components/patient/ordenes-tab"
import { PatientHeader } from "../../components/patient/patient-header"
import { PlanTab } from "../../components/patient/plan-tab"
import { RecorridoClinicoTab } from "../../components/patient/recorrido-tab"
import { ResponsablesTab } from "../../components/patient/responsables-tab"
import { ResumenTab } from "../../components/patient/resumen-tab"
import { PortalInvitePanel } from "../../components/portal/portal-invite-panel"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { PatientFull, PatientSummary, PlanItem } from "../../lib/patients"

type TabPermission = "clinical.read" | "finance.read" | "patients.read"

const TABS = [
  { value: "resumen", label: "Resumen", permission: "clinical.read" },
  { value: "recorrido", label: "Recorrido clínico", permission: "clinical.read" },
  { value: "antecedentes", label: "Antecedentes", permission: "clinical.read" },
  { value: "odontograma", label: "Odontograma", permission: "clinical.read" },
  { value: "historia", label: "Historia", permission: "clinical.read" },
  { value: "plan", label: "Planes de tratamiento", permission: "clinical.read" },
  { value: "controles", label: "Controles", permission: "clinical.read" },
  { value: "recetas", label: "Recetas", permission: "clinical.read" },
  { value: "formularios", label: "Formularios", permission: "clinical.read" },
  { value: "consentimientos", label: "Consentimientos", permission: "clinical.read" },
  { value: "ordenes", label: "Órdenes", permission: "clinical.read" },
  { value: "cuenta", label: "Cuenta", permission: "finance.read" },
  { value: "responsables", label: "Responsables", permission: "patients.read" },
  { value: "imagenes", label: "Imágenes y documentos", permission: "clinical.read" },
] as const satisfies ReadonlyArray<{ value: string; label: string; permission: TabPermission }>
type PatientTab = (typeof TABS)[number]["value"]

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
  tab?: PatientTab
  tooth?: number
  planId?: string
  budgetId?: string
  documentId?: string
  itemId?: string
} & Partial<Record<(typeof FILTER_KEYS)[number], string>>
export const Route = createFileRoute("/_org/patients/$patientId")({
  validateSearch: (search: Record<string, unknown>): PatientSearch => {
    const tab = TABS.find((item) => item.value === search.tab)?.value
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

function PatientDetailPage() {
  const { patientId } = Route.useParams()
  const { tab = "resumen", tooth, planId, budgetId, documentId, itemId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const canClinical = usePermission("clinical.read")
  const canFinance = usePermission("finance.read")
  const canPatients = usePermission("patients.read")
  const canTab = (permission: TabPermission) =>
    permission === "clinical.read" ? canClinical : permission === "finance.read" ? canFinance : canPatients
  const visibleTabs = TABS.filter((item) => canTab(item.permission))
  const activeTab = visibleTabs.some((item) => item.value === tab)
    ? tab
    : (visibleTabs[0]?.value ?? "responsables")
  const detail = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canPatients || canClinical || canFinance,
  })
  const summary = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: canClinical,
  })
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
    enabled: canClinical,
  })
  const changeTab = (next: PatientTab, nextTooth?: number) => {
    void navigate({ search: { tab: next, ...(nextTooth ? { tooth: nextTooth } : {}) } })
  }
  const openItem = (nextItemId: string) => {
    void navigate({ search: { tab: "recorrido", itemId: nextItemId } })
  }
  const openTab = (
    next: PatientTab,
    tooth?: number,
    nextItemId?: string,
    nextPlanId?: string,
    nextBudgetId?: string,
  ) => {
    void navigate({
      search: {
        tab: next,
        ...(tooth ? { tooth } : {}),
        ...(nextItemId ? { itemId: nextItemId } : {}),
        ...(nextPlanId ? { planId: nextPlanId } : {}),
        ...(nextBudgetId ? { budgetId: nextBudgetId } : {}),
      },
    })
  }
  if (detail.isLoading)
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </PageShell>
    )
  if (!detail.data)
    return (
      <PageShell>
        <EmptyState
          title="No se pudo cargar el paciente"
          description={detail.error?.message ?? "El paciente no existe."}
        />
      </PageShell>
    )
  return (
    <PageShell className="flex min-w-0 flex-col gap-6">
      <PatientHeader
        detail={detail.data.data}
        summary={summary.data?.data}
        onAntecedentes={() => changeTab("antecedentes")}
      />
      <PortalInvitePanel patientId={patientId} />
      {summary.isError && canClinical && (
        <p role="alert" className="text-sm text-destructive">
          {summary.error.message}
        </p>
      )}
      <Tabs
        className="min-w-0 w-full"
        value={activeTab}
        onValueChange={(value) => {
          if (visibleTabs.some((item) => item.value === value)) changeTab(value as PatientTab)
        }}
      >
        <div className="max-w-full overflow-x-auto border-b pb-1">
          <TabsList className="h-auto flex-wrap justify-start" variant="line" aria-label="Ficha del paciente">
            {visibleTabs.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="resumen" className="pt-4">
          <ResumenTab
            patientId={patientId}
            detail={detail.data.data}
            summary={summary.data?.data}
            onTabChange={openTab}
          />
        </TabsContent>
        <TabsContent value="recorrido" className="pt-4">
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
        </TabsContent>
        <TabsContent value="antecedentes" className="pt-4">
          <AntecedentesTab patientId={patientId} />
        </TabsContent>
        <TabsContent value="odontograma" className="pt-4">
          <OdontogramaTab patientId={patientId} initialTooth={tooth} />
        </TabsContent>
        <TabsContent value="historia" className="pt-4">
          <HistoriaTab
            patientId={patientId}
            initialTooth={tooth}
            onOdontogramSelect={(next) => changeTab("odontograma", next)}
          />
        </TabsContent>
        <TabsContent value="plan" className="pt-4">
          <PlanTab patientId={patientId} initialPlanId={planId} initialBudgetId={budgetId} />
        </TabsContent>
        <TabsContent value="controles" className="pt-4">
          {itemId ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">
                Mostrando solo los controles del tratamiento abierto en el recorrido.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openTab("controles")}
              >
                Ver todos los controles
              </Button>
            </div>
          ) : null}
          <ControlesPanel
            patientId={patientId}
            itemId={itemId}
            items={planItems.data?.data ?? []}
            encounterId={summary.data?.data.openEncounterId ?? undefined}
          />
        </TabsContent>
        <TabsContent value="recetas" className="pt-4">
          {itemId ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">
                Mostrando solo las recetas del tratamiento abierto en el recorrido.
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => openTab("recetas")}>
                Ver todas las recetas
              </Button>
            </div>
          ) : null}
          <RecetasPanel
            patientId={patientId}
            itemId={itemId}
            items={planItems.data?.data ?? []}
            encounterId={summary.data?.data.openEncounterId ?? undefined}
          />
        </TabsContent>
        <TabsContent value="formularios" className="pt-4">
          <FormulariosTab
            patientId={patientId}
            encounterId={summary.data?.data.openEncounterId ?? undefined}
          />
        </TabsContent>
        <TabsContent value="consentimientos" className="pt-4">
          <ConsentimientosTab
            patientId={patientId}
            encounterId={summary.data?.data.openEncounterId ?? undefined}
            planItemId={itemId}
          />
        </TabsContent>
        <TabsContent value="ordenes" className="pt-4">
          <OrdenesTab
            patientId={patientId}
            encounterId={summary.data?.data.openEncounterId ?? undefined}
          />
        </TabsContent>
        <TabsContent value="cuenta" className="pt-4">
          <CuentaTab patientId={patientId} />
        </TabsContent>
        <TabsContent value="responsables" className="pt-4">
          <ResponsablesTab patientId={patientId} />
        </TabsContent>
        <TabsContent value="imagenes" className="pt-4">
          <ImagenesTab patientId={patientId} initialTooth={tooth} initialDocumentId={documentId} />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
