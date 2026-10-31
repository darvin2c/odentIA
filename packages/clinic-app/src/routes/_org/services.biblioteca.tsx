import { formatMoneyInput, parseMoney } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  FieldGroup,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@odentia/ui"
import {
  common,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  fieldErrorMessages,
  FilterBar,
  FormDrawer,
  SkeletonRegion,
  PageHeader,
  SubmitButton,
  setSubmitErrors,
  submitForm,
  useAppForm,
  useFormSubmitError,
  useFormSurface,
  useListSearch,
  useDraftBlocker,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Library } from "lucide-react"
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { productUi } from "../../product/product-ui"
import { missingOfficialCode, OfficialCodeField, officialCodeText } from "../../components/official-code-field"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { RadioChips } from "../../components/ui/radio-chips"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { useCan, usePermission } from "../../lib/crm"
import { libraryHeading, libraryPrimary } from "../../lib/screen-rules"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import {
  BILLING_MODE_LABELS,
  type BillingMode,
  currencySymbol,
  createServiceApi,
  fetchMostUsedServices,
  fetchServices,
  fetchTreatmentTemplates,
  type OfficialCoding,
  PRICE_DISCLOSURE_OPTIONS,
  type PriceDisclosure,
  type QuickAddServiceBody,
  quickAddServicesApi,
  SERVICE_PLACE_OPTIONS,
  type TreatmentTemplateItem,
} from "../../lib/services"
import { useClinicSpecialties } from "../../lib/clinical-forms"
import { LibraryBodySkeleton, LibraryPageSkeleton, LibraryRowsSkeleton } from "../../components/skeletons/services"

export const Route = createFileRoute("/_org/services/biblioteca")({
  pendingComponent: LibraryPageSkeleton,
  component: AddServicesPage,
})

const PAGE_LIMIT = 20

/** Tope por guardado: la API recibe 100 servicios como máximo. */
const MAX_SELECTION = 100

type View = "mas-usados" | "biblioteca"

