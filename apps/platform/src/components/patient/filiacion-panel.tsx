import { Button } from "@odentia/ui"
import type { ReactNode } from "react"
import { useState } from "react"
import { usePermission } from "../../lib/crm"
import { sexLabel } from "../../lib/patient-overview"
import { ageFrom, type PatientFull } from "../../lib/patients"
import { FiliacionDrawer } from "./filiacion-drawer"

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  )
}

const missing = <span className="text-muted-foreground">No registrado</span>

/** Filiación en un solo lugar de la ficha: lectura completa y edición desde aquí. */
export function FiliacionPanel({ detail }: { detail: PatientFull }) {
  const canWrite = usePermission("patients.write")
  const [editing, setEditing] = useState(false)
  const patient = detail.patient
  const age = ageFrom(patient.birthDate)
  return (
    <section className="elevated rounded-xl border bg-card p-6" aria-labelledby="filiacion-titulo">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id="filiacion-titulo" className="font-heading text-base font-medium">
          Filiación
        </h2>
        {canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            Editar datos personales
          </Button>
        ) : null}
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Nombre completo">{patient.displayName}</Field>
        <Field label="Documento">
          {patient.docType && patient.docNumber
            ? `${patient.docType} ${patient.docNumber}`
            : (patient.docNumber ?? missing)}
        </Field>
        <Field label="Nacimiento / edad">
          {patient.birthDate ? `${patient.birthDate}${age ? ` · ${age} años` : ""}` : missing}
        </Field>
        <Field label="Sexo">{patient.sex ? sexLabel(patient.sex) : missing}</Field>
        <Field label="Teléfono">{patient.phone ?? missing}</Field>
        <Field label="Correo">{patient.email ?? missing}</Field>
        <Field label="Dirección">{patient.address ?? missing}</Field>
        <Field label="Seguro">
          {patient.insuranceType
            ? `${patient.insuranceType}${patient.insuranceDetail ? ` · ${patient.insuranceDetail}` : ""}`
            : missing}
        </Field>
        <Field label="Contacto de emergencia">
          {patient.emergencyContactName
            ? `${patient.emergencyContactName}${patient.emergencyContactPhone ? ` · ${patient.emergencyContactPhone}` : ""}`
            : missing}
        </Field>
        <Field label="Consentimiento de datos">
          {typeof patient.dataConsentAt === "string"
            ? `Registrado el ${new Date(patient.dataConsentAt).toLocaleDateString("es-PE", { day: "numeric", month: "short", year: "numeric" })}`
            : "No registrado"}
        </Field>
        <Field label="Origen / referencia">{patient.referralSource ?? missing}</Field>
      </dl>
      <FiliacionDrawer
        patientId={patient.id}
        detail={detail}
        open={editing}
        onOpenChange={setEditing}
      />
    </section>
  )
}
