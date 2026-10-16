import {
  ageLabel,
  documentText,
  EDUCATION_LEVEL_LABELS,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
} from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import { internationalText } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useState } from "react"
import type { RegistrationConfig } from "@odentia/clinical"
import { apiFetch } from "../../lib/api"
import { usePermission, useCan } from "../../lib/crm"
import { sexLabel } from "../../lib/patient-overview"
import { hcLabel, missingFiliation, type PatientFull } from "../../lib/patients"
import { DataConsentSection } from "./data-consent-section"
import { MessagePermissionsSection, messageRecipientOf } from "./message-permissions-section"
import {
  COUNTRY_LABELS,
  FiliacionSectionDrawer,
  type FiliacionSectionKey,
  INSURANCE_LABELS,
  useBranches,
} from "./filiacion-section-drawer"
import { useUbigeoLabel } from "./ubigeo-field"
import { activeOrgLocale } from "../../lib/locale"

const missing = <span className="text-muted-foreground">No registrado</span>

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children ?? missing}</dd>
    </div>
  )
}

function Section({
  title,
  onEdit,
  children,
  footer,
}: {
  title: string
  onEdit?: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-5"
      aria-label={title}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        {onEdit ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Editar
          </Button>
        ) : null}
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
      {footer}
    </section>
  )
}

const country = (code: string | null | undefined) =>
  code ? `${COUNTRY_LABELS[code] ?? code}` : null

/**
 * Filiación con las secciones del formato de historia clínica. Cada grupo se
 * edita en su propio cajón con los catálogos del registro; lo no registrado se
 * ve como tal. La obligatoriedad la fija «Registro de pacientes».
 */
