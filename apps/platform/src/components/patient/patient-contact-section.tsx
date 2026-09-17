import { CONTACT_RELATIONSHIP_LABELS } from "@odentia/clinical"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { ConfirmDialog, FormDrawer, RowActions } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { type ContactFull, type ContactListItem, timeAgo, useCanWrite } from "../../lib/crm"
import type { PatientContactLink, PatientFull } from "../../lib/patients"
import { ContactConversationDialog } from "../contact-conversation-dialog"

type Relationship = PatientContactLink["relationship"]

const RELATIONSHIPS: Relationship[] = ["self", "guardian", "family", "other"]

const ENTRY_LABELS: Record<string, string> = {
  platform: "Plataforma (registro interno)",
  public_link: "Enlace público",
  qr: "Código QR",
  conversation: "Conversación",
  legacy: "Registro anterior: origen no disponible",
}

const RESPONDENT_LABELS: Record<string, string> = {
  patient: "Paciente",
  representative: "Representante",
  staff: "Personal de la clínica",
}

interface DeclaredRepresentative {
  displayName?: string
  relationship?: string
  relationshipDetail?: string
  phone?: string
  email?: string
}

function declaredRepresentative(answers: unknown): DeclaredRepresentative | null {
  if (!answers || typeof answers !== "object") return null
  const rep = (answers as Record<string, unknown>).representative
  if (!rep || typeof rep !== "object") return null
  return rep as DeclaredRepresentative
}

function declaredDemographics(answers: unknown): Record<string, unknown> {
  if (!answers || typeof answers !== "object") return {}
  const demographics = (answers as Record<string, unknown>).demographics
  return demographics && typeof demographics === "object"
    ? (demographics as Record<string, unknown>)
    : {}
}

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? (error.shape.message ?? "No se pudo completar la operación.")
    : "No se pudo completar la operación."
}