/** Todos los templateId ya incorporados (recorre el cursor de cada estado). */
async function fetchAllOwnedTemplateIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const state of ["active", "inactive"] as const) {
    let cursor: string | undefined
    do {
      const page = await fetchServices({ state, limit: 100, cursor })
      for (const row of page.data) {
        if (row.templateId) ids.add(row.templateId)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  return ids
}

/* --------------------------- Borrador de la tabla -------------------------- */

/**
 * Lo que la persona ya eligió o escribió de un servicio. Vive aparte de la
 * vista: cambiar de «Más usados» a la biblioteca, buscar o paginar no lo borra.
 */
interface Draft {
  /** El tratamiento de la biblioteca (`templateId`). */
  key: string
  chosen: boolean
  /** Nombre que usará la clínica. */
  name: string
  price: string
  billingMode: BillingMode
  durationMin: string
  scope: string
  /** El nombre en la biblioteca, para nombrar la fila mientras se cambia el propio. */
  libraryName: string
  /** Su código en la lista del país («CPMS D2330»); null donde no hay lista. */
  code: string | null
}

/**
 * El formulario de la tabla: un borrador por tratamiento que pasó por la
 * vista (sus campos son `items[i].price`…) y una sola respuesta a «¿Cómo
 * dice…?» para todo lo que se guarda.
 */
interface BatchValues {
  items: Draft[]
  priceDisclosure: PriceDisclosure
}

/** Fila de la tabla: el borrador, su lugar en el formulario y de dónde salió. */
interface AddRow extends Draft {
  /** Posición en `items`: nombra sus campos. */
  index: number
  /** Tipo de tratamiento de «Más usados» del que salió, si aplica. */
  concept: string | null
  /** Ya está en el tarifario de la clínica: no se elige otra vez. */
  owned: boolean
}

/** `listLabel`: el nombre corto de la lista del país («CPMS», «CIE-9-MC»), nunca su clave. */
function templateDraft(template: TreatmentTemplateItem, listLabel: string | null): Draft {
  const coding = template.codings[0]
  return {
    key: template.id,
    chosen: false,
    name: template.name,
    price: "",
    billingMode: "treatment",
    durationMin: "",
    scope: template.scope,
    libraryName: template.name,
    code: coding && listLabel ? `${listLabel} ${coding.code}` : null,
  }
}

/** Lo escrito en el precio que no se lee como importe; vacío no es error aquí. */
function priceTextIssue(raw: string, regional: Regional | null): string | undefined {
  if (!regional) return undefined
  const price = checkPrice(raw, regional)
  return price.state === "invalid" ? price.message : undefined
}

const MISSING_PRICE = "Falta el precio"
const ROW_DURATION_ISSUE = "Minutos entre 1 y 1440"

/** Un servicio elegido se guarda cuando su precio se lee y su nombre y su duración valen. */
function isReady(draft: Draft, regional: Regional): boolean {
  return (
    checkPrice(draft.price, regional).state === "ok" &&
    checkName(draft.name) === null &&
    checkDuration(draft.durationMin).ok
  )
}

/**
 * Lo que se revisa al guardar la tabla, dicho en el campo de su fila. Lo mal
 * escrito de un servicio elegido no deja guardar. Uno elegido sin precio
 * espera en la tabla mientras otro esté listo; si no hay ninguno listo, se
 * pide el precio de cada uno.
 */
function checkBatch(
  value: BatchValues,
  regional: Regional | null,
): { form?: string; fields: Record<string, string> } | undefined {
  if (!regional) return { form: "Falta la moneda de la clínica", fields: {} }
  const fields: Record<string, string> = {}
  const waiting: number[] = []
  let ready = 0
  value.items.forEach((draft, index) => {
    if (!draft.chosen) return
    const name = checkName(draft.name)
    if (name) fields[`items[${index}].name`] = name
    const durationOk = checkDuration(draft.durationMin).ok
    if (!durationOk) fields[`items[${index}].durationMin`] = ROW_DURATION_ISSUE
    const price = checkPrice(draft.price, regional)
    if (price.state === "invalid") fields[`items[${index}].price`] = price.message
    else if (price.state === "empty") waiting.push(index)
    else if (!name && durationOk) ready += 1
  })
  if (Object.keys(fields).length > 0) return { fields }
  if (ready > 0) return undefined
  if (waiting.length === 0) return { form: "Elige al menos un servicio y ponle su precio.", fields: {} }
  for (const index of waiting) fields[`items[${index}].price`] = MISSING_PRICE
  return { fields }
}

/** Cómo se llama en la fila cada dato que el servidor señala de un servicio del lote. */
const BATCH_ROW_FIELDS: Readonly<Record<string, keyof Draft>> = {
  templateId: "name",
  kind: "name",
  name: "name",
  priceCents: "price",
  billingMode: "billingMode",
  durationMin: "durationMin",
}

/**
 * El servidor nombra el servicio por su lugar en el cuerpo (`items[2].priceCents`),
 * donde solo van los listos; `sent[k]` es el lugar de ese servicio en el formulario.
 */
function batchField(sent: readonly number[], serverField: string): string | undefined {
  const match = /^items\[(\d+)\]\.(\w+)/.exec(serverField)
  if (!match) return undefined
  const index = sent[Number(match[1])]
  const field = BATCH_ROW_FIELDS[match[2] ?? ""]
  return index === undefined || !field ? undefined : `items[${index}].${field}`
}

interface Regional {
  currency: string
  locale: string
}

type PriceCheck = { state: "empty" } | { state: "invalid"; message: string } | { state: "ok"; cents: number }

function checkPrice(raw: string, regional: Regional): PriceCheck {
  if (raw.trim() === "") return { state: "empty" }
  try {
    return { state: "ok", cents: parseMoney(raw, regional.currency, regional.locale) }
  } catch (error) {
    return {
      state: "invalid",
      message: error instanceof Error ? error.message : "Importe inválido",
    }
  }
}

/** Minutos enteros entre 1 y 1440; vacío es «sin duración». */
function checkDuration(raw: string): { ok: boolean; minutes: number | null } {
  if (raw.trim() === "") return { ok: true, minutes: null }
  const minutes = Number(raw.trim())
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return { ok: false, minutes: null }
  return { ok: true, minutes }
}

function checkName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return "Ponle un nombre"
  if (name.length > 200) return "Máximo 200 caracteres"
  return null
}

/* --------------------------------- Página --------------------------------- */

/**
 * Agregar servicios (tablero 8b): se eligen de «Más usados», de la biblioteca
 * o se crean propios; en la misma tabla se les pone nombre, precio y cómo se
 * cobran, y lo que se guarda queda activo. Quien no administra el tarifario
 * solo consulta la biblioteca.
 */
function AddServicesPage() {
  const receptionName = useReceptionName()
  const can = useCan()
  const { canIncorporate, title, subtitle } = libraryHeading(can)
  const canViewLibrary =
    canIncorporate ||
    usePermission("catalog.read") ||
    usePermission("clinical.read") ||
    usePermission("appointments.read") ||
    usePermission("finance.read")
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const kindFilter = listSearch.get("tipo") ?? "todos"
  const cursor = listSearch.get("cursor")
  // La biblioteca se ordena por tipo de tratamiento (ADR 0069): no son las especialidades de la clínica.
  const libraryFilterOptions = [
    { value: "todos", label: "Todos" },
    ...productUi().services.kinds.map((kind) => ({ value: kind.key, label: kind.name })),
  ]
  /** La lista de servicios del país: el código de cada tratamiento es el suyo; sin lista, ninguno. */
  const codeList = useClinicalProfile().services
  const hasFilters = search.trim() !== "" || kindFilter !== "todos"
  /** «Más usados» es el punto de partida de quien agrega; buscar o filtrar va a la biblioteca. */
  const view: View =
    canIncorporate && !hasFilters && listSearch.get("vista") !== "biblioteca"
      ? "mas-usados"
      : "biblioteca"

  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  /** Cada apertura del servicio propio empieza en blanco. */
  const [ownSession, setOwnSession] = useState(0)
  const [ownOpen, setOwnOpen] = useState(false)

  /** Moneda y formato de la clínica: con ellos se escriben y leen los precios. */
  const profileQuery = useOrgProfile()
  const currency = profileQuery.data?.currency
  const locale = profileQuery.data?.locale
  const regional = useMemo<Regional | null>(
    () => (currency && locale ? { currency, locale } : null),
    [currency, locale],
  )

  useEffect(() => {
    if (!cursor) setPreviousCursors([])
  }, [cursor])

  const mostUsedQuery = useQuery({
    queryKey: ["services", "most-used"],
    enabled: canIncorporate && view === "mas-usados",
    queryFn: fetchMostUsedServices,
  })

  const libraryQuery = useQuery({
    queryKey: ["services", "biblioteca", search, kindFilter, cursor],
    enabled: canViewLibrary && view === "biblioteca",
    queryFn: () =>
      fetchTreatmentTemplates({
        q: search.trim() || undefined,
        kind: kindFilter === "todos" ? undefined : kindFilter,
        cursor: cursor ?? undefined,
        limit: PAGE_LIMIT,
      }),
  })

  const ownedQuery = useQuery({
    queryKey: ["services", "owned-templates"],
    enabled: canViewLibrary && view === "biblioteca",
    queryFn: fetchAllOwnedTemplateIds,
    staleTime: 60_000,
  })

  const activeQuery = view === "mas-usados" ? mostUsedQuery : libraryQuery
  const nextCursor = libraryQuery.data?.nextCursor ?? null
  const total = libraryQuery.data?.total ?? 0
  const pageNumber = previousCursors.length + 1

  /** Tratamientos de la vista, con el tipo del que salen en «Más usados». */
  const viewTemplates = useMemo<Array<{ template: TreatmentTemplateItem; concept: string | null }>>(
    () =>
      view === "mas-usados"
        ? (mostUsedQuery.data?.data ?? []).flatMap((concept) =>
            concept.templates.map((template) => ({ template, concept: concept.label })),
          )
        : (libraryQuery.data?.data ?? []).map((template) => ({ template, concept: null })),
    [view, mostUsedQuery.data, libraryQuery.data],
  )

  const owned = ownedQuery.data
  const saveMutation = useMutation({
    mutationFn: (body: { items: QuickAddServiceBody[]; priceDisclosure: PriceDisclosure }) =>
      quickAddServicesApi(body.items, body.priceDisclosure),
  })
  /** Lugar de cada servicio enviado en `items` del formulario: el servidor lo nombra por su lugar en el cuerpo. */
  const sentIndex = useRef<number[]>([])
  /**
   * «¿Cómo dice {receptionName} estos precios?»: una sola pregunta para todo lo que
   * se guarda, con «Precio exacto» marcado (decisión 5 de la fase 4). Después
   * se cambia en Servicios, uno por uno o varios a la vez.
   */
  const form = useAppForm({
    defaultValues: { items: [], priceDisclosure: "exacto" } as BatchValues,
    validators: { onSubmit: ({ value }) => checkBatch(value, regional) },
    onSubmit: async ({ value }) => {
      if (!regional) throw new Error("Falta la moneda de la clínica")
      const items: QuickAddServiceBody[] = []
      const sent: number[] = []
      value.items.forEach((draft, index) => {
        if (!draft.chosen || !isReady(draft, regional)) return
        const price = checkPrice(draft.price, regional)
        if (price.state !== "ok") return
        items.push({
          kind: "template",
          templateId: draft.key,
          name: draft.name.trim(),
          priceCents: price.cents,
          billingMode: draft.billingMode,
          durationMin: checkDuration(draft.durationMin).minutes,
        })
        sent.push(index)
      })
      sentIndex.current = sent
      const result = await saveMutation.mutateAsync({ items, priceDisclosure: value.priceDisclosure })
      // Sale de la tabla solo lo guardado; lo que espera su precio se queda, marcado en su campo.
      const saved = new Set(sent.map((index) => value.items[index]?.key))
      const left = value.items.filter((draft) => !saved.has(draft.key))
      form.setFieldValue("items", left, { dontUpdateMeta: true, dontValidate: true })
      const waiting = left.flatMap((draft, index) => (draft.chosen ? [index] : []))
      setSubmitErrors(form, { fields: Object.fromEntries(waiting.map((index) => [`items[${index}].price`, MISSING_PRICE])) })
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      const created = result.data.created.length
      const already = result.data.existing.length
      const parts = [
        created === 1
          ? "1 servicio guardado y activo"
          : `${created} servicios guardados y activos`,
      ]
      if (already > 0) {
        parts.push(already === 1 ? "1 ya estaba entre tus servicios" : `${already} ya estaban entre tus servicios`)
      }
      if (waiting.length > 0) {
        parts.push(
          waiting.length === 1 ? "queda 1 por completar en la tabla" : `quedan ${waiting.length} por completar en la tabla`,
        )
      }
      toast.success(`${parts.join(" · ")}.`)
    },
  })
  const items = useStore(form.store, (state) => state.values.items)
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const submitError = useFormSubmitError(form)
  const pageRef = useRef<HTMLDivElement>(null)
  const codeLabel = codeList?.label ?? null

  // Cada tratamiento de la vista tiene su borrador desde que aparece, así sus
  // campos ya existen al escribir. Lo agregado no se quita: los índices (y
  // con ellos los campos) no cambian al pasar de una vista a otra.
  useEffect(() => {
    const known = new Set(form.state.values.items.map((draft) => draft.key))
    const missing: Draft[] = []
    for (const { template } of viewTemplates) {
      if (known.has(template.id)) continue
      known.add(template.id)
      missing.push(templateDraft(template, codeLabel))
    }
    if (missing.length === 0) return
    form.setFieldValue("items", (previous) => [...previous, ...missing], { dontUpdateMeta: true, dontValidate: true })
  }, [codeLabel, form, viewTemplates])

  const { rows, syncing } = useMemo(() => {
    const indexByKey = new Map(items.map((draft, index) => [draft.key, index]))
    const inView = new Set<string>()
    const list: AddRow[] = []
    let pending = false
    for (const { template, concept } of viewTemplates) {
      const index = indexByKey.get(template.id)
      const draft = index === undefined ? undefined : items[index]
      if (index === undefined || !draft) {
        pending = true
        continue
      }
      if (inView.has(template.id)) continue
      inView.add(template.id)
      list.push({
        ...draft,
        index,
        concept,
        owned: view === "biblioteca" && (owned?.has(template.id) ?? false),
      })
    }
    // Lo elegido en otra vista sigue a la vista: lo que se va a guardar —y lo
    // que quedó incompleto— nunca se pierde de vista.
    items.forEach((draft, index) => {
      if (draft.chosen && !inView.has(draft.key)) list.push({ ...draft, index, concept: null, owned: false })
    })
    return { rows: list, syncing: pending }
  }, [items, owned, view, viewTemplates])

  /** Todo lo elegido, esté o no en la vista: es lo que cuenta y lo que se guarda. */
  const chosen = useMemo(() => items.filter((draft) => draft.chosen), [items])
  const ready = regional ? chosen.filter((draft) => isReady(draft, regional)).length : 0
  const missingPrice = chosen.filter((draft) => draft.price.trim() === "").length
  const toFix = chosen.length - ready - missingPrice
  const chosenCount = useRef(0)
  chosenCount.current = chosen.length
  const dirty = chosen.length > 0

  /** Elegir (o dejar de elegir) un servicio; elegir respeta el tope de un guardado. */
  const setChosen = useCallback(
    (row: AddRow, next: boolean): boolean => {
      if (next && !row.chosen && chosenCount.current >= MAX_SELECTION) {
        toast.info(`Guarda estos ${MAX_SELECTION} antes de elegir más`)
        return false
      }
      form.setFieldValue(`items[${row.index}].chosen`, next)
      return true
    },
    [form],
  )

  const openOwn = useCallback(() => {
    setOwnSession((session) => session + 1)
    setOwnOpen(true)
  }, [])

  /** Un cambio de vista conserva lo elegido; solo cambia qué se muestra para elegir. */
  const changeView = (next: View) => {
    setPreviousCursors([])
    listSearch.setParams(
      next === "mas-usados"
        ? { vista: undefined, q: undefined, tipo: undefined, cursor: undefined }
        : { vista: "biblioteca", cursor: undefined },
    )
  }

  const pricePlaceholder = regional ? formatMoneyInput(0, regional.currency, regional.locale) : ""
  const priceHeader = regional
    ? `Precio (${currencySymbol(regional.currency, regional.locale)})`
    : "Precio"

  // Las definiciones no dependen de lo escrito: una columna recreada en cada
  // tecla remontaría su celda y el campo perdería el foco. Los valores llegan
  // por la fila.
  const columns = useMemo<ColumnDef<AddRow>[]>(() => {
    const serviceColumn: ColumnDef<AddRow> = {
      id: "servicio",
      header: canIncorporate ? "Servicio, con el nombre que usará la clínica" : "Tratamiento",
      meta: { view: { role: "title" } },
      cell: ({ row }) => {
        const item = row.original
        return (
          <ServiceCell
            row={item}
            nameInput={
              // Quien administra el tarifario cambia el nombre de lo que elige.
              canIncorporate && item.chosen ? (
                // Tras guardar, los borradores que quedan cambian de lugar: el campo se vuelve a montar con su nombre nuevo.
                <form.AppField key={item.index} name={`items[${item.index}].name`}>
                  {(field) => (
                    <field.TextField
                      label={`Nombre que usará la clínica para ${item.libraryName}`}
                      hideLabel
                      className="gap-1"
                      inputClassName="w-full min-w-48"
                      maxLength={200}
                      disabled={saving}
                    />
                  )}
                </form.AppField>
              ) : null
            }
          />
        )
      },
    }
    if (!canIncorporate) {
      return [
        serviceColumn,
        {
          id: "estado",
          header: "En la clínica",
          meta: { view: { primary: true } },
          cell: ({ row }) =>
            row.original.owned ? (
              <Badge variant="secondary">Ya agregado</Badge>
            ) : (
              <span className="text-muted-foreground">No agregado</span>
            ),
        },
      ]
    }
    return [
      {
        id: "elegir",
        header: "",
        // «media» y no «select»: en teléfono la casilla acompaña a cada fila
        // sin la barra de «seleccionar todo», que aquí no existe.
        meta: { view: { role: "media", label: "Agregar" } },
        cell: ({ row }) => (
          <Checkbox
            checked={row.original.chosen}
            disabled={row.original.owned || saving}
            onCheckedChange={(value) => setChosen(row.original, value === true)}
            aria-label={`Agregar ${row.original.name.trim() || "este servicio"}`}
          />
        ),
      },
      serviceColumn,
      {
        id: "cobro",
        header: "Se cobra",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const item = row.original
          if (item.owned) return <span className="text-muted-foreground">—</span>
          if (!item.chosen) return BILLING_MODE_LABELS[item.billingMode]
          return (
            <form.AppField key={item.index} name={`items[${item.index}].billingMode`}>
              {(field) => (
                <field.Control
                  label={`Cómo se cobra ${item.name.trim() || "este servicio"}`}
                  hideLabel
                  className="w-40 gap-1"
                >
                  {(control) => (
                    <ChoiceSelect
                      id={control.id}
                      name={control.name}
                      className="w-40"
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      disabled={saving}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value as BillingMode)}
                    >
                      <option value="treatment">{BILLING_MODE_LABELS.treatment}</option>
                      <option value="session">{BILLING_MODE_LABELS.session}</option>
                    </ChoiceSelect>
                  )}
                </field.Control>
              )}
            </form.AppField>
          )
        },
      },
      {
        id: "duracion",
        header: "Duración",
        // Principal: en teléfono también se pone la duración, junto al precio.
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const item = row.original
          if (item.owned) return <span className="text-muted-foreground">—</span>
          if (!item.chosen) {
            return item.durationMin.trim() !== "" ? (
              `${item.durationMin.trim()} min`
            ) : (
              <span className="text-muted-foreground">Sin duración</span>
            )
          }
          return (
            <form.AppField key={item.index} name={`items[${item.index}].durationMin`}>
              {(field) => (
                <field.Control
                  label={`Duración en minutos de ${item.name.trim() || "este servicio"}`}
                  hideLabel
                  className="w-auto gap-1"
                >
                  {(control) => (
                    <div className="inline-flex items-center gap-1.5">
                      <Input
                        {...control.props}
                        className="w-16"
                        inputMode="numeric"
                        disabled={saving}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <span className="text-muted-foreground">min</span>
                    </div>
                  )}
                </field.Control>
              )}
            </form.AppField>
          )
        },
      },
      {
        id: "precio",
        header: priceHeader,
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const item = row.original
          if (item.owned) return <Badge variant="secondary">Ya está entre tus servicios</Badge>
          const label = item.name.trim() || "este servicio"
          return (
            <form.AppField
              key={item.index}
              name={`items[${item.index}].price`}
              // Lo que no se lee como importe se dice al salir del campo: el formato depende de la moneda.
              validators={{ onBlur: ({ value }) => (item.chosen ? priceTextIssue(value, regional) : undefined) }}
            >
              {(field) => (
                <field.Control
                  label={item.billingMode === "session" ? `Precio por sesión de ${label}` : `Precio de ${label}`}
                  hideLabel
                  className="w-28 gap-1"
                  description={
                    item.chosen && field.state.value.trim() === "" && field.state.meta.errors.length === 0
                      ? MISSING_PRICE
                      : undefined
                  }
                >
                  {(control) => (
                    <Input
                      {...control.props}
                      className="w-28"
                      inputMode="decimal"
                      placeholder={pricePlaceholder}
                      disabled={saving}
                      value={field.state.value}
                      onChange={(event) => {
                        const price = event.target.value
                        // Poner el precio ya es elegirlo: no hace falta marcar antes la casilla.
                        if (price.trim() !== "" && !item.chosen && !setChosen(item, true)) return
                        field.handleChange(price)
                      }}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          )
        },
      },
    ]
  }, [canIncorporate, form, priceHeader, pricePlaceholder, regional, saving, setChosen])

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.key,
  })

  const goNext = () => {
    if (!nextCursor) return
    setPreviousCursors((stack) => [...stack, cursor ?? ""])
    listSearch.setParam("cursor", nextCursor)
  }
  const goPrevious = () => {
    const copy = [...previousCursors]
    const previous = copy.pop()
    setPreviousCursors(copy)
    listSearch.setParam("cursor", previous || undefined)
  }

  if (!canViewLibrary) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Biblioteca de procedimientos" />
        <EmptyState
          title="Sin acceso"
          description="Necesitas permiso clínico, de agenda, de caja o de configuración para ver la biblioteca."
        />
      </div>
    )
  }

  const emptyView =
    view === "mas-usados" ? (
      <EmptyState
        icon={Library}
        title="No hay sugerencias para empezar"
        description="No hay una biblioteca de procedimientos para tu clínica, o ya agregaste los más usados. Crea tus servicios propios o busca en la biblioteca."
        actionLabel="Crear un servicio propio"
        onAction={openOwn}
        secondaryActionLabel="Ver toda la biblioteca"
        onSecondaryAction={() => changeView("biblioteca")}
      />
    ) : hasFilters ? (
      <EmptyState
        icon={Library}
        title="Sin resultados"
        description={
          canIncorporate
            ? "Ningún procedimiento de la biblioteca coincide. Si tu clínica lo ofrece, créalo como servicio propio."
            : "Ningún procedimiento de la biblioteca coincide con la búsqueda."
        }
        actionLabel={canIncorporate && regional ? "Crear un servicio propio" : undefined}
        onAction={canIncorporate && regional ? openOwn : undefined}
      />
    ) : (
      <EmptyState
        icon={Library}
        title="Aún no hay biblioteca de procedimientos"
        description={
          canIncorporate
            ? "Puedes trabajar igual con servicios propios: créalos con su precio."
            : "Cuando la clínica tenga una biblioteca de procedimientos, aparecerá aquí."
        }
        actionLabel={canIncorporate && regional ? "Crear un servicio propio" : undefined}
        onAction={canIncorporate && regional ? openOwn : undefined}
      />
    )

  const body = !regional ? null : activeQuery.isPending || (syncing && rows.length === 0) ? (
    <SkeletonRegion message="Cargando la biblioteca…">
      <LibraryRowsSkeleton canIncorporate={canIncorporate} />
    </SkeletonRegion>
  ) : activeQuery.isError ? (
    <ErrorState
      error={activeQuery.error instanceof ApiError ? activeQuery.error.shape : null}
      onRetry={() => void activeQuery.refetch()}
    />
  ) : rows.length === 0 ? (
    emptyView
  ) : (
    <div className="flex min-w-0 flex-col gap-3">
      <DataTable table={table} isFetching={activeQuery.isFetching && !activeQuery.isPending} />
      {codeList ? (
        <p className="text-xs text-muted-foreground">
          {codeList.required
            ? `Los códigos son los de ${codeList.listName}, la que pide la norma de tu país (${codeList.norm}).`
            : `Los códigos son los de ${codeList.listName}, de referencia en tu país (${codeList.norm}).`}
        </p>
      ) : null}
      {view === "biblioteca" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Página {pageNumber} · {total} con este filtro
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={previousCursors.length === 0 || libraryQuery.isFetching}
              onClick={goPrevious}
            >
              {common.filters.previous}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!nextCursor || libraryQuery.isFetching}
              onClick={goNext}
            >
              {common.filters.next}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )

  return (
    <div ref={pageRef} className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title={title}
        subtitle={subtitle}
        primary={regional ? libraryPrimary(can, openOwn) : profileQuery.isPending ? libraryPrimary(can) : undefined}
      />
      {profileQuery.isPending ? (
        <SkeletonRegion message="Cargando la biblioteca…" className="flex min-w-0 flex-col gap-4">
          <LibraryBodySkeleton canIncorporate={canIncorporate} />
        </SkeletonRegion>
      ) : profileQuery.isError ? (
        <ErrorState
          message="No se pudo cargar la moneda de la clínica"
          onRetry={() => void profileQuery.refetch()}
        />
      ) : !regional ? (
        <EmptyState
          title="Falta la región de la clínica"
          description={
            canIncorporate
              ? "Los precios se guardan en la moneda de la clínica. Configura el país y la moneda para agregar servicios."
              : "Quien administra la clínica debe configurar el país y la moneda antes de agregar servicios."
          }
          actionLabel={canIncorporate ? "Configurar la clínica" : undefined}
          onAction={canIncorporate ? () => void navigate({ to: "/settings" }) : undefined}
        />
      ) : (
        <>
          <FilterBar
            filters={[
              {
                key: "tipo",
                label: "Tipo",
                type: "select",
                options: libraryFilterOptions,
              },
            ]}
            sortOptions={[]}
            resetKeys={["q", "tipo"]}
            searchPlaceholder="Buscar en la biblioteca"
          />
          {canIncorporate ? (
            <Tabs value={view} onValueChange={(next) => changeView(next as View)}>
              <TabsList aria-label="De dónde elegir">
                <TabsTrigger value="mas-usados">Más usados</TabsTrigger>
                <TabsTrigger value="biblioteca">Toda la biblioteca</TabsTrigger>
              </TabsList>
              <TabsContent value="mas-usados">{view === "mas-usados" ? body : null}</TabsContent>
              <TabsContent value="biblioteca">{view === "biblioteca" ? body : null}</TabsContent>
            </Tabs>
          ) : (
            body
          )}
          {canIncorporate && (chosen.length > 0 || rows.length > 0) ? (
            <div
              // Fija al pie: en teléfono y tablet queda justo encima de la
              // barra de secciones (pegada al borde, con su zona segura); desde
              // `lg` esa barra es un riel lateral y esta baja hasta el borde.
              className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-border bg-card p-3 shadow-sm lg:bottom-0"
            >
              {chosen.length > 0 ? (
                <form.AppField name="priceDisclosure">
                  {(field) => (
                    <field.Group legend={`¿Cómo dice ${receptionName} estos precios?`} className="min-w-0 basis-full gap-1.5">
                      {(control) => (
                        <RadioChips
                          id={control.id}
                          aria-label={`¿Cómo dice ${receptionName} estos precios?`}
                          aria-describedby={control.describedBy}
                          invalid={control.invalid}
                          onBlur={control.onBlur}
                          value={field.state.value}
                          options={PRICE_DISCLOSURE_OPTIONS}
                          onChange={(next) => field.handleChange(next)}
                          disabled={saving}
                        />
                      )}
                    </field.Group>
                  )}
                </form.AppField>
              ) : null}
              <p className="hidden min-w-0 flex-1 basis-56 text-xs text-muted-foreground sm:block">
                {codeList
                  ? `El nombre es el que verán caja y el paciente; se puede cambiar. El ${codeList.codeName} se conserva.`
                  : "El nombre es el que verán caja y el paciente; se puede cambiar."}
              </p>
              <p className="text-sm font-medium" role="status">
                {ready === 1 ? "1 listo" : `${ready} listos`}
                {missingPrice > 0 ? ` · ${missingPrice} sin precio` : ""}
                {toFix > 0 ? ` · ${toFix} por corregir` : ""}
              </p>
              {/* Lo que no es de ningún servicio (o de uno que ya no está a la vista), junto al botón. */}
              {submitError ? (
                <p role="alert" className="basis-full text-sm text-destructive">
                  {submitError}
                </p>
              ) : null}
              <SubmitButton
                type="button"
                className="min-h-11"
                pending={saving}
                onClick={() =>
                  void submitForm(form, {
                    fieldMap: (key) => batchField(sentIndex.current, key),
                    root: pageRef.current,
                  })
                }
              >
                {`Guardar y activar ${ready}`}
              </SubmitButton>
            </div>
          ) : null}
          <OwnServiceDrawer
            key={ownSession}
            open={ownOpen}
            regional={regional}
            onClose={() => setOwnOpen(false)}
          />
        </>
      )}
      <LeaveGuard dirty={dirty && !saving} />
    </div>
  )
}

