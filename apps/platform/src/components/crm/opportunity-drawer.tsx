import { Button, Field, FieldLabel, Input, Spinner } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import {
  type ContactFull,
  type OpportunityDetail,
  type Pipeline,
  useOrgMembers,
  usePermission,
} from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { fetchServices } from "../../lib/services"
import { isoToLocalInput, localInputToIso, parseAmountToCents } from "./crm-helpers"

/** Contrato compartido con InboxWorkspace: no agregar ni quitar props. */
export interface OpportunityDrawerProps {
  open: boolean
  contactId?: string
  conversationId?: string
  opportunityId?: string
  onClose: () => void
  onSaved?: () => void
}

interface BudgetOption {
  id: string
  title: string
  status: string
}

const CONTACT_PAGE = 10
const SERVICE_PAGE = 20

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback
  return err instanceof Error ? err.message : fallback
}

/**
 * Crear/editar oportunidad comercial. El contacto puede venir fijo (uso
 * contextual desde ficha/bandeja) o elegirse con búsqueda paginada; el
 * paciente siempre sale de los vínculos del contacto (nunca se duplica la
 * ficha clínica) y el servicio del catálogo. La fecha local se convierte a
 * ISO en el envío. En creación solo se ofrecen etapas abiertas; el cierre
 * con motivo vive en el modo edición.
 */
