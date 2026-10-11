import { Button, Field, FieldLabel, Input, Spinner } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import {
  type ContactFull,
  type ConversationListItem,
  type OpportunityListItem,
  type TaskItem,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { isoToLocalInput, localInputToIso } from "./crm-helpers"

/**
 * Contrato compartido con InboxWorkspace. `taskId` (opcional, añadido para el
 * foco /tasks?task=) abre el drawer en edición de esa tarea; sin él crea.
 */
export interface TaskDrawerProps {
  open: boolean
  contactId?: string
  conversationId?: string
  opportunityId?: string
  taskId?: string
  onClose: () => void
  onSaved?: () => void
}

const PAGE = 30

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback
  return err instanceof Error ? err.message : fallback
}

export function TaskDrawer({
  open,
  contactId,
  conversationId,
  opportunityId,
  taskId,
  onClose,
  onSaved,
}: TaskDrawerProps) {
  const queryClient = useQueryClient()
  const members = useOrgMembers()
  const canWrite = usePermission("tasks.write")
  const canReadCrm = usePermission("crm.read")
  const canReadConversations = usePermission("conversations.read")
  const isEdit = Boolean(taskId)

  const taskQuery = useQuery({
    queryKey: ["tasks", "detail", taskId],
    queryFn: () => apiFetch<{ data: TaskItem }>(`/api/tasks/${taskId}`),
    enabled: open && !!taskId,
  })
  const editTask = taskQuery.data?.data ?? null
  const isFollowUp = editTask?.kind === "opportunity_follow_up"
  const [draftTitle, setDraftTitle] = useState("")
  const [draftDue, setDraftDue] = useState("")
  const [draftAssignee, setDraftAssignee] = useState("")
  const [draftContactId, setDraftContactId] = useState("")
  const [draftConversationId, setDraftConversationId] = useState("")
  const [draftOpportunityId, setDraftOpportunityId] = useState("")
  const [contactSearch, setContactSearch] = useState("")
  const [oppSearch, setOppSearch] = useState("")
  const [convSearch, setConvSearch] = useState("")

  useEffect(() => {
    if (!open) return
    if (editTask) {
      // Edición: los vínculos no se tocan, solo título/fecha/responsable.
      setDraftTitle(editTask.title)
      setDraftDue(editTask.dueAt ? isoToLocalInput(editTask.dueAt) : "")
      setDraftAssignee(editTask.assigneeUserId ?? "")
      setDraftContactId(editTask.contactId ?? "")
      setDraftConversationId(editTask.conversationId ?? "")
      setDraftOpportunityId(editTask.opportunityId ?? "")
    } else {
      setDraftTitle("")
      setDraftDue("")
      setDraftAssignee("")
      setDraftContactId("")
      setDraftConversationId("")
      setDraftOpportunityId("")
    }
    setContactSearch("")
    setOppSearch("")
    setConvSearch("")
    saveMutation.reset()
    // Solo al abrir o al resolver la tarea: el borrador es del usuario después.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editTask?.id])

  const effectiveContactId = contactId ?? draftContactId ?? ""
  const effectiveConversationId = conversationId ?? draftConversationId ?? ""
  const effectiveOpportunityId = opportunityId ?? draftOpportunityId ?? ""

  const contactDetailQuery = useQuery({
    queryKey: ["contact", effectiveContactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${effectiveContactId}`),
    enabled: open && !isEdit && canReadCrm && effectiveContactId !== "",
  })
  const linkedConversations = useMemo(
    () => contactDetailQuery.data?.data.conversations ?? [],
    [contactDetailQuery.data],
  )
  const contactName = contactDetailQuery.data?.data.contact.displayName ?? null

  // Selector manual de contactos (búsqueda paginada del servidor).
  const contactsQuery = useInfiniteQuery({
    queryKey: ["drawer-task-contacts", contactSearch.trim()],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams({ isActive: "true", limit: String(PAGE) })
      if (contactSearch.trim()) params.set("q", contactSearch.trim())
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: { id: string; displayName: string }[]; nextCursor: string | null }>(
        `/api/contacts?${params}`,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open && !isEdit && canReadCrm && !contactId,
  })
  const contactOptions = useMemo(
    () => contactsQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [contactsQuery.data],
  )

  // Selector manual de oportunidades: por contacto cuando hay uno, o búsqueda
  // global paginada. Al elegir se arrastra el contacto de la oportunidad.
  const oppsQuery = useInfiniteQuery({
    queryKey: ["drawer-task-opps", effectiveContactId, oppSearch.trim()],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams({ limit: String(PAGE) })
      if (effectiveContactId) params.set("contactId", effectiveContactId)
      else if (oppSearch.trim()) params.set("q", oppSearch.trim())
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: OpportunityListItem[]; nextCursor: string | null }>(
        `/api/opportunities?${params}`,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open && !isEdit && canReadCrm && !opportunityId,
  })
  const oppOptions = useMemo(
    () => oppsQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [oppsQuery.data],
  )
  const chosenOpp = oppOptions.find((o) => o.id === effectiveOpportunityId) ?? null

  // Selector manual de hilos: del contacto cuando hay uno; si no, búsqueda
  // global de conversaciones paginada por el servidor.
  const convsQuery = useInfiniteQuery({
    queryKey: ["drawer-task-convs", convSearch.trim()],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams({ limit: String(PAGE) })
      if (convSearch.trim()) params.set("q", convSearch.trim())
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: ConversationListItem[]; nextCursor: string | null }>(
        `/api/conversations?${params}`,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open && !isEdit && canReadConversations && !conversationId && effectiveContactId === "",
  })
  const convOptions = useMemo(
    () => convsQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [convsQuery.data],
  )

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draftTitle.trim()) throw new Error("Ingresa el título de la tarea.")
      if (isEdit) {
        if (!editTask) throw new Error("No se pudo cargar la tarea.")
        return apiFetch(`/api/tasks/${editTask.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: draftTitle.trim(),
            dueAt: draftDue === (editTask.dueAt ? isoToLocalInput(editTask.dueAt) : "")
              ? editTask.dueAt : draftDue ? localInputToIso(draftDue) : null,
            assigneeUserId: draftAssignee || null,
          }),
        })
      }
      // La oportunidad manda el contacto: si hay discrepancia con el contacto
      // elegido se rechaza aquí en vez de dejarla al servidor en silencio. Si
      // hay contacto y la oportunidad manual no está entre sus opciones (p. ej.
      // quedó huérfana tras cambiar el contacto), no se envía su id oculto.
      // Sin contacto, el id solo es válido: el servidor deriva el vínculo.
      const oppContactId = chosenOpp?.contactId ?? null
      if (!opportunityId && draftOpportunityId !== "" && !chosenOpp && effectiveContactId !== "") {
        throw new Error("La oportunidad elegida ya no está disponible: vuelve a elegirla.")
      }
      if (oppContactId && effectiveContactId && oppContactId !== effectiveContactId) {
        throw new Error("La oportunidad pertenece a otro contacto: revisa los vínculos.")
      }
      return apiFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: draftTitle.trim(),
          contactId: oppContactId ?? (effectiveContactId || undefined),
          conversationId: effectiveConversationId || undefined,
          opportunityId: effectiveOpportunityId || undefined,
          dueAt: draftDue ? localInputToIso(draftDue) : undefined,
          assigneeUserId: draftAssignee || null,
        }),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] })
      void queryClient.invalidateQueries({ queryKey: ["contact", effectiveContactId] })
      saveMutation.reset()
      onSaved?.()
      onClose()
    },
  })

  const pending = saveMutation.isPending

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!pending) {
          saveMutation.reset()
          onClose()
        }
      }}
      title={isEdit ? "Editar tarea" : "Nueva tarea"}
      description={
        !canWrite
          ? "Sin permiso de gestión de tareas: solo lectura."
          : isEdit
            ? isFollowUp ? "Cambia la próxima acción desde la oportunidad; completa el seguimiento en Tareas." : "Edita título, fecha y responsable; conserva los vínculos del caso."
            : effectiveContactId !== "" || effectiveOpportunityId !== ""
              ? "Contexto fijado desde la ficha: solo completa el seguimiento."
              : undefined
      }
      onSubmit={(event) => {
        event.preventDefault()
        saveMutation.mutate()
      }}
      isSubmitting={pending}
      error={
        taskQuery.error instanceof Error
          ? mutationMessage(taskQuery.error, "No se pudo cargar la tarea.")
          : saveMutation.error instanceof Error
            ? mutationMessage(
                saveMutation.error,
                isEdit ? "No se pudo guardar la tarea." : "No se pudo crear la tarea.",
              )
            : null
      }
      submitLabel={isEdit ? "Guardar" : "Crear"}
      cancelLabel="Cancelar"
      hideSubmit={!canWrite || isFollowUp || (isEdit && !editTask)}
    >
      <div className="flex flex-col gap-4">
        {taskQuery.isLoading && isEdit && <p role="status" className="text-sm text-muted-foreground">Cargando tarea…</p>}
        {/* En edición los vínculos son de solo lectura: vienen con la tarea. */}
        {isEdit && editTask ? (
          <p className="text-sm text-muted-foreground">
            Contexto: {[editTask.contactName, editTask.opportunityTitle].filter(Boolean).join(" · ") || "sin vínculos"}
          </p>
        ) : null}
        <Field>
          <FieldLabel htmlFor="task-drawer-title">Título</FieldLabel>
          <Input
            id="task-drawer-title"
            value={draftTitle}
            disabled={isFollowUp || !canWrite}
            maxLength={200}
            required
            placeholder="Llamar para confirmar el plan"
            onChange={(e) => setDraftTitle(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="task-drawer-due">Vence (opcional)</FieldLabel>
          <Input
            id="task-drawer-due"
            type="datetime-local"
            value={draftDue}
            disabled={isFollowUp || !canWrite}
            onChange={(e) => setDraftDue(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="task-drawer-assignee">Responsable (opcional)</FieldLabel>
          <select
            id="task-drawer-assignee"
            aria-label="Responsable"
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            value={draftAssignee}
            disabled={isFollowUp || !canWrite}
            onChange={(e) => setDraftAssignee(e.target.value)}
          >
            <option value="">Sin asignar</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user.name}
              </option>
            ))}
          </select>
        </Field>
        {!isEdit && canReadCrm ? (
          <details
            open={
              contactId !== undefined ||
              conversationId !== undefined ||
              opportunityId !== undefined ||
              draftContactId !== "" ||
              draftConversationId !== "" ||
              draftOpportunityId !== ""
            }
          >
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Vínculos del caso (opcional)
            </summary>
            <div className="mt-2 flex flex-col gap-4">
        {/* Contacto: fijo o selector buscable paginado. */}
        {contactId ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Contacto: </span>
            <span className="font-medium">{contactName ?? "vinculado al caso"}</span>
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="task-drawer-contact-search">Contacto (opcional)</FieldLabel>
            {draftContactId !== "" ? (
              <p className="flex items-center gap-2 text-sm">
                <span className="font-medium">
                  {contactName ??
                    contactOptions.find((c) => c.id === draftContactId)?.displayName ??
                    "Contacto elegido"}
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setDraftContactId("")
                    setDraftConversationId("")
                    setDraftOpportunityId("")
                  }}
                >
                  Quitar
                </Button>
              </p>
            ) : (
              <>
                <div className="relative">
                  <Input
                    id="task-drawer-contact-search"
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    placeholder="Buscar por nombre, teléfono o correo"
                    aria-busy={contactsQuery.isFetching}
                    className={contactsQuery.isFetching ? "pr-9" : undefined}
                  />
                  {contactsQuery.isFetching ? (
                    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[var(--identity-accent)]">
                      <Spinner className="size-4" aria-hidden />
                    </span>
                  ) : null}
                </div>
                {contactsQuery.isFetching ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    Buscando contactos…
                  </p>
                ) : null}
                <div className="mt-1 flex max-h-36 flex-col gap-1 overflow-y-auto">
                  {contactOptions.map((c) => (
                    <Button
                      key={c.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-start"
                      onClick={() => {
                        setDraftContactId(c.id)
                        setDraftConversationId("")
                        setDraftOpportunityId("")
                      }}
                    >
                      {c.displayName}
                    </Button>
                  ))}
                </div>
                {contactsQuery.hasNextPage ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="self-start"
                    disabled={contactsQuery.isFetchingNextPage}
                    onClick={() => void contactsQuery.fetchNextPage()}
                  >
                    {contactsQuery.isFetchingNextPage ? (
                      <>
                        <Spinner className="size-6" aria-hidden />
                        Cargar más contactos
                      </>
                    ) : (
                      "Cargar más contactos"
                    )}
                  </Button>
                ) : null}
                {contactsQuery.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    No se pudieron cargar los contactos.{" "}
                    <Button type="button" variant="link" size="sm" onClick={() => contactsQuery.refetch()}>
                      Reintentar
                    </Button>
                  </p>
                ) : null}
              </>
            )}
          </Field>
        )}

        {/* Hilo: del contacto cuando hay uno, o búsqueda global. */}
        {conversationId ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Hilo: </span>
            <span className="font-medium">vinculado al contexto</span>
          </p>
        ) : effectiveContactId !== "" ? (
          <Field>
            <FieldLabel htmlFor="task-drawer-conversation">Hilo del contacto (opcional)</FieldLabel>
            {contactDetailQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando hilos…</p>
            ) : contactDetailQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar los hilos.{" "}
                <Button type="button" variant="link" size="sm" onClick={() => contactDetailQuery.refetch()}>
                  Reintentar
                </Button>
              </p>
            ) : linkedConversations.length === 0 ? (
              <p className="text-sm text-muted-foreground">El contacto no tiene hilos.</p>
            ) : (
              <select
                id="task-drawer-conversation"
                aria-label="Hilo del contacto"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={draftConversationId}
                onChange={(e) => setDraftConversationId(e.target.value)}
              >
                <option value="">Sin hilo vinculado</option>
                {linkedConversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {channelLabel(c.channel)} · {c.status}
                    {c.connectionName ? ` · ${c.connectionName}` : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <Field>
            <FieldLabel htmlFor="task-drawer-conv-search">Hilo (opcional)</FieldLabel>
            <div className="relative">
              <Input
                id="task-drawer-conv-search"
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="Buscar hilo por persona o texto"
                aria-busy={convsQuery.isFetching}
                className={convsQuery.isFetching ? "pr-9" : undefined}
              />
              {convsQuery.isFetching ? (
                <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[var(--identity-accent)]">
                  <Spinner className="size-4" aria-hidden />
                </span>
              ) : null}
            </div>
            {convsQuery.isFetching ? (
              <p className="text-xs text-muted-foreground" role="status">
                Buscando hilos…
              </p>
            ) : null}
            <div className="mt-1 flex max-h-36 flex-col gap-1 overflow-y-auto">
              {convOptions.map((c) => (
                <Button
                  key={c.id}
                  type="button"
                  variant={draftConversationId === c.id ? "default" : "outline"}
                  size="sm"
                  className="justify-start"
                  onClick={() => {
                    setDraftConversationId(c.id)
                    // El hilo arrastra su contacto salvo que ya haya uno fijo; si
                    // cambia el contacto, la oportunidad anterior queda huérfana.
                    if (!contactId && draftContactId === "") {
                      setDraftContactId(c.contact.id)
                      setDraftOpportunityId("")
                    }
                  }}
                >
                  {c.contact.displayName} · {channelLabel(c.connection.channel)}
                </Button>
              ))}
            </div>
            {convsQuery.hasNextPage ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="self-start"
                disabled={convsQuery.isFetchingNextPage}
                onClick={() => void convsQuery.fetchNextPage()}
              >
                {convsQuery.isFetchingNextPage ? (
                  <>
                    <Spinner className="size-6" aria-hidden />
                    Cargar más hilos
                  </>
                ) : (
                  "Cargar más hilos"
                )}
              </Button>
            ) : null}
            {convsQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar los hilos.{" "}
                <Button type="button" variant="link" size="sm" onClick={() => convsQuery.refetch()}>
                  Reintentar
                </Button>
              </p>
            ) : null}
          </Field>
        )}

        {/* Oportunidad: paginada por contacto o por búsqueda. */}
        {opportunityId ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Oportunidad: </span>
            <span className="font-medium">vinculada al contexto</span>
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="task-drawer-opp-search">Oportunidad (opcional)</FieldLabel>
            {effectiveContactId === "" ? (
              <div className="relative">
                <Input
                  id="task-drawer-opp-search"
                  value={oppSearch}
                  onChange={(e) => setOppSearch(e.target.value)}
                  placeholder="Buscar por título o interés"
                  aria-busy={oppsQuery.isFetching}
                  className={oppsQuery.isFetching ? "pr-9" : undefined}
                />
                {oppsQuery.isFetching ? (
                  <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[var(--identity-accent)]">
                    <Spinner className="size-4" aria-hidden />
                  </span>
                ) : null}
              </div>
            ) : null}
            {oppsQuery.isFetching && !oppsQuery.isFetchingNextPage ? (
              <p className="text-xs text-muted-foreground" role="status">
                Buscando oportunidades…
              </p>
            ) : null}
            <div className="mt-1 flex max-h-36 flex-col gap-1 overflow-y-auto">
              {oppOptions.map((o) => (
                <Button
                  key={o.id}
                  type="button"
                  variant={draftOpportunityId === o.id ? "default" : "outline"}
                  size="sm"
                  className="justify-start"
                  onClick={() => setDraftOpportunityId(o.id === draftOpportunityId ? "" : o.id)}
                >
                  {o.title} · {o.stageName}
                </Button>
              ))}
            </div>
            {oppsQuery.hasNextPage ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="self-start"
                disabled={oppsQuery.isFetchingNextPage}
                onClick={() => void oppsQuery.fetchNextPage()}
              >
                {oppsQuery.isFetchingNextPage ? (
                  <>
                    <Spinner className="size-6" aria-hidden />
                    Cargar más oportunidades
                  </>
                ) : (
                  "Cargar más oportunidades"
                )}
              </Button>
            ) : null}
            {oppsQuery.isError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar las oportunidades.{" "}
                <Button type="button" variant="link" size="sm" onClick={() => oppsQuery.refetch()}>
                  Reintentar
                </Button>
              </p>
            ) : null}
          </Field>
        )}
            </div>
          </details>
        ) : null}

      </div>
    </FormDrawer>
  )
}