/* --------------------------------- Celdas --------------------------------- */

/** Nombre que usará la clínica (su campo, al elegirlo) y de qué servicio se trata. */
function ServiceCell({
  row,
  nameInput,
}: {
  row: AddRow
  /** El campo del nombre cuando se puede cambiar; si no, el nombre se lee. */
  nameInput: ReactNode
}) {
  const official = [row.concept, row.code].filter(Boolean).join(" · ")
  return (
    // `whitespace-normal` y tope de ancho: las celdas son `nowrap` y una
    // denominación oficial larga empujaría el precio fuera de la pantalla.
    <div className="flex min-w-48 max-w-xl flex-col gap-1 whitespace-normal">
      {nameInput ?? <span className="font-medium break-words">{row.name}</span>}
      {official ? (
        <span className="text-xs font-normal break-words text-muted-foreground">{official}</span>
      ) : null}
    </div>
  )
}

const BILLING_OPTIONS: ReadonlyArray<{ value: BillingMode; label: string }> = [
  { value: "treatment", label: BILLING_MODE_LABELS.treatment },
  { value: "session", label: BILLING_MODE_LABELS.session },
]

/* ----------------------------- Servicio propio ----------------------------- */

interface OwnServiceValues {
  name: string
  officialCode: OfficialCoding | null
  /** La especialidad de la clínica (una sola lista, ADR 0039). */
  specialtyId: string
  scope: string
  /** Lo tratado queda dibujado: lo que deja en la pieza al completarse. */
  leavesCondition: string
  leavesVariant: string
  billingMode: BillingMode
  price: string
  durationMin: string
}