export function OpportunityDrawer({
  open,
  contactId,
  conversationId,
  opportunityId,
  onClose,
  onSaved,
}: OpportunityDrawerProps) {
  const queryClient = useQueryClient()
  const members = useOrgMembers()
  const canWrite = usePermission("crm.write")
  const isEdit = Boolean(opportunityId)

  const detailQuery = useQuery({
    queryKey: ["opportunity", opportunityId],
    queryFn: () =>
      apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId as string}`),
    enabled: open && isEdit,
  })
  const detail = detailQuery.data?.data ?? null

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
    enabled: open,
  })
  const pipelines = useMemo(() => pipelinesQuery.data?.data ?? [], [pipelinesQuery.data])

  const [contactSearch, setContactSearch] = useState("")
  // La lista de contactos no se muestra completa al abrir: solo con búsqueda
  // o tras pedirla explícitamente.
  const [showAllContacts, setShowAllContacts] = useState(false)
  const contactsQuery = useInfiniteQuery({
    queryKey: ["drawer-contacts", contactSearch.trim()],
    queryFn: ({ pageParam }: { pageParam: string | null }) => {
      const params = new URLSearchParams({ isActive: "true", limit: String(CONTACT_PAGE) })
      if (contactSearch.trim()) params.set("q", contactSearch.trim())
      if (pageParam) params.set("cursor", pageParam)
      return apiFetch<{ data: { id: string; displayName: string }[]; nextCursor: string | null }>(
        `/api/contacts?${params}`,
      )
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open && !isEdit && !contactId,
  })
  const contactOptions = useMemo(
    () => contactsQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [contactsQuery.data],
  )

  // Borrador del formulario.
  const [draftContactId, setDraftContactId] = useState("")
  const [draftPatientId, setDraftPatientId] = useState("")
  const [draftPipelineId, setDraftPipelineId] = useState("")
  const [draftStageId, setDraftStageId] = useState("")
  const [draftTitle, setDraftTitle] = useState("")
  const [draftInterest, setDraftInterest] = useState("")
  const [draftServiceId, setDraftServiceId] = useState("")
  const [draftServiceName, setDraftServiceName] = useState("")
  const [draftAmount, setDraftAmount] = useState("")
  // Vacía = la moneda de la clínica (se muestra como sugerencia en el campo).
  const [draftCurrency, setDraftCurrency] = useState("")
  const orgCurrency = useOrgProfile().data?.currency
  const [draftAssignee, setDraftAssignee] = useState("")
  const [draftNextAction, setDraftNextAction] = useState("")
  const [draftNote, setDraftNote] = useState("")
  const [draftBudgetId, setDraftBudgetId] = useState("")
  const [amountError, setAmountError] = useState<string | null>(null)
  const [serviceSearch, setServiceSearch] = useState("")
  const [closeOutcome, setCloseOutcome] = useState<"won" | "lost" | null>(null)
  const [closeReason, setCloseReason] = useState("")

  const effectiveContactId = contactId ?? draftContactId ?? ""
  const defaultPipeline = pipelines.find((p) => p.isDefault) ?? pipelines[0] ?? null
  const defaultPipelineId = defaultPipeline?.id ?? ""
  // El usuario manda sobre el valor por defecto: si elige o limpia el embudo
  // a mano, la llegada tardía de /pipelines no lo pisa.
  const pipelineTouchedRef = useRef(false)

  // Al abrir o cambiar de registro: valores iniciales (edición desde el
  // detalle, creación en blanco). No depende del embudo por defecto para no
  // borrar lo que el usuario ya escribió cuando /pipelines llega tarde. Al
  // cerrar se conserva el borrador hasta el próximo abrir para no perder el
  // caso a mitad de captura.
  useEffect(() => {
    if (!open) return
    if (detail) {
      setDraftContactId(detail.contactId)
      setDraftPatientId(detail.patientId ?? "")
      setDraftPipelineId(detail.pipelineId)
      setDraftStageId(detail.stageId)
      setDraftTitle(detail.title)
      setDraftInterest(detail.interestText ?? "")
      setDraftServiceId(detail.serviceId ?? "")
      setDraftServiceName(detail.serviceName ?? "")
      setDraftAmount(detail.amountCents !== null ? String(detail.amountCents / 100) : "")
      setDraftCurrency(detail.currency)
      setDraftAssignee(detail.assignedUserId ?? "")
      setDraftNextAction(isoToLocalInput(detail.nextActionAt))
      setDraftNote(detail.nextActionNote ?? "")
      setDraftBudgetId(detail.budgetId ?? "")
    } else if (!isEdit) {
      setDraftContactId("")
      setDraftPatientId("")
      setDraftPipelineId("")
      setDraftStageId("")
      setDraftTitle("")
      setDraftInterest("")
      setDraftServiceId("")
      setDraftServiceName("")
      setDraftAmount("")
      setDraftCurrency("")
      setDraftAssignee("")
      setDraftNextAction("")
      setDraftNote("")
      setDraftBudgetId("")
    }
    pipelineTouchedRef.current = false
    setAmountError(null)
    setShowAllContacts(false)
    setCloseOutcome(null)
    setCloseReason("")
    // Solo al abrir o al llegar el detalle: el borrador es del usuario después.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, opportunityId, detail?.id])

  // Embudo por defecto tardío: solo si la selección sigue sin valor y el
  // usuario no la tocó (respeta elegir o limpiar a mano). Nunca toca el resto
  // del borrador.
  useEffect(() => {
    if (!open || isEdit) return
    if (defaultPipelineId === "") return
    if (pipelineTouchedRef.current) return
    if (draftPipelineId !== "") return
    setDraftPipelineId(defaultPipelineId)
  }, [open, isEdit, defaultPipelineId, draftPipelineId])

  const contactDetailQuery = useQuery({
    queryKey: ["contact", effectiveContactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${effectiveContactId}`),
    enabled: open && effectiveContactId !== "",
  })
  const linkedPatients = useMemo(
    () => contactDetailQuery.data?.data.patients ?? [],
    [contactDetailQuery.data],
  )
  const contactConversations = useMemo(
    () => contactDetailQuery.data?.data.conversations ?? [],
    [contactDetailQuery.data],
  )

  const servicesQuery = useInfiniteQuery({
    queryKey: ["drawer-services", serviceSearch.trim()],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchServices({
        q: serviceSearch.trim() || undefined,
        limit: SERVICE_PAGE,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: open,
  })
  const serviceOptions = useMemo(
    () => servicesQuery.data?.pages.flatMap((p) => p.data) ?? [],
    [servicesQuery.data],
  )

  // Presupuesto mínimo del API /crm con permisos del servidor: siempre por
  // contacto+paciente efectivos del borrador, también en edición, para no
  // ofrecer presupuestos del paciente persistido tras cambiar el borrador. La
  // clave incluye ambas dependencias para no mostrar opciones viejas de otro
  // paciente. Sin opciones, el selector muestra el error real sin inventar datos.
  const budgetQuery = useQuery({
    queryKey: ["contact-budget-options", effectiveContactId, draftPatientId],
    queryFn: () =>
      apiFetch<{ data: BudgetOption[] }>(
        `/api/crm/contacts/${effectiveContactId}/budget-options?patientId=${draftPatientId}`,
      ),
    enabled: open && effectiveContactId !== "" && draftPatientId !== "",
    retry: false,
  })
  const budgetOptions = budgetQuery.data?.data ?? null

  const selectedPipeline =
    pipelines.find((p) => p.id === (isEdit ? detail?.pipelineId : draftPipelineId)) ?? null
  const openStages = useMemo(
    () => (selectedPipeline?.stages ?? []).filter((s) => s.kind === "open"),
    [selectedPipeline],
  )
  const currentStageName = isEdit
    ? (selectedPipeline?.stages.find((s) => s.id === detail?.stageId)?.name ?? detail?.stageName)
    : null

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["opportunities"] })
    void queryClient.invalidateQueries({ queryKey: ["opportunity"] })
    void queryClient.invalidateQueries({ queryKey: ["pipeline-cards"] })
    void queryClient.invalidateQueries({ queryKey: ["pipeline-list"] })
    void queryClient.invalidateQueries({ queryKey: ["opportunity-summary"] })
    void queryClient.invalidateQueries({ queryKey: ["contact-opportunities"] })
    void queryClient.invalidateQueries({ queryKey: ["contact"] })
    void queryClient.invalidateQueries({ queryKey: ["tasks"] })
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const amountRaw = draftAmount.trim()
      const amountCents = parseAmountToCents(amountRaw)
      if (amountRaw !== "" && amountCents === null) {
        throw new Error("Monto inválido: usa números con hasta dos decimales.")
      }
      if (!draftTitle.trim()) throw new Error("Ingresa el título de la oportunidad.")
      if (!effectiveContactId) throw new Error("Elige el contacto de la oportunidad.")
      const body: Record<string, unknown> = {
        title: draftTitle.trim(),
        interestText: draftInterest.trim() || null,
        serviceId: draftServiceId || null,
        amountCents,
        // Vacía: el servidor usa la moneda de la clínica; nunca se asume una aquí.
        currency: draftCurrency.trim().toUpperCase() || undefined,
        assignedUserId: draftAssignee || null,
        nextActionAt: localInputToIso(draftNextAction),
        nextActionNote: draftNote.trim() || null,
        budgetId: draftBudgetId || null,
      }
      if (isEdit) {
        return apiFetch(`/api/opportunities/${opportunityId as string}`, {
          method: "PATCH",
          body: JSON.stringify({ ...body, patientId: draftPatientId || null }),
        })
      }
      return apiFetch("/api/opportunities", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          contactId: effectiveContactId,
          patientId: draftPatientId || null,
          pipelineId: draftPipelineId || undefined,
          stageId: draftStageId || undefined,
          conversationId: conversationId ?? null,
        }),
      })
    },
    onSuccess: () => {
      invalidate()
      saveMutation.reset()
      onSaved?.()
      onClose()
    },
  })

  const closeMutation = useMutation({
    mutationFn: () => {
      if (!closeOutcome) throw new Error("Elige el resultado del cierre.")
      if (!closeReason.trim()) throw new Error("El motivo del cierre es obligatorio.")
      return apiFetch(`/api/opportunities/${opportunityId as string}/close`, {
        method: "POST",
        body: JSON.stringify({ outcome: closeOutcome, reason: closeReason.trim() }),
      })
    },
    onSuccess: () => {
      invalidate()
      closeMutation.reset()
      setCloseOutcome(null)
      setCloseReason("")
      onSaved?.()
      onClose()
    },
  })

  const reopenMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/opportunities/${opportunityId as string}/reopen`, { method: "POST" }),
    onSuccess: () => {
      invalidate()
      reopenMutation.reset()
      onSaved?.()
      onClose()
    },
  })

  const pending = saveMutation.isPending || closeMutation.isPending || reopenMutation.isPending
  const error =
    amountError ??
    (saveMutation.error instanceof Error
      ? mutationMessage(saveMutation.error, "No se pudo guardar la oportunidad.")
      : null)
  const isClosed = detail?.status !== undefined && detail.status !== "open"

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!pending) {
          saveMutation.reset()
          closeMutation.reset()
          onClose()
        }
      }}
      title={isEdit ? "Editar oportunidad" : "Nueva oportunidad"}
      description={
        !canWrite
          ? "Sin permiso de escritura del CRM: solo lectura."
          : conversationId && !isEdit
            ? "Se vinculará a la conversación de origen."
            : undefined
      }
      onSubmit={(event) => {
        event.preventDefault()
        setAmountError(null)
        saveMutation.mutate()
      }}
      isSubmitting={pending}
      isLoading={isEdit && detailQuery.isLoading}
      error={error}
      submitLabel={isEdit ? "Guardar" : "Crear"}
      cancelLabel="Cancelar"
      hideSubmit={!canWrite || (isEdit && isClosed)}
    >
      <div className="flex flex-col gap-4">
        {isEdit && detailQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            No se pudo cargar la oportunidad.{" "}
            <Button type="button" variant="link" size="sm" onClick={() => detailQuery.refetch()}>
              Reintentar
            </Button>
          </p>
        ) : null}

        {/* Contacto: fijo en uso contextual, búsqueda paginada en manual. */}
        {contactId || isEdit ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Contacto: </span>
            <span className="font-medium">
              {contactDetailQuery.data?.data.contact.displayName ?? detail?.contactName ?? "—"}
            </span>
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="opp-drawer-contact-search">Contacto</FieldLabel>
            {/* El input nunca se deshabilita por la búsqueda: sigue editable
                mientras el fetching real se indica dentro del campo. */}
            <div className="relative">
              <Input
                id="opp-drawer-contact-search"
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
                Buscando contactos{contactSearch.trim() ? ` «${contactSearch.trim()}»` : ""}…
              </p>
            ) : null}
            {contactSearch.trim() === "" && !showAllContacts ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="self-start"
                onClick={() => setShowAllContacts(true)}
              >
                Mostrar lista de contactos
              </Button>
            ) : (
              <div className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
                {contactOptions.map((c) => (
                  <Button
                    key={c.id}
                    type="button"
                    variant={draftContactId === c.id ? "default" : "outline"}
                    size="sm"
                    className="justify-start"
                    onClick={() => {
                      setDraftContactId(c.id)
                      setDraftPatientId("")
                      setDraftBudgetId("")
                    }}
                  >
                    {c.displayName}
                  </Button>
                ))}
              </div>
            )}
            {(contactSearch.trim() !== "" || showAllContacts) && contactsQuery.hasNextPage ? (
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
                No se pudieron buscar contactos.{" "}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => contactsQuery.refetch()}
                >
                  Reintentar
                </Button>
              </p>
            ) : null}
          </Field>
        )}

        {/* Paciente vinculado al contacto (representación explícita). */}
        {effectiveContactId !== "" ? (
          <Field>
            <FieldLabel>Paciente vinculado (opcional)</FieldLabel>
            {contactDetailQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando vínculos…</p>
            ) : linkedPatients.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin pacientes vinculados a este contacto. Regístralo o vincúlalo desde la ficha del
                contacto; no se crea una ficha clínica desde aquí.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <Button
                  type="button"
                  variant={draftPatientId === "" ? "default" : "outline"}
                  size="sm"
                  className="justify-start"
                  onClick={() => {
                    setDraftPatientId("")
                    setDraftBudgetId("")
                  }}
                >
                  Sin paciente vinculado
                </Button>
                {linkedPatients.map((p) => (
                  <Button
                    key={p.id}
                    type="button"
                    variant={draftPatientId === p.id ? "default" : "outline"}
                    size="sm"
                    className="justify-start"
                    onClick={() => {
                      setDraftPatientId(p.id)
                      setDraftBudgetId("")
                    }}
                  >
                    {p.displayName}
                    {!p.isActive ? " · archivado" : ""}
                  </Button>
                ))}
              </div>
            )}
          </Field>
        ) : null}

        <Field>
          <FieldLabel htmlFor="opp-drawer-title">Título</FieldLabel>
          <Input
            id="opp-drawer-title"
            value={draftTitle}
            maxLength={200}
            required
            placeholder="Ortodoncia · evaluación"
            onChange={(e) => setDraftTitle(e.target.value)}
          />
        </Field>

        {/* Servicio del catálogo: tras un desplegable para no mostrar el
            tarifario completo al abrir. */}
        <details className="rounded-md border px-3 py-2">
          <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
            Servicio del catálogo (opcional)
            {draftServiceName ? ` · ${draftServiceName}` : ""}
          </summary>
          <Field>
            <FieldLabel htmlFor="opp-drawer-service-search">Buscar un servicio</FieldLabel>
            {draftServiceId ? (
              <p className="flex items-center gap-2 text-sm">
                <span className="font-medium">{draftServiceName || "Servicio elegido"}</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    setDraftServiceId("")
                    setDraftServiceName("")
                  }}
                >
                  Quitar
                </Button>
              </p>
            ) : (
              <>
                <div className="relative">
                  <Input
                    id="opp-drawer-service-search"
                    value={serviceSearch}
                    onChange={(e) => setServiceSearch(e.target.value)}
                    placeholder="Buscar un servicio"
                    aria-busy={servicesQuery.isFetching}
                    className={servicesQuery.isFetching ? "pr-9" : undefined}
                  />
                  {servicesQuery.isFetching ? (
                    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[var(--identity-accent)]">
                      <Spinner className="size-4" aria-hidden />
                    </span>
                  ) : null}
                </div>
                {servicesQuery.isFetching ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    Buscando servicios…
                  </p>
                ) : null}
                {serviceSearch.trim() !== "" ? (
                  <div className="mt-1 flex max-h-40 flex-col gap-1 overflow-y-auto">
                    {serviceOptions
                      .filter((s) => s.isActive)
                      .map((s) => (
                        <Button
                          key={s.id}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="justify-start"
                          onClick={() => {
                            setDraftServiceId(s.id)
                            setDraftServiceName(s.name)
                          }}
                        >
                          {s.name}
                        </Button>
                      ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Escribe para buscar un servicio.
                  </p>
                )}
                {servicesQuery.hasNextPage ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="self-start"
                    disabled={servicesQuery.isFetchingNextPage}
                    onClick={() => void servicesQuery.fetchNextPage()}
                  >
                    {servicesQuery.isFetchingNextPage ? (
                      <>
                        <Spinner className="size-6" aria-hidden />
                        Cargar más servicios
                      </>
                    ) : (
                      "Cargar más servicios"
                    )}
                  </Button>
                ) : null}
                {servicesQuery.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    No se pudieron buscar los servicios.{" "}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => void servicesQuery.refetch()}
                    >
                      Reintentar
                    </Button>
                  </p>
                ) : null}
              </>
            )}
          </Field>
        </details>

        <Field>
          <FieldLabel htmlFor="opp-drawer-interest">Interés (texto libre, opcional)</FieldLabel>
          <Input
            id="opp-drawer-interest"
            value={draftInterest}
            maxLength={500}
            placeholder="Ortodoncia, profilaxis…"
            onChange={(e) => setDraftInterest(e.target.value)}
          />
        </Field>

        {/* Embudo y etapa: en creación solo etapas abiertas. */}
        {isEdit ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Etapa actual: </span>
            <span className="font-medium">{currentStageName ?? "—"}</span>
            <span className="text-muted-foreground">
              {" "}
              · el movimiento de etapa se hace desde el tablero o la ficha.
            </span>
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="opp-drawer-pipeline">Embudo</FieldLabel>
              <select
                id="opp-drawer-pipeline"
                aria-label="Embudo"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={draftPipelineId}
                onChange={(e) => {
                  pipelineTouchedRef.current = true
                  setDraftPipelineId(e.target.value)
                  setDraftStageId("")
                }}
              >
                <option value="">Elegir embudo…</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="opp-drawer-stage">Etapa inicial</FieldLabel>
              <select
                id="opp-drawer-stage"
                aria-label="Etapa inicial"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={draftStageId}
                onChange={(e) => setDraftStageId(e.target.value)}
              >
                <option value="">Elegir etapa…</option>
                {openStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Solo etapas abiertas: el cierre con motivo no es una etapa inicial.
              </p>
            </Field>
          </div>
        )}

        {/* Valor, responsable y seguimiento: opciones tras un desplegable para
            un mínimo inicial (título, contacto, etapa) que permite datos
            opcionales progresivos. */}
        <details className="rounded-md border px-3 py-2">
          <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
            Detalles y seguimiento (opcional)
          </summary>
          <div className="flex flex-col gap-4 pt-2">
        <div className="flex gap-2">
          <Field className="flex-1">
            <FieldLabel htmlFor="opp-drawer-amount">Valor (opcional)</FieldLabel>
            <Input
              id="opp-drawer-amount"
              value={draftAmount}
              inputMode="decimal"
              placeholder="2500.00"
              onChange={(e) => setDraftAmount(e.target.value)}
            />
          </Field>
          <Field className="w-24">
            <FieldLabel htmlFor="opp-drawer-currency">Moneda</FieldLabel>
            <Input
              id="opp-drawer-currency"
              value={draftCurrency}
              maxLength={3}
              placeholder={orgCurrency}
              onChange={(e) => setDraftCurrency(e.target.value)}
            />
          </Field>
        </div>

        {/* Presupuesto mínimo del API /crm (solo con paciente elegido). */}
        {draftPatientId !== "" ? (
          <Field>
            <FieldLabel htmlFor="opp-drawer-budget">Presupuesto vinculado (opcional)</FieldLabel>
            {budgetQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Cargando presupuestos…</p>
            ) : budgetOptions ? (
              <select
                id="opp-drawer-budget"
                aria-label="Presupuesto vinculado"
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={draftBudgetId}
                onChange={(e) => setDraftBudgetId(e.target.value)}
              >
                <option value="">Sin vincular</option>
                {budgetOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} · {b.status}
                  </option>
                ))}
              </select>
            ) : (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar los presupuestos vinculados.{" "}
                <Button type="button" variant="link" size="sm" onClick={() => void budgetQuery.refetch()}>
                  Reintentar
                </Button>
              </p>
            )}
          </Field>
        ) : null}

        <Field>
          <FieldLabel htmlFor="opp-drawer-assignee">Responsable (opcional)</FieldLabel>
          <select
            id="opp-drawer-assignee"
            aria-label="Responsable"
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
            value={draftAssignee}
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

        <Field>
          <FieldLabel htmlFor="opp-drawer-next-action">Próxima acción (fecha y hora)</FieldLabel>
          <Input
            id="opp-drawer-next-action"
            type="datetime-local"
            value={draftNextAction}
            onChange={(e) => setDraftNextAction(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="opp-drawer-note">Nota de seguimiento (opcional)</FieldLabel>
          <Input
            id="opp-drawer-note"
            value={draftNote}
            maxLength={500}
            placeholder="Llamar para confirmar…"
            onChange={(e) => setDraftNote(e.target.value)}
          />
        </Field>
          </div>
        </details>

        {(() => {
          const originId = conversationId ?? detail?.conversationId ?? null
          if (!originId) return null
          const originChannel = contactConversations.find((c) => c.id === originId)?.channel
          return (
            <p className="text-sm text-muted-foreground">
              Conversación de origen:{" "}
              <Link to="/inbox" search={{ conversation: originId }} className="hover:underline">
                {originChannel ? `${channelLabel(originChannel)} · ` : ""}abrir hilo
              </Link>
            </p>
          )
        })()}

        {/* Cierre con motivo (solo edición de oportunidad abierta). */}
        {isEdit && detail && detail.status === "open" && canWrite ? (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <p className="text-sm font-medium">Cerrar oportunidad</p>
            {closeOutcome ? (
              <>
                <Field>
                  <FieldLabel htmlFor="opp-drawer-close-reason">
                    Motivo del cierre (obligatorio)
                  </FieldLabel>
                  <Input
                    id="opp-drawer-close-reason"
                    value={closeReason}
                    maxLength={500}
                    placeholder={
                      closeOutcome === "won" ? "Aceptó el plan de tratamiento…" : "Eligió otra clínica…"
                    }
                    onChange={(e) => setCloseReason(e.target.value)}
                  />
                </Field>
                {closeMutation.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {mutationMessage(closeMutation.error, "No se pudo cerrar la oportunidad.")}
                  </p>
                ) : null}
                <span className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={closeMutation.isPending}
                    onClick={() => closeMutation.mutate()}
                  >
                    Confirmar cierre como {closeOutcome === "won" ? "ganada" : "perdida"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={closeMutation.isPending}
                    onClick={() => {
                      closeMutation.reset()
                      setCloseOutcome(null)
                      setCloseReason("")
                    }}
                  >
                    Cancelar
                  </Button>
                </span>
              </>
            ) : (
              <span className="flex gap-2">
                <Button type="button" size="sm" onClick={() => setCloseOutcome("won")}>
                  Marcar ganada
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCloseOutcome("lost")}
                >
                  Marcar perdida
                </Button>
              </span>
            )}
          </div>
        ) : null}
        {isEdit && detail && detail.status !== "open" && canWrite ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={reopenMutation.isPending}
              onClick={() => reopenMutation.mutate()}
            >
              Reabrir oportunidad
            </Button>
            {reopenMutation.error ? (
              <p role="alert" className="text-sm text-destructive">
                {mutationMessage(reopenMutation.error, "No se pudo reabrir la oportunidad.")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}
