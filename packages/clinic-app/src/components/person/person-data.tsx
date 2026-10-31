import { Badge, Button, Field, FieldLabel, Input } from "@odentia/ui"
import { DatePickerButton, FormDrawer, internationalText, LoadingState, SkeletonRegion } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { type ContactFull, type FieldDef, useCan, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { sexLabel } from "../../lib/patient-overview"
import type { PatientFull } from "../../lib/patients"
import type { PersonPage } from "../../lib/people"
import { documentLine } from "../../lib/person-data"
import { mutationErrorMessage, QueryErrorState } from "../../lib/query-error"
import { FiliacionPanel } from "../patient/filiacion-panel"
import { FiliacionSectionDrawer, type FiliacionSectionKey } from "../patient/filiacion-section-drawer"
import { MessagePermissionsSection } from "../patient/message-permissions-section"
import { PhoneWhatsAppNote } from "./phone-whatsapp"
import { TagsInput } from "../patient/tags-input"
import { FiliacionSkeleton } from "../skeletons/person-sections"
import { ChoiceSelect } from "../ui/choice-select"

const PREFERRED_LABELS: Record<string, string> = {
  email: "Correo",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">
        {children ?? <span className="text-muted-foreground">No registrado</span>}
      </dd>
    </div>
  )
}