const OWN_SERVICE_DEFAULTS: OwnServiceValues = {
  name: "",
  officialCode: null,
  specialtyId: "",
  scope: "general",
  leavesCondition: "",
  leavesVariant: "",
  billingMode: "treatment",
  price: "",
  durationMin: "",
}

/** Lo que se revisa antes de crear el servicio propio, con los mismos límites que la API. */
function ownServiceSchema(regional: Regional, codeList: { codeName: string; required: boolean } | null) {
  return z.object({
    name: z.string().trim().min(1, "Ponle un nombre").max(200, "Máximo 200 caracteres"),
    officialCode: z.custom<OfficialCoding | null>().superRefine((value, ctx) => {
      const issue = missingOfficialCode(codeList, value)
      if (issue) ctx.addIssue({ code: "custom", message: issue })
    }),
    specialtyId: z.string().min(1, "Elige la especialidad"),
    scope: z.string(),
    leavesCondition: z.string(),
    leavesVariant: z.string(),
    billingMode: z.enum(["treatment", "session"]),
    price: z.string().superRefine((value, ctx) => {
      const price = checkPrice(value, regional)
      if (price.state === "empty") ctx.addIssue({ code: "custom", message: "Pon el precio (0 si no tiene costo)" })
      else if (price.state === "invalid") ctx.addIssue({ code: "custom", message: price.message })
    }),
    durationMin: z.string().refine((value) => checkDuration(value).ok, "Minutos enteros entre 1 y 1440"),
  })
}

