import { appWords } from "../../lib/product-words"
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, X } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { budgetStatusLabel } from "../../lib/budgets"
import { channelLabel } from "../../lib/channels"
import { type ContactFull, type OpportunityDetail, type Pipeline, useOrgMembers, usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { useOrgProfile } from "../../lib/org"
import { fetchServices, type ServiceCatalogItem } from "../../lib/services"
import { type PickedPerson, PersonPicker } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"

/** Contrato compartido con InboxWorkspace: no agregar ni quitar props. */
export interface OpportunityDrawerProps {
  open: boolean
  contactId?: string
  conversationId?: string
  opportunityId?: string
  onClose: () => void
  onSaved?: (detail: OpportunityDetail) => void
}

interface BudgetOption {
  id: string
  title: string
  status: string
}

/** Recepción: la oportunidad sin responsable es suya hasta que alguien la toma. */
const RECEPTION = ""

function mutationMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.shape.message ?? err.message ?? fallback
  return err instanceof Error ? err.message : fallback
}

function amountInputText(amountCents: number, currency: string, locale: string): string {
  try {
    return formatMoneyInput(amountCents, currency, locale)
  } catch {
    return ""
  }
}

/**
 * Crear o editar una oportunidad: un interés concreto de una persona (ADR
 * 0028). Nace en «Interesado» y avanza sola; aquí no se elige etapa ni embudo.
 * La persona se busca con el buscador de personas; el servicio, en la lista de
 * precios, y su precio es el valor. Sin servicio, el valor es opcional y en la
 * moneda de la clínica. Sin responsable queda en Recepción. Cerrarla y
 * reabrirla se hace desde la oportunidad, con la única forma de cerrar.
 */
