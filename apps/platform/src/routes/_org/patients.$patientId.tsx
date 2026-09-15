import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useChildMatches, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@odentia/ui";
import { EmptyState } from "@odentia/ui-patterns";
import { HistoriaTab } from "../../components/patient/historia-tab";
import { ImagenesTab } from "../../components/patient/imagenes-tab";
import { OdontogramaTab } from "../../components/patient/odontograma-tab";
import { PatientHeader } from "../../components/patient/patient-header";
import { PlanTab } from "../../components/patient/plan-tab";
import { ResumenTab } from "../../components/patient/resumen-tab";
import { apiFetch } from "../../lib/api";
import { FDI_ADULT, FDI_CHILD, type PatientFull, type PatientSummary } from "../../lib/patients";

const TABS = [
  { value: "resumen", label: "Resumen" },
  { value: "odontograma", label: "Odontograma" },
  { value: "historia", label: "Historia" },
  { value: "plan", label: "Plan" },
  { value: "imagenes", label: "Imágenes" },
] as const;
type PatientTab = typeof TABS[number]["value"];

export const Route = createFileRoute("/_org/patients/$patientId")({
  validateSearch: (search: Record<string, unknown>): { tab?: PatientTab; tooth?: number } => {
    const tab = TABS.find((item) => item.value === search.tab)?.value;
    const tooth = Number(search.tooth);
    return { ...(tab ? { tab } : {}), ...(FDI_ADULT.includes(tooth) || FDI_CHILD.includes(tooth) ? { tooth } : {}) };
  },
  component: PatientRoute,
});

function PatientRoute() {
  const hasChild = useChildMatches({ select: (matches) => matches.length > 0 });
  return hasChild ? <Outlet /> : <PatientDetailPage />;
}

function PatientDetailPage() {
  const { patientId } = Route.useParams();
  const { tab = "resumen", tooth } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const detail = useQuery({ queryKey: ["patient", patientId], queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`) });
  const summary = useQuery({ queryKey: ["patient-summary", patientId], queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`) });
  const changeTab = (next: PatientTab, nextTooth?: number) => { void navigate({ search: { tab: next, ...(nextTooth ? { tooth: nextTooth } : {}) } }); };
  if (detail.isLoading) return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>;
  if (!detail.data) return <EmptyState title="No se pudo cargar el paciente" description={detail.error?.message ?? "El paciente no existe."} />;
  return <div className="flex flex-col gap-6">
    <PatientHeader detail={detail.data.data} summary={summary.data?.data} />
    {summary.isError && <p role="alert" className="text-sm text-destructive">{summary.error.message}</p>}
    <Tabs value={tab} onValueChange={(value) => { if (TABS.some((item) => item.value === value)) changeTab(value as PatientTab); }}>
      <TabsList className="max-w-full overflow-x-auto overflow-y-hidden" aria-label="Ficha del paciente">{TABS.map((item) => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}</TabsList>
      <TabsContent value="resumen" className="pt-4"><ResumenTab patientId={patientId} detail={detail.data.data} summary={summary.data?.data} onTabChange={changeTab} /></TabsContent>
      <TabsContent value="odontograma" className="pt-4"><OdontogramaTab patientId={patientId} initialTooth={tooth} onToothSelect={(next) => changeTab("odontograma", next)} /></TabsContent>
      <TabsContent value="historia" className="pt-4"><HistoriaTab patientId={patientId} initialTooth={tooth} onOdontogramSelect={(next) => changeTab("odontograma", next)} /></TabsContent>
      <TabsContent value="plan" className="pt-4"><PlanTab patientId={patientId} /></TabsContent>
      <TabsContent value="imagenes" className="pt-4"><ImagenesTab patientId={patientId} initialTooth={tooth} /></TabsContent>
    </Tabs>
  </div>;
}