/**
 * Cómo se llama en el cajón cada dato que nombra `POST /api/services`; lo que
 * no aparece aquí se llama igual (`name`, `specialtyId`, `scope`,
 * `officialCode`, `billingMode`, `durationMin`).
 */
const OWN_SERVICE_FIELDS: Readonly<Record<string, keyof OwnServiceValues>> = {
  priceCents: "price",
  leavesFinding: "leavesCondition",
  "leavesFinding.condition": "leavesCondition",
  "leavesFinding.variant": "leavesVariant",
}

/**
 * Servicio propio (tablero 26): lo que la clínica ofrece y la biblioteca no
 * trae. «Guardar y activar» lo deja en el tarifario en el acto, con su precio;
 * no pasa por la tabla de lo elegido.
 */
function OwnServiceDrawer({
  open,
  regional,
  onClose,
}: {
  open: boolean
  regional: Regional
  onClose: () => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const specialtiesQuery = useClinicSpecialties({ activeOnly: true, enabled: open })
  // Lo que el servicio deja al completarse, si el producto lo registra (odentIA: «Deja en la pieza»).
  const leaves = productUi().services.leaves
  // El código de la lista del país (tablero 3): obligatorio, opcional o sin campo.
  const codeList = useClinicalProfile().services
  const codeText = officialCodeText(codeList)
  const schema = useMemo(() => ownServiceSchema(regional, codeList), [regional, codeList])
  const saveMutation = useMutation({ mutationFn: createServiceApi })

  const form = useAppForm({
    defaultValues: OWN_SERVICE_DEFAULTS,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const price = checkPrice(value.price, regional)
      if (price.state !== "ok") throw new Error("Revisa el precio")
      const result = await saveMutation.mutateAsync({
        name: value.name.trim(),
        specialtyId: value.specialtyId,
        scope: value.scope,
        priceCents: price.cents,
        billingMode: value.billingMode,
        durationMin: checkDuration(value.durationMin).minutes,
        leavesFinding: leaves?.body(value.leavesCondition, value.leavesVariant) ?? null,
        officialCode: value.officialCode?.code ?? null,
      })
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success(`«${result.data.name}» ya está activo entre tus servicios`)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: OWN_SERVICE_FIELDS })
  const scope = useStore(form.store, (state) => state.values.scope)
  const billingMode = useStore(form.store, (state) => state.values.billingMode)
  const specialtyOptions = (specialtiesQuery.data?.data ?? []).map((option) => ({
    value: option.id,
    label: option.name,
  }))

  return (
    <FormDrawer
      {...surface}
      open={open}
      title="Servicio propio"
      description="Lo que tu clínica ofrece y la biblioteca no trae. Queda activo al guardarlo."
      submitLabel="Guardar y activar"
      onClose={onClose}
    >
      <FieldGroup>
        <form.AppField name="name">{(field) => <field.TextField label="Nombre" maxLength={200} />}</form.AppField>
        {codeText ? (
          <form.AppField name="officialCode">
            {(field) => (
              <field.Control label={codeText.label} description={codeText.description}>
                {(control) => (
                  <OfficialCodeField
                    id={control.id}
                    value={field.state.value}
                    onChange={(next) => field.handleChange(next)}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="specialtyId">
          {(field) => (
            <field.SelectField
              label="Especialidad"
              options={specialtyOptions}
              placeholder={specialtiesQuery.isPending ? "Cargando…" : "Elige la especialidad"}
              disabled={specialtiesQuery.isPending}
            />
          )}
        </form.AppField>
        {/* Sin «dónde» (latidIA, decisión 4 del issue 229), todo servicio es general. */}
        {productUi().site ? (
          <form.AppField name="scope">
            {(field) => (
              <field.Group legend="Dónde se hace" description="Así la atención sabe qué pedir al registrarlo.">
                {(control) => (
                  <RadioChips
                    id={control.id}
                    aria-label="Dónde se hace"
                    aria-describedby={control.describedBy}
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    options={SERVICE_PLACE_OPTIONS}
                    onChange={(next) => {
                      field.handleChange(next)
                      // Lo que deja en la pieza depende de dónde se hace.
                      form.setFieldValue("leavesCondition", "")
                      form.setFieldValue("leavesVariant", "")
                    }}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {leaves ? (
          <form.AppField name="leavesCondition">
            {(condition) => (
              <form.AppField name="leavesVariant">
                {(variant) => (
                  <leaves.Field
                    idPrefix={id}
                    scope={scope}
                    condition={condition.state.value}
                    variant={variant.state.value}
                    errors={{
                      condition: fieldErrorMessages(condition.state.meta.errors)[0] ?? null,
                      variant: fieldErrorMessages(variant.state.meta.errors)[0] ?? null,
                    }}
                    onBlur={() => {
                      condition.handleBlur()
                      variant.handleBlur()
                    }}
                    onChange={(nextCondition, nextVariant) => {
                      condition.handleChange(nextCondition)
                      variant.handleChange(nextVariant)
                    }}
                  />
                )}
              </form.AppField>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="billingMode">
          {(field) => (
            <field.Group legend="Cómo se cobra" description="Por sesión: se cobra el precio en cada visita atendida.">
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-label="Cómo se cobra"
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={BILLING_OPTIONS}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <form.AppField
            name="price"
            // Lo que no se lee como importe se dice al salir del campo: el formato depende de la moneda.
            validators={{ onBlur: ({ value }) => priceTextIssue(value, regional) }}
          >
            {(field) => (
              <field.Control
                label={billingMode === "session" ? "Precio por sesión" : "Precio"}
                description="Usa 0 si no tiene costo."
              >
                {(control) => (
                  <InputGroup>
                    <InputGroupAddon align="inline-start">
                      <InputGroupText>{currencySymbol(regional.currency, regional.locale)}</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput
                      {...control.props}
                      inputMode="decimal"
                      placeholder={formatMoneyInput(0, regional.currency, regional.locale)}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </InputGroup>
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="durationMin">
            {(field) => (
              <field.Control label="Duración">
                {(control) => (
                  <InputGroup>
                    <InputGroupInput
                      {...control.props}
                      inputMode="numeric"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>min</InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
      </FieldGroup>
    </FormDrawer>
  )
}

/* ------------------------------ Salir sin guardar -------------------------- */

/**
 * Lo elegido vive en la pantalla hasta guardarlo: salir pregunta antes. Buscar,
 * filtrar o paginar cambian la URL de esta misma pantalla y no cuentan como salir.
 */
function LeaveGuard({ dirty }: { dirty: boolean }) {
  const blocker = useDraftBlocker({
    disabled: !dirty,
    enableBeforeUnload: () => dirty,
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
  })
  return (
    <ConfirmDialog
      open={blocker.status === "blocked"}
      title="Salir sin guardar"
      description="Los servicios que elegiste todavía no están guardados. Si sales, se pierde lo que escribiste."
      confirmLabel="Salir sin guardar"
      cancelLabel="Seguir aquí"
      onConfirm={() => blocker.proceed?.()}
      onClose={() => blocker.reset?.()}
    />
  )
}
