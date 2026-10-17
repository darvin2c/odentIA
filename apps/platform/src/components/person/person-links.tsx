import { CONTACT_RELATIONSHIP_LABELS, type Kinship, KINSHIP_LABELS } from "@odentia/clinical"
import { Badge, Button, buttonVariants, Checkbox, Field, FieldLabel, Input } from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  normalizeCountry,
  PhoneInput,
  RowActions,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { useOrgProfile } from "../../lib/org"
import type { PatientContactLink, PatientFull } from "../../lib/patients"
import { hcLabel } from "../../lib/patients"
import { type PersonPage, RELATIONSHIP_WORDS } from "../../lib/people"
import { mutationErrorMessage } from "../../lib/query-error"
import { CreatePatientDrawer } from "../patient/create-patient-drawer"
import { SummaryCard } from "../patient/resumen-tab"
import { PersonLink } from "../person-link"
import { PersonPicker, type PickedPerson } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"

type Relationship = "guardian" | "family" | "other"
const RELATIONSHIPS: Relationship[] = ["guardian", "family", "other"]

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

/** Relación y si recibe los avisos: lo mismo al vincular y al cambiar la relación. */
function RelationFields({
  relationship,
  kinship,
  detail,
  preferred,
  onChange,
  preferredLabel,
}: {
  relationship: Relationship
  /** Parentesco con HL7 v3 RoleCode; vacío si no se sabe. */
  kinship: string
  detail: string
  preferred: boolean
  onChange: (next: { relationship?: Relationship; kinship?: string; detail?: string; preferred?: boolean }) => void
  preferredLabel: string
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="link-relationship">Relación</FieldLabel>
        <ChoiceSelect
          id="link-relationship"
          value={relationship}
          onChange={(event) => onChange({ relationship: event.target.value as Relationship })}
        >
          {RELATIONSHIPS.map((value) => (
            <option key={value} value={value}>
              {CONTACT_RELATIONSHIP_LABELS[value]}
            </option>
          ))}
        </ChoiceSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="link-kinship">Parentesco (opcional)</FieldLabel>
        <ChoiceSelect
          id="link-kinship"
          value={kinship}
          onChange={(event) => onChange({ kinship: event.target.value })}
        >
          <option value="">Sin indicar</option>
          {Object.entries(KINSHIP_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </ChoiceSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="link-detail">Detalle (opcional)</FieldLabel>
        <Input
          id="link-detail"
          value={detail}
          maxLength={100}
          onChange={(event) => onChange({ detail: event.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={preferred}
          onCheckedChange={(checked) => onChange({ preferred: checked === true })}
        />
        {preferredLabel}
      </label>
    </>
  )
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
  const [picked, setPicked] = useState<PickedPerson | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState({
    givenNames: "",
    paternalSurname: "",
    maternalSurname: "",
  })
  const [newPhone, setNewPhone] = useState<string | null>(null)
  const [relationship, setRelationship] = useState<Relationship>("family")
  const [relationDetail, setRelationDetail] = useState("")
  const [kinship, setKinship] = useState("")
  const [preferred, setPreferred] = useState(false)
  const [editing, setEditing] = useState<PatientContactLink | null>(null)
  const [unlinking, setUnlinking] = useState<{
    patientId: string
    contactId: string
    name: string
  } | null>(null)
  const [registering, setRegistering] = useState(false)

  const resetForm = () => {
    setPicked(null)
    setCreating(false)
    setNewName({ givenNames: "", paternalSurname: "", maternalSurname: "" })
    setNewPhone(null)
    setRelationship(linking === "charge" ? "guardian" : "family")
    setRelationDetail("")
    setKinship("")
    setPreferred(false)
  }

  const link = useMutation({
    mutationFn: async () => {
      // Quien habla por la paciente: la persona elegida (o nueva) se vincula a su ficha.
      // A su cargo: esta persona se vincula a la ficha del paciente elegido.
      let otherId = picked?.id ?? null
      if (linking === "talker" && creating) {
        const created = await apiFetch<{ data: { id: string } }>("/api/people", {
          method: "POST",
          body: JSON.stringify({ ...newName, ...(newPhone ? { phone: newPhone } : {}) }),
        })
        otherId = created.data.id
        setCreating(false)
        setPicked({
          id: otherId,
          name: [newName.givenNames, newName.paternalSurname].join(" ").trim(),
        })
      }
      const targetPatient = linking === "talker" ? patientId : (picked?.patientId ?? null)
      const contactId = linking === "talker" ? otherId : person.id
      if (!targetPatient || !contactId) throw new Error("Elige a la persona")
      await apiFetch(`/api/patients/${targetPatient}/contacts/${contactId}`, {
        method: "PUT",
        body: JSON.stringify({
          relationship,
          ...(relationDetail.trim() ? { relationshipDetail: relationDetail.trim() } : {}),
          kinship: kinship || null,
          isPreferred: preferred,
        }),
      })
      return targetPatient
    },
    onSuccess: (targetPatient) => {
      refresh(targetPatient)
      setLinking(null)
      resetForm()
    },
  })
  const editRelation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/contacts/${editing?.contactId}`, {
        method: "PUT",
        body: JSON.stringify({
          relationship,
          ...(relationDetail.trim() ? { relationshipDetail: relationDetail.trim() } : {}),
          kinship: kinship || null,
          isPreferred: preferred,
        }),
      }),
    onSuccess: () => {
      refresh()
      setEditing(null)
    },
  })
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
  const canSubmitLink =
    linking === "talker"
      ? creating
        ? Boolean(
            newName.givenNames.trim() &&
              (newName.paternalSurname.trim() || newName.maternalSurname.trim()),
          )
        : Boolean(picked)
      : Boolean(picked?.patientId)

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
                onClick={() => {
                  link.reset()
                  setLinking("talker")
                  resetForm()
                }}
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
                            editRelation.reset()
                            setRelationship(
                              row.relationship === "self" ? "family" : row.relationship,
                            )
                            setRelationDetail(row.relationshipDetail ?? "")
                            setKinship(row.kinship ?? "")
                            setPreferred(row.isPreferred)
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
                onClick={() => {
                  link.reset()
                  setLinking("charge")
                  resetForm()
                  setRelationship("guardian")
                }}
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
        open={linking !== null}
        onClose={() => {
          if (!link.isPending) setLinking(null)
        }}
        title={
          linking === "talker"
            ? "Vincular a quien habla por ella"
            : "Vincular a un paciente a su cargo"
        }
        description="Buscar no identifica a nadie: confirma que es la persona correcta antes de vincular."
        submitLabel="Vincular"
        isSubmitting={link.isPending}
        submitDisabled={!canSubmitLink}
        error={link.error ? mutationErrorMessage(link.error) : null}
        onSubmit={(event) => {
          event.preventDefault()
          if (canSubmitLink) link.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          {linking === "talker" && creating ? (
            <div className="flex flex-col gap-3 rounded-md border p-3">
              <p className="text-sm font-medium">Persona nueva</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-person-paternal">Primer apellido</FieldLabel>
                  <Input
                    id="new-person-paternal"
                    maxLength={100}
                    value={newName.paternalSurname}
                    onChange={(event) =>
                      setNewName((prev) => ({ ...prev, paternalSurname: event.target.value }))
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-person-maternal">Segundo apellido</FieldLabel>
                  <Input
                    id="new-person-maternal"
                    maxLength={100}
                    value={newName.maternalSurname}
                    onChange={(event) =>
                      setNewName((prev) => ({ ...prev, maternalSurname: event.target.value }))
                    }
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="new-person-given">Nombres</FieldLabel>
                  <Input
                    id="new-person-given"
                    maxLength={100}
                    value={newName.givenNames}
                    onChange={(event) =>
                      setNewName((prev) => ({ ...prev, givenNames: event.target.value }))
                    }
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="new-person-phone">Teléfono</FieldLabel>
                  <PhoneInput
                    id="new-person-phone"
                    value={newPhone}
                    defaultCountry={countryCode}
                    onChange={setNewPhone}
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="self-start"
                onClick={() => setCreating(false)}
              >
                Mejor buscarla
              </Button>
            </div>
          ) : (
            <>
              <PersonPicker
                label={linking === "talker" ? "Persona" : "Paciente"}
                value={picked}
                onChange={setPicked}
                excludeId={person.id}
                patientsOnly={linking === "charge"}
              />
              {linking === "talker" && !picked ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="self-start"
                  onClick={() => setCreating(true)}
                >
                  No está: crear a la persona
                </Button>
              ) : null}
            </>
          )}
          <RelationFields
            relationship={relationship}
            kinship={kinship}
            detail={relationDetail}
            preferred={preferred}
            preferredLabel={
              linking === "talker"
                ? "Recibe los avisos de la paciente"
                : `${person.displayName} recibe los avisos del paciente`
            }
            onChange={(next) => {
              if (next.relationship) setRelationship(next.relationship)
              if (next.detail !== undefined) setRelationDetail(next.detail)
              if (next.kinship !== undefined) setKinship(next.kinship)
              if (next.preferred !== undefined) setPreferred(next.preferred)
            }}
          />
        </div>
      </FormDrawer>

      <FormDrawer
        open={editing !== null}
        onClose={() => {
          if (!editRelation.isPending) setEditing(null)
        }}
        title={`Relación con ${editing?.displayName ?? ""}`}
        submitLabel="Guardar"
        isSubmitting={editRelation.isPending}
        error={editRelation.error ? mutationErrorMessage(editRelation.error) : null}
        onSubmit={(event) => {
          event.preventDefault()
          editRelation.mutate()
        }}
      >
        <RelationFields
          relationship={relationship}
          kinship={kinship}
          detail={relationDetail}
          preferred={preferred}
          preferredLabel="Recibe los avisos de la paciente"
          onChange={(next) => {
            if (next.relationship) setRelationship(next.relationship)
            if (next.detail !== undefined) setRelationDetail(next.detail)
            if (next.kinship !== undefined) setKinship(next.kinship)
            if (next.preferred !== undefined) setPreferred(next.preferred)
          }}
        />
      </FormDrawer>

      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => {
          if (!unlink.isPending) setUnlinking(null)
        }}
        title={`Desvincular a ${unlinking?.name ?? ""}`}
        description={
          unlink.error
            ? (mutationErrorMessage(unlink.error) ?? "No se pudo desvincular.")
            : "Se retira el vínculo. Las dos personas, sus conversaciones y la ficha clínica se conservan, y queda registrado."
        }
        confirmLabel="Desvincular"
        pending={unlink.isPending}
        onConfirm={() => {
          if (unlinking)
            unlink.mutate({ patientId: unlinking.patientId, contactId: unlinking.contactId })
        }}
      />

      <CreatePatientDrawer
        open={registering}
        onClose={() => {
          setRegistering(false)
          refresh()
        }}
        contactId={person.id}
        person={person}
        registerOther
        stayOnPage
      />
    </div>
  )
}
