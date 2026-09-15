import { Link } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Badge,
  Button,
} from "@odentia/ui";
import { useState } from "react";
import { useCanWrite } from "../../lib/crm";
import { ageFrom, hcLabel, type PatientFull, type PatientSummary } from "../../lib/patients";
import { FiliacionDrawer } from "./filiacion-drawer";
import { NewEncounterButton } from "./new-encounter-button";
import { PatientAvatar } from "./patient-avatar";

const dateLabel = (value: string) => new Date(value).toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" });

export function PatientHeader({ detail, summary }: { detail: PatientFull; summary?: PatientSummary }) {
  const canWrite = useCanWrite();
  const [editing, setEditing] = useState(false);
  const patient = detail.patient;
  const age = ageFrom(patient.birthDate);
  const identifiers = [patient.docType && patient.docNumber ? `${patient.docType} ${patient.docNumber}` : patient.docNumber, age ? `${age} años` : null, patient.phone].filter(Boolean);
  return (
    <header className="flex flex-col gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/patients" />}>Pacientes</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <PatientAvatar patientId={patient.id} name={detail.displayName} storageKey={patient.avatarStorageKey} />
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-semibold">{detail.displayName}</h1><Badge>{hcLabel(patient.patientNumber)}</Badge></div>
            {identifiers.length > 0 && <p className="text-sm text-muted-foreground">{identifiers.join(" · ")}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && <Button variant="outline" onClick={() => setEditing(true)}>Editar datos</Button>}
          <NewEncounterButton patientId={patient.id} openEncounterId={summary?.openEncounterId} />
        </div>
      </div>
      {detail.activeAllergies.length > 0 || detail.activeConditions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {detail.activeAllergies.map((allergy) => (
            <Badge key={allergy.id} variant={allergy.severity === "leve" ? "secondary" : "destructive"}>
              Alergia: {allergy.substance}
            </Badge>
          ))}
          {detail.activeConditions.map((condition) => (
            <Badge key={condition.id} variant="warning">
              {condition.name}
            </Badge>
          ))}
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Última atención: {summary ? summary.lastEncounter ? dateLabel(summary.lastEncounter.finalizedAt ?? summary.lastEncounter.createdAt) : "Sin atenciones" : "Cargando…"}
        {" · "}
        Próxima cita: {summary ? summary.nextAppointmentAt ? dateLabel(summary.nextAppointmentAt) : "No programada" : "Cargando…"}
        {summary ? ` · Plan: ${summary.planPending.count} pendientes${summary.planPending.totals.map((total) => ` · ${new Intl.NumberFormat("es-PE", { style: "currency", currency: total.currency }).format(total.totalCents / 100)}`).join("")}` : ""}
      </p>
      <FiliacionDrawer patientId={patient.id} detail={detail} open={editing} onOpenChange={setEditing} />
    </header>
  );
}
