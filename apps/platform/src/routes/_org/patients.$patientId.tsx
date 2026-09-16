import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui";
import { EmptyState } from "@odentia/ui-patterns";
import { HistoriaTab } from "../../components/patient/historia-tab";
import { AntecedentesTab } from "../../components/patient/antecedentes-tab";
import { OdontogramaTab } from "../../components/patient/odontograma-tab";
import { PatientHeader } from "../../components/patient/patient-header";
import { ImagenesTab } from "../../components/patient/imagenes-tab";
import { PlanTab } from "../../components/patient/plan-tab";
import { ResumenTab } from "../../components/patient/resumen-tab";
import { apiFetch } from "../../lib/api";
import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical";
import { type PatientFull, type PatientSummary } from "../../lib/patients";

const TABS = [
  { value: "resumen", label: "Resumen" },
  { value: "antecedentes", label: "Antecedentes" },
  { value: "odontograma", label: "Odontograma" },
  { value: "historia", label: "Historia" },
  { value: "plan", label: "Planes de tratamiento" },
  { value: "imagenes", label: "Imágenes y documentos" },
] as const;
type PatientTab = typeof TABS[number]["value"];

const searchId = (value: unknown): string | undefined =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
const FILTER_KEYS = ["q", "sort", "estado", "decision", "ejecucion", "categoria", "atencion", "tratamiento", "etiqueta"] as const;
type PatientSearch = { tab?: PatientTab; tooth?: number; planId?: string; budgetId?: string; documentId?: string } & Partial<Record<typeof FILTER_KEYS[number], string>>;
export const Route = createFileRoute("/_org/patients/$patientId")({
  validateSearch: (search: Record<string, unknown>): PatientSearch => {
    const tab = TABS.find((item) => item.value === search.tab)?.value;
    const tooth = Number(search.tooth);
    const filters = Object.fromEntries(FILTER_KEYS.flatMap((key) => typeof search[key] === "string" && search[key].length <= 200 ? [[key, search[key]]] : []));
    return { ...filters, ...(tab ? { tab } : {}), ...(FDI_ADULT.includes(tooth) || FDI_CHILD.includes(tooth) ? { tooth } : {}), planId: searchId(search.planId), budgetId: searchId(search.budgetId), documentId: searchId(search.documentId) };
  },
  component: PatientRoute,
});

function PatientRoute() {
  const childRoutes = useChildMatches({ select: (matches) => matches.map((match) => match.routeId) });
  return childRoutes.length > 0 ? <Outlet /> : <PatientDetailPage />;
}

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const { tab = "resumen", tooth, planId, budgetId, documentId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const detail = useQuery({ queryKey: ["patient", patientId], queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`) });
  const summary = useQuery({ queryKey: ["patient-summary", patientId], queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`) });
  const changeTab = (next: PatientTab, nextTooth?: number) => { void navigate({ search: { tab: next, ...(nextTooth ? { tooth: nextTooth } : {}) } }); };
  if (detail.isLoading) return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>;
  if (!detail.data) return <EmptyState title="No se pudo cargar el paciente" description={detail.error?.message ?? "El paciente no existe."} />;
  return <div className="flex min-w-0 flex-col gap-6">
    <PatientHeader detail={detail.data.data} summary={summary.data?.data} onAntecedentes={() => changeTab("antecedentes")} />
    {summary.isError && <p role="alert" className="text-sm text-destructive">{summary.error.message}</p>}
    <Tabs value={tab} onValueChange={(value) => { if (TABS.some((item) => item.value === value)) changeTab(value as PatientTab); }}>
      <div className="max-w-full overflow-x-auto border-b pb-1"><TabsList variant="line" aria-label="Ficha del paciente">{TABS.map((item) => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}</TabsList></div>
      <TabsContent value="resumen" className="pt-4"><ResumenTab patientId={patientId} detail={detail.data.data} summary={summary.data?.data} onTabChange={changeTab} /></TabsContent>
      <TabsContent value="antecedentes" className="pt-4"><AntecedentesTab patientId={patientId} /></TabsContent>
      <TabsContent value="odontograma" className="pt-4"><OdontogramaTab patientId={patientId} initialTooth={tooth} /></TabsContent>
      <TabsContent value="historia" className="pt-4"><HistoriaTab patientId={patientId} initialTooth={tooth} onOdontogramSelect={(next) => changeTab("odontograma", next)} /></TabsContent>
      <TabsContent value="plan" className="pt-4"><PlanTab patientId={patientId} initialPlanId={planId} initialBudgetId={budgetId} /></TabsContent>
      <TabsContent value="imagenes" className="pt-4"><ImagenesTab patientId={patientId} initialTooth={tooth} initialDocumentId={documentId} /></TabsContent>
    </Tabs>
  </div>;
}
