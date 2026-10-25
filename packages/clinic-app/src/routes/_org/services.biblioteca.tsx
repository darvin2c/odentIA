import { formatMoneyInput, parseMoney } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
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
  FilterBar,
  FormDrawer,
  LoadingState,
  PageHeader,
  SubmitButton,
  useListSearch,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useBlocker, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Library, Plus } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { productUi } from "../../product/product-ui"
import { missingOfficialCode, OfficialCodeField } from "../../components/official-code-field"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { RadioChips } from "../../components/ui/radio-chips"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
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

export const Route = createFileRoute("/_org/services/biblioteca")({
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

/** Fila de la tabla: el servicio con lo elegido y lo que le falta para guardarse. */
interface AddRow extends Draft {
  key: string
  /** Tipo de tratamiento de «Más usados» del que salió, si aplica. */
  concept: string | null
  /** Ya está en el tarifario de la clínica: no se elige otra vez. */
  owned: boolean
  nameIssue: string | null
  priceIssue: string | null
  /** El precio se marca como error: ya se intentó guardar o lo escrito no vale. */
  priceFlagged: boolean
  durationIssue: string | null
  ready: boolean
}

/** `listLabel`: el nombre corto de la lista del país («CPMS», «CIE-9-MC»), nunca su clave. */
function templateDraft(template: TreatmentTemplateItem, listLabel: string | null): Draft {
  const coding = template.codings[0]
  return {
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

function draftOf(row: AddRow): Draft {
  return {
    chosen: row.chosen,
    name: row.name,
    price: row.price,
    billingMode: row.billingMode,
    durationMin: row.durationMin,
    scope: row.scope,
    libraryName: row.libraryName,
    code: row.code,
  }
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

function toRow(
  key: string,
  draft: Draft,
  regional: Regional,
  extra: { concept: string | null; owned: boolean; attempted: boolean },
): AddRow {
  const price = checkPrice(draft.price, regional)
  const nameIssue = checkName(draft.name)
  const durationIssue = checkDuration(draft.durationMin).ok ? null : "Minutos entre 1 y 1440"
  const priceIssue =
    price.state === "empty" ? "Falta el precio" : price.state === "invalid" ? price.message : null
  return {
    ...draft,
    key,
    concept: extra.concept,
    owned: extra.owned,
    nameIssue,
    priceIssue,
    priceFlagged: price.state === "invalid" || (price.state === "empty" && extra.attempted),
    durationIssue,
    ready: price.state === "ok" && nameIssue === null && durationIssue === null,
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? error.message
  return error instanceof Error ? error.message : common.errors.generic
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
  const canIncorporate = usePermission("settings.write")
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
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  /** Tras un guardado, lo que quedó incompleto se marca como pendiente de corregir. */
  const [attempted, setAttempted] = useState(false)
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
  const rows = useMemo<AddRow[]>(() => {
    if (!regional) return []
    const inView = new Set(viewTemplates.map((entry) => entry.template.id))
    const list = viewTemplates.map(({ template, concept }) =>
      toRow(template.id, drafts[template.id] ?? templateDraft(template, codeList?.label ?? null), regional, {
        concept,
        owned: view === "biblioteca" && (owned?.has(template.id) ?? false),
        attempted,
      }),
    )
    // Lo elegido en otra vista sigue a la vista: lo que se va a guardar —y lo
    // que quedó incompleto— nunca se pierde de vista.
    for (const [key, draft] of Object.entries(drafts)) {
      if (inView.has(key)) continue
      if (draft.chosen) {
        list.push(toRow(key, draft, regional, { concept: null, owned: false, attempted }))
      }
    }
    return list
  }, [attempted, codeList, drafts, owned, regional, view, viewTemplates])

  /** Todo lo elegido, esté o no en la vista: es lo que cuenta y lo que se guarda. */
  const chosen = useMemo(
    () =>
      regional
        ? Object.entries(drafts)
            .filter(([, draft]) => draft.chosen)
            .map(([key, draft]) =>
              toRow(key, draft, regional, { concept: null, owned: false, attempted }),
            )
        : [],
    [attempted, drafts, regional],
  )
  const ready = chosen.filter((row) => row.ready)
  const missingPrice = chosen.filter((row) => row.price.trim() === "").length
  const toFix = chosen.length - ready.length - missingPrice
  const chosenCount = useRef(0)
  chosenCount.current = chosen.length
  const dirty = Object.values(drafts).some((draft) => draft.chosen)

  /** Aplica un cambio a la fila; elegir respeta el tope de un guardado. */
  const editRow = useCallback((row: AddRow, patch: Partial<Draft>) => {
    if (patch.chosen === true && !row.chosen && chosenCount.current >= MAX_SELECTION) {
      toast.info(`Guarda estos ${MAX_SELECTION} antes de elegir más`)
      return
    }
    setDrafts((previous) => ({
      ...previous,
      [row.key]: { ...(previous[row.key] ?? draftOf(row)), ...patch },
    }))
  }, [])

  const openOwn = useCallback(() => {
    setOwnSession((session) => session + 1)
    setOwnOpen(true)
  }, [])

  /**
   * «¿Cómo dice {receptionName} estos precios?»: una sola pregunta para todo lo que
   * se guarda, con «Precio exacto» marcado (decisión 5 de la fase 4). Después
   * se cambia en Servicios, uno por uno o varios a la vez.
   */
  const [disclosure, setDisclosure] = useState<PriceDisclosure>("exacto")
  const disclosureLabelId = useId()

  const saveMutation = useMutation({
    mutationFn: async (toSave: AddRow[]) => {
      if (!regional) throw new Error("Falta la moneda de la clínica")
      const items: QuickAddServiceBody[] = []
      for (const row of toSave) {
        const price = checkPrice(row.price, regional)
        const duration = checkDuration(row.durationMin)
        if (price.state !== "ok" || !duration.ok) continue
        items.push({
          kind: "template",
          templateId: row.key,
          name: row.name.trim(),
          priceCents: price.cents,
          billingMode: row.billingMode,
          durationMin: duration.minutes,
        })
      }
      const result = await quickAddServicesApi(items, disclosure)
      return { result, savedKeys: toSave.map((row) => row.key) }
    },
    onSuccess: async ({ result, savedKeys }) => {
      // Sale de la tabla solo lo guardado; lo incompleto se queda, marcado.
      const saved = new Set(savedKeys)
      const left = chosen.filter((row) => !saved.has(row.key)).length
      setDrafts((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !saved.has(key))),
      )
      setAttempted(left > 0)
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
      if (left > 0) {
        parts.push(left === 1 ? "queda 1 por completar en la tabla" : `quedan ${left} por completar en la tabla`)
      }
      toast.success(`${parts.join(" · ")}.`)
    },
    onError: (error) => {
      toast.error(errorMessage(error))
    },
  })
  const saving = saveMutation.isPending

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
      cell: ({ row }) => (
        <ServiceCell
          row={row.original}
          editable={canIncorporate}
          disabled={saving}
          onName={(name) => editRow(row.original, { name })}
        />
      ),
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
            onCheckedChange={(value) => editRow(row.original, { chosen: value === true })}
            aria-label={`Agregar ${row.original.name.trim() || "este servicio"}`}
          />
        ),
      },
      serviceColumn,
      {
        id: "cobro",
        header: "Se cobra",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.owned ? (
            <span className="text-muted-foreground">—</span>
          ) : row.original.chosen ? (
            <ChoiceSelect
              className="w-40"
              aria-label={`Cómo se cobra ${row.original.name.trim() || "este servicio"}`}
              disabled={saving}
              value={row.original.billingMode}
              onChange={(event) =>
                editRow(row.original, { billingMode: event.target.value as BillingMode })
              }
            >
              <option value="treatment">{BILLING_MODE_LABELS.treatment}</option>
              <option value="session">{BILLING_MODE_LABELS.session}</option>
            </ChoiceSelect>
          ) : (
            BILLING_MODE_LABELS[row.original.billingMode]
          ),
      },
      {
        id: "duracion",
        header: "Duración",
        // Principal: en teléfono también se pone la duración, junto al precio.
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.owned ? (
            <span className="text-muted-foreground">—</span>
          ) : row.original.chosen ? (
            <span className="inline-flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5">
                <Input
                  className="w-16"
                  inputMode="numeric"
                  aria-label={`Duración en minutos de ${row.original.name.trim() || "este servicio"}`}
                  aria-invalid={row.original.durationIssue !== null || undefined}
                  disabled={saving}
                  value={row.original.durationMin}
                  onChange={(event) => editRow(row.original, { durationMin: event.target.value })}
                />
                <span className="text-muted-foreground">min</span>
              </span>
              {row.original.durationIssue ? (
                <span className="text-xs text-destructive">{row.original.durationIssue}</span>
              ) : null}
            </span>
          ) : row.original.durationMin.trim() !== "" ? (
            `${row.original.durationMin.trim()} min`
          ) : (
            <span className="text-muted-foreground">Sin duración</span>
          ),
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
            <span className="flex flex-col gap-1">
              <Input
                className="w-28"
                inputMode="decimal"
                placeholder={pricePlaceholder}
                aria-label={
                  item.billingMode === "session"
                    ? `Precio por sesión de ${label}`
                    : `Precio de ${label}`
                }
                aria-invalid={(item.chosen && item.priceFlagged) || undefined}
                disabled={saving}
                value={item.price}
                onChange={(event) => {
                  const price = event.target.value
                  // Poner el precio ya es elegirlo: no hace falta marcar antes la casilla.
                  editRow(item, price.trim() !== "" && !item.chosen ? { price, chosen: true } : { price })
                }}
              />
              {item.chosen && item.priceIssue ? (
                <span
                  className={cn(
                    "text-xs",
                    item.priceFlagged ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {item.priceIssue}
                </span>
              ) : null}
            </span>
          )
        },
      },
    ]
  }, [canIncorporate, editRow, priceHeader, pricePlaceholder, saving])

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

  const title = canIncorporate ? "Agregar servicios" : "Biblioteca de procedimientos"
  const subtitle = canIncorporate
    ? "Elige de la biblioteca o crea los tuyos, y pon el precio aquí mismo. Lo que guardes queda activo."
    : "Lo que la clínica puede agregar a sus servicios. Los agrega quien administra la clínica."

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

  const body = !regional ? null : activeQuery.isPending ? (
    <LoadingState />
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
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title={title}
        subtitle={subtitle}
        primary={canIncorporate && regional ? { label: "Crear un servicio propio", icon: <Plus aria-hidden />, onClick: openOwn } : undefined}
      />
      {profileQuery.isPending ? (
        <LoadingState />
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
                <div className="flex min-w-0 basis-full flex-col gap-1.5">
                  <span id={disclosureLabelId} className="text-sm font-medium">
                    ¿Cómo dice {receptionName} estos precios?
                  </span>
                  <RadioChips
                    value={disclosure}
                    options={PRICE_DISCLOSURE_OPTIONS}
                    onChange={setDisclosure}
                    labelledBy={disclosureLabelId}
                    disabled={saving}
                  />
                </div>
              ) : null}
              <p className="hidden min-w-0 flex-1 basis-56 text-xs text-muted-foreground sm:block">
                {codeList
                  ? `El nombre es el que verán caja y el paciente; se puede cambiar. El ${codeList.codeName} se conserva.`
                  : "El nombre es el que verán caja y el paciente; se puede cambiar."}
              </p>
              <p className="text-sm font-medium" role="status">
                {ready.length === 1 ? "1 listo" : `${ready.length} listos`}
                {missingPrice > 0 ? ` · ${missingPrice} sin precio` : ""}
                {toFix > 0 ? ` · ${toFix} por corregir` : ""}
              </p>
              <SubmitButton
                type="button"
                className="min-h-11"
                disabled={ready.length === 0}
                pending={saving}
                onClick={() => saveMutation.mutate(ready)}
              >
                {`Guardar y activar ${ready.length}`}
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

/** Nombre que usará la clínica (editable al elegirlo) y de qué servicio se trata. */
function ServiceCell({
  row,
  editable,
  disabled,
  onName,
}: {
  row: AddRow
  /** Quien administra el tarifario cambia el nombre de lo que elige. */
  editable: boolean
  /** Guardando: el campo se conserva, sin aceptar cambios. */
  disabled: boolean
  onName: (name: string) => void
}) {
  const official = [row.concept, row.code].filter(Boolean).join(" · ")
  return (
    // `whitespace-normal` y tope de ancho: las celdas son `nowrap` y una
    // denominación oficial larga empujaría el precio fuera de la pantalla.
    <span className="flex min-w-48 max-w-xl flex-col gap-1 whitespace-normal">
      {row.chosen && editable ? (
        <>
          <Input
            className="w-full min-w-48"
            aria-label={`Nombre que usará la clínica para ${row.libraryName}`}
            aria-invalid={row.nameIssue !== null || undefined}
            maxLength={200}
            disabled={disabled}
            value={row.name}
            onChange={(event) => onName(event.target.value)}
          />
          {row.nameIssue ? <span className="text-xs text-destructive">{row.nameIssue}</span> : null}
        </>
      ) : (
        <span className="font-medium break-words">{row.name}</span>
      )}
      {official ? (
        <span className="text-xs font-normal break-words text-muted-foreground">{official}</span>
      ) : null}
    </span>
  )
}

const BILLING_OPTIONS: ReadonlyArray<{ value: BillingMode; label: string }> = [
  { value: "treatment", label: BILLING_MODE_LABELS.treatment },
  { value: "session", label: BILLING_MODE_LABELS.session },
]

/* ----------------------------- Servicio propio ----------------------------- */

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
  const [name, setName] = useState("")
  // La especialidad de la clínica (una sola lista, ADR 0039).
  const [specialtyId, setSpecialtyId] = useState("")
  const specialtiesQuery = useClinicSpecialties({ activeOnly: true, enabled: open })
  const [scope, setScope] = useState<string>("general")
  const [billingMode, setBillingMode] = useState<BillingMode>("treatment")
  const [price, setPrice] = useState("")
  const [durationMin, setDurationMin] = useState("")
  // Lo tratado queda dibujado: lo que deja en la pieza al completarse.
  const [leavesCondition, setLeavesCondition] = useState("")
  const [leavesVariant, setLeavesVariant] = useState("")
  // Lo que el servicio deja al completarse, si el producto lo registra (odentIA: «Deja en la pieza»).
  const leaves = productUi().services.leaves
  // El código de la lista del país (tablero 3): obligatorio, opcional o sin campo.
  const codeList = useClinicalProfile().services
  const [officialCode, setOfficialCode] = useState<OfficialCoding | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const nameIssue = checkName(name)
  const specialtyIssue = specialtyId ? null : "Elige la especialidad"
  const codeIssue = missingOfficialCode(codeList, officialCode)
  const priceCheck = checkPrice(price, regional)
  const priceIssue =
    priceCheck.state === "invalid"
      ? priceCheck.message
      : priceCheck.state === "empty" && submitted
        ? "Pon el precio (0 si no tiene costo)"
        : null
  const duration = checkDuration(durationMin)
  const durationIssue = duration.ok ? null : "Minutos enteros entre 1 y 1440"
  const isDirty =
    name !== "" ||
    specialtyId !== "" ||
    scope !== "general" ||
    billingMode !== "treatment" ||
    price !== "" ||
    durationMin !== "" ||
    leavesCondition !== "" ||
    officialCode !== null

  const saveMutation = useMutation({
    mutationFn: (priceCents: number) =>
      createServiceApi({
        name: name.trim(),
        specialtyId,
        scope,
        priceCents,
        billingMode,
        durationMin: duration.minutes,
        leavesFinding: leaves?.body(leavesCondition, leavesVariant) ?? null,
        officialCode: officialCode?.code ?? null,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success(`«${result.data.name}» ya está activo entre tus servicios`)
      onClose()
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (nameIssue || specialtyIssue || codeIssue || durationIssue || priceCheck.state !== "ok") return
    saveMutation.mutate(priceCheck.cents)
  }

  return (
    <FormDrawer
      open={open}
      title="Servicio propio"
      description="Lo que tu clínica ofrece y la biblioteca no trae. Queda activo al guardarlo."
      error={saveMutation.isError ? errorMessage(saveMutation.error) : null}
      isDirty={isDirty}
      isSubmitting={saveMutation.isPending}
      submitLabel="Guardar y activar"
      onClose={onClose}
      onSubmit={submit}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-nombre`}>Nombre</FieldLabel>
          <Input
            id={`${id}-nombre`}
            value={name}
            maxLength={200}
            aria-invalid={(submitted && nameIssue !== null) || undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {submitted && nameIssue ? <FieldError>{nameIssue}</FieldError> : null}
        </Field>
        <OfficialCodeField
          value={officialCode}
          onChange={setOfficialCode}
          error={submitted ? codeIssue : null}
        />
        <Field>
          <FieldLabel htmlFor={`${id}-especialidad`}>Especialidad</FieldLabel>
          <ChoiceSelect
            id={`${id}-especialidad`}
            value={specialtyId}
            placeholder={specialtiesQuery.isPending ? "Cargando…" : "Elige la especialidad"}
            disabled={specialtiesQuery.isPending}
            aria-invalid={(submitted && specialtyIssue !== null) || undefined}
            onChange={(event) => setSpecialtyId(event.target.value)}
          >
            {(specialtiesQuery.data?.data ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </ChoiceSelect>
          {submitted && specialtyIssue ? <FieldError>{specialtyIssue}</FieldError> : null}
        </Field>
        {/* Sin «dónde» (latidIA, decisión 4 del issue 229), todo servicio es general. */}
        {productUi().site ? (
          <Field>
            <span id={`${id}-donde`} className="text-sm font-medium">
              Dónde se hace
            </span>
            <RadioChips
              labelledBy={`${id}-donde`}
              value={scope}
              options={SERVICE_PLACE_OPTIONS}
              onChange={(next) => {
                setScope(next)
                // Lo que deja en la pieza depende de dónde se hace.
                setLeavesCondition("")
                setLeavesVariant("")
              }}
            />
            <p className="text-xs text-muted-foreground">
              Así la atención sabe qué pedir al registrarlo.
            </p>
          </Field>
        ) : null}
        {leaves ? (
          <leaves.Field
            idPrefix={id}
            scope={scope}
            condition={leavesCondition}
            variant={leavesVariant}
            onChange={(nextCondition, nextVariant) => {
              setLeavesCondition(nextCondition)
              setLeavesVariant(nextVariant)
            }}
          />
        ) : null}
        <Field>
          <span id={`${id}-cobro`} className="text-sm font-medium">
            Cómo se cobra
          </span>
          <RadioChips
            labelledBy={`${id}-cobro`}
            value={billingMode}
            options={BILLING_OPTIONS}
            onChange={setBillingMode}
          />
          <p className="text-xs text-muted-foreground">
            Por sesión: se cobra el precio en cada visita atendida.
          </p>
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-precio`}>
              {billingMode === "session" ? "Precio por sesión" : "Precio"}
            </FieldLabel>
            <InputGroup>
              <InputGroupAddon align="inline-start">
                <InputGroupText>{currencySymbol(regional.currency, regional.locale)}</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id={`${id}-precio`}
                inputMode="decimal"
                placeholder={formatMoneyInput(0, regional.currency, regional.locale)}
                aria-invalid={priceIssue !== null || undefined}
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </InputGroup>
            {priceIssue ? (
              <FieldError>{priceIssue}</FieldError>
            ) : (
              <p className="text-xs text-muted-foreground">Usa 0 si no tiene costo.</p>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-duracion`}>Duración</FieldLabel>
            <InputGroup>
              <InputGroupInput
                id={`${id}-duracion`}
                inputMode="numeric"
                aria-invalid={durationIssue !== null || undefined}
                value={durationMin}
                onChange={(event) => setDurationMin(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>min</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            {durationIssue ? <FieldError>{durationIssue}</FieldError> : null}
          </Field>
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
  const blocker = useBlocker({
    disabled: !dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
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
