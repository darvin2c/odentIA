import { Badge, Button, Field, FieldError, FieldLabel, Input } from "@odentia/ui"
import {
  common,
  DataTable,
  EmptyState,
  FilterBar,
  FormDrawer,
  fieldErrorMessages,
  PageHeader,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { MessageCircle, Plus, Send } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { TagsInput } from "../../components/patient/tags-input"
import { apiFetch } from "../../lib/api"
import { type ContactListItem, type Pipeline, timeAgo } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/contacts/")({
  component: ContactsPage,
})

const orgRouteApi = getRouteApi("/_org")

const contactSchema = z.object({
  displayName: z.string().min(1, "Ingresa el nombre"),
  notes: z.string(),
  tags: z.array(z.string()),
})

type ContactFormValues = z.infer<typeof contactSchema>

const emptyValues: ContactFormValues = { displayName: "", notes: "", tags: [] }

function ContactsPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const listSearch = useListSearch()
  // SearchInput (FilterBar) escribe la búsqueda en `q` con debounce propio.
  const q = listSearch.get("q") ?? ""
  const stageId = listSearch.get("stageId") ?? undefined
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
    // El backend espera `q` directamente, sin mapeo.
    queryKey: ["contacts", q, stageId],
    queryFn: () => {
      const params = new URLSearchParams()
      if (q.trim()) params.set("q", q.trim())
      if (stageId) params.set("stageId", stageId)
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

  const [drawerOpen, setDrawerOpen] = useState(false)

  const saveMutation = useMutation({
    mutationFn: async (values: ContactFormValues) => {
      await apiFetch("/api/contacts", {
        method: "POST",
        body: JSON.stringify({
          displayName: values.displayName,
          notes: values.notes || undefined,
          tags: values.tags,
        }),
      })
    },
    onSuccess: () => {
      setDrawerOpen(false)
      form.reset()
      void queryClient.invalidateQueries({ queryKey: ["contacts"] })
    },
  })

  const form = useForm({
    defaultValues: emptyValues,
    validators: { onSubmit: contactSchema },
    onSubmit: ({ value }) => saveMutation.mutate(value),
  })

  const columns = useMemo<ColumnDef<ContactListItem>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: "Nombre",
        cell: ({ row }) => (
          <Link
            to="/contacts/$contactId"
            params={{ contactId: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.displayName}
          </Link>
        ),
      },
      {
        id: "channels",
        header: "Canales",
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
    ],
    [org.members, stageName],
  )

  const hasFilters = q.trim() !== "" || stageId !== undefined
  const table = useReactTable({
    data: visibleContacts,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Contactos"
        subtitle="Pacientes y conversaciones asociadas"
        actions={
          <Button type="button" className="min-h-11" onClick={() => setDrawerOpen(true)}>
            <Plus aria-hidden />
            Nuevo contacto
          </Button>
        }
      />
      <FilterBar
        filters={[
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
        searchPlaceholder="Buscar contacto"
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
      <FormDrawer
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false)
          saveMutation.reset()
        }}
        title="Nuevo contacto"
        submitLabel="Crear"
        cancelLabel="Cancelar"
        isSubmitting={saveMutation.isPending}
        error={saveMutation.error instanceof Error ? saveMutation.error.message : null}
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <div className="flex flex-col gap-4">
          <form.Field name="displayName">
            {(field) => (
              <Field>
                <FieldLabel>Nombre</FieldLabel>
                <Input
                  value={field.state.value}
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
                <Input
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
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
      </FormDrawer>
    </div>
  )
}
