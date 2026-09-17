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
  Textarea,
} from "@odentia/ui"
import {
  ConfirmDialog,
  EmptyState,
  FormDrawer,
  PageHeader,
  PageShell,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { MessageCircle, Send } from "lucide-react"
import { useState } from "react"
import { ContactConversationDialog } from "../../components/contact-conversation-dialog"
import { CreatePatientDrawer } from "../../components/patient/create-patient-drawer"
import { TagsInput } from "../../components/patient/tags-input"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type ContactFull,
  type ContactListItem,
  type FieldDef,
  type Pipeline,
  timeAgo,
  useCanWrite,
} from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"

export const Route = createFileRoute("/_org/contacts/$contactId")({
  component: ContactDetailPage,
})

const orgRouteApi = getRouteApi("/_org")

const RELATIONSHIP_LABELS: Record<string, string> = {
  self: "Propio paciente",
  guardian: "Tutor o responsable",
  family: "Familiar",
  other: "Otro contacto",
}

interface PatientSearchItem {
  id: string
  displayName: string
  patientNumber: number
}

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback
  return err instanceof Error ? err.message : fallback
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof ApiError) {
    const shape = err.shape as { code?: unknown }
    return typeof shape.code === "string" ? shape.code : undefined
  }
  return undefined
}