export function OpportunityDrawer({ open, contactId, conversationId, opportunityId, onClose, onSaved }: OpportunityDrawerProps) {
  const ids = useId()
  const queryClient = useQueryClient()
  const members = useOrgMembers()
  const canWrite = usePermission("crm.write")
  const isEdit = Boolean(opportunityId)
  const profile = useOrgProfile()
  const orgCurrency = profile.data?.currency ?? ""
  const moneyLocale = profile.data?.locale?.trim() || activeOrgLocale() || new Intl.NumberFormat().resolvedOptions().locale

  const detailQuery = useQuery({
    queryKey: ["opportunity", opportunityId],
    queryFn: () => apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId as string}`),
    enabled: open && isEdit,
  })
  const detail = detailQuery.data?.data ?? null
  const pipelinesQuery = useQuery({
    queryKey: ["pipelines"],
    queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"),
    enabled: open && !isEdit,
  })
  const pipelines = pipelinesQuery.data?.data ?? []

  const [person, setPerson] = useState<PickedPerson | null>(null)
  const [patientId, setPatientId] = useState("")
  const [title, setTitle] = useState("")
  const [titleTouched, setTitleTouched] = useState(false)
  const [service, setService] = useState<{ id: string; name: string; priceCents: number; currency: string } | null>(null)
  const [amount, setAmount] = useState("")
  const [interest, setInterest] = useState("")
  const [assignee, setAssignee] = useState(RECEPTION)
  const [budgetId, setBudgetId] = useState("")
  const [pipelineId, setPipelineId] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const draftReady = !isEdit || (!!detail && !profile.isPending)

  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir o al llegar el detalle; después el borrador es de quien escribe
  useEffect(() => {
    if (!open || !draftReady) return
    if (detail) {
      setPerson({ id: detail.contactId, name: detail.contactName, phone: detail.contactPhone })
      setPatientId(detail.patientId ?? "")
      setTitle(detail.title)
      setService(
        detail.serviceId && detail.serviceName
          ? { id: detail.serviceId, name: detail.serviceName, priceCents: detail.amountCents ?? 0, currency: detail.currency }
          : null,
      )
      setAmount(!detail.serviceId && detail.amountCents !== null ? amountInputText(detail.amountCents, detail.currency, moneyLocale) : "")
      setInterest(detail.interestText ?? "")
      setAssignee(detail.assignedUserId ?? RECEPTION)
      setBudgetId(detail.budgetId ?? "")
    } else if (!isEdit) {
      setPerson(null)
      setPatientId("")
      setTitle("")
      setService(null)
      setAmount("")
      setInterest("")
      setAssignee(RECEPTION)
      setBudgetId("")
      setPipelineId("")
    }
    setTitleTouched(false)
    setFormError(null)
    save.reset()
  }, [open, opportunityId, detail?.id, draftReady])

  // Con el contacto fijo (Bandeja, ficha) la persona viene dada.
  const fixedContactQuery = useQuery({
    queryKey: ["contact", contactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${contactId}`),
    enabled: open && !!contactId,
  })
  const effectiveContactId = contactId ?? person?.id ?? ""
  const personQuery = useQuery({
    queryKey: ["contact", effectiveContactId],
    queryFn: () => apiFetch<{ data: ContactFull }>(`/api/contacts/${effectiveContactId}`),
    enabled: open && effectiveContactId !== "",
  })
  const linkedPatients = personQuery.data?.data.patients ?? []
  const conversations = personQuery.data?.data.conversations ?? []
  const fixedName = fixedContactQuery.data?.data.contact.displayName ?? detail?.contactName ?? null

  const budgetQuery = useQuery({
    queryKey: ["contact-budget-options", effectiveContactId, patientId],
    queryFn: () => apiFetch<{ data: BudgetOption[] }>(`/api/crm/contacts/${effectiveContactId}/budget-options?patientId=${patientId}`),
    enabled: open && isEdit && effectiveContactId !== "" && patientId !== "",
    retry: false,
  })

  function invalidate() {
    for (const key of ["opportunities", "opportunity", "pipeline-cards", "pipeline-list", "opportunity-summary", "contact-opportunities", "contact", "crm-context", "tasks"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  const save = useMutation({
    mutationFn: () => {
      if (!effectiveContactId) throw new Error("Elige a la persona interesada.")
      if (!title.trim()) throw new Error("Escribe qué le interesa: el tratamiento, el precio o la evaluación.")
      let amountCents: number | null = null
      if (!service && amount.trim()) {
        if (!orgCurrency) throw new Error("Configura la moneda de la clínica para anotar un valor.")
        amountCents = parseMoney(amount.trim(), orgCurrency, moneyLocale)
      }
      const body: Record<string, unknown> = {
        title: title.trim(),
        serviceId: service?.id ?? null,
        interestText: interest.trim() || null,
        assignedUserId: assignee || null,
        patientId: patientId || null,
        ...(service ? {} : { amountCents }),
      }
      if (isEdit) {
        return apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId as string}`, {
          method: "PATCH",
          body: JSON.stringify({ ...body, budgetId: budgetId || null }),
        })
      }
      return apiFetch<{ data: OpportunityDetail }>("/api/opportunities", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          contactId: effectiveContactId,
          conversationId: conversationId ?? null,
          ...(pipelineId ? { pipelineId } : {}),
        }),
      })
    },
    onSuccess: (result) => {
      invalidate()
      onSaved?.(result.data)
      onClose()
    },
    onError: (err) => setFormError(mutationMessage(err, "No se pudo guardar la oportunidad.")),
  })

  const isClosed = detail !== null && detail.status !== "open"
  const readOnly = !canWrite || isClosed
  const originId = conversationId ?? detail?.conversationId ?? null
  const originChannel = conversations.find((item) => item.id === originId)?.channel
  const servicePrice =
    service && profile.data?.locale ? formatMoney(service.priceCents, service.currency, profile.data.locale) : null

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!save.isPending) onClose()
      }}
      title={isEdit ? "Editar oportunidad" : "Nueva oportunidad"}
      description={
        !canWrite
          ? "Sin permiso para cambiar oportunidades: solo lectura."
          : isClosed
            ? "Está cerrada: reábrela para cambiarla."
            : isEdit
              ? undefined
              : "Un interés concreto de la persona. Nace en «Interesado» y avanza sola cuando agenda o recibe un presupuesto."
      }
      onSubmit={(event) => {
        event.preventDefault()
        setFormError(null)
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isLoading={isEdit && !draftReady && !detailQuery.isError}
      isDirty={!isEdit ? title.trim() !== "" || person !== null : false}
      error={formError ?? (detailQuery.isError ? "No se pudo cargar la oportunidad." : null)}
      submitLabel={isEdit ? "Guardar" : "Crear"}
      cancelLabel="Cancelar"
      hideSubmit={readOnly}
    >
      <div className="flex flex-col gap-4">
        {contactId || isEdit ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Persona: </span>
            <span className="font-medium">{fixedName ?? person?.name ?? "—"}</span>
          </p>
        ) : (
          <PersonPicker
            label="Persona interesada"
            value={person}
            onChange={(next) => {
              setPerson(next)
              setPatientId("")
              setBudgetId("")
            }}
          />
        )}

        {effectiveContactId && linkedPatients.length > 0 ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-paciente`}>Para quién es</FieldLabel>
            <ChoiceSelect
              id={`${ids}-paciente`}
              value={patientId}
              disabled={readOnly}
              onChange={(event) => {
                setPatientId(event.target.value)
                setBudgetId("")
              }}
            >
              <option value="">Sin paciente todavía</option>
              {linkedPatients.map((linked) => (
                <option key={linked.id} value={linked.id}>
                  {linked.displayName}
                  {linked.isActive ? "" : " · archivado"}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
        ) : null}

        <Field>
          <FieldLabel htmlFor={`${ids}-titulo`}>Qué le interesa</FieldLabel>
          <Input
            id={`${ids}-titulo`}
            value={title}
            maxLength={200}
            required
            disabled={readOnly}
            placeholder={appWords().examples.treatment}
            onChange={(event) => {
              setTitle(event.target.value)
              setTitleTouched(true)
            }}
          />
        </Field>

        <ServiceSearch
          value={service}
          disabled={readOnly}
          onChange={(next) => {
            setService(next)
            if (next && (!titleTouched || !title.trim())) setTitle(next.name)
          }}
        />
        {service ? (
          <p className="text-sm text-muted-foreground">
            Valor: <span className="font-medium text-foreground">{servicePrice ?? "…"}</span> · de la lista de precios
          </p>
        ) : null}

        {!isEdit && pipelines.length > 1 ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-embudo`}>Embudo</FieldLabel>
            <ChoiceSelect id={`${ids}-embudo`} value={pipelineId} onChange={(event) => setPipelineId(event.target.value)}>
              <option value="">El principal</option>
              {pipelines.map((pipe) => (
                <option key={pipe.id} value={pipe.id}>
                  {pipe.name}
                </option>
              ))}
            </ChoiceSelect>
          </Field>
        ) : null}

        <Collapsible className="flex flex-col gap-3" defaultOpen={isEdit}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
                Más datos (opcional)
                <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
              </Button>
            }
          />
          <CollapsibleContent className="flex flex-col gap-4">
            {!service ? (
              <Field>
                <FieldLabel htmlFor={`${ids}-valor`}>Valor estimado{orgCurrency ? ` (${orgCurrency})` : ""}</FieldLabel>
                <Input
                  id={`${ids}-valor`}
                  value={amount}
                  inputMode="decimal"
                  disabled={readOnly}
                  placeholder={orgCurrency ? amountInputText(0, orgCurrency, moneyLocale) : undefined}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <FieldDescription>Con un servicio de la lista de precios, el valor es su precio.</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${ids}-interes`}>Lo que pidió, en sus palabras</FieldLabel>
              <Input
                id={`${ids}-interes`}
                value={interest}
                maxLength={500}
                disabled={readOnly}
                placeholder="Preguntó cuánto cuesta y si hay cuotas"
                onChange={(event) => setInterest(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${ids}-responsable`}>Quién la lleva</FieldLabel>
              <ChoiceSelect id={`${ids}-responsable`} value={assignee} disabled={readOnly} onChange={(event) => setAssignee(event.target.value)}>
                <option value={RECEPTION}>Recepción (nadie la tomó)</option>
                {members.map((item) => (
                  <option key={item.userId} value={item.userId}>
                    {item.user.name}
                  </option>
                ))}
              </ChoiceSelect>
            </Field>
            {isEdit && patientId ? (
              <Field>
                <FieldLabel htmlFor={`${ids}-presupuesto`}>Presupuesto</FieldLabel>
                {budgetQuery.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    No se pudieron cargar sus presupuestos.{" "}
                    <Button type="button" variant="link" size="sm" onClick={() => void budgetQuery.refetch()}>
                      Reintentar
                    </Button>
                  </p>
                ) : (
                  <ChoiceSelect
                    id={`${ids}-presupuesto`}
                    value={budgetId}
                    disabled={readOnly || budgetQuery.isPending}
                    onChange={(event) => setBudgetId(event.target.value)}
                  >
                    <option value="">Sin presupuesto</option>
                    {(budgetQuery.data?.data ?? []).map((budget) => (
                      <option key={budget.id} value={budget.id}>
                        {budget.title} · {budgetStatusLabel(budget.status)}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
                <FieldDescription>Al presentar un presupuesto se une solo a la oportunidad del mismo tratamiento.</FieldDescription>
              </Field>
            ) : null}
          </CollapsibleContent>
        </Collapsible>

        {originId ? (
          <p className="text-sm text-muted-foreground">
            Conversación de origen:{" "}
            <Link to="/inbox" search={{ conversation: originId }} className="hover:underline">
              {originChannel ? `${channelLabel(originChannel)} · ` : ""}abrir conversación
            </Link>
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

type ServicePick = { id: string; name: string; priceCents: number; currency: string }

/** El servicio de la lista de precios, buscado en el servidor por su nombre. */
function ServiceSearch({
  value,
  onChange,
  disabled,
}: {
  value: ServicePick | null
  onChange: (service: ServicePick | null) => void
  disabled: boolean
}) {
  const id = useId()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [open, setOpen] = useState(false)
  const profile = useOrgProfile()
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])
  const services = useQuery({
    queryKey: ["opportunity-services", debounced],
    queryFn: () => fetchServices({ q: debounced || undefined, state: "active", limit: 20 }),
    enabled: open && !disabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const items = useMemo(
    () =>
      (services.data?.data ?? []).map((row: ServiceCatalogItem) => ({
        id: row.id,
        name: row.name,
        priceCents: row.priceCents,
        currency: row.currency,
      })),
    [services.data],
  )
  if (value) {
    return (
      <Field>
        <FieldLabel>Servicio</FieldLabel>
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-1.5">
          <span className="truncate font-medium">{value.name}</span>
          {!disabled ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={`Quitar el servicio ${value.name}`}>
              <X aria-hidden />
              Quitar
            </Button>
          ) : null}
        </div>
      </Field>
    )
  }
  return (
    <Field>
      <FieldLabel htmlFor={id}>Servicio (opcional)</FieldLabel>
      <Combobox
        items={items}
        filter={null}
        disabled={disabled}
        open={open && !disabled}
        onOpenChange={setOpen}
        value={null}
        isItemEqualToValue={(a: ServicePick, b: ServicePick) => a.id === b.id}
        itemToStringValue={(item: ServicePick) => item.id}
        itemToStringLabel={(item: ServicePick) => item.name}
        inputValue={query}
        onInputValueChange={(next, details) => {
          if (details.reason === "input-change") {
            setQuery(next)
            setOpen(true)
          } else if (details.reason === "input-clear" || details.reason === "clear-press") {
            setQuery("")
          }
        }}
        onValueChange={(item: ServicePick | null) => {
          if (item) {
            onChange(item)
            setQuery("")
            setOpen(false)
          }
        }}
      >
        <ComboboxInput id={id} disabled={disabled} placeholder="Buscar en la lista de precios" triggerLabel="Mostrar servicios" />
        <ComboboxContent aria-label="Servicios">
          <ComboboxList aria-label="Servicios">
            {(item: ServicePick) => (
              <ComboboxItem key={item.id} value={item} className="flex items-center justify-between gap-3">
                <span>{item.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {profile.data?.locale ? formatMoney(item.priceCents, item.currency, profile.data.locale) : ""}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{services.isFetching ? "Buscando…" : "Ningún servicio con ese nombre."}</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>Con servicio, el valor sale de su precio.</FieldDescription>
    </Field>
  )
}
