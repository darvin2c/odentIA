import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@odentia/ui";
import { KpiCard } from "@odentia/ui-patterns";
import { ClipboardList } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { timeAgo, useCanWrite } from "../../lib/crm";
import type {
  AnamnesisAnswers,
  ClinicalNote,
  PatientFull,
  PatientSummary,
  PlanItem,
} from "../../lib/patients";
import { AnamnesisDrawer } from "./anamnesis-drawer";
import { AntecedentesCards } from "./antecedentes-cards";

export type ResumenTabTarget = "plan" | "historia" | "odontograma";

function money(totalCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency }).format(totalCents / 100);
  } catch {
    return `${(totalCents / 100).toFixed(2)} ${currency}`;
  }
}

function motivoOf(answers: AnamnesisAnswers | undefined): string {
  if (!answers || typeof answers.motivoConsulta !== "string") return "";
  return answers.motivoConsulta;
}

/** Resumen clínico del paciente: alertas, diagnósticos, plan pendiente, última atención y antecedentes. */
export function ResumenTab({
  patientId,
  detail,
  summary,
  onTabChange,
}: {
  patientId: string;
  detail: PatientFull;
  summary?: PatientSummary;
  onTabChange: (tab: ResumenTabTarget, tooth?: number) => void;
}) {
  const canWrite = useCanWrite();
  const [anamnesisOpen, setAnamnesisOpen] = useState(false);

  const allergiesQuery = useQuery({
    queryKey: ["patient-allergies", patientId],
    queryFn: () => apiFetch<{ data: unknown[] }>(`/api/patients/${patientId}/allergies`),
  });
  const conditionsQuery = useQuery({
    queryKey: ["patient-conditions", patientId],
    queryFn: () => apiFetch<{ data: unknown[] }>(`/api/patients/${patientId}/conditions`),
  });
  const medicationsQuery = useQuery({
    queryKey: ["patient-medications", patientId],
    queryFn: () => apiFetch<{ data: unknown[] }>(`/api/patients/${patientId}/medications`),
  });

  const summaryQuery = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: summary === undefined,
  });
  const planQuery = useQuery({
    queryKey: ["plan", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  });
  const notesQuery = useQuery({
    queryKey: ["patient-notes", patientId],
    queryFn: () => apiFetch<{ data: ClinicalNote[] }>(`/api/patients/${patientId}/notes`),
  });
  const anamnesisQuery = useQuery({
    queryKey: ["patient-anamnesis", patientId],
    queryFn: () =>
      apiFetch<{ data: { version: number; createdAt: string; answers: AnamnesisAnswers } }>(
        `/api/patients/${patientId}/anamnesis`,
      ),
    retry: false,
  });

  const triageLoaded =
    allergiesQuery.isFetched && conditionsQuery.isFetched && medicationsQuery.isFetched && anamnesisQuery.isFetched;
  const triageEmpty =
    (allergiesQuery.data?.data.length ?? 0) === 0 &&
    (conditionsQuery.data?.data.length ?? 0) === 0 &&
    (medicationsQuery.data?.data.length ?? 0) === 0 &&
    anamnesisQuery.data == null;

  const resolved = summary ?? summaryQuery.data?.data ?? null;
  const notes = notesQuery.data?.data ?? [];
  const pendingItems = (planQuery.data?.data ?? []).filter((i) => i.status === "pendiente").slice(0, 5);
  const lastEncounter = resolved?.lastEncounter ?? null;
  const unlinkedNote = notes.find((n) => n.encounterId == null) ?? null;
  const anamnesis = anamnesisQuery.data?.data ?? null;
  const motivo = motivoOf(anamnesis?.answers);

  const totals = resolved?.planPending.totals ?? [];
  const totalsText =
    totals.length === 0
      ? "Sin montos registrados"
      : totals.map((t) => `${money(t.totalCents, t.currency)} (${t.count})`).join(" · ");

  return (
    <div className="flex flex-col gap-4">
      {canWrite && triageLoaded && triageEmpty ? (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <div className="flex items-start gap-2">
              <ClipboardList className="mt-0.5 size-4 text-primary" aria-hidden="true" />
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">Este paciente aún no tiene triaje clínico.</p>
                <p className="text-xs text-muted-foreground">
                  Registra alergias, condiciones, medicación y anamnesis en un solo paso.
                </p>
              </div>
            </div>
            <Link
              to="/patients/$patientId/triaje"
              params={{ patientId }}
              className={buttonVariants()}
            >
              Iniciar triaje
            </Link>
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Alertas médicas</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {detail.activeAllergies.length === 0 && detail.activeConditions.length === 0 && (
              <p className="text-sm text-muted-foreground">Sin alertas médicas registradas.</p>
            )}
            {detail.activeAllergies.map((a) => (
              <Badge key={a.id} variant={a.severity === "leve" ? "secondary" : "destructive"}>
                Alergia: {a.substance} ({a.severity})
              </Badge>
            ))}
            {detail.activeConditions.map((c) => (
              <Badge key={c.id} variant="warning">
                {c.name}
              </Badge>
            ))}
            {detail.currentMedications.length > 0 && (
              <div className="mt-1">
                <p className="text-xs font-medium text-muted-foreground">Medicación actual</p>
                {detail.currentMedications.map((m) => (
                  <p key={m.id} className="text-sm">
                    {m.name}
                    {m.dose && <span className="text-muted-foreground"> · {m.dose}</span>}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <KpiCard
            title="Ítems pendientes del plan"
            value={resolved?.planPending.count ?? (planQuery.data ? pendingItems.length : "—")}
            description={totalsText}
          />
          <Card>
            <CardHeader>
              <CardTitle>Próximos por atender</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {planQuery.isError && (
                <p role="alert" className="text-sm text-destructive">
                  No se pudo cargar el plan de tratamiento.
                </p>
              )}
              {pendingItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0"
                >
                  <span>
                    {item.title}
                    {item.toothNumber != null && (
                      <span className="text-muted-foreground"> · P{item.toothNumber}</span>
                    )}
                  </span>
                  {item.priceCents != null && (
                    <span className="text-muted-foreground">{money(item.priceCents, item.currency)}</span>
                  )}
                </div>
              ))}
              <div>
                <Button size="sm" variant="outline" onClick={() => onTabChange("plan")}>
                  Ver plan
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Última atención</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {lastEncounter ? (
              <div className="flex flex-col gap-1">
                <p className="text-sm">
                  {lastEncounter.reason || "Atención finalizada"}{" "}
                  <span className="text-muted-foreground">· {timeAgo(lastEncounter.finalizedAt)}</span>
                </p>
                {lastEncounter.nextStep && <p className="text-sm">{lastEncounter.nextStep}</p>}
                <div>
                  <Button size="sm" variant="outline" onClick={() => onTabChange("historia")}>
                    Ver historia
                  </Button>
                </div>
              </div>
            ) : unlinkedNote ? (
              <div className="flex flex-col gap-1">
                <p className="text-sm">{unlinkedNote.note}</p>
                <p className="text-xs text-muted-foreground">
                  {timeAgo(unlinkedNote.createdAt)}
                  {unlinkedNote.diagnosisCode && (
                    <>
                      {" · "} <Badge>{unlinkedNote.diagnosisCode}</Badge>
                    </>
                  )}
                </p>
                <div>
                  <Button size="sm" variant="outline" onClick={() => onTabChange("historia")}>
                    Ver historia
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Sin atenciones ni notas clínicas.</p>
            )}
            {resolved?.openEncounterId && (
              <p className="text-sm text-muted-foreground">Con borrador de atención abierto.</p>
            )}
            {resolved?.nextAppointmentAt && (
              <p className="text-sm">
                Próxima cita:{" "}
                {new Date(resolved.nextAppointmentAt).toLocaleDateString("es-PE", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}{" "}
                <span className="text-muted-foreground">({timeAgo(resolved.nextAppointmentAt)})</span>
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Última anamnesis</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {anamnesisQuery.isError ? (
              <p className="text-sm text-muted-foreground">Sin anamnesis.</p>
            ) : anamnesis ? (
              <>
                <p className="text-sm">
                  Versión {anamnesis.version} · {timeAgo(anamnesis.createdAt)}
                </p>
                {motivo !== "" && <p className="text-sm text-muted-foreground">{motivo}</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Cargando…</p>
            )}
            <div>
              <Button disabled={!canWrite} onClick={() => setAnamnesisOpen(true)}>
                Nueva anamnesis
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <AntecedentesCards patientId={patientId} />

      <AnamnesisDrawer patientId={patientId} open={anamnesisOpen} onOpenChange={setAnamnesisOpen} />
    </div>
  );
}
