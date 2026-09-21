import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical"
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui"
import { EmptyState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router"
import { AntecedentesTab } from "../../components/patient/antecedentes-tab"
import { ControlesPanel, RecetasPanel } from "../../components/patient/clinical-panels"
import { CuentaTab } from "../../components/patient/cuenta-tab"
import { HistoriaTab } from "../../components/patient/historia-tab"
import { ImagenesTab } from "../../components/patient/imagenes-tab"
import { OdontogramaTab } from "../../components/patient/odontograma-tab"
import { PatientHeader } from "../../components/patient/patient-header"
import { PlanTab } from "../../components/patient/plan-tab"
import { RecorridoClinicoTab } from "../../components/patient/recorrido-tab"
import { ResponsablesTab } from "../../components/patient/responsables-tab"
import { ResumenTab } from "../../components/patient/resumen-tab"
import { apiFetch } from "../../lib/api"
import type { PatientFull, PatientSummary, PlanItem } from "../../lib/patients"

const TABS = [
  { value: "resumen", label: "Resumen" },
  { value: "recorrido", label: "Recorrido clínico" },
  { value: "antecedentes", label: "Antecedentes" },
  { value: "odontograma", label: "Odontograma" },
  { value: "historia", label: "Historia" },
  { value: "plan", label: "Planes de tratamiento" },
  { value: "controles", label: "Controles" },
  { value: "recetas", label: "Recetas" },
  { value: "cuenta", label: "Cuenta" },
  { value: "responsables", label: "Responsables" },
  { value: "imagenes", label: "Imágenes y documentos" },
] as const
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
  const detail = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })
  const summary = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
  })
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
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
      {summary.isError && (
        <p role="alert" className="text-sm text-destructive">
          {summary.error.message}
        </p>
      )}
      <Tabs
        className="min-w-0 w-full"
        value={tab}
        onValueChange={(value) => {
          if (TABS.some((item) => item.value === value)) changeTab(value as PatientTab)
        }}
      >
        <div className="max-w-full overflow-x-auto border-b pb-1">
          <TabsList className="h-auto flex-wrap justify-start" variant="line" aria-label="Ficha del paciente">
            {TABS.map((item) => (
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
