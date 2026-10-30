import { CONTACT_RELATIONSHIP_LABELS, type Kinship, KINSHIP_LABELS } from "@odentia/clinical"
import { Badge, Button, buttonVariants } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  normalizeCountry,
  RowActions,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  withFieldGroup,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { useOrgProfile } from "../../lib/org"
import type { PatientContactLink, PatientFull } from "../../lib/patients"
import { hcLabel } from "../../lib/patients"
import { type PersonPage, RELATIONSHIP_WORDS } from "../../lib/people"
import { NewPatientDrawer, type NewPatientTarget } from "../patient/new-patient-drawer"
import { SummaryCard } from "../patient/resumen-tab"
import { PersonLink } from "../person-link"
import { PersonPicker, type PickedPerson } from "../person-picker"
import { refineNewPerson } from "./new-person-schema"

type Relationship = "guardian" | "family" | "other"
const RELATIONSHIPS = ["guardian", "family", "other"] as const satisfies readonly Relationship[]
const RELATIONSHIP_OPTIONS = RELATIONSHIPS.map((value) => ({ value, label: CONTACT_RELATIONSHIP_LABELS[value] }))
const KINSHIP_OPTIONS = [
  { value: "", label: "Sin indicar" },
  ...Object.entries(KINSHIP_LABELS).map(([value, label]) => ({ value, label })),
]

const ENTRY_LABELS: Record<string, string> = {
  platform: "Registro en la clínica",
  public_link: "Enlace público",
  qr: "Código QR",
  conversation: "Conversación",
  legacy: "Registro anterior: origen no disponible",
}

const RESPONDENT_LABELS: Record<string, string> = {
  patient: "La propia persona",
  representative: "Su representante",
  staff: "El equipo de la clínica",
}

function useRefresh(person: PersonPage) {
  const queryClient = useQueryClient()
  return (patientId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["person"] })
    void queryClient.invalidateQueries({ queryKey: ["people"] })
    if (person.patient)
      void queryClient.invalidateQueries({ queryKey: ["patient", person.patient.id] })
    if (patientId) void queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
  }
}

/** La relación y si recibe los avisos, con los nombres del cuerpo de PUT `/api/patients/:id/contacts/:contactId`. */
const RELATION_DEFAULTS = {
  relationship: "family" as Relationship,
  /** Parentesco con HL7 v3 RoleCode; vacío si no se sabe. */
  kinship: "",
  relationshipDetail: "",
  isPreferred: false,
  /** Contacto de emergencia (decisión 25); a su cargo no se pregunta. */
  isEmergency: false,
}
type RelationValues = typeof RELATION_DEFAULTS
const RELATION_FIELDS = {
  relationship: "relationship",
  kinship: "kinship",
  relationshipDetail: "relationshipDetail",
  isPreferred: "isPreferred",
  isEmergency: "isEmergency",
} as const
const relationShape = {
  relationship: z.enum(RELATIONSHIPS, "Elige la relación"),
  kinship: z.string(),
  relationshipDetail: z.string().trim().max(100),
  isPreferred: z.boolean(),
  isEmergency: z.boolean(),
}

/** El cuerpo del vínculo; la marca de emergencia solo si se preguntó. */
function relationBody(value: RelationValues, withEmergency: boolean) {
  return {
    relationship: value.relationship,
    ...(value.relationshipDetail.trim() ? { relationshipDetail: value.relationshipDetail.trim() } : {}),
    kinship: value.kinship || null,
    isPreferred: value.isPreferred,
    ...(withEmergency ? { isEmergency: value.isEmergency } : {}),
  }
}

/** Relación y si recibe los avisos: lo mismo al vincular y al cambiar la relación. */
const RelationFields = withFieldGroup({
  defaultValues: RELATION_DEFAULTS,
  props: { preferredLabel: "", showEmergency: false },
  render: function RelationFieldsRender({ group, preferredLabel, showEmergency }) {
    return (
      <>
        <group.AppField name="relationship">
          {(field) => <field.SelectField label="Relación" options={RELATIONSHIP_OPTIONS} />}
        </group.AppField>
        <group.AppField name="kinship">
          {(field) => <field.SelectField label="Parentesco (opcional)" options={KINSHIP_OPTIONS} />}
        </group.AppField>
        <group.AppField name="relationshipDetail">
          {(field) => <field.TextField label="Detalle (opcional)" maxLength={100} />}
        </group.AppField>
        <group.AppField name="isPreferred">
          {(field) => <field.CheckboxField label={preferredLabel} />}
        </group.AppField>
        {showEmergency ? (
          <group.AppField name="isEmergency">
            {(field) => <field.CheckboxField label="Contacto de emergencia" />}
          </group.AppField>
        ) : null}
      </>
    )
  },
})