export function FiliacionPanel({ detail }: { detail: PatientFull }) {
  const canWrite = usePermission("patients.write")
  const canRead = usePermission("patients.read")
  const [editing, setEditing] = useState<FiliacionSectionKey | null>(null)
  const p = detail.patient
  const birthPlace = useUbigeoLabel(p.birthPlaceUbigeo)
  const addressPlace = useUbigeoLabel(p.addressUbigeo)
  const branches = useBranches(canRead)
  const can = useCan()
  const canConfig = can("crm.read") || can("settings.read")
  // Lo que falta es lo que «Registro de pacientes» pide como obligatorio: el
  // mismo criterio que los pendientes del Resumen (`missingFiliation`).
  const config = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: () =>
      apiFetch<{ data: RegistrationConfig; meta: { today: string } }>("/api/patient-registration/config"),
    enabled: canWrite && canConfig,
    retry: false,
  })
  const age = ageLabel(p.birthDate)
  const edit = (section: FiliacionSectionKey) => (canWrite ? () => setEditing(section) : undefined)
  const gaps = config.data ? missingFiliation(config.data.data, p, detail.contacts) : []
  const legacy = p.identityLegacy ? Object.values(p.identityLegacy).join(", ") : null

  return (
    <section aria-labelledby="filiacion-titulo" className="flex min-w-0 flex-col gap-4">
      {/* Jerarquía de la ficha: h1 paciente, h2 sección, h3 bloques. */}
      <h2 id="filiacion-titulo" className="text-base font-semibold">
        Datos personales
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{hcLabel(p.patientNumber)}</Badge>
        {p.identityNeedsReview ? (
          <Badge variant="warning">Identidad por revisar: confirma apellidos y nombres</Badge>
        ) : null}
        {gaps.length > 0 ? (
          <span className="text-muted-foreground">Faltan datos que la clínica pide: {gaps.join(", ")}.</span>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Section
          title="Identidad"
          onEdit={edit("identidad")}
          footer={
            legacy ? (
              <p className="text-xs text-muted-foreground">
                Dato anterior sin catálogo, conservado para revisar: {legacy}.
              </p>
            ) : null
          }
        >
          <Item label="Apellido paterno">{p.paternalSurname}</Item>
          <Item label="Apellido materno">{p.maternalSurname}</Item>
          <Item label="Nombres">{p.givenNames}</Item>
          <Item label="Documento">
            {p.docNumber
              ? `${documentText(p.docType, p.docNumber)}${p.docCountry ? ` · ${country(p.docCountry)}` : ""}`
              : null}
          </Item>
          <Item label="Nacimiento">
            {p.birthDate
              ? `${new Date(`${p.birthDate}T12:00:00`).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric" })}${age ? ` · ${age}` : ""}`
              : null}
          </Item>
          <Item label="Sexo">{p.sex ? sexLabel(p.sex) : null}</Item>
          <Item label="Estado civil">
            {p.maritalStatus
              ? MARITAL_STATUS_LABELS[p.maritalStatus as keyof typeof MARITAL_STATUS_LABELS]
              : null}
          </Item>
          <Item label="Grado de instrucción">
            {p.educationLevel
              ? EDUCATION_LEVEL_LABELS[p.educationLevel as keyof typeof EDUCATION_LEVEL_LABELS]
              : null}
          </Item>
          <Item label="Ocupación">{p.occupation}</Item>
          <Item label="Nacionalidad">{country(p.nationality)}</Item>
        </Section>
        <Section title="Nacimiento y domicilio" onEdit={edit("domicilio")}>
          <Item label="Lugar de nacimiento">{birthPlace}</Item>
          <Item label="Domicilio">{p.address}</Item>
          <Item label="Ubigeo del domicilio">{addressPlace}</Item>
          <Item label="Referencia">{p.addressReference}</Item>
          <Item label="Procedencia">{p.origin}</Item>
        </Section>
        <Section title="Contacto" onEdit={edit("contacto")}>
          <Item label="Teléfono">{p.phone ? internationalText(p.phone) : null}</Item>
          <Item label="Correo">{p.email}</Item>
          <Item label="Cómo nos conoció">{p.referralSource}</Item>
        </Section>
        <Section title="Seguro" onEdit={edit("seguro")}>
          <Item label="Tipo">
            {p.insuranceType ? (INSURANCE_LABELS[p.insuranceType] ?? p.insuranceType) : null}
          </Item>
          <Item label="Aseguradora">{p.insurerName}</Item>
          <Item label="N.º de afiliación">{p.affiliationNumber}</Item>
          <Item label="Detalle">{p.insuranceDetail}</Item>
        </Section>
        <Section
          title="Contacto de emergencia"
          onEdit={edit("emergencia")}
          footer={
            <p className="text-xs text-muted-foreground">
              El representante legal de un menor es una persona vinculada con documento: se
              gestiona en Responsables.
            </p>
          }
        >
          <Item label="Contacto de emergencia">
            {p.emergencyContactName
              ? `${p.emergencyContactName}${p.emergencyContactRelationship ? ` · ${KINSHIP_LABELS[p.emergencyContactRelationship as keyof typeof KINSHIP_LABELS] ?? p.emergencyContactRelationship}` : ""}`
              : null}
          </Item>
          <Item label="Teléfono de emergencia">
            {p.emergencyContactPhone ? internationalText(p.emergencyContactPhone) : null}
          </Item>
        </Section>
        <section
          className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-5"
          aria-label="Datos y consentimiento"
        >
          <h3 className="font-heading text-sm font-medium">Datos y consentimiento</h3>
          <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label="Sede de registro">
              {p.registeredBranchId
                ? (branches.data?.data.find((b) => b.id === p.registeredBranchId)?.name ?? "—")
                : null}
            </Item>
            <Item label="Registrado">
              {detail.registration
                ? `${new Date(detail.registration.createdAt).toLocaleDateString(activeOrgLocale())} · ${detail.registration.entryPoint === "platform" ? "alta interna" : "registro público"}`
                : null}
            </Item>
          </dl>
          <DataConsentSection detail={detail} />
          <MessagePermissionsSection
            contactId={messageRecipientOf(detail)?.contactId}
            recipientName={
              messageRecipientOf(detail)?.relationship === "self" ? null : messageRecipientOf(detail)?.displayName
            }
          />
        </section>
      </div>
      {editing ? (
        <FiliacionSectionDrawer
          key={editing}
          patient={p}
          section={editing}
          open
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}
