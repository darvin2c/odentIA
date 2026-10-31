import { normalizeTags } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import {
  DatePickerButton,
  FormDrawer,
  internationalText,
  LoadingState,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useMemo, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { type ContactFull, type FieldDef, useCan, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { sexLabel } from "../../lib/patient-overview"
import type { PatientFull } from "../../lib/patients"
import type { PersonPage } from "../../lib/people"
import { documentLine } from "../../lib/person-data"
import { QueryErrorState } from "../../lib/query-error"
import { FiliacionPanel } from "../patient/filiacion-panel"
import { FiliacionSectionDrawer, type FiliacionSectionKey } from "../patient/filiacion-section-drawer"
import { MessagePermissionsSection } from "../patient/message-permissions-section"
import { PhoneWhatsAppNote } from "./phone-whatsapp"
import { TAGS_INPUT_HELP, TagsCount, TagsInput } from "../patient/tags-input"
import { FiliacionSkeleton } from "../skeletons/person-sections"

/** Las mismas reglas de `normalizeTags` que aplica la ruta, dichas en el campo. */
const tagsSchema = z.object({
  tags: z.array(z.string()).superRefine((tags, ctx) => {
    try {
      normalizeTags(tags)
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Revisa las etiquetas" })
    }
  }),
})

/** Lo guardado de cada campo propio, como texto para su control. */
function customFieldsDraft(defs: FieldDef[], saved: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    defs.map((def) => {
      const value = saved[def.key]
      return [def.key, value === undefined || value === null ? "" : String(value)]
    }),
  )
}

/** Un número escrito con coma o punto decimal; `null` si no es un número. */
function numberOf(raw: string): number | null {
  const value = Number(raw.trim().replace(",", "."))
  return Number.isFinite(value) ? value : null
}

/**
 * Lo que se envía de cada campo propio: vacío es `null` (el servidor lo
 * quita) y un número va como número, como exige `sanitizeCustomFields`.
 */
function customFieldsBody(defs: FieldDef[], draft: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(
    defs.map((def) => {
      const raw = draft[def.key] ?? ""
      if (!raw.trim()) return [def.key, null]
      return [def.key, def.type === "number" ? numberOf(raw) : raw]
    }),
  )
}

/** Un número que no lo es se dice en su campo, en vez de perderse al guardar. */
function customFieldsSchema(defs: FieldDef[]) {
  return z.object({
    customFields: z.record(z.string(), z.string()).superRefine((draft, ctx) => {
      for (const def of defs) {
        const raw = draft[def.key] ?? ""
        if (def.type === "number" && raw.trim() && numberOf(raw) === null)
          ctx.addIssue({ code: "custom", path: [def.key], message: "Escribe un número, como 12 o 3.5" })
      }
    }),
  })
}

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
  const defs = fields.data?.data ?? []
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/contacts/${person.id}`, { method: "PATCH", body: JSON.stringify(body) }),
  })
  const saved = async (body: Record<string, unknown>) => {
    await patch.mutateAsync(body)
    setOpen(null)
    void queryClient.invalidateQueries({ queryKey: ["contact", person.id] })
    void queryClient.invalidateQueries({ queryKey: ["people"] })
  }
  const preferredForm = useAppForm({
    defaultValues: { preferredChannel: "" },
    onSubmit: ({ value }) => saved({ preferredChannel: value.preferredChannel || null }),
  })
  const tagsForm = useAppForm({
    defaultValues: { tags: [] as string[] },
    validators: { onSubmit: tagsSchema },
    onSubmit: ({ value }) => saved({ tags: value.tags }),
  })
  const customForm = useAppForm({
    defaultValues: { customFields: {} as Record<string, string> },
    validators: { onSubmit: customFieldsSchema(defs) },
    // Vaciar un dato lo quita (null): una cadena vacía no es número, fecha ni opción.
    onSubmit: ({ value }) => saved({ customFields: customFieldsBody(defs, value.customFields) }),
  })
  const preferredSurface = useFormSurface(preferredForm)
  const tagsSurface = useFormSurface(tagsForm)
  const customSurface = useFormSurface(customForm)
  const draftPreferred = useStore(preferredForm.store, (state) => state.values.preferredChannel)
  const connected = useMemo(() => {
    const channels = [
      ...new Set(
        (connections.data?.data ?? []).filter((c) => c.status === "active").map((c) => c.channel),
      ),
    ]
    if (draftPreferred && !channels.includes(draftPreferred)) channels.unshift(draftPreferred)
    return channels
  }, [connections.data, draftPreferred])
  if (!canRead) return null
  const data = contact.data?.data.contact
  const custom = data?.customFields ?? {}
  const close = () => {
    if (!patch.isPending) setOpen(null)
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
                      preferredForm.reset({ preferredChannel: data.preferredChannel ?? "" })
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
                      tagsForm.reset({ tags: data.tags })
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
                    customForm.reset({ customFields: customFieldsDraft(defs, custom) })
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
        {...preferredSurface}
        open={open === "preferido"}
        onClose={close}
        title="Medio preferido para avisos"
        description="Solo los medios que la clínica tiene conectados. Si nadie lo eligió, se usa el de su última conversación; los documentos van por correo si tiene uno."
        submitLabel="Guardar"
      >
        <preferredForm.AppField name="preferredChannel">
          {(field) => (
            <field.SelectField
              label="Medio preferido"
              options={[
                { value: "", label: "Sin preferencia" },
                ...connected.map((channel) => ({ value: channel, label: PREFERRED_LABELS[channel] ?? channel })),
              ]}
            />
          )}
        </preferredForm.AppField>
      </FormDrawer>
      <FormDrawer
        {...tagsSurface}
        open={open === "etiquetas"}
        onClose={close}
        title="Editar etiquetas"
        submitLabel="Guardar"
      >
        <tagsForm.AppField name="tags">
          {(field) => (
            <field.Control
              label={
                <>
                  Etiquetas <TagsCount count={field.state.value.length} />
                </>
              }
              description={TAGS_INPUT_HELP}
            >
              {(control) => (
                <TagsInput
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </field.Control>
          )}
        </tagsForm.AppField>
      </FormDrawer>
      <FormDrawer
        {...customSurface}
        open={open === "campos"}
        onClose={close}
        title="Editar campos propios"
        submitLabel="Guardar"
      >
        <div className="flex flex-col gap-4">
          {defs.map((def) => (
            <customForm.AppField key={def.key} name={`customFields.${def.key}`}>
              {(field) =>
                def.type === "select" ? (
                  <field.SelectField
                    label={def.label}
                    options={[
                      { value: "", label: "Sin dato" },
                      ...(def.options ?? []).map((option) => ({ value: option, label: option })),
                    ]}
                  />
                ) : def.type === "date" ? (
                  <field.Control label={def.label}>
                    {(control) => (
                      <DatePickerButton
                        {...control.props}
                        className="w-56"
                        value={field.state.value ?? ""}
                        emptyLabel="Sin dato"
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                ) : (
                  <field.TextField label={def.label} inputMode={def.type === "number" ? "decimal" : undefined} />
                )
              }
            </customForm.AppField>
          ))}
        </div>
      </FormDrawer>
    </Card>
  )
}
