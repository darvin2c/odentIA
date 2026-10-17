import {
  ageLabel,
  EDUCATION_LEVEL_LABELS,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  type RegistrationConfig,
} from "@odentia/clinical"
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@odentia/ui"
import { internationalText } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import type { ReactNode } from "react"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { useCan, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { useClinicalProfile } from "../../lib/org"
import { sexLabel } from "../../lib/patient-overview"
import { filiationGapsText, hcLabel, type PatientFull } from "../../lib/patients"
import { addressLine, countryText, documentLine, insuranceText } from "../../lib/person-data"
import { DataConsentSection } from "./data-consent-section"
import { FiliacionSectionDrawer, type FiliacionSectionKey, useBranches } from "./filiacion-section-drawer"
import { MessagePermissionsSection, messageRecipientOf } from "./message-permissions-section"

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

/**
 * Datos de la persona en tres tarjetas (Identidad, Contacto y, si la clínica
 * lo pide o ya lo tiene, Seguro) y lo opcional plegado en «Más datos»
 * (decisión 10 de la fase 3). Lo que depende del país (documento, dirección,
 * seguro) se dice como en la clínica de ese país. «Faltan datos para
 * atenderla» lo calcula el servidor y solo lo recibe quien edita; «Completar»
 * abre solo lo que falta.
 */
export function FiliacionPanel({
  detail,
  phoneNote,
}: {
  detail: PatientFull
  /** Junto al teléfono: si es su WhatsApp (decisión 23). */
  phoneNote?: ReactNode
}) {
  const canWrite = usePermission("patients.write")
  const canRead = usePermission("patients.read")
  const profile = useClinicalProfile()
  const [editing, setEditing] = useState<FiliacionSectionKey | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const p = detail.patient
  const branches = useBranches(canRead)
  const can = useCan()
  const canConfig = can("crm.read") || can("settings.read")
  // El seguro se muestra si la clínica lo pide o si ya hay uno guardado.
  const config = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: () =>
      apiFetch<{ data: RegistrationConfig; meta: { today: string } }>("/api/patient-registration/config"),
    enabled: canConfig,
    retry: false,
  })
  const asksInsurance = config.data ? config.data.data.fields.insuranceType !== "hidden" : false
  const showInsurance = asksInsurance || Boolean(p.insuranceType || p.insurerName || p.affiliationNumber)
  const age = ageLabel(p.birthDate)
  const edit = (section: FiliacionSectionKey) => (canWrite ? () => setEditing(section) : undefined)
  const gaps = detail.missingData ?? []
  // El contacto de emergencia es una persona vinculada con la marca (decisión 25).
  const emergency =
    detail.contacts
      .filter((link) => link.isEmergency)
      .map((link) =>
        [
          link.displayName,
          link.kinship ? (KINSHIP_LABELS[link.kinship as keyof typeof KINSHIP_LABELS] ?? link.kinship) : null,
          link.phone ? internationalText(link.phone) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .join("; ") || null
  const birthPlace = [p.birthPlace, countryText(p.birthCountry)].filter(Boolean).join(", ") || null

  return (
    <section aria-labelledby="filiacion-titulo" className="flex min-w-0 flex-col gap-4">
      {/* Jerarquía de la ficha: h1 paciente, h2 sección, h3 bloques. */}
      <h2 id="filiacion-titulo" className="text-base font-semibold">
        Datos personales
      </h2>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{hcLabel(p.patientNumber)}</Badge>
        {p.identityNeedsReview && gaps.length === 0 ? (
          <Badge variant="warning">Apellidos por confirmar: al guardar Identidad quedan confirmados</Badge>
        ) : null}
        {gaps.length > 0 ? (
          <>
            <Badge variant="warning">Faltan datos para atenderla</Badge>
            <span className="text-muted-foreground">{filiationGapsText(gaps)}.</span>
            {canWrite ? (
              <Button size="sm" variant="outline" onClick={() => setEditing("completar")}>
                Completar
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Section title="Identidad" onEdit={edit("identidad")}>
          <Item label="Nombres">{p.givenNames}</Item>
          <Item label="Primer apellido">{p.paternalSurname}</Item>
          <Item label="Segundo apellido">{p.maternalSurname}</Item>
          <Item label="Documento">{documentLine(p.docType, p.docNumber, p.docCountry)}</Item>
          <Item label="Nacimiento">
            {p.birthDate
              ? `${new Date(`${p.birthDate}T12:00:00`).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric" })}${age ? ` · ${age}` : ""}`
              : null}
          </Item>
          <Item label="Sexo">{p.sex ? sexLabel(p.sex) : null}</Item>
        </Section>
        <Section title="Contacto" onEdit={edit("contacto")}>
          <Item label="Teléfono">
            {p.phone ? (
              <>
                {internationalText(p.phone)}
                {phoneNote}
              </>
            ) : null}
          </Item>
          <Item label="Correo">{p.email}</Item>
          <Item label="Dirección">{addressLine(profile, p)}</Item>
          <Item label="Contacto de emergencia">
            {emergency ?? (
              <span className="text-muted-foreground">
                No registrado: márcalo en Datos › Personas vinculadas («Contacto de emergencia»)
              </span>
            )}
          </Item>
        </Section>
        {showInsurance ? (
          <Section title="Seguro" onEdit={edit("seguro")}>
            <Item label="Seguro">{insuranceText(profile, p.insuranceType, p.insuranceScheme)}</Item>
            <Item label="Aseguradora">{p.insurerName}</Item>
            <Item label="N.º de afiliación">{p.affiliationNumber}</Item>
          </Section>
        ) : null}
      </div>
      <Collapsible
        open={moreOpen}
        onOpenChange={setMoreOpen}
        className="elevated rounded-xl border bg-card p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger className="text-sm font-medium">
            <span className="flex items-center gap-1">
              Más datos <ChevronDown aria-hidden className="size-4" />
            </span>
          </CollapsibleTrigger>
          {canWrite && moreOpen ? (
            <Button size="sm" variant="outline" onClick={() => setEditing("mas")}>
              Editar
            </Button>
          ) : null}
        </div>
        <CollapsibleContent>
          <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 pt-3 sm:grid-cols-2">
            <Item label="Nacionalidad">{countryText(p.nationality)}</Item>
            <Item label="Lugar de nacimiento">{birthPlace}</Item>
            <Item label="Estado civil">
              {p.maritalStatus
                ? MARITAL_STATUS_LABELS[p.maritalStatus as keyof typeof MARITAL_STATUS_LABELS]
                : null}
            </Item>
            <Item label="Nivel educativo">
              {p.educationLevel
                ? EDUCATION_LEVEL_LABELS[p.educationLevel as keyof typeof EDUCATION_LEVEL_LABELS]
                : null}
            </Item>
            <Item label="Ocupación">{p.occupation}</Item>
            <Item label="Cómo nos conoció">{p.referralSource}</Item>
            {profile.origin ? <Item label="Procedencia">{p.origin}</Item> : null}
          </dl>
        </CollapsibleContent>
      </Collapsible>
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
      {editing ? (
        <FiliacionSectionDrawer
          key={editing}
          patient={p}
          section={editing}
          missing={gaps}
          open
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}