function Card({
  title,
  onEdit,
  children,
}: {
  title: string
  onEdit?: () => void
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        {onEdit ? (
          <Button size="sm" variant="outline" onClick={onEdit}>
            Editar
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/**
 * Datos personales de la persona. Con ficha son los de la filiación
 * (`FiliacionPanel`); sin ella, su identidad y cómo ubicarla, que se editan
 * con el mismo formulario y las mismas reglas. Debajo, lo que la clínica
 * guarda de ella para ventas y mensajes (quien lleva el CRM).
 */
export function PersonData({ person, detail }: { person: PersonPage; detail?: PatientFull }) {
  const can = useCan()
  const canEdit = can("patients.write") || can("crm.write")
  const [editing, setEditing] = useState<FiliacionSectionKey | null>(null)
  if (person.patient) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {detail ? (
          <FiliacionPanel
            detail={detail}
            phoneNote={<PhoneWhatsAppNote contactId={person.id} value={person.phoneWhatsApp} />}
          />
        ) : (
          <SkeletonRegion message="Cargando sus datos…">
            <FiliacionSkeleton canEdit={can("patients.write")} />
          </SkeletonRegion>
        )}
        <PersonCrmCard person={person} />
      </div>
    )
  }
  const edit = (section: FiliacionSectionKey) =>
    canEdit && !person.archived ? () => setEditing(section) : undefined
  const born = person.birthDate
    ? new Date(`${person.birthDate}T12:00:00`).toLocaleDateString(activeOrgLocale(), {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null
  return (
    <section aria-labelledby="datos-titulo" className="flex min-w-0 flex-col gap-4">
      <h2 id="datos-titulo" className="text-base font-semibold">
        Datos personales
      </h2>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card title="Identidad" onEdit={edit("identidad")}>
          <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label="Nombres">
              {person.givenNames ?? (person.familyName ? null : person.displayName)}
            </Item>
            <Item label="Apellidos">{person.familyName}</Item>
            <Item label="Documento">{documentLine(person.docType, person.docNumber, person.docCountry)}</Item>
            <Item label="Nacimiento">{born}</Item>
            <Item label="Sexo">{person.sex ? sexLabel(person.sex) : null}</Item>
          </dl>
        </Card>
        <Card title="Contacto" onEdit={edit("contacto")}>
          <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label="Teléfono">
              {person.phone ? (
                <>
                  {internationalText(person.phone)}
                  <PhoneWhatsAppNote contactId={person.id} value={person.phoneWhatsApp} />
                </>
              ) : null}
            </Item>
            <Item label="Correo">{person.email}</Item>
          </dl>
          <MessagePermissionsSection contactId={person.archived ? null : person.id} />
        </Card>
      </div>
      <PersonCrmCard person={person} />
      {editing ? (
        <FiliacionSectionDrawer
          key={editing}
          person={person}
          section={editing}
          open
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * Lo que la clínica guarda de la persona para ventas y mensajes: medio
 * preferido, etiquetas y campos propios. Lo lee y cambia quien lleva el CRM.
 */
function PersonCrmCard({ person }: { person: PersonPage }) {
  const canRead = usePermission("crm.read")
  const canWrite = usePermission("crm.write")
  const canConfigure = usePermission("settings.read") || canWrite
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<"preferido" | "etiquetas" | "campos" | null>(null)
  const [draftPreferred, setDraftPreferred] = useState("")
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftCustom, setDraftCustom] = useState<Record<string, unknown>>({})
  const contact = useQuery({
    queryKey: ["contact", person.id],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${person.id}`),
    enabled: canRead,
    retry: false,
  })
  const fields = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
    enabled: canRead,
  })
  const connections = useQuery({
    queryKey: ["connections", "usable", "preferred"],
    queryFn: () =>
      apiFetch<{ data: { id: string; channel: string; status: string }[] }>(
        "/api/channels/connections/usable",
      ),
    enabled: open === "preferido",
  })
  const connected = useMemo(() => {
    const channels = [
      ...new Set(
        (connections.data?.data ?? []).filter((c) => c.status === "active").map((c) => c.channel),
      ),
    ]
    if (draftPreferred && !channels.includes(draftPreferred)) channels.unshift(draftPreferred)
    return channels
  }, [connections.data, draftPreferred])
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/contacts/${person.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      setOpen(null)
      void queryClient.invalidateQueries({ queryKey: ["contact", person.id] })
      void queryClient.invalidateQueries({ queryKey: ["people"] })
    },
  })
  if (!canRead) return null
  const data = contact.data?.data.contact
  const defs = fields.data?.data ?? []
  const custom = data?.customFields ?? {}
  const close = () => {
    if (!patch.isPending) {
      setOpen(null)
      patch.reset()
    }
  }
  return (
    <Card title="Para ventas y mensajes">
      {contact.isPending ? (
        <LoadingState message="Cargando…" />
      ) : contact.isError || !data ? (
        <QueryErrorState error={contact.error} onRetry={() => void contact.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <Item label="Medio preferido para avisos">
              <span className="flex flex-wrap items-center gap-2">
                {data.preferredChannel
                  ? (PREFERRED_LABELS[data.preferredChannel] ?? data.preferredChannel)
                  : "Sin preferencia"}
                {canWrite ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    onClick={() => {
                      patch.reset()
                      setDraftPreferred(data.preferredChannel ?? "")
                      setOpen("preferido")
                    }}
                  >
                    Cambiar
                  </Button>
                ) : null}
              </span>
            </Item>
            <Item label="Etiquetas">
              <span className="flex flex-wrap items-center gap-1">
                {data.tags.length === 0 ? (
                  <span className="text-muted-foreground">Sin etiquetas</span>
                ) : null}
                {data.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
                {canWrite ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="link"
                    onClick={() => {
                      patch.reset()
                      setDraftTags(data.tags)
                      setOpen("etiquetas")
                    }}
                  >
                    Editar etiquetas
                  </Button>
                ) : null}
              </span>
            </Item>
          </dl>
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                Campos propios de la clínica
              </p>
              {canWrite && defs.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    patch.reset()
                    setDraftCustom({ ...custom })
                    setOpen("campos")
                  }}
                >
                  Editar campos
                </Button>
              ) : null}
            </div>
            {defs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                La clínica aún no definió campos propios.{" "}
                {canConfigure ? (
                  <Link
                    to="/settings/fields"
                    className="font-semibold text-primary hover:underline"
                  >
                    Definir campos
                  </Link>
                ) : null}
              </p>
            ) : (
              <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                {defs.map((def) => (
                  <Item key={def.key} label={def.label}>
                    {custom[def.key] === undefined || custom[def.key] === ""
                      ? null
                      : String(custom[def.key])}
                  </Item>
                ))}
              </dl>
            )}
          </div>
        </div>
      )}
      <FormDrawer
        open={open === "preferido"}
        onClose={close}
        title="Medio preferido para avisos"
        description="Solo los medios que la clínica tiene conectados. Si nadie lo eligió, se usa el de su última conversación; los documentos van por correo si tiene uno."
        submitLabel="Guardar"
        isSubmitting={patch.isPending}
        error={patch.error ? mutationErrorMessage(patch.error) : null}
        onSubmit={(event) => {
          event.preventDefault()
          patch.mutate({ preferredChannel: draftPreferred || null })
        }}
      >
        <Field>
          <FieldLabel htmlFor="person-preferred">Medio preferido</FieldLabel>
          <ChoiceSelect
            id="person-preferred"
            value={draftPreferred}
            onChange={(event) => setDraftPreferred(event.target.value)}
          >
            <option value="">Sin preferencia</option>
            {connected.map((channel) => (
              <option key={channel} value={channel}>
                {PREFERRED_LABELS[channel] ?? channel}
              </option>
            ))}
          </ChoiceSelect>
        </Field>
      </FormDrawer>
      <FormDrawer
        open={open === "etiquetas"}
        onClose={close}
        title="Editar etiquetas"
        submitLabel="Guardar"
        isSubmitting={patch.isPending}
        error={patch.error ? mutationErrorMessage(patch.error) : null}
        onSubmit={(event) => {
          event.preventDefault()
          patch.mutate({ tags: draftTags })
        }}
      >
        <Field>
          <FieldLabel>Etiquetas</FieldLabel>
          <TagsInput value={draftTags} onChange={setDraftTags} />
        </Field>
      </FormDrawer>
      <FormDrawer
        open={open === "campos"}
        onClose={close}
        title="Editar campos propios"
        submitLabel="Guardar"
        isSubmitting={patch.isPending}
        error={patch.error ? mutationErrorMessage(patch.error) : null}
        onSubmit={(event) => {
          event.preventDefault()
          patch.mutate({ customFields: draftCustom })
        }}
      >
        <div className="flex flex-col gap-4">
          {defs.map((def) => {
            const id = `person-field-${def.key}`
            const value = draftCustom[def.key]
            const set = (next: unknown) => setDraftCustom((prev) => ({ ...prev, [def.key]: next }))
            return (
              <Field key={def.key}>
                <FieldLabel htmlFor={id}>{def.label}</FieldLabel>
                {def.type === "select" ? (
                  <ChoiceSelect
                    id={id}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => set(event.target.value)}
                  >
                    <option value="">Sin dato</option>
                    {(def.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </ChoiceSelect>
                ) : def.type === "date" ? (
                  <DatePickerButton
                    id={id}
                    className="w-56"
                    value={typeof value === "string" ? value : ""}
                    emptyLabel="Sin dato"
                    // Sin fecha viaja como null: el servidor la quita (una cadena vacía no es fecha).
                    onChange={(next) => set(next || null)}
                  />
                ) : (
                  <Input
                    id={id}
                    inputMode={def.type === "number" ? "decimal" : undefined}
                    value={value === undefined || value === null ? "" : String(value)}
                    onChange={(event) => {
                      const raw = event.target.value
                      set(def.type === "number" ? (raw === "" ? "" : Number(raw)) : raw)
                    }}
                  />
                )}
              </Field>
            )
          })}
        </div>
      </FormDrawer>
    </Card>
  )
}