const LINK_DEFAULTS = {
  ...RELATION_DEFAULTS,
  /** La persona (o el paciente, a su cargo) elegida en el buscador. */
  picked: null as PickedPerson | null,
  /** Crear a la persona en vez de buscarla. */
  creating: false,
  givenNames: "",
  familyName: "",
  phone: null as string | null,
}

/**
 * Datos › Personas vinculadas: quién habla por la persona (si es paciente) y
 * de quién es responsable. Vincular usa el mismo buscador de personas de toda
 * la aplicación; la propia persona no se desvincula. Lo cambia quien edita la
 * filiación (`patients.write`), la misma regla que el servidor.
 */
export function PersonLinks({ person, detail }: { person: PersonPage; detail?: PatientFull }) {
  const canWrite = usePermission("patients.write")
  const canReadChats = usePermission("conversations.read")
  const refresh = useRefresh(person)
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const patientId = person.patient?.id ?? null
  const [linking, setLinking] = useState<"talker" | "charge" | null>(null)
  const [editing, setEditing] = useState<PatientContactLink | null>(null)
  const [unlinking, setUnlinking] = useState<{
    patientId: string
    contactId: string
    name: string
  } | null>(null)
  const [registering, setRegistering] = useState(false)
  const dependentTarget: NewPatientTarget = { kind: "dependent", person }

  const linkSchema = z
    .object({
      ...relationShape,
      picked: z.custom<PickedPerson | null>(),
      creating: z.boolean(),
      givenNames: z.string().max(100),
      familyName: z.string().max(200),
      phone: z.string().nullable(),
    })
    .superRefine((value, ctx) => {
      if (linking === "talker" && value.creating) refineNewPerson(value, ctx, countryCode)
      else if (linking === "talker" && !value.picked)
        ctx.addIssue({ code: "custom", path: ["picked"], message: "Elige a la persona" })
      else if (linking === "charge" && !value.picked?.patientId)
        ctx.addIssue({ code: "custom", path: ["picked"], message: "Elige al paciente" })
    })
  const linkForm = useAppForm({
    defaultValues: LINK_DEFAULTS,
    validators: { onSubmit: linkSchema },
    onSubmit: async ({ value, formApi }) => {
      // Quien habla por la paciente: la persona elegida (o nueva) se vincula a su ficha.
      // A su cargo: esta persona se vincula a la ficha del paciente elegido.
      let other = value.picked
      if (linking === "talker" && value.creating) {
        const created = await apiFetch<{ data: { id: string } }>("/api/people", {
          method: "POST",
          body: JSON.stringify({
            givenNames: value.givenNames.trim(),
            familyName: value.familyName.trim(),
            ...(value.phone ? { phone: value.phone } : {}),
          }),
        })
        // Ya creada: si el vínculo falla, reintentar no la crea otra vez.
        other = {
          id: created.data.id,
          name: [value.givenNames.trim(), value.familyName.trim()].join(" "),
        }
        formApi.setFieldValue("creating", false)
        formApi.setFieldValue("picked", other)
      }
      const targetPatient = linking === "talker" ? patientId : (other?.patientId ?? null)
      const contactId = linking === "talker" ? (other?.id ?? null) : person.id
      if (!targetPatient || !contactId) return
      await apiFetch(`/api/patients/${targetPatient}/contacts/${contactId}`, {
        method: "PUT",
        // Quien habla por ella puede ser además su contacto de emergencia, en el mismo paso.
        body: JSON.stringify(relationBody(value, linking === "talker")),
      })
      refresh(targetPatient)
      setLinking(null)
    },
  })
  // La persona que rechaza el vínculo (archivada, la propia del paciente) es la elegida.
  const linkSurface = useFormSurface(linkForm, { fieldMap: { contactId: "picked" } })
  const picked = useStore(linkForm.store, (state) => state.values.picked)
  const creating = useStore(linkForm.store, (state) => state.values.creating)
  const openLinking = (mode: "talker" | "charge") => {
    linkForm.reset({ ...LINK_DEFAULTS, relationship: mode === "charge" ? "guardian" : "family" })
    setLinking(mode)
  }

  const editForm = useAppForm({
    defaultValues: RELATION_DEFAULTS,
    validators: { onSubmit: z.object(relationShape) },
    onSubmit: async ({ value }) => {
      await apiFetch(`/api/patients/${patientId}/contacts/${editing?.contactId}`, {
        method: "PUT",
        body: JSON.stringify(relationBody(value, true)),
      })
      refresh()
      setEditing(null)
    },
  })
  const editSurface = useFormSurface(editForm)
  const unlink = useMutation({
    mutationFn: (input: { patientId: string; contactId: string }) =>
      apiFetch(`/api/patients/${input.patientId}/contacts/${input.contactId}`, {
        method: "DELETE",
      }),
    onSuccess: (_data, input) => {
      refresh(input.patientId)
      setUnlinking(null)
    },
  })

  const talkers = (detail?.contacts ?? []).filter((row) => row.relationship !== "self")
  const registration = detail?.registration ?? null
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {patientId ? (
        <SummaryCard
          title="Quién habla por ella"
          action={
            canWrite && !person.archived ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openLinking("talker")}
              >
                Vincular a una persona
              </Button>
            ) : undefined
          }
        >
          {talkers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Habla por sí misma. Si un familiar o tutor escribe o decide por ella, vincúlalo aquí.
            </p>
          ) : (
            <ul className="flex flex-col divide-y">
              {talkers.map((row) => (
                <li
                  key={row.contactId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-2">
                      <PersonLink contactId={row.contactId}>{row.displayName}</PersonLink>
                      {row.isPreferred ? <Badge>Recibe los avisos</Badge> : null}
                      {row.isEmergency ? <Badge variant="outline">Contacto de emergencia ✓</Badge> : null}
                      {!row.isActive ? <Badge variant="outline">Archivada</Badge> : null}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {(row.kinship && KINSHIP_LABELS[row.kinship as Kinship]) ||
                        row.relationshipDetail ||
                        CONTACT_RELATIONSHIP_LABELS[row.relationship]}
                    </span>
                  </span>
                  {canWrite ? (
                    <RowActions
                      label={`Acciones de ${row.displayName}`}
                      items={[
                        {
                          key: "edit",
                          label: "Cambiar la relación",
                          onSelect: () => {
                            editForm.reset({
                              relationship: row.relationship === "self" ? "family" : row.relationship,
                              relationshipDetail: row.relationshipDetail ?? "",
                              kinship: row.kinship ?? "",
                              isPreferred: row.isPreferred,
                              isEmergency: row.isEmergency,
                            })
                            setEditing(row)
                          },
                        },
                        {
                          key: "unlink",
                          label: "Desvincular",
                          tone: "danger" as const,
                          onSelect: () => {
                            unlink.reset()
                            setUnlinking({
                              patientId: patientId,
                              contactId: row.contactId,
                              name: row.displayName,
                            })
                          },
                        },
                      ]}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SummaryCard>
      ) : null}

      <SummaryCard
        title="A su cargo"
        action={
          canWrite && !person.archived ? (
            <span className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => openLinking("charge")}
              >
                Vincular a un paciente
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRegistering(true)}
              >
                Registrar a alguien a su cargo
              </Button>
            </span>
          ) : undefined
        }
      >
        {person.responsibleFor.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No es responsable de ningún paciente. Si registra o acompaña a un hijo o familiar,
            vincúlalo aquí.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {person.responsibleFor.map((row) => (
              <li
                key={row.patientId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-2">
                    <PersonLink contactId={row.personId} patientId={row.patientId}>
                      {row.displayName}
                    </PersonLink>
                    <span className="text-xs text-muted-foreground">
                      {hcLabel(row.patientNumber)}
                    </span>
                    {row.archived ? <Badge variant="outline">Archivada</Badge> : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {(row.kinship && KINSHIP_LABELS[row.kinship as Kinship]) ||
                      row.relationshipDetail ||
                      RELATIONSHIP_WORDS[row.relationship] ||
                      row.relationship}
                  </span>
                </span>
                {canWrite ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      unlink.reset()
                      setUnlinking({
                        patientId: row.patientId,
                        contactId: person.id,
                        name: row.displayName,
                      })
                    }}
                  >
                    Desvincular
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SummaryCard>

      {registration ? (
        <SummaryCard title="Cómo llegó su registro">
          <p className="text-sm">
            {ENTRY_LABELS[registration.entryPoint] ?? "Registro"}
            {" · "}
            {new Date(registration.createdAt).toLocaleString(activeOrgLocale(), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            Lo declaró{" "}
            {registration.respondent
              ? (RESPONDENT_LABELS[registration.respondent] ?? "alguien")
              : "alguien sin registrar"}
            {registration.actor ? ` · lo registró ${registration.actor.name}` : ""}
          </p>
          {registration.conversationId && canReadChats ? (
            <div>
              <Link
                to="/inbox"
                search={{ conversation: registration.conversationId }}
                className={buttonVariants({ variant: "link", size: "sm" })}
              >
                Ver la conversación de la que salió
              </Link>
            </div>
          ) : null}
        </SummaryCard>
      ) : null}

      <FormDrawer
        {...linkSurface}
        open={linking !== null}
        onClose={() => {
          if (!linkSurface.isSubmitting) setLinking(null)
        }}
        title={
          linking === "talker"
            ? "Vincular a quien habla por ella"
            : "Vincular a un paciente a su cargo"
        }
        description="Buscar no identifica a nadie: confirma que es la persona correcta antes de vincular."
        submitLabel="Vincular"
      >
        <div className="flex flex-col gap-4">
          {linking === "talker" && creating ? (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <p className="text-sm font-medium">Persona nueva</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {/* Primero los nombres y después los apellidos, como en todo el registro. */}
                <linkForm.AppField name="givenNames">
                  {(field) => <field.TextField label="Nombres" className="sm:col-span-2" maxLength={100} />}
                </linkForm.AppField>
                <linkForm.AppField name="familyName">
                  {(field) => <field.TextField label="Apellidos" className="sm:col-span-2" maxLength={200} />}
                </linkForm.AppField>
                <linkForm.AppField name="phone">
                  {(field) => (
                    <field.PhoneField label="Teléfono" className="sm:col-span-2" defaultCountry={countryCode} />
                  )}
                </linkForm.AppField>
              </div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="self-start"
                onClick={() => linkForm.setFieldValue("creating", false)}
              >
                Mejor buscarla
              </Button>
            </div>
          ) : (
            <>
              <linkForm.AppField name="picked">
                {(field) => (
                  <field.Control label={linking === "talker" ? "Persona" : "Paciente"}>
                    {(control) => (
                      <PersonPicker
                        id={control.id}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                        label={linking === "talker" ? "Persona" : "Paciente"}
                        value={field.state.value}
                        onChange={field.handleChange}
                        excludeId={person.id}
                        patientsOnly={linking === "charge"}
                      />
                    )}
                  </field.Control>
                )}
              </linkForm.AppField>
              {linking === "talker" && !picked ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="self-start"
                  onClick={() => linkForm.setFieldValue("creating", true)}
                >
                  No está: crear a la persona
                </Button>
              ) : null}
            </>
          )}
          <RelationFields
            form={linkForm}
            fields={RELATION_FIELDS}
            showEmergency={linking === "talker"}
            preferredLabel={
              linking === "talker"
                ? "Recibe los avisos de la paciente"
                : `${person.displayName} recibe los avisos del paciente`
            }
          />
        </div>
      </FormDrawer>

      <FormDrawer
        {...editSurface}
        open={editing !== null}
        onClose={() => {
          if (!editSurface.isSubmitting) setEditing(null)
        }}
        title={`Relación con ${editing?.displayName ?? ""}`}
        submitLabel="Guardar"
      >
        <RelationFields
          form={editForm}
          fields={RELATION_FIELDS}
          showEmergency
          preferredLabel="Recibe los avisos de la paciente"
        />
      </FormDrawer>

      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => {
          if (!unlink.isPending) setUnlinking(null)
        }}
        title={`Desvincular a ${unlinking?.name ?? ""}`}
        description="Se retira el vínculo. Las dos personas, sus conversaciones y la ficha clínica se conservan, y queda registrado."
        error={unlink.error ? submitErrorMessage(unlink.error) : null}
        confirmLabel="Desvincular"
        pending={unlink.isPending}
        onConfirm={() => {
          if (unlinking)
            unlink.mutate({ patientId: unlinking.patientId, contactId: unlinking.contactId })
        }}
      />

      <NewPatientDrawer
        open={registering}
        onClose={() => {
          setRegistering(false)
          refresh()
        }}
        target={dependentTarget}
      />
    </div>
  )
}