function useInvalidatePatient(patientId: string) {
  const queryClient = useQueryClient()
  return (contactId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ["patient", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patients"] })
    void queryClient.invalidateQueries({ queryKey: ["contacts"] })
    if (contactId) void queryClient.invalidateQueries({ queryKey: ["contact", contactId] })
  }
}

/** Contactos vinculados, procedencia y acciones de relación de la ficha del paciente. */
export function PatientContactSection({ detail }: { detail: PatientFull }) {
  const canWrite = useCanWrite()
  const patientId = detail.patient.id
  const invalidate = useInvalidatePatient(patientId)
  const [contactDialogOpen, setContactDialogOpen] = useState(false)
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [editing, setEditing] = useState<PatientContactLink | null>(null)
  const [unlinking, setUnlinking] = useState<PatientContactLink | null>(null)
  const [unlinkError, setUnlinkError] = useState<string | null>(null)

  const unlinkMutation = useMutation({
    mutationFn: (contactId: string) =>
      apiFetch(`/api/patients/${patientId}/contacts/${contactId}`, { method: "DELETE" }),
    onSuccess: (_data, contactId) => {
      setUnlinkError(null)
      setUnlinking(null)
      invalidate(contactId)
    },
    onError: (mutationError) => setUnlinkError(errorMessage(mutationError)),
  })

  const registration = detail.registration
  const representative = registration ? declaredRepresentative(registration.answers) : null
  const demographics = registration ? declaredDemographics(registration.answers) : {}
  const declaredPhone = trimmed(representative?.phone) ?? trimmed(demographics.phone)
  const declaredEmail = trimmed(representative?.email) ?? trimmed(demographics.email)

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Contactos vinculados</CardTitle>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setLinkOpen(true)}
              >
                Vincular contacto
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={detail.contacts.length === 0}
                onClick={() => setContactDialogOpen(true)}
              >
                Contactar
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={detail.contacts.length === 0}
                onClick={() => setConversationsOpen(true)}
              >
                Ver conversaciones
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {detail.contacts.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Este paciente aún no tiene contactos vinculados.
              </p>
              {declaredPhone || declaredEmail || representative?.displayName ? (
                <p className="text-sm text-muted-foreground">
                  Datos declarados: contacto aún no vinculado
                  {representative?.displayName ? ` · ${representative.displayName}` : ""}
                  {declaredPhone ? ` · ${declaredPhone}` : ""}
                  {declaredEmail ? ` · ${declaredEmail}` : ""}. El personal puede vincular
                  un contacto existente o crear uno desde estos datos.
                </p>
              ) : null}
              {canWrite ? (
                <div>
                  <Button type="button" size="sm" onClick={() => setLinkOpen(true)}>
                    Vincular o crear contacto
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.contacts.map((link) => (
                <li
                  key={link.contactId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to="/contacts/$contactId"
                        params={{ contactId: link.contactId }}
                        className="font-medium hover:underline"
                      >
                        {link.displayName}
                      </Link>
                      {link.isPreferred ? <Badge>Preferente</Badge> : null}
                      {!link.isActive ? <Badge variant="outline">Archivado</Badge> : null}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {CONTACT_RELATIONSHIP_LABELS[link.relationship] ?? link.relationship}
                      {link.relationshipDetail ? ` · ${link.relationshipDetail}` : ""}
                      {link.phone || link.email
                        ? `${link.phone ? ` · ${link.phone}` : ""}${link.email ? ` · ${link.email}` : ""}`
                        : " · Sin medios registrados"}
                    </p>
                  </div>
                  {canWrite ? (
                    <RowActions
                      label={`Acciones del contacto ${link.displayName}`}
                      items={[
                        {
                          key: "edit",
                          label: "Editar relación",
                          onSelect: () => setEditing(link),
                        },
                        {
                          key: "unlink",
                          label: "Desvincular",
                          tone: "danger",
                          onSelect: () => {
                            setUnlinkError(null)
                            setUnlinking(link)
                          },
                        },
                      ]}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {representative?.displayName ? (
            <div className="rounded-md border p-3">
              <p className="text-sm font-medium">Representante declarado</p>
              <p className="text-sm text-muted-foreground">
                {representative.displayName}
                {representative.relationshipDetail
                  ? ` · ${representative.relationshipDetail}`
                  : ""}
                {trimmed(representative.phone) ? ` · ${trimmed(representative.phone)}` : ""}
                {trimmed(representative.email) ? ` · ${trimmed(representative.email)}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Dato declarado en el registro, no verificado. No otorga acceso a la ficha.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Procedencia del registro</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {registration ? (
            <>
              <p className="text-sm">
                {ENTRY_LABELS[registration.entryPoint] ?? registration.entryPoint}
                {" · "}
                {new Date(registration.createdAt).toLocaleString("es-PE", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
              <p className="text-sm text-muted-foreground">
                Declarante:{" "}
                {registration.respondent
                  ? (RESPONDENT_LABELS[registration.respondent] ?? registration.respondent)
                  : "No registrado"}
                {registration.actor ? ` · Operador: ${registration.actor.name}` : ""}
              </p>
              {registration.conversationId ? (
                <p className="text-sm">
                  <Link
                    to="/inbox"
                    search={{ conversation: registration.conversationId }}
                    className="hover:underline"
                  >
                    Ver conversación de origen
                  </Link>
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Registro anterior: origen no disponible.
            </p>
          )}
        </CardContent>
      </Card>

      <ContactConversationDialog
        open={contactDialogOpen}
        onClose={() => setContactDialogOpen(false)}
        contacts={detail.contacts.map((link) => ({
          contactId: link.contactId,
          displayName: link.displayName,
          isPreferred: link.isPreferred,
        }))}
      />
      {conversationsOpen ? (
        <PatientConversationsDialog
          detail={detail}
          onClose={() => setConversationsOpen(false)}
        />
      ) : null}
      {linkOpen ? (
        <LinkContactDialog
          detail={detail}
          declaredName={trimmed(representative?.displayName) ?? detail.patient.displayName}
          declaredPhone={declaredPhone}
          declaredEmail={declaredEmail}
          onClose={() => setLinkOpen(false)}
        />
      ) : null}
      {editing ? (
        <EditRelationDialog
          patientId={patientId}
          link={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => {
          if (!unlinkMutation.isPending) {
            setUnlinking(null)
            setUnlinkError(null)
          }
        }}
        title={`Desvincular a ${unlinking?.displayName ?? ""}`}
        description={
          unlinkError ??
          "Se retira la relación con este paciente. La persona, sus conversaciones y la ficha clínica se conservan. Esta acción queda registrada."
        }
        confirmLabel="Desvincular"
        pending={unlinkMutation.isPending}
        onConfirm={() => {
          if (unlinking) unlinkMutation.mutate(unlinking.contactId)
        }}
      />
    </div>
  )
}

function PatientConversationsDialog({
  detail,
  onClose,
}: {
  detail: PatientFull
  onClose: () => void
}) {
  const contactsQuery = useQuery({
    queryKey: ["patient-contact-conversations", detail.patient.id],
    queryFn: async () => {
      const entries = await Promise.all(
        detail.contacts.map(async (link) => {
          const body = await apiFetch<{ data: ContactFull }>(
            `/api/contacts/${link.contactId}`,
          )
          return { link, conversations: body.data.conversations }
        }),
      )
      return entries
    },
  })
  const entries = contactsQuery.data ?? []
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conversaciones</DialogTitle>
          <DialogDescription>
            La conversación pertenece al contacto y puede incluir a otros pacientes. No se
            copian mensajes a la historia clínica.
          </DialogDescription>
        </DialogHeader>
        {contactsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Cargando conversaciones…</p>
        ) : contactsQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(contactsQuery.error)}
          </p>
        ) : entries.every((entry) => entry.conversations.length === 0) ? (
          <p className="text-sm text-muted-foreground">Sin conversaciones registradas.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {entries.map((entry) =>
              entry.conversations.length === 0 ? null : (
                <div key={entry.link.contactId} className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{entry.link.displayName}</p>
                  <ul className="flex flex-col gap-1">
                    {entry.conversations.map((conversation) => (
                      <li
                        key={conversation.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                      >
                        <span className="text-sm text-muted-foreground">
                          {conversation.channel}
                          {conversation.connectionName
                            ? ` · ${conversation.connectionName}`
                            : ""}
                          {` · ${conversation.status}`}
                          {conversation.lastMessageAt
                            ? ` · ${timeAgo(conversation.lastMessageAt)}`
                            : ""}
                        </span>
                        <Link
                          to="/inbox"
                          search={{ conversation: conversation.id }}
                          className="text-sm font-medium hover:underline"
                        >
                          Abrir en bandeja
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function LinkContactDialog({
  detail,
  declaredName,
  declaredPhone,
  declaredEmail,
  onClose,
}: {
  detail: PatientFull
  declaredName: string | null
  declaredPhone: string | null
  declaredEmail: string | null
  onClose: () => void
}) {
  const patientId = detail.patient.id
  const invalidate = useInvalidatePatient(patientId)
  const [query, setQuery] = useState("")
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [selected, setSelected] = useState<ContactListItem | null>(null)
  const [relationship, setRelationship] = useState<Relationship>("family")
  const [relationshipDetail, setRelationshipDetail] = useState("")
  const [isPreferred, setIsPreferred] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState(declaredName ?? "")
  const [newPhone, setNewPhone] = useState(declaredPhone ?? "")
  const [newEmail, setNewEmail] = useState(declaredEmail ?? "")
  // Contacto recién creado pendiente de vinculación: si el PUT falla se conserva
  // para reintentar sin crear otro.
  const [pendingCreated, setPendingCreated] = useState<{
    id: string
    displayName: string
  } | null>(null)
  const [creating, setCreating] = useState(false)

  const searchQuery = useQuery({
    queryKey: ["contacts", "patient-link-search", submittedQuery],
    queryFn: () => {
      const params = new URLSearchParams()
      params.set("q", submittedQuery)
      params.set("limit", "10")
      return apiFetch<{ data: ContactListItem[] }>(`/api/contacts?${params}`)
    },
    enabled: submittedQuery.trim().length > 0,
  })

  const linkMutation = useMutation({
    mutationFn: (body: {
      contactId: string
      relationship: Relationship
      relationshipDetail: string
      isPreferred: boolean
    }) =>
      apiFetch(`/api/patients/${patientId}/contacts/${body.contactId}`, {
        method: "PUT",
        body: JSON.stringify({
          relationship: body.relationship,
          ...(body.relationshipDetail.trim()
            ? { relationshipDetail: body.relationshipDetail.trim() }
            : {}),
          isPreferred: body.isPreferred,
        }),
      }),
    onSuccess: (_data, variables) => {
      setPendingCreated(null)
      setError(null)
      invalidate(variables.contactId)
      onClose()
    },
    onError: (mutationError) => {
      setError(errorMessage(mutationError))
    },
  })

  const results = searchQuery.data?.data ?? []

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vincular contacto</DialogTitle>
          <DialogDescription>
            Busca por nombre, teléfono o correo. Los resultados son sugerencias sin
            verificar: confirma la identidad de la persona antes de vincular.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setSelected(null)
              setSubmittedQuery(query.trim())
            }}
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar contacto…"
              aria-label="Buscar contacto por nombre, teléfono o correo"
            />
            <Button type="submit" variant="outline" disabled={!query.trim()}>
              Buscar
            </Button>
          </form>
          {searchQuery.isPending && submittedQuery ? (
            <p className="text-sm text-muted-foreground">Buscando…</p>
          ) : null}
          {searchQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(searchQuery.error)}
            </p>
          ) : null}
          {submittedQuery && !searchQuery.isPending && !searchQuery.isError ? (
            results.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin resultados. Puedes crear el contacto desde los datos declarados.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {results.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(item)}
                      aria-pressed={selected?.id === item.id}
                      className={`w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent ${selected?.id === item.id ? "border-primary" : ""}`}
                    >
                      <span className="font-medium">{item.displayName}</span>
                      <span className="block text-xs text-muted-foreground">
                        Sugerencia sin verificar · confirma que es la persona correcta
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

            <div className="flex flex-col gap-3 rounded-md border p-3">
              <p className="text-sm">
                {selected ? `Vincular a ${selected.displayName}` : "Elige la relación del contacto que vas a crear"}:
              </p>
              <Field>
                <FieldLabel htmlFor="link-relationship">Relación</FieldLabel>
                <Select
                  value={relationship}
                  onValueChange={(value) => setRelationship(value as Relationship)}
                >
                  <SelectTrigger id="link-relationship">
                    <SelectValue>{CONTACT_RELATIONSHIP_LABELS[relationship]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {RELATIONSHIPS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {CONTACT_RELATIONSHIP_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="link-detail">Detalle (opcional, p. ej. Madre)</FieldLabel>
                <Input
                  id="link-detail"
                  value={relationshipDetail}
                  maxLength={100}
                  onChange={(event) => setRelationshipDetail(event.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={isPreferred}
                  onCheckedChange={(checked) => setIsPreferred(checked === true)}
                />
                Marcar como preferente
              </label>
              {error && !pendingCreated ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div>
                {selected ? (
                <Button
                  type="button"
                  disabled={linkMutation.isPending}
                  onClick={() =>
                    linkMutation.mutate({
                      contactId: selected.id,
                      relationship,
                      relationshipDetail,
                      isPreferred,
                    })
                  }
                >
                  {linkMutation.isPending ? "Vinculando…" : "Confirmar vinculación"}
                </Button>
                ) : null}
              </div>
            </div>

          <div className="flex flex-col gap-2 rounded-md border p-3">
            <p className="text-sm font-medium">Crear contacto desde datos declarados</p>
            <p className="text-xs text-muted-foreground">
              {declaredName ?? "Sin nombre declarado"}
              {declaredPhone ? ` · ${declaredPhone}` : ""}
              {declaredEmail ? ` · ${declaredEmail}` : ""}
            </p>
            <Field>
              <FieldLabel htmlFor="new-contact-name">Nombre del nuevo contacto</FieldLabel>
              <Input id="new-contact-name" value={newName} maxLength={200} disabled={!!pendingCreated} onChange={event => setNewName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-contact-phone">Teléfono declarado</FieldLabel>
              <Input id="new-contact-phone" type="tel" value={newPhone} maxLength={50} disabled={!!pendingCreated} onChange={event => setNewPhone(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-contact-email">Correo declarado</FieldLabel>
              <Input id="new-contact-email" type="email" value={newEmail} maxLength={200} disabled={!!pendingCreated} onChange={event => setNewEmail(event.target.value)} />
            </Field>
            {pendingCreated ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm">
                  Se creó «{pendingCreated.displayName}» pero la vinculación falló. Puedes
                  reintentar sin crear otro contacto.
                </p>
                {error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <div>
                  <Button
                    type="button"
                    disabled={linkMutation.isPending}
                    onClick={() =>
                      linkMutation.mutate({
                        contactId: pendingCreated.id,
                        relationship,
                        relationshipDetail,
                        isPreferred,
                      })
                    }
                  >
                    {linkMutation.isPending ? "Reintentando…" : "Reintentar vinculación"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {error && selected === null ? (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={creating || !newName.trim()}
                    onClick={() => {
                      if (!newName.trim()) return
                      const displayName = newName.trim()
                      setCreating(true)
                      setError(null)
                      let createdId: string | null = null
                      void apiFetch<{ data: { id: string } }>("/api/contacts", {
                        method: "POST",
                        body: JSON.stringify({
                          displayName,
                          ...(newPhone.trim() ? { phone: newPhone.trim() } : {}),
                          ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
                        }),
                      })
                        .then((created) => {
                          createdId = created.data.id
                          setPendingCreated({ id: created.data.id, displayName })
                          return apiFetch(
                            `/api/patients/${patientId}/contacts/${created.data.id}`,
                            {
                              method: "PUT",
                              body: JSON.stringify({
                                relationship,
                                ...(relationshipDetail.trim()
                                  ? { relationshipDetail: relationshipDetail.trim() }
                                  : {}),
                                isPreferred,
                              }),
                            },
                          )
                        })
                        .then(() => {
                          const linkedId = createdId
                          setPendingCreated(null)
                          invalidate(linkedId ?? undefined)
                          onClose()
                        })
                        .catch((creationError: unknown) => {
                          // Si falló el PUT, pendingCreated ya quedó fijado para reintentar
                          // sin crear otro contacto. Si falló el POST no hay nada que conservar.
                          setError(errorMessage(creationError))
                        })
                        .finally(() => setCreating(false))
                    }}
                  >
                    {creating ? "Creando…" : "Crear y vincular"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditRelationDialog({
  patientId,
  link,
  onClose,
}: {
  patientId: string
  link: PatientContactLink
  onClose: () => void
}) {
  const invalidate = useInvalidatePatient(patientId)
  const [relationship, setRelationship] = useState<Relationship>(link.relationship)
  const [relationshipDetail, setRelationshipDetail] = useState(link.relationshipDetail ?? "")
  const [isPreferred, setIsPreferred] = useState(link.isPreferred)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/contacts/${link.contactId}`, {
        method: "PUT",
        body: JSON.stringify({
          relationship,
          ...(relationshipDetail.trim()
            ? { relationshipDetail: relationshipDetail.trim() }
            : {}),
          isPreferred,
        }),
      }),
    onSuccess: () => {
      invalidate(link.contactId)
      onClose()
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  })

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={`Relación con ${link.displayName}`}
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        mutation.mutate()
      }}
      isSubmitting={mutation.isPending}
      error={error}
      submitLabel="Guardar relación"
    >
      <Field>
        <FieldLabel htmlFor="edit-relationship">Relación</FieldLabel>
        <Select value={relationship} onValueChange={(value) => setRelationship(value as Relationship)}>
          <SelectTrigger id="edit-relationship">
            <SelectValue>{CONTACT_RELATIONSHIP_LABELS[relationship]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {RELATIONSHIPS.map((value) => (
              <SelectItem key={value} value={value}>
                {CONTACT_RELATIONSHIP_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-detail">Detalle (opcional, máx. 100)</FieldLabel>
        <Input
          id="edit-detail"
          value={relationshipDetail}
          maxLength={100}
          onChange={(event) => setRelationshipDetail(event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={isPreferred} onCheckedChange={(checked) => setIsPreferred(checked === true)} />
        Contacto preferente
      </label>
    </FormDrawer>
  )
}

/** Declaración original conservada en el snapshot (solo lectura). */
export function RegistrationDeclarationDialog({
  answers,
  onClose,
}: {
  answers: unknown
  onClose: () => void
}) {
  const entries =
    answers && typeof answers === "object"
      ? Object.entries(answers as Record<string, unknown>)
      : []
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Declaración original</DialogTitle>
          <DialogDescription>
            Lo declarado al registrarse. Los datos vigentes se editan con el editor de
            antecedentes, no aquí.
          </DialogDescription>
        </DialogHeader>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin respuestas conservadas.</p>
        ) : (
          <dl className="flex flex-col gap-2">
            {entries.map(([key, value]) => (
              <div key={key} className="rounded-md border p-3">
                <dt className="text-sm font-medium">{key}</dt>
                <dd className="overflow-x-auto text-xs text-muted-foreground">
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
