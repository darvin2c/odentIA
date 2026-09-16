import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Field,
  FieldLabel,
  Input,
} from "@odentia/ui"
import { EmptyState, FormDrawer, PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { TagsInput } from "../../components/patient/tags-input"
import { apiFetch } from "../../lib/api"
import { type ContactFull, type FieldDef, type Pipeline, timeAgo } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/contacts/$contactId")({
  component: ContactDetailPage,
})

const orgRouteApi = getRouteApi("/_org")

function ContactDetailPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { org } = orgRouteApi.useRouteContext()
  const { contactId } = Route.useParams()
  const [tagsOpen, setTagsOpen] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [convertOpen, setConvertOpen] = useState(false)

  const detailQuery = useQuery({
    queryKey: ["contact", contactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
  })
  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })
  const fieldsQuery = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
  })

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["contact", contactId] })
    void queryClient.invalidateQueries({ queryKey: ["contacts"] })
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["contact", contactId] })
    void queryClient.invalidateQueries({ queryKey: ["contacts"] })
  }

  const patchMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch(`/api/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: invalidate,
  })

  const convertMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      apiFetch<{ data: { id: string } }>("/api/patients", {
        method: "POST",
        body: JSON.stringify({ contactId, ...values }),
      }),
    onSuccess: (created) => {
      setConvertOpen(false)
      invalidate()
      void navigate({ to: "/patients/$patientId", params: { patientId: created.data.id } })
    },
  })

  const detail = detailQuery.data?.data
  if (detailQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando…</p>
  }
  if (!detail) {
    return <EmptyState title="No encontrado" description="El contacto ya no existe." />
  }

  const stages = pipelinesQuery.data?.data.flatMap((p) => p.stages) ?? []
  const fieldDefs = fieldsQuery.data?.data ?? []
  const customFields = detail.contact.customFields

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/contacts" />}>Contactos</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{detail.contact.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <PageHeader
        title={detail.contact.displayName}
        subtitle={`Contacto desde ${timeAgo(detail.contact.createdAt)}`}
      />
      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Paciente</h2>
        {detail.patientId ? (
          <Link
            to="/patients/$patientId"
            params={{ patientId: detail.patientId }}
            className="text-sm text-primary hover:underline"
          >
            Ver ficha clínica
          </Link>
        ) : (
          <div>
            <p className="text-sm text-muted-foreground">Este contacto aún no es paciente.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setConvertOpen(true)}
            >
              Convertir en paciente
            </Button>
          </div>
        )}
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Datos</h2>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              const form = new FormData(e.currentTarget)
              void patchMutation.mutate({
                displayName: String(form.get("displayName") ?? detail.contact.displayName),
                notes: String(form.get("notes") ?? ""),
              })
            }}
          >
            <Field>
              <FieldLabel>Nombre</FieldLabel>
              <Input
                name="displayName"
                defaultValue={detail.contact.displayName}
                key={detail.contact.displayName}
              />
            </Field>
            <Field>
              <FieldLabel>Notas</FieldLabel>
              <Input
                name="notes"
                defaultValue={detail.contact.notes ?? ""}
                key={detail.contact.notes ?? ""}
              />
            </Field>
            <div className="flex gap-2">
              <Field>
                <FieldLabel>Etapa</FieldLabel>
                <select
                  aria-label="Etapa"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={detail.contact.stageId ?? ""}
                  onChange={(e) => patchMutation.mutate({ stageId: e.target.value || null })}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel>Asignado</FieldLabel>
                <select
                  aria-label="Asignado"
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={detail.contact.assignedUserId ?? ""}
                  onChange={(e) => patchMutation.mutate({ assignedUserId: e.target.value || null })}
                >
                  <option value="">Sin asignar</option>
                  {org.members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <SubmitButton pending={patchMutation.isPending}>Guardar</SubmitButton>
          </form>
          <div>
            <span className="text-sm font-medium">Etiquetas</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {detail.contact.tags.length === 0 && (
                <span className="text-sm text-muted-foreground">Sin etiquetas</span>
              )}
              {detail.contact.tags.map((t) => (
                <Badge variant="secondary" key={t}>
                  {t}
                </Badge>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                setDraftTags(detail.contact.tags)
                setTagsOpen(true)
              }}
            >
              Editar etiquetas
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Campos personalizados</h2>
          {fieldDefs.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Sin campos definidos (Configuración → Campos).
            </p>
          )}
          {fieldDefs.map((def) => (
            <Field key={def.key}>
              <FieldLabel>{def.label}</FieldLabel>
              {def.type === "select" ? (
                <select
                  aria-label={def.label}
                  className="rounded-md border bg-background px-2 py-1.5 text-sm"
                  value={
                    typeof customFields[def.key] === "string"
                      ? (customFields[def.key] as string)
                      : ""
                  }
                  onChange={(e) =>
                    patchMutation.mutate({
                      customFields: { ...customFields, [def.key]: e.target.value },
                    })
                  }
                >
                  <option value="">—</option>
                  {(def.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                  defaultValue={String(customFields[def.key] ?? "")}
                  key={`${def.key}:${String(customFields[def.key] ?? "")}`}
                  onBlur={(e) => {
                    const raw = e.target.value
                    if (raw === "") return
                    const value = def.type === "number" ? Number(raw) : raw
                    patchMutation.mutate({ customFields: { ...customFields, [def.key]: value } })
                  }}
                />
              )}
            </Field>
          ))}
          <h2 className="mt-2 text-sm font-semibold">Identidades</h2>
          {detail.identities.map((ident) => (
            <p key={ident.id} className="text-sm text-muted-foreground">
              {ident.channel === "whatsapp" ? "WhatsApp" : "Telegram"} ·{" "}
              {ident.displayName ?? ident.externalUserId}
            </p>
          ))}
        </section>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Tareas abiertas</h2>
          {detail.openTasks.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin tareas abiertas.</p>
          )}
          {detail.openTasks.map((t) => (
            <p key={t.id} className="text-sm">
              {t.title}
              {t.dueAt && (
                <span className="text-muted-foreground"> · vence {timeAgo(t.dueAt)}</span>
              )}
            </p>
          ))}
          <Link to="/tasks" className="text-sm text-primary hover:underline">
            Ir a tareas
          </Link>
        </section>
        <section className="flex flex-col gap-2 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Conversaciones</h2>
          {detail.conversations.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin conversaciones.</p>
          )}
          {detail.conversations.map((conv) => (
            <p key={conv.id} className="text-sm">
              <Badge variant={conv.status === "open" ? "success" : "secondary"}>
                {conv.status}
              </Badge>{" "}
              <span className="text-muted-foreground">{timeAgo(conv.lastMessageAt)}</span>{" "}
              <Link
                to="/inbox"
                search={{ conversation: conv.id }}
                className="text-primary hover:underline"
              >
                Abrir
              </Link>
            </p>
          ))}
        </section>
      </div>
      <FormDrawer
        open={tagsOpen}
        onClose={() => setTagsOpen(false)}
        title="Editar etiquetas"
        submitLabel="Guardar"
        cancelLabel="Cancelar"
        isSubmitting={patchMutation.isPending}
        error={patchMutation.error instanceof Error ? patchMutation.error.message : null}
        onSubmit={(event) => {
          event.preventDefault()
          patchMutation.mutate({ tags: draftTags }, { onSuccess: () => setTagsOpen(false) })
        }}
      >
        <Field>
          <FieldLabel>Etiquetas</FieldLabel>
          <TagsInput value={draftTags} onChange={setDraftTags} />
        </Field>
      </FormDrawer>
      <FormDrawer
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        title="Convertir en paciente"
        submitLabel="Crear ficha"
        cancelLabel="Cancelar"
        isSubmitting={convertMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget as HTMLFormElement)
          const str = (k: string) => {
            const v = String(form.get(k) ?? "").trim()
            return v ? v : undefined
          }
          void convertMutation.mutate({
            ...(str("docType") ? { docType: str("docType") } : {}),
            ...(str("docNumber") ? { docNumber: str("docNumber") } : {}),
            ...(str("birthDate") ? { birthDate: str("birthDate") } : {}),
            ...(str("sex") ? { sex: str("sex") } : {}),
          })
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Tipo de documento (opcional)</FieldLabel>
            <select
              name="docType"
              aria-label="Tipo de documento"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              defaultValue=""
            >
              <option value="">—</option>
              <option value="DNI">DNI</option>
              <option value="CE">CE</option>
              <option value="PASAPORTE">Pasaporte</option>
              <option value="OTRO">Otro</option>
            </select>
          </Field>
          <Field>
            <FieldLabel>Número de documento (opcional)</FieldLabel>
            <Input name="docNumber" />
          </Field>
          <Field>
            <FieldLabel>Fecha de nacimiento (opcional)</FieldLabel>
            <Input name="birthDate" type="date" />
          </Field>
          <Field>
            <FieldLabel>Sexo (opcional)</FieldLabel>
            <select
              name="sex"
              aria-label="Sexo"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              defaultValue=""
            >
              <option value="">—</option>
              <option value="M">Masculino</option>
              <option value="F">Femenino</option>
            </select>
          </Field>
        </div>
      </FormDrawer>
    </div>
  )
}
