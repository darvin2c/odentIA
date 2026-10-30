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
  Input,
} from "@odentia/ui"
import { type FieldControl, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ChevronDown, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
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

type ServicePick = { id: string; name: string; priceCents: number; currency: string }

interface OpportunityValues {
  person: PickedPerson | null
  patientId: string
  title: string
  service: ServicePick | null
  amount: string
  interest: string
  assignee: string
  budgetId: string
  pipelineId: string
}

const EMPTY_VALUES: OpportunityValues = {
  person: null,
  patientId: "",
  title: "",
  service: null,
  amount: "",
  interest: "",
  assignee: RECEPTION,
  budgetId: "",
  pipelineId: "",
}

/** Lo que la validación necesita de la pantalla: si la persona se elige aquí y con qué moneda se anota el valor. */
interface OpportunityRules {
  needsPerson: boolean
  currency: string
  locale: string
}

/** Los datos dentro de «Más datos»: con un error ahí, el desplegable se abre. */
const MORE_FIELDS = ["amount", "interest", "assignee", "budgetId"] as const

/** El nombre del dato en el cuerpo de la petición → su campo en pantalla. */
const SERVER_FIELDS: Record<string, string> = {
  contactId: "person",
  serviceId: "service",
  amountCents: "amount",
  interestText: "interest",
  assignedUserId: "assignee",
}

function opportunitySchema(rules: () => OpportunityRules) {
  return z
    .object({
      person: z.custom<PickedPerson | null>(),
      patientId: z.string(),
      title: z
        .string()
        .trim()
        .min(1, "Escribe qué le interesa: el tratamiento, el precio o la evaluación.")
        .max(200, "Escribe como mucho 200 caracteres."),
      service: z.custom<ServicePick | null>(),
      amount: z.string(),
      interest: z.string().max(500, "Escribe como mucho 500 caracteres."),
      assignee: z.string(),
      budgetId: z.string(),
      pipelineId: z.string(),
    })
    .superRefine((value, ctx) => {
      const { needsPerson, currency, locale } = rules()
      if (needsPerson && !value.person) {
        ctx.addIssue({ code: "custom", path: ["person"], message: "Elige a la persona interesada." })
      }
      if (value.service || !value.amount.trim()) return
      if (!currency) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "Configura la moneda de la clínica para anotar un valor." })
        return
      }
      try {
        parseMoney(value.amount.trim(), currency, locale)
      } catch (error) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: error instanceof Error ? error.message : "Importe inválido" })
      }
    })
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
  const draftReady = !isEdit || (!!detail && !profile.isPending)

  function invalidate() {
    for (const key of ["opportunities", "opportunity", "pipeline-cards", "pipeline-list", "opportunity-summary", "contact-opportunities", "contact", "crm-context", "tasks"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isEdit
        ? apiFetch<{ data: OpportunityDetail }>(`/api/opportunities/${opportunityId as string}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : apiFetch<{ data: OpportunityDetail }>("/api/opportunities", { method: "POST", body: JSON.stringify(body) }),
  })

  // La validación lee la pantalla del momento (persona fija o no, moneda de la clínica).
  const rules = useRef<OpportunityRules>({ needsPerson: false, currency: "", locale: "" })
  rules.current = { needsPerson: !contactId && !isEdit, currency: orgCurrency, locale: moneyLocale }
  const schema = useMemo(() => opportunitySchema(() => rules.current), [])

  const form = useAppForm({
    defaultValues: EMPTY_VALUES,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const amountCents =
        !value.service && value.amount.trim() ? parseMoney(value.amount.trim(), orgCurrency, moneyLocale) : null
      const body: Record<string, unknown> = {
        title: value.title.trim(),
        serviceId: value.service?.id ?? null,
        interestText: value.interest.trim() || null,
        assignedUserId: value.assignee || null,
        patientId: value.patientId || null,
        ...(value.service ? {} : { amountCents }),
      }
      const result = await save.mutateAsync(
        isEdit
          ? { ...body, budgetId: value.budgetId || null }
          : {
              ...body,
              contactId: contactId ?? value.person?.id,
              conversationId: conversationId ?? null,
              ...(value.pipelineId ? { pipelineId: value.pipelineId } : {}),
            },
      )
      invalidate()
      onSaved?.(result.data)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: SERVER_FIELDS })

  // «Más datos»: cerrado al crear; un error ahí (del cliente o del servidor) lo abre para que se vea.
  const [moreOpen, setMoreOpen] = useState(isEdit)
  const moreInvalid = useStore(form.store, (state) =>
    MORE_FIELDS.some((name) => (state.fieldMeta[name]?.errors.length ?? 0) > 0),
  )
  useEffect(() => {
    if (moreInvalid) setMoreOpen(true)
  }, [moreInvalid])

  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir o al llegar el detalle; después el borrador es de quien escribe
  useEffect(() => {
    if (!open || !draftReady) return
    if (detail) {
      form.reset({
        person: { id: detail.contactId, name: detail.contactName, phone: detail.contactPhone },
        patientId: detail.patientId ?? "",
        title: detail.title,
        service:
          detail.serviceId && detail.serviceName
            ? { id: detail.serviceId, name: detail.serviceName, priceCents: detail.amountCents ?? 0, currency: detail.currency }
            : null,
        amount: !detail.serviceId && detail.amountCents !== null ? amountInputText(detail.amountCents, detail.currency, moneyLocale) : "",
        interest: detail.interestText ?? "",
        assignee: detail.assignedUserId ?? RECEPTION,
        budgetId: detail.budgetId ?? "",
        pipelineId: "",
      })
    } else if (!isEdit) {
      form.reset(EMPTY_VALUES)
    }
    setMoreOpen(isEdit)
  }, [open, opportunityId, detail?.id, draftReady])

  const person = useStore(form.store, (state) => state.values.person)
  const patientId = useStore(form.store, (state) => state.values.patientId)
  const service = useStore(form.store, (state) => state.values.service)

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

  const isClosed = detail !== null && detail.status !== "open"
  const readOnly = !canWrite || isClosed
  const originId = conversationId ?? detail?.conversationId ?? null
  const originChannel = conversations.find((item) => item.id === originId)?.channel
  const servicePrice =
    service && profile.data?.locale ? formatMoney(service.priceCents, service.currency, profile.data.locale) : null

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
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
      isLoading={isEdit && !draftReady && !detailQuery.isError}
      isDirty={!isEdit && surface.isDirty}
      error={surface.error ?? (detailQuery.isError ? "No se pudo cargar la oportunidad." : null)}
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
          <form.AppField name="person">
            {(field) => (
              <field.Control label="Persona interesada">
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    label="Persona interesada"
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onChange={(next) => {
                      field.handleChange(next)
                      form.setFieldValue("patientId", "")
                      form.setFieldValue("budgetId", "")
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        )}

        {effectiveContactId && linkedPatients.length > 0 ? (
          <form.AppField name="patientId">
            {(field) => (
              <field.Control label="Para quién es">
                {(control) => (
                  <ChoiceSelect
                    {...control.props}
                    value={field.state.value}
                    disabled={readOnly}
                    onChange={(event) => {
                      field.handleChange(event.target.value)
                      form.setFieldValue("budgetId", "")
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
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}

        <form.AppField name="title">
          {(field) => (
            <field.TextField label="Qué le interesa" maxLength={200} disabled={readOnly} placeholder={appWords().examples.treatment} />
          )}
        </form.AppField>

        <form.AppField name="service">
          {(field) => (
            <field.Control
              label={field.state.value ? "Servicio" : "Servicio (opcional)"}
              description={field.state.value ? undefined : "Con servicio, el valor sale de su precio."}
            >
              {(control) => (
                <ServiceSearch
                  control={control}
                  value={field.state.value}
                  disabled={readOnly}
                  onChange={(next) => {
                    field.handleChange(next)
                    const title = form.getFieldValue("title")
                    if (next && (!form.getFieldMeta("title")?.isDirty || !title.trim())) form.setFieldValue("title", next.name)
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        {service ? (
          <p className="text-sm text-muted-foreground">
            Valor: <span className="font-medium text-foreground">{servicePrice ?? "…"}</span> · de la lista de precios
          </p>
        ) : null}

        {!isEdit && pipelines.length > 1 ? (
          <form.AppField name="pipelineId">
            {(field) => (
              <field.Control label="Embudo">
                {(control) => (
                  <ChoiceSelect {...control.props} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)}>
                    <option value="">El principal</option>
                    {pipelines.map((pipe) => (
                      <option key={pipe.id} value={pipe.id}>
                        {pipe.name}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}

        <Collapsible className="flex flex-col gap-3" open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
                Más datos (opcional)
                <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
              </Button>
            }
          />
          {/* Montado aunque esté cerrado: lo que el servidor diga de estos datos cae en su campo. */}
          <CollapsibleContent keepMounted className="flex flex-col gap-4">
            {!service ? (
              <form.AppField name="amount">
                {(field) => (
                  <field.Control
                    label={`Valor estimado${orgCurrency ? ` (${orgCurrency})` : ""}`}
                    description="Con un servicio de la lista de precios, el valor es su precio."
                  >
                    {(control) => (
                      <Input
                        {...control.props}
                        value={field.state.value}
                        inputMode="decimal"
                        disabled={readOnly}
                        placeholder={orgCurrency ? amountInputText(0, orgCurrency, moneyLocale) : undefined}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ) : null}
            <form.AppField name="interest">
              {(field) => (
                <field.TextField
                  label="Lo que pidió, en sus palabras"
                  maxLength={500}
                  disabled={readOnly}
                  placeholder="Preguntó cuánto cuesta y si hay cuotas"
                />
              )}
            </form.AppField>
            <form.AppField name="assignee">
              {(field) => (
                <field.Control label="Quién la lleva">
                  {(control) => (
                    <ChoiceSelect
                      {...control.props}
                      value={field.state.value}
                      disabled={readOnly}
                      onChange={(event) => field.handleChange(event.target.value)}
                    >
                      <option value={RECEPTION}>Recepción (nadie la tomó)</option>
                      {members.map((item) => (
                        <option key={item.userId} value={item.userId}>
                          {item.user.name}
                        </option>
                      ))}
                    </ChoiceSelect>
                  )}
                </field.Control>
              )}
            </form.AppField>
            {isEdit && patientId ? (
              <form.AppField name="budgetId">
                {(field) => (
                  <field.Control
                    label="Presupuesto"
                    description="Al presentar un presupuesto se une solo a la oportunidad del mismo tratamiento."
                  >
                    {(control) =>
                      budgetQuery.isError ? (
                        <p role="alert" className="text-sm text-destructive">
                          No se pudieron cargar sus presupuestos.{" "}
                          <Button type="button" variant="link" size="sm" onClick={() => void budgetQuery.refetch()}>
                            Reintentar
                          </Button>
                        </p>
                      ) : (
                        <ChoiceSelect
                          {...control.props}
                          value={field.state.value}
                          disabled={readOnly || budgetQuery.isPending}
                          onChange={(event) => field.handleChange(event.target.value)}
                        >
                          <option value="">Sin presupuesto</option>
                          {(budgetQuery.data?.data ?? []).map((budget) => (
                            <option key={budget.id} value={budget.id}>
                              {budget.title} · {budgetStatusLabel(budget.status)}
                            </option>
                          ))}
                        </ChoiceSelect>
                      )
                    }
                  </field.Control>
                )}
              </form.AppField>
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

/**
 * El servicio de la lista de precios, buscado en el servidor por su nombre. La
 * etiqueta, la ayuda y el error los pone el campo (`control`).
 */
function ServiceSearch({
  control,
  value,
  onChange,
  disabled,
}: {
  control: FieldControl
  value: ServicePick | null
  onChange: (service: ServicePick | null) => void
  disabled: boolean
}) {
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
      <div
        id={control.id}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-1.5 aria-invalid:border-destructive"
      >
        <span className="truncate font-medium">{value.name}</span>
        {!disabled ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
            onBlur={control.onBlur}
            aria-label={`Quitar el servicio ${value.name}`}
          >
            <X aria-hidden />
            Quitar
          </Button>
        ) : null}
      </div>
    )
  }
  return (
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
      <ComboboxInput
        id={control.id}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.describedBy}
        onBlur={control.onBlur}
        disabled={disabled}
        placeholder="Buscar en la lista de precios"
        triggerLabel="Mostrar servicios"
      />
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
  )
}
