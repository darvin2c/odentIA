import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  isValidE164,
  MasterDetail,
  normalizeCountry,
  PageHeader,
  PageShell,
  PhoneInput,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { MessageCircle, Plus, Send } from "lucide-react"
import { type FormEvent, useMemo, useState } from "react"
import { z } from "zod"
import { ContactConversationDialog } from "../../components/contact-conversation-dialog"
import { TagsInput } from "../../components/patient/tags-input"
import { ApiError, apiFetch } from "../../lib/api"
import { type ContactListItem, type Pipeline, timeAgo, useCanWrite } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/contacts/")({
  component: ContactsPage,
})

const orgRouteApi = getRouteApi("/_org")

const contactSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  // El campo emite E.164 o `null` (vacío), nunca el texto con máscara.
  phone: z
    .string()
    .nullable()
    .refine((value) => value === null || isValidE164(value), "Teléfono inválido"),
  email: z.string().max(254).optional(),
  notes: z.string(),
  tags: z.array(z.string()),
})

type ContactFormValues = z.infer<typeof contactSchema>

const emptyValues: ContactFormValues = {
  displayName: "",
  phone: null,
  email: "",
  notes: "",
  tags: [],
}

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback
  return err instanceof Error ? err.message : fallback
}

function ContactsPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { org } = orgRouteApi.useRouteContext()
  // El país del perfil define la máscara del teléfono que se captura.
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const canWrite = useCanWrite()
  const listSearch = useListSearch()
  const q = listSearch.get("q") ?? ""
  const stageId = listSearch.get("stageId") ?? undefined
  const activeFilter = listSearch.get("isActive") ?? "true"
  const sort = listSearch.get("sort")

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })
  const stages = useMemo(
    () => pipelinesQuery.data?.data.flatMap((p) => p.stages) ?? [],
    [pipelinesQuery.data],
  )
  const stageName = useMemo(() => new Map(stages.map((s) => [s.id, s.name])), [stages])

  const contactsQuery = useQuery({
    // El backend espera `q` directamente, sin mapeo. Cambiar filtros resetea
    // el cursor vía useListSearch.
    queryKey: ["contacts", q, stageId, activeFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (q.trim()) params.set("q", q.trim())
      if (stageId) params.set("stageId", stageId)
      params.set(
        "isActive",
        activeFilter === "false" ? "false" : activeFilter === "all" ? "all" : "true",
      )
      return apiFetch<{ data: ContactListItem[]; nextCursor: string | null }>(
        `/api/contacts?${params}`,
      )
    },
  })
  // Sin orden el backend manda; con `sort` se ordena en cliente.
  const visibleContacts = useMemo(() => {
    const rows = [...(contactsQuery.data?.data ?? [])]
    if (!sort) return rows
    const descending = sort.startsWith("-")
    const field = descending ? sort.slice(1) : sort
    if (field === "nombre") {
      rows.sort((a, b) => a.displayName.localeCompare(b.displayName, "es"))
    } else if (field === "actividad") {
      rows.sort((a, b) => (a.lastInteractionAt ?? "").localeCompare(b.lastInteractionAt ?? ""))
    } else {
      return rows
    }
    // `nombre` asciende por defecto; `actividad` muestra lo reciente primero.
    const invert = field === "actividad" ? !descending : descending
    if (invert) rows.reverse()
    return rows
  }, [contactsQuery.data, sort])
  const allTags = useMemo(() => {
    const seen: Record<string, true> = {}
    const out: string[] = []
    for (const contact of contactsQuery.data?.data ?? []) {
      for (const tag of contact.tags) {
        if (!seen[tag]) {
          seen[tag] = true
          out.push(tag)
        }
      }
    }
    return out
  }, [contactsQuery.data])

  useOrgEvents(["message.created", "conversation.updated"], () => {
    void queryClient.invalidateQueries({ queryKey: ["contacts"] })
  })

  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [dialog, setDialog] = useState<{
    contact: ContactListItem
    prepareRegistration: boolean
  } | null>(null)
  const [archiving, setArchiving] = useState<ContactListItem | null>(null)

  const saveMutation = useMutation({
    mutationFn: async (values: ContactFormValues) => {
      await apiFetch("/api/contacts", {
        method: "POST",
        body: JSON.stringify({
          displayName: values.displayName,
          phone: values.phone ?? undefined,
          email: values.email?.trim() ? values.email.trim() : undefined,
          notes: values.notes || undefined,
          tags: values.tags,
        }),
      })
    },
    onSuccess: () => {
      closeContactForm()
      void queryClient.invalidateQueries({ queryKey: ["contacts"] })
    },
  })

  const activeMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      apiFetch(`/api/contacts/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: input.isActive }),
      }),
    onSuccess: () => {
      setArchiving(null)
      void queryClient.invalidateQueries({ queryKey: ["contacts"] })
    },
  })

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: contactSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  })

  // Suscripción explícita: el render de la página no se entera de los cambios de
  // meta del formulario por sí solo (los campos se re-renderizan por su cuenta).
  const isDirty = useStore(form.store, (state) => state.isDirty)

  /** Cierra y deja el formulario prístino: sin el reset, el dirty sobrevive al
   *  cierre y el próximo abrir pediría confirmar cambios ya guardados. */
  function closeContactForm() {
    setFormOpen(false)
    form.reset()
    saveMutation.reset()
  }

  const columns = useMemo<ColumnDef<ContactListItem>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: "Nombre",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{row.original.displayName}</span>
            {!row.original.isActive && <Badge variant="secondary">Archivado</Badge>}
          </span>
        ),
      },
      {
        id: "channels",
        header: "Canales",
        meta: { view: { role: "media" } },
        cell: ({ row }) => (
          <span className="flex gap-1">
            {row.original.channels.includes("whatsapp") && (
              <MessageCircle className="size-4 text-green-600" />
            )}
            {row.original.channels.includes("telegram") && <Send className="size-4 text-sky-600" />}
          </span>
        ),
      },
      {
        id: "stage",
        header: "Etapa",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.stageId ? (
            <Badge variant="secondary">{stageName.get(row.original.stageId) ?? "—"}</Badge>
          ) : (
            "—"
          ),
      },
      {
        accessorKey: "tags",
        header: "Etiquetas",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            {row.original.tags.map((t) => (
              <Badge variant="secondary" key={t}>
                {t}
              </Badge>
            ))}
          </span>
        ),
      },
      {
        accessorKey: "lastInteractionAt",
        header: "Última actividad",
        meta: { view: { primary: true } },
        cell: ({ row }) => timeAgo(row.original.lastInteractionAt),
      },
      {
        id: "assignee",
        header: "Asignado",
        cell: ({ row }) => {
          const member = org.members.find((m) => m.userId === row.original.assignedUserId)
          return member ? member.user.name : <span className="text-muted-foreground">—</span>
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActions
            label={`Acciones de ${row.original.displayName}`}
            items={[
              {
                key: "open",
                label: "Abrir",
                onSelect: () =>
                  void navigate({
                    to: "/contacts/$contactId",
                    params: { contactId: row.original.id },
                  }),
              },
              {
                key: "conversar",
                label: "Conversar",
                onSelect: () => setDialog({ contact: row.original, prepareRegistration: false }),
              },
              ...(canWrite
                ? [
                    {
                      key: "registro",
                      label: "Enviar registro",
                      onSelect: () =>
                        setDialog({ contact: row.original, prepareRegistration: true }),
                    },
                  ]
                : []),
              ...(canWrite
                ? [
                    row.original.isActive
                      ? {
                          key: "archivar",
                          label: "Archivar",
                          tone: "danger" as const,
                          onSelect: () => {
                            activeMutation.reset()
                            setArchiving(row.original)
                          },
                        }
                      : {
                          key: "reactivar",
                          label: "Reactivar",
                          onSelect: () => {
                            activeMutation.reset()
                            setArchiving(row.original)
                          },
                        },
                  ]
                : []),
            ]}
          />
        ),
      },
    ],
    [org.members, stageName, canWrite, activeMutation, navigate],
  )

  const hasFilters = q.trim() !== "" || stageId !== undefined || activeFilter !== "true"
  const table = useReactTable({
    data: visibleContacts,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const formFields = (
    <div className="flex flex-col gap-4">
      <form.Field name="displayName">
        {(field) => (
          <Field>
            <FieldLabel>Nombre</FieldLabel>
            <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="phone">
        {(field) => {
          const errors = fieldErrorMessages(field.state.meta.errors)
          return (
            <Field>
              <FieldLabel htmlFor="contact-phone">Teléfono (opcional, declarado)</FieldLabel>
              <PhoneInput
                id="contact-phone"
                value={field.state.value}
                onChange={(next) => field.handleChange(next)}
                defaultCountry={countryCode}
                invalid={errors.length > 0}
              />
              <FieldError>{errors}</FieldError>
            </Field>
          )
        }}
      </form.Field>
      <form.Field name="email">
        {(field) => (
          <Field>
            <FieldLabel>Correo (opcional, declarado)</FieldLabel>
            <Input
              type="email"
              value={field.state.value ?? ""}
              onChange={(e) => field.handleChange(e.target.value)}
            />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="notes">
        {(field) => (
          <Field>
            <FieldLabel>Notas (opcional)</FieldLabel>
            <Input value={field.state.value} onChange={(e) => field.handleChange(e.target.value)} />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
      <form.Field name="tags">
        {(field) => (
          <Field>
            <FieldLabel>Etiquetas (opcional)</FieldLabel>
            <TagsInput
              value={field.state.value}
              onChange={(tags) => field.handleChange(tags)}
              suggestions={allTags}
            />
            <FieldError>{fieldErrorMessages(field.state.meta.errors)}</FieldError>
          </Field>
        )}
      </form.Field>
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    onClose: closeContactForm,
    title: "Nuevo contacto",
    isDirty,
    isSubmitting: saveMutation.isPending,
    submitLabel: "Crear",
    cancelLabel: "Cancelar",
    error: saveMutation.error instanceof Error ? saveMutation.error.message : null,
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      void form.handleSubmit()
    },
  }

  return (
    <PageShell className="flex flex-col gap-2">
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Contactos"
          subtitle="Pacientes y conversaciones asociadas"
          actions={
            <Button type="button" className="min-h-11" onClick={() => setFormOpen(true)}>
              <Plus aria-hidden />
              Nuevo contacto
            </Button>
          }
        />
        <FilterBar
          filters={[
            {
              key: "isActive",
              label: "Estado",
              type: "select",
              options: [
                { value: "true", label: "Activos" },
                { value: "false", label: "Archivados" },
                { value: "all", label: "Todos" },
              ],
            },
            {
              key: "stageId",
              label: "Etapa",
              type: "select",
              options: stages.map((s) => ({ value: s.id, label: s.name })),
            },
          ]}
          sortOptions={[
            { value: "nombre", label: "Nombre" },
            { value: "actividad", label: "Última actividad" },
          ]}
          searchPlaceholder="Buscar por nombre, teléfono o correo"
        />
        {visibleContacts.length === 0 && !contactsQuery.isLoading ? (
          <EmptyState
            title={hasFilters ? common.filters.noResults : "Sin contactos"}
            description={
              hasFilters
                ? "No hay contactos que coincidan con los filtros aplicados."
                : "Crea el primero o espera un mensaje entrante."
            }
          />
        ) : (
          <DataTable table={table} />
        )}
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}
      <ContactConversationDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        contacts={
          dialog
            ? [
                {
                  contactId: dialog.contact.id,
                  displayName: dialog.contact.displayName,
                  isPreferred: true,
                },
              ]
            : []
        }
        prepareRegistration={dialog?.prepareRegistration ?? false}
      />
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => {
          if (!activeMutation.isPending) {
            activeMutation.reset()
            setArchiving(null)
          }
        }}
        onConfirm={() =>
          archiving && activeMutation.mutate({ id: archiving.id, isActive: !archiving.isActive })
        }
        title={
          archiving?.isActive
            ? `Archivar ${archiving?.displayName ?? ""}`
            : `Reactivar ${archiving?.displayName ?? ""}`
        }
        description={
          activeMutation.error
            ? mutationMessage(activeMutation.error, "No se pudo actualizar el contacto.")
            : archiving?.isActive
              ? "El contacto archivado conserva identidades y conversaciones. No se podrán iniciar nuevas conversaciones ni crear vínculos o envíos hasta reactivarlo."
              : "El contacto volverá a estar disponible para conversaciones, vínculos y envíos. Los enlaces de registro revocados al archivar no se reactivan."
        }
        confirmLabel={archiving?.isActive ? "Archivar" : "Reactivar"}
        variant={archiving?.isActive ? "destructive" : "default"}
        pending={activeMutation.isPending}
      />
    </PageShell>
  )
}