function ContactDetailPage() {
  const queryClient = useQueryClient()
  const { org } = orgRouteApi.useRouteContext()
  const canWrite = useCanWrite()
  const { contactId } = Route.useParams()
  const [tagsOpen, setTagsOpen] = useState(false)
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [patientDrawer, setPatientDrawer] = useState(false)
  const [dialog, setDialog] = useState<{ prepareRegistration: boolean } | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  const [linkOpen, setLinkOpen] = useState(false)
  const [linkSearch, setLinkSearch] = useState("")
  const [linkChoice, setLinkChoice] = useState<PatientSearchItem | null>(null)
  const [linkRelation, setLinkRelation] = useState("family")
  const [linkDetail, setLinkDetail] = useState("")
  const [linkPreferred, setLinkPreferred] = useState(false)

  const [identityOpen, setIdentityOpen] = useState(false)
  const [identityChannel, setIdentityChannel] = useState("whatsapp")
  const [identityExternalId, setIdentityExternalId] = useState("")

  const [moveIdentityId, setMoveIdentityId] = useState<string | null>(null)
  const [destSearch, setDestSearch] = useState("")
  const [destChoice, setDestChoice] = useState<ContactListItem | null>(null)
  const [moveReason, setMoveReason] = useState("")
  const [moveResult, setMoveResult] = useState<string | null>(null)

  const [resolveConfirm, setResolveConfirm] = useState<{
    conversationId: string
    conversationLabel: string
    identityId: string
    identityLabel: string
  } | null>(null)
  const [resolveSelection, setResolveSelection] = useState<Record<string, string>>({})

  const detailQuery = useQuery({
    queryKey: ["contact", contactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
  })
  const detail = detailQuery.data?.data ?? null
  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
  })
  const fieldsQuery = useQuery({
    queryKey: ["fields"],
    queryFn: () => apiFetch<{ data: FieldDef[] }>("/api/fields"),
  })
  const patientSearchQuery = useQuery({
    queryKey: ["patients-search", linkSearch.trim()],
    queryFn: () =>
      apiFetch<{ data: PatientSearchItem[] }>(
        `/api/patients?q=${encodeURIComponent(linkSearch.trim())}&limit=10`,
      ),
    enabled: linkOpen && linkSearch.trim().length > 0,
  })
  const destSearchQuery = useQuery({
    queryKey: ["contacts-search", destSearch.trim()],
    queryFn: () =>
      apiFetch<{ data: ContactListItem[] }>(
        `/api/contacts?q=${encodeURIComponent(destSearch.trim())}&isActive=all&limit=10`,
      ),
    enabled: moveIdentityId !== null && destSearch.trim().length > 0,
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

  const activeMutation = useMutation({
    mutationFn: (isActive: boolean) =>
      apiFetch(`/api/contacts/${contactId}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onSuccess: () => {
      setArchiveOpen(false)
      invalidate()
    },
  })

  const linkMutation = useMutation({
    mutationFn: () => {
      if (!linkChoice) throw new Error("Elige un paciente para vincular")
      return apiFetch(`/api/patients/${linkChoice.id}/contacts/${contactId}`, {
        method: "PUT",
        body: JSON.stringify({
          relationship: linkRelation,
          ...(linkDetail.trim() ? { relationshipDetail: linkDetail.trim() } : {}),
          isPreferred: linkPreferred,
        }),
      })
    },
    onSuccess: () => {
      setLinkOpen(false)
      setLinkChoice(null)
      setLinkSearch("")
      setLinkDetail("")
      setLinkPreferred(false)
      invalidate()
    },
  })

  const identityMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { id: string } }>(`/api/contacts/${contactId}/identities`, {
        method: "POST",
        body: JSON.stringify({ channel: identityChannel, externalUserId: identityExternalId.trim() }),
      }),
    onSuccess: () => {
      setIdentityOpen(false)
      setIdentityExternalId("")
      invalidate()
    },
  })

  const moveMutation = useMutation({
    mutationFn: () => {
      if (!moveIdentityId || !destChoice) throw new Error("Elige el contacto destino")
      return apiFetch<{
        data: { movedConversations: number; movedTasks: number; revokedLinks: number }
      }>(`/api/contacts/${contactId}/identities/${moveIdentityId}/move`, {
        method: "POST",
        body: JSON.stringify({ toContactId: destChoice.id, reason: moveReason.trim() }),
      })
    },
    onSuccess: (result) => {
      setMoveResult(
        `Identidad reasignada: ${result.data.movedConversations} conversación(es), ${result.data.movedTasks} tarea(s). Enlaces pendientes revocados: ${result.data.revokedLinks}.`,
      )
      setMoveIdentityId(null)
      setDestChoice(null)
      setDestSearch("")
      setMoveReason("")
      invalidate()
    },
  })

  const resolveMutation = useMutation({
    mutationFn: (input: { conversationId: string; identityId: string }) =>
      apiFetch(`/api/conversations/${input.conversationId}/identity`, {
        method: "PUT",
        body: JSON.stringify({ identityId: input.identityId }),
      }),
    onSuccess: () => {
      setResolveConfirm(null)
      invalidate()
    },
  })

  if (detailQuery.isLoading) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </PageShell>
    )
  }
  if (!detail) {
    return (
      <PageShell>
        <EmptyState title="No encontrado" description="El contacto ya no existe." />
      </PageShell>
    )
  }

  const stages = pipelinesQuery.data?.data.flatMap((p) => p.stages) ?? []
  const fieldDefs = fieldsQuery.data?.data ?? []
  const customFields = detail.contact.customFields
  const patients = detail.patients
  const selfLink = patients.find((p) => p.relationship === "self")
  const archived = !detail.contact.isActive
  const moveIdentity = detail.identities.find((i) => i.id === moveIdentityId) ?? null
  const moveResolvedCount = moveIdentity
    ? detail.conversations.filter((c) => c.contactIdentityId === moveIdentity.id).length
    : 0
  const moveAmbiguous =
    moveIdentity != null && errorCode(moveMutation.error) === "AMBIGUOUS_CHANNEL_HISTORY"
  const ambiguousConvs = moveIdentity
    ? detail.conversations.filter(
        (c) => c.contactIdentityId === null && c.channel === moveIdentity.channel,
      )
    : []

  return (
    <PageShell className="flex flex-col gap-6">
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
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              variant="secondary"
              className={archived ? undefined : "border-emerald-300 bg-emerald-50 text-emerald-900"}
            >
              {archived ? "Archivado" : "Activo"}
            </Badge>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialog({ prepareRegistration: false })}
            >
              <MessageCircle aria-hidden className="size-4" />
              Conversar
            </Button>
            {canWrite && (
              <Button
                type="button"
                variant="outline"
                disabled={archived}
                title={
                  archived
                    ? "Contacto archivado: reactívalo para enviar un registro"
                    : undefined
                }
                onClick={() => setDialog({ prepareRegistration: true })}
              >
                Enviar registro
              </Button>
            )}
            {selfLink ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  render={<Link to="/patients/$patientId" params={{ patientId: selfLink.id }} />}
                >
                  Ver paciente
                </Button>
                <Button type="button" onClick={() => setPatientDrawer(true)}>
                  Registrar a otra persona
                </Button>
              </>
            ) : (
              <Button
                type="button"
                disabled={archived}
                title={
                  archived ? "Contacto archivado: reactívalo para registrar" : undefined
                }
                onClick={() => setPatientDrawer(true)}
              >
                Registrar paciente
              </Button>
            )}
            {canWrite && (
              <Button
                type="button"
                variant={archived ? "default" : "outline"}
                onClick={() => {
                  activeMutation.reset()
                  setArchiveOpen(true)
                }}
              >
                {archived ? "Reactivar" : "Archivar"}
              </Button>
            )}
          </span>
        }
      />
      {archived && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          Contacto archivado: conserva identidades y conversaciones, pero no admite nuevas
          conversaciones, vínculos de pacientes ni envíos de registro. Reactívalo para
          continuar. Las conversaciones existentes siguen accesibles desde la bandeja.
        </p>
      )}
      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Pacientes vinculados</h2>
          {canWrite && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={archived}
              title={archived ? "Contacto archivado: reactívalo para vincular" : undefined}
              onClick={() => {
                linkMutation.reset()
                setLinkOpen(true)
              }}
            >
              Vincular paciente existente
            </Button>
          )}
        </div>
        {patients.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin pacientes vinculados. Usa «Registrar paciente» para crear la ficha con este
            contacto como contexto, o vincula una ficha existente con búsqueda explícita.
          </p>
        ) : (
          patients.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <Link
                  to="/patients/$patientId"
                  params={{ patientId: p.id }}
                  className="font-medium text-primary hover:underline"
                >
                  {p.displayName}
                </Link>
                <span className="text-muted-foreground">
                  {RELATIONSHIP_LABELS[p.relationship] ?? p.relationship}
                  {p.relationshipDetail ? ` · ${p.relationshipDetail}` : ""}
                </span>
                {p.isPreferred && <Badge>Preferente</Badge>}
                {!p.isActive && <Badge variant="secondary">Paciente archivado</Badge>}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                render={<Link to="/patients/$patientId" params={{ patientId: p.id }} />}
              >
                Abrir
              </Button>
            </div>
          ))
        )}
        <p className="text-xs text-muted-foreground">
          Una coincidencia de teléfono nunca crea el vínculo automáticamente: siempre se
          confirma aquí.
        </p>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Datos</h2>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              const form = new FormData(e.currentTarget)
              const str = (k: string) => String(form.get(k) ?? "").trim()
              void patchMutation.mutate({
                displayName: str("displayName") || detail.contact.displayName,
                phone: str("phone") ? str("phone") : null,
                email: str("email") ? str("email") : null,
                notes: str("notes"),
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
              <FieldLabel>Teléfono (declarado)</FieldLabel>
              <Input
                name="phone"
                defaultValue={detail.contact.phone ?? ""}
                key={detail.contact.phone ?? ""}
              />
            </Field>
            <Field>
              <FieldLabel>Correo (declarado)</FieldLabel>
              <Input
                type="email"
                name="email"
                defaultValue={detail.contact.email ?? ""}
                key={detail.contact.email ?? ""}
              />
            </Field>
            {(detail.contact.phone ?? detail.contact.email) &&
            detail.identities.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Dato declarado, sin verificación de canal: aún no hay identidades vinculadas.
              </p>
            ) : null}
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
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Canales</h2>
            {canWrite && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={archived}
                title={archived ? "Contacto archivado: reactívalo para gestionar canales" : undefined}
                onClick={() => {
                  identityMutation.reset()
                  setIdentityOpen(true)
                }}
              >
                Agregar identidad
              </Button>
            )}
          </div>
          {moveResult && (
            <p role="status" className="rounded-md border p-2 text-sm">
              {moveResult}
            </p>
          )}
          {detail.identities.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Sin identidades de canal. El teléfono o correo declarados no crean una identidad
              por sí solos.
            </p>
          )}
          {detail.identities.map((ident) => {
            const resolved = detail.conversations.filter(
              (c) => c.contactIdentityId === ident.id,
            ).length
            return (
              <div key={ident.id} className="flex flex-col gap-1 rounded-md border px-2 py-1.5">
                <span className="flex items-center gap-2 text-sm">
                  {ident.channel === "whatsapp" ? (
                    <MessageCircle className="size-4 text-green-600" />
                  ) : (
                    <Send className="size-4 text-sky-600" />
                  )}
                  <span className="font-medium">
                    {ident.channel === "whatsapp" ? "WhatsApp" : "Telegram"}
                  </span>
                  <span className="text-muted-foreground">
                    {ident.displayName ?? ident.externalUserId}
                  </span>
                  <Badge variant="secondary">
                    {resolved} conversación(es) vinculada(s)
                  </Badge>
                </span>
                {canWrite && (
                  <span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={archived}
                      onClick={() => {
                        moveMutation.reset()
                        setMoveResult(null)
                        setMoveIdentityId(ident.id)
                      }}
                    >
                      Reasignar canal
                    </Button>
                  </span>
                )}
              </div>
            )
          })}
          <p className="text-xs text-muted-foreground">
            El correo es un dato declarado, no un canal de envío: los canales soportados son
            WhatsApp y Telegram.
          </p>
        </section>
      </div>

      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Conversaciones</h2>
        <p className="text-xs text-muted-foreground">
          La conversación pertenece al contacto y puede incluir a otros pacientes.
        </p>
        {detail.conversations.length === 0 && (
          <p className="text-sm text-muted-foreground">Sin conversaciones.</p>
        )}
        {detail.conversations.map((conv) => {
          const linked = detail.identities.find((i) => i.id === conv.contactIdentityId)
          const sameChannel = detail.identities.filter(
            (i) => i.channel === conv.channel,
          )
          return (
            <div
              key={conv.id}
              className="flex flex-col gap-1 rounded-md border px-2 py-1.5"
            >
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant="secondary"
                  className={conv.status === "open" ? "border-emerald-300 bg-emerald-50 text-emerald-900" : undefined}
                >
                  {conv.status}
                </Badge>
                <span className="font-medium">
                  {conv.channel === "whatsapp" ? "WhatsApp" : "Telegram"}
                </span>
                {conv.connectionName && (
                  <span className="text-muted-foreground">{conv.connectionName}</span>
                )}
                <span className="text-muted-foreground">
                  {linked
                    ? `Identidad: ${linked.displayName ?? linked.externalUserId}`
                    : "Sin identidad asignada"}
                </span>
                <span className="text-muted-foreground">{timeAgo(conv.lastMessageAt)}</span>
                <Link
                  to="/inbox"
                  search={{ conversation: conv.id }}
                  className="text-primary hover:underline"
                >
                  Abrir
                </Link>
              </span>
              {canWrite && !linked && sameChannel.length > 0 && (
                <span className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`Identidad para conversación ${conv.id}`}
                    className="rounded-md border bg-background px-2 py-1.5 text-sm"
                    value={resolveSelection[conv.id] ?? ""}
                    onChange={(e) =>
                      setResolveSelection((prev) => ({ ...prev, [conv.id]: e.target.value }))
                    }
                  >
                    <option value="">Asignar identidad…</option>
                    {sameChannel.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.displayName ?? i.externalUserId}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!resolveSelection[conv.id] || resolveMutation.isPending}
                    onClick={() => {
                      const identityId = resolveSelection[conv.id]
                      const identity = sameChannel.find((i) => i.id === identityId)
                      if (!identity) return
                      resolveMutation.reset()
                      setResolveConfirm({
                        conversationId: conv.id,
                        conversationLabel: `${conv.channel === "whatsapp" ? "WhatsApp" : "Telegram"}${conv.connectionName ? ` · ${conv.connectionName}` : ""}`,
                        identityId: identity.id,
                        identityLabel: identity.displayName ?? identity.externalUserId,
                      })
                    }}
                  >
                    Asignar
                  </Button>
                </span>
              )}
            </div>
          )
        })}
      </section>

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
          <h2 className="text-sm font-semibold">Registro</h2>
          <p className="text-sm text-muted-foreground">
            Los enlaces de registro se crean desde la bandeja: «Conversar» o «Enviar
            registro» abren la conversación y allí se prepara el mensaje con el enlace.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setDialog({ prepareRegistration: false })}
          >
            Abrir selector de conversación
          </Button>
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
        open={linkOpen}
        onClose={() => {
          setLinkOpen(false)
          linkMutation.reset()
        }}
        title="Vincular paciente existente"
        submitLabel="Vincular"
        cancelLabel="Cancelar"
        isSubmitting={linkMutation.isPending}
        error={linkMutation.error instanceof Error ? linkMutation.error.message : null}
        onSubmit={(event) => {
          event.preventDefault()
          linkMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Busca la ficha por nombre o documento y confirma la relación. Son sugerencias:
            nada se vincula solo por escribir.
          </p>
          <Field>
            <FieldLabel>Buscar paciente</FieldLabel>
            <Input
              value={linkSearch}
              onChange={(e) => {
                setLinkSearch(e.target.value)
                setLinkChoice(null)
              }}
              placeholder="Nombre del paciente"
            />
          </Field>
          {patientSearchQuery.data?.data.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant={linkChoice?.id === p.id ? "default" : "outline"}
              size="sm"
              className="justify-start"
              onClick={() => setLinkChoice(p)}
            >
              #{p.patientNumber} · {p.displayName}
            </Button>
          ))}
          <Field>
            <FieldLabel>Relación</FieldLabel>
            <select
              aria-label="Relación"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={linkRelation}
              onChange={(e) => setLinkRelation(e.target.value)}
            >
              <option value="self">Propio paciente</option>
              <option value="guardian">Tutor o responsable</option>
              <option value="family">Familiar</option>
              <option value="other">Otro contacto</option>
            </select>
          </Field>
          <Field>
            <FieldLabel>Detalle (opcional, p. ej. Madre)</FieldLabel>
            <Input
              value={linkDetail}
              maxLength={100}
              onChange={(e) => setLinkDetail(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={linkPreferred}
              onChange={(e) => setLinkPreferred(e.target.checked)}
            />
            Marcar como preferente
          </label>
        </div>
      </FormDrawer>
      <FormDrawer
        open={identityOpen}
        onClose={() => {
          setIdentityOpen(false)
          identityMutation.reset()
        }}
        title="Agregar identidad de canal"
        submitLabel="Agregar"
        cancelLabel="Cancelar"
        isSubmitting={identityMutation.isPending}
        error={identityMutation.error instanceof Error ? identityMutation.error.message : null}
        onSubmit={(event) => {
          event.preventDefault()
          if (!identityExternalId.trim()) return
          identityMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Canal</FieldLabel>
            <select
              aria-label="Canal"
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={identityChannel}
              onChange={(e) => setIdentityChannel(e.target.value)}
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
            </select>
          </Field>
          <Field>
            <FieldLabel>
              {identityChannel === "whatsapp"
                ? "Teléfono internacional (dígitos)"
                : "ID numérico de usuario de Telegram"}
            </FieldLabel>
            <Input
              value={identityExternalId}
              onChange={(e) => setIdentityExternalId(e.target.value)}
              placeholder={identityChannel === "whatsapp" ? "51987654321" : "123456789"}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            {identityChannel === "whatsapp"
              ? "Se guarda como wa:<dígitos> (7–15 dígitos). Si ya pertenece a otro contacto se rechaza con 409."
              : "Se guarda como tg:<id numérico>, nunca @usuario. Si ya pertenece a otro contacto se rechaza con 409."}
          </p>
        </div>
      </FormDrawer>
      <FormDrawer
        open={moveIdentityId !== null}
        onClose={() => {
          if (!moveMutation.isPending) {
            setMoveIdentityId(null)
            moveMutation.reset()
          }
        }}
        title="Reasignar canal a otro contacto"
        submitLabel="Reasignar"
        cancelLabel="Cancelar"
        isSubmitting={moveMutation.isPending}
        error={moveAmbiguous ? null : moveMutation.error instanceof Error ? moveMutation.error.message : null}
        onSubmit={(event) => {
          event.preventDefault()
          if (!destChoice || !moveReason.trim()) return
          moveMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Se mueve la identidad de {moveIdentity?.channel === "whatsapp" ? "WhatsApp" : "Telegram"}{" "}
            ({moveIdentity?.displayName ?? moveIdentity?.externalUserId}) desde{" "}
            <strong>{detail.contact.displayName}</strong> al contacto destino, junto con{" "}
            {moveResolvedCount} conversación(es) resuelta(s) por esa identidad. Los vínculos
            de pacientes no se mueven y el origen no se archiva.
          </p>
          <Field>
            <FieldLabel>Buscar contacto destino</FieldLabel>
            <Input
              value={destSearch}
              onChange={(e) => {
                setDestSearch(e.target.value)
                setDestChoice(null)
              }}
              placeholder="Nombre, teléfono o correo"
            />
          </Field>
          {destSearchQuery.data?.data
            .filter((c) => c.id !== contactId)
            .map((c) => (
              <Button
                key={c.id}
                type="button"
                variant={destChoice?.id === c.id ? "default" : "outline"}
                size="sm"
                className="justify-start"
                onClick={() => setDestChoice(c)}
              >
                {c.displayName}
                {!c.isActive ? " · archivado" : ""}
              </Button>
            ))}
          <Field>
            <FieldLabel>Motivo (1–500 caracteres)</FieldLabel>
            <Textarea
              value={moveReason}
              maxLength={500}
              onChange={(e) => setMoveReason(e.target.value)}
              placeholder="La persona indicó que este número ahora lo usa…"
            />
          </Field>
          {moveAmbiguous && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-300 p-2">
              <p className="text-sm">
                Hay historial del canal sin identidad determinable: resuelve cada
                conversación antes de reintentar. No se mueve nada por conjetura.
              </p>
              {ambiguousConvs.map((conv) => (
                <span key={conv.id} className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {conv.connectionName ?? conv.channel} · {timeAgo(conv.lastMessageAt)}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={resolveMutation.isPending}
                    onClick={() => {
                      if (!moveIdentity) return
                      resolveMutation.reset()
                      setResolveConfirm({
                        conversationId: conv.id,
                        conversationLabel: conv.connectionName ?? conv.channel,
                        identityId: moveIdentity.id,
                        identityLabel:
                          moveIdentity.displayName ?? moveIdentity.externalUserId,
                      })
                    }}
                  >
                    Asignar a esta identidad
                  </Button>
                </span>
              ))}
              {resolveMutation.error && (
                <p role="alert" className="text-sm text-destructive">
                  {mutationMessage(resolveMutation.error, "No se pudo asignar la identidad.")}
                </p>
              )}
            </div>
          )}
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={archiveOpen}
        onClose={() => {
          if (!activeMutation.isPending) {
            activeMutation.reset()
            setArchiveOpen(false)
          }
        }}
        onConfirm={() => activeMutation.mutate(!detail.contact.isActive)}
        title={archived ? `Reactivar ${detail.contact.displayName}` : `Archivar ${detail.contact.displayName}`}
        description={
          activeMutation.error
            ? mutationMessage(activeMutation.error, "No se pudo actualizar el contacto.")
            : archived
              ? "El contacto volverá a estar disponible. Los enlaces de registro revocados al archivar no se reactivan."
              : "El contacto archivado conserva identidades y conversaciones. Se revocan sus enlaces de registro pendientes y se bloquean nuevas conversaciones, vínculos y envíos hasta reactivarlo."
        }
        confirmLabel={archived ? "Reactivar" : "Archivar"}
        variant={archived ? "default" : "destructive"}
        pending={activeMutation.isPending}
      />
      <ConfirmDialog
        open={resolveConfirm !== null}
        onClose={() => {
          if (!resolveMutation.isPending) {
            resolveMutation.reset()
            setResolveConfirm(null)
          }
        }}
        onConfirm={() =>
          resolveConfirm &&
          resolveMutation.mutate({
            conversationId: resolveConfirm.conversationId,
            identityId: resolveConfirm.identityId,
          })
        }
        title="Asignar identidad a la conversación"
        description={
          resolveMutation.error
            ? mutationMessage(resolveMutation.error, "No se pudo asignar la identidad.")
            : `La conversación ${resolveConfirm?.conversationLabel ?? ""} quedará vinculada a la identidad ${resolveConfirm?.identityLabel ?? ""}. Los hilos grupales de Telegram nunca se atribuyen a una identidad personal.`
        }
        confirmLabel="Asignar"
        variant="default"
        pending={resolveMutation.isPending}
      />
      <ContactConversationDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        contacts={[
          { contactId, displayName: detail.contact.displayName, isPreferred: true },
        ]}
        prepareRegistration={dialog?.prepareRegistration ?? false}
      />
      <CreatePatientDrawer
        open={patientDrawer}
        onClose={() => {
          setPatientDrawer(false)
          invalidate()
        }}
        contactId={contactId}
      />
    </PageShell>
  )
}
