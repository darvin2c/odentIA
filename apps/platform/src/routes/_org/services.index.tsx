import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldError as UiFieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DataTable,
  DetailDrawer,
  DetailField,
  DetailList,
  DetailPanel,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  FormPanel,
  fieldErrorMessages,
  LoadingState,
  MasterDetail,
  PageHeader,
  RowActions,
  useDetailMode,
  useListSearch,
} from "@odentia/ui-patterns"
import { useForm, useStore } from "@tanstack/react-form"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ChevronDown, Plus, Tag } from "lucide-react"
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { conditionLabel, formatMoney, formatMoneyInput, parseMoney, variantLabel } from "@odentia/clinical"
import { LeavesFindingField, leavesFindingBody } from "../../components/leaves-finding-field"
import { capitalize, missingOfficialCode, OfficialCodeField } from "../../components/official-code-field"
import {
  ServiceMaterialsCost,
  ServiceMaterialsEditor,
  ServiceMaterialsReadOnly,
  ServicesWithoutMaterialsCard,
} from "../../components/service-materials"
import { ServiceSelect } from "../../components/service-select"
import { RadioChips } from "../../components/ui/radio-chips"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { useClinicSpecialties } from "../../lib/clinical-forms"
import { useCan, usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  draftLineOf,
  type MaterialDraftLine,
  materialsChanged,
  materialsToSave,
} from "../../lib/materials"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import { PageDraftGuard } from "../../lib/page-draft-guard"
import {
  BILLING_MODE_LABELS,
  type BillingMode,
  MATERIAL_QUANTITY_MAX,
  PRICE_DISCLOSURE_BATCH,
  PRICE_DISCLOSURE_OPTIONS,
  PRICE_DISCLOSURE_TAG,
  type PriceDisclosure,
  createServiceApi,
  setServicesPriceDisclosureApi,
  fetchService,
  fetchServiceMaterials,
  fetchServices,
  fetchTreatmentTemplate,
  type OfficialCoding,
  saveServiceMaterialsApi,
  type ServiceCatalogItem,
  SERVICE_PLACE_OPTIONS,
  TREATMENT_SCOPE_LABELS,
  type TreatmentTemplateItem,
  updateServiceApi,
} from "../../lib/services"

/** Muestra el primer mensaje de validación de TanStack Form. */
function FieldError({ errors }: { errors: unknown }) {
  return <UiFieldError>{fieldErrorMessages(errors)[0]}</UiFieldError>
}

export const Route = createFileRoute("/_org/services/")({
  /** Los filtros los lee `useListSearch`; aquí solo se tipa la especialidad para los enlaces (Especialidades abre la lista filtrada). */
  validateSearch: (search: Record<string, unknown>): { especialidad?: string } => ({
    ...search,
    especialidad: typeof search.especialidad === "string" ? search.especialidad : undefined,
  }),
  component: TarifarioPage,
})

const orgRouteApi = getRouteApi("/_org")

const STATE_OPTIONS = [
  { value: "active", label: "Activas" },
  { value: "inactive", label: "Inactivas" },
]

const TARIFARIO_SORT_OPTIONS = [
  { value: "nombre", label: "Nombre" },
  { value: "precio", label: "Precio" },
  { value: "ambito", label: "Ámbito" },
]

const BILLING_OPTIONS: ReadonlyArray<{ value: BillingMode; label: string }> = [
  { value: "treatment", label: BILLING_MODE_LABELS.treatment },
  { value: "session", label: BILLING_MODE_LABELS.session },
]

function stateLabel(state: string): string {
  return STATE_OPTIONS.find((o) => o.value === state)?.label ?? state
}

/* ------------------------------- Tarifario -------------------------------- */

/** Servicios por página del tarifario: el resto llega con «Cargar más». */
const TARIFARIO_PAGE = 100

/** Oferta abierta en la superficie lateral del tarifario, o el alta de una nueva. */
/** `materiales`: se abrió desde «Empieza por estos 5» y la sección de materiales se muestra sola. */
type EditorTarget = { kind: "offer"; id: string; focus?: "materiales" } | { kind: "create" }

/**
 * Tarifario de la clínica: listado agrupado por especialidad con el detalle al
 * costado (`MasterDetail`). El panel deja la lista a la vista mientras se edita
 * la tarifa; por debajo del corte, ese mismo formulario se abre como drawer.
 */
function TarifarioPage() {
  const receptionName = useReceptionName()
  const { org } = orgRouteApi.useRouteContext()
  const canManage = usePermission("settings.write")
  const canViewTariff =
    canManage ||
    usePermission("catalog.read") ||
    usePermission("clinical.read") ||
    usePermission("appointments.read") ||
    usePermission("finance.read")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const specialtyFilter = listSearch.get("especialidad") ?? "todas"
  const estadoFilter = listSearch.get("estado") ?? "active"
  const sortParam = listSearch.get("sort") ?? ""
  const mode = useDetailMode()
  // Materiales de cada servicio (ADR 0067): los ve quien ve Inventario y los
  // configura quien lo lleva. La API decide qué llega en cada fila.
  const can = useCan()
  const seesMaterials = can("inventory.read") || can("inventory.stock")
  const canWriteMaterials = can("inventory.write")
  /** Moneda y formato de la clínica: los importes se leen con su locale. */
  const profileQuery = useOrgProfile()
  const profileLocale = profileQuery.data?.locale
  const profileCurrency = profileQuery.data?.currency
  const [target, setTarget] = useState<EditorTarget | null>(null)
  /** Un servicio abierto desde «Empieza por estos 5» que la lista cargada no trae (otra página u otro filtro). */
  const [extraOffer, setExtraOffer] = useState<ServiceCatalogItem | null>(null)
  /** Se cierra sin desmontar: el drawer necesita su salida y `MasterDetail` su colapso. */
  const [surfaceOpen, setSurfaceOpen] = useState(false)
  const [toggling, setToggling] = useState<ServiceCatalogItem | null>(null)
  /**
   * Servicios elegidos para cambiar a la vez «Cómo dice el precio» (decisión 5
   * de la fase 4). Un filtro nuevo empieza sin nada elegido: lo elegido que
   * deja de verse no se cambia a ciegas.
   */
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => {
    setSelected([])
  }, [search, specialtyFilter, estadoFilter])

  // Las especialidades de la clínica: el filtro y el formulario usan la misma lista (ADR 0039).
  const specialtiesQuery = useClinicSpecialties({ enabled: canViewTariff })
  const specialties = useMemo(() => specialtiesQuery.data?.data ?? [], [specialtiesQuery.data])
  const specialtyOptions = useMemo(
    () => [
      { value: "todas", label: "Todas" },
      ...specialties.map((item) => ({ value: item.id, label: item.name })),
    ],
    [specialties],
  )

  // El tarifario entero, por páginas y con su total: nunca un tope mudo (tope B1 de la fase 4).
  const pagesQuery = useInfiniteQuery({
    queryKey: ["services", "tarifario", search, specialtyFilter, estadoFilter],
    enabled: canViewTariff,
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchServices({
        q: search.trim() || undefined,
        specialtyId: specialtyFilter === "todas" ? undefined : specialtyFilter,
        state: estadoFilter === "inactive" ? "inactive" : "active",
        limit: TARIFARIO_PAGE,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })

  const rows = useMemo(() => (pagesQuery.data?.pages ?? []).flatMap((page) => page.data), [pagesQuery.data])
  const total = pagesQuery.data?.pages[0]?.total ?? 0
  /**
   * Fila vigente de la oferta abierta: si el filtro la deja fuera, no hay
   * detalle, salvo la que se abrió desde «Empieza por estos 5».
   */
  const editing =
    target?.kind === "offer"
      ? (rows.find((row) => row.id === target.id) ?? (extraOffer?.id === target.id ? extraOffer : null))
      : null

  const sortedRows = useMemo(() => {
    if (!sortParam) return rows
    const desc = sortParam.startsWith("-")
    const field = desc ? sortParam.slice(1) : sortParam
    const factor = desc ? -1 : 1
    return [...rows].sort((a, b) => {
      if (field === "precio") {
        return (a.priceCents - b.priceCents) * factor
      }
      if (field === "ambito") {
        const scopeA = a.scope ? (TREATMENT_SCOPE_LABELS[a.scope] ?? a.scope) : ""
        const scopeB = b.scope ? (TREATMENT_SCOPE_LABELS[b.scope] ?? b.scope) : ""
        return scopeA.localeCompare(scopeB, "es") * factor
      }
      return a.name.localeCompare(b.name, "es") * factor
    })
  }, [rows, sortParam])

  // Agrupado por la especialidad de la clínica, con su nombre.
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: ServiceCatalogItem[] }>()
    for (const row of sortedRows) {
      const key = row.specialtyId ?? "sin-especialidad"
      const group = map.get(key) ?? { label: row.specialtyName ?? "Sin especialidad", rows: [] }
      group.rows.push(row)
      map.set(key, group)
    }
    return [...map.entries()].sort(([, x], [, y]) => x.label.localeCompare(y.label, "es"))
  }, [sortedRows])
  /** «Código interno» solo es columna si la clínica usa alguno (decisión 4 del lienzo del issue 40). */
  const usesInternalCode = rows.some((row) => row.code)

  const disclosureMutation = useMutation({
    mutationFn: (priceDisclosure: PriceDisclosure) => setServicesPriceDisclosureApi(selected, priceDisclosure),
    onSuccess: async (result, priceDisclosure) => {
      const label = PRICE_DISCLOSURE_OPTIONS.find((option) => option.value === priceDisclosure)?.label ?? priceDisclosure
      const updated = result.data.updated
      setSelected([])
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success(
        updated === 1
          ? `Listo: ${receptionName} dice ese precio como «${label}».`
          : `Listo: ${receptionName} dice esos ${updated} precios como «${label}».`,
      )
    },
    onError: (error) => {
      // Lo elegido se conserva para volver a intentarlo.
      toast.error(error instanceof ApiError ? (error.shape.message ?? error.message) : error.message)
    },
  })

  const toggleMutation = useMutation({
    mutationFn: (service: ServiceCatalogItem) =>
      updateServiceApi(service.id, { isActive: !service.isActive }),
    onSuccess: async () => {
      setToggling(null)
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success("Estado actualizado")
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  /** Abre la superficie sobre una oferta; `null` es el alta de una prestación propia. */
  const openOffer = useCallback((offer: ServiceCatalogItem | null, focus?: "materiales") => {
    setTarget(offer ? { kind: "offer", id: offer.id, focus } : { kind: "create" })
    setSurfaceOpen(true)
  }, [])

  /** Cierra sin desmontar: `MasterDetail` colapsa la columna y el drawer anima su salida. */
  const closeOffer = useCallback(() => setSurfaceOpen(false), [])

  /** Abre un servicio por su id («Empieza por estos 5»): el de la lista, o lo pide si no está cargado. */
  const openOfferById = useCallback(
    async (serviceId: string) => {
      const loaded = rows.find((row) => row.id === serviceId)
      if (loaded) {
        openOffer(loaded, "materiales")
        return
      }
      try {
        const found = await queryClient.fetchQuery({
          queryKey: ["services", "one", serviceId],
          queryFn: () => fetchService(serviceId),
          staleTime: 30_000,
        })
        setExtraOffer(found.data)
        openOffer(found.data, "materiales")
      } catch (error) {
        toast.error(financeErrorMessage(error))
      }
    },
    [rows, openOffer, queryClient],
  )

  const columns = useMemo<ColumnDef<ServiceCatalogItem>[]>(
    () => [
      ...(canManage
        ? [
            {
              id: "select",
              // La casilla de la cabecera elige los de su especialidad (cada grupo es su tabla).
              header: ({ table }) => {
                const ids = table.getCoreRowModel().rows.map((row) => row.original.id)
                const all = ids.length > 0 && ids.every((id) => selected.includes(id))
                return (
                  <Checkbox
                    checked={all}
                    onCheckedChange={(value) =>
                      setSelected((previous) =>
                        value === true
                          ? [...new Set([...previous, ...ids])].slice(0, PRICE_DISCLOSURE_BATCH)
                          : previous.filter((id) => !ids.includes(id)),
                      )
                    }
                    aria-label="Elegir todos los servicios de este grupo"
                  />
                )
              },
              meta: { view: { role: "select" } },
              cell: ({ row }) => (
                <Checkbox
                  checked={selected.includes(row.original.id)}
                  onCheckedChange={() =>
                    setSelected((previous) =>
                      previous.includes(row.original.id)
                        ? previous.filter((id) => id !== row.original.id)
                        : previous.length >= PRICE_DISCLOSURE_BATCH
                          ? previous
                          : [...previous, row.original.id],
                    )
                  }
                  aria-label={`Elegir ${row.original.name}`}
                />
              ),
            } satisfies ColumnDef<ServiceCatalogItem>,
          ]
        : []),
      {
        accessorKey: "name",
        header: "Servicio",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          // `whitespace-normal` y tope de ancho: las celdas del registry son
          // `nowrap`, así que un nombre largo (o su procedencia) ensancharía la
          // tabla y empujaría precio y estado fuera del panel.
          <span className="flex min-w-0 max-w-72 flex-col whitespace-normal">
            <span className="font-medium break-words">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.source === "template" ? "De la biblioteca" : "Propio de la clínica"}
            </span>
          </span>
        ),
      },
      ...(usesInternalCode
        ? [
            {
              accessorKey: "code",
              header: "Código interno",
              meta: { view: { primary: true } },
              cell: ({ row }) =>
                row.original.code ? (
                  <span className="font-mono">{row.original.code}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                ),
            } satisfies ColumnDef<ServiceCatalogItem>,
          ]
        : []),
      {
        accessorKey: "scope",
        header: "Ámbito",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          row.original.scope
            ? (TREATMENT_SCOPE_LABELS[row.original.scope] ?? row.original.scope)
            : "—",
      },
      {
        accessorKey: "priceCents",
        header: "Precio",
        meta: { view: { primary: true } },
        cell: ({ row }) =>
          profileLocale === undefined ? (
            <Skeleton className="h-4 w-16" />
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {formatMoney(row.original.priceCents, row.original.currency, profileLocale)}
              {PRICE_DISCLOSURE_TAG[row.original.priceDisclosure] ? (
                <Badge variant="secondary">{PRICE_DISCLOSURE_TAG[row.original.priceDisclosure]}</Badge>
              ) : null}
            </span>
          ),
      },
      {
        accessorKey: "billingMode",
        header: "Se cobra",
        meta: { view: { primary: true } },
        cell: ({ row }) => BILLING_MODE_LABELS[row.original.billingMode],
      },
      // «3 · S/ 2.18» o «Sin materiales»: solo para quien ve Inventario (el
      // costo, solo con precios; lo decide la API al entregar la fila).
      ...(seesMaterials
        ? [
            {
              id: "materials",
              header: "Materiales",
              meta: { view: { primary: true } },
              cell: ({ row }) => {
                const materials = row.original.materials
                if (!materials || materials.count === 0)
                  return <span className="text-muted-foreground">Sin materiales</span>
                return (
                  <span className="tabular-nums">
                    {materials.count}
                    {materials.cost && profileLocale !== undefined
                      ? ` · ${formatMoney(materials.cost.cents, materials.cost.currency, profileLocale)}`
                      : ""}
                  </span>
                )
              },
            } satisfies ColumnDef<ServiceCatalogItem>,
          ]
        : []),
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canManage ? (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[
                {
                  key: "edit",
                  label: "Ver y editar",
                  onSelect: () => openOffer(row.original),
                },
                row.original.isActive
                  ? {
                      key: "deactivate",
                      label: "Desactivar",
                      tone: "danger" as const,
                      onSelect: () => setToggling(row.original),
                    }
                  : {
                      key: "reactivate",
                      label: "Reactivar",
                      onSelect: () => setToggling(row.original),
                    },
              ]}
            />
          ) : null,
      },
    ],
    [canManage, openOffer, profileLocale, selected, seesMaterials, usesInternalCode],
  )

  const hasFilters = search.trim() !== "" || specialtyFilter !== "todas" || sortParam !== ""

  /**
   * Un solo contenedor para el alta y la edición: `OfferEditor` decide panel o
   * drawer con `asPanel`, y monta el detalle de lectura para quien no escribe.
   * La `key` remonta el formulario al cambiar de oferta (estado y errores
   * propios de cada una).
   */
  const profileReady = profileLocale !== undefined && profileCurrency !== undefined
  const editor =
    !profileReady ? (
      <DetailPanel
        title="Servicios y precios"
        headerContent={null}
        onClose={closeOffer}
      >
        {profileQuery.isError ? (
          <ErrorState
            message="No se pudo cargar la configuración regional"
            onRetry={() => void profileQuery.refetch()}
          />
        ) : (
          <LoadingState />
        )}
      </DetailPanel>
    ) : target?.kind === "create" ? (
      <OfferEditor
        key="alta"
        offer={null}
        asPanel={mode === "panel"}
        open={surfaceOpen}
        canWrite={canManage}
        onClose={closeOffer}
        orgCurrency={profileCurrency}
        orgLocale={profileLocale}
      />
    ) : editing ? (
      <OfferEditor
        key={editing.id}
        offer={editing}
        revealMaterials={target?.kind === "offer" && target.focus === "materiales"}
        asPanel={mode === "panel"}
        open={surfaceOpen}
        canWrite={canManage}
        onClose={closeOffer}
        orgCurrency={profileCurrency}
        orgLocale={profileLocale}
      />
    ) : null
  const editorVisible = surfaceOpen && editor !== null
  const activeOfferId = editorVisible && target?.kind === "offer" ? target.id : null

  if (!canViewTariff) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Servicios y precios" subtitle={org.name} />
        <EmptyState
          title="Sin acceso"
          description="Necesitas permiso clínico, de agenda, de caja o de configuración para ver los servicios y sus precios."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <MasterDetail
        listScroll="page"
        panelSize="lg"
        panel={mode === "panel" && editorVisible ? editor : null}
      >
        <PageHeader
          title="Servicios y precios"
          subtitle={`${org.name} · lo que ofrece la clínica y cuánto cuesta`}
          actions={
            canManage ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => openOffer(null)}
                >
                  Crear un servicio propio
                </Button>
                <Button
                  type="button"
                  className="min-h-11"
                  onClick={() => void navigate({ to: "/services/biblioteca" })}
                >
                  <Plus aria-hidden />
                  Agregar servicios
                </Button>
              </>
            ) : undefined
          }
        />
        {canWriteMaterials && profileLocale !== undefined ? (
          <ServicesWithoutMaterialsCard locale={profileLocale} onOpen={(id) => void openOfferById(id)} />
        ) : null}
        <FilterBar
          filters={[
            {
              key: "especialidad",
              label: "Especialidad",
              type: "select",
              options: specialtyOptions,
            },
            { key: "estado", label: "Estado", type: "select", options: STATE_OPTIONS },
          ]}
          sortOptions={TARIFARIO_SORT_OPTIONS}
          searchPlaceholder="Buscar por nombre o código interno" searchLabel="Buscar en servicios"
        />

        {pagesQuery.isPending ? (
          <LoadingState />
        ) : pagesQuery.isError ? (
          <ErrorState
            error={pagesQuery.error instanceof ApiError ? pagesQuery.error.shape : null}
            onRetry={() => void pagesQuery.refetch()}
          />
        ) : rows.length === 0 && !hasFilters && estadoFilter === "active" ? (
          <EmptyState
            icon={Tag}
            title="Aún no tienes servicios"
            description={
              canManage
                ? "Elige los servicios más usados o crea los tuyos, y ponles precio en una sola pantalla. Lo que guardes queda activo."
                : "Todavía no hay servicios con precio. Los agrega quien administra la clínica."
            }
            actionLabel={canManage ? "Agregar servicios" : undefined}
            onAction={
              canManage ? () => void navigate({ to: "/services/biblioteca" }) : undefined
            }
            secondaryActionLabel={canManage ? "Crear un servicio propio" : undefined}
            onSecondaryAction={canManage ? () => openOffer(null) : undefined}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Tag}
            title="Sin resultados"
            description={`Ninguna prestación ${stateLabel(estadoFilter).toLowerCase()} coincide con la búsqueda.`}
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-6">
            {groups.map(([key, group]) => (
              <section key={key} aria-label={group.label}>
                <h3 className="mb-2 text-sm font-semibold">{group.label}</h3>
                <GroupTable
                  rows={group.rows}
                  columns={columns}
                  onSelect={(offer) => openOffer(offer)}
                  activeId={activeOfferId}
                />
              </section>
            ))}
            {pagesQuery.isFetchNextPageError ? (
              <p role="alert" className="text-sm text-destructive">
                No se pudieron cargar más servicios; se conservan los cargados.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground" role="status">
                {`Mostrando ${rows.length} de ${total} ${total === 1 ? "servicio" : "servicios"}`}
              </p>
              {pagesQuery.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-8"
                  disabled={pagesQuery.isFetchingNextPage}
                  onClick={() => void pagesQuery.fetchNextPage()}
                >
                  {pagesQuery.isFetchingNextPage ? "Cargando…" : "Cargar más"}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </MasterDetail>

      {canManage && selected.length > 0 ? (
        <div
          role="region"
          aria-label="Servicios elegidos"
          // Fija al pie, como la barra de «Agregar servicios»: encima de la barra de secciones en teléfono.
          className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-md border border-border bg-card p-3 shadow-sm lg:bottom-0"
        >
          <p className="text-sm font-medium" role="status">
            {selected.length === 1 ? "1 seleccionado" : `${selected.length} seleccionados`}
            {selected.length >= PRICE_DISCLOSURE_BATCH ? ` · como mucho ${PRICE_DISCLOSURE_BATCH} a la vez` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value=""
              disabled={disclosureMutation.isPending}
              onValueChange={(value) => disclosureMutation.mutate(value as PriceDisclosure)}
            >
              <SelectTrigger className="min-h-11 w-auto" aria-label={`Cómo dice el precio ${receptionName}`}>
                <SelectValue placeholder="Cómo dice el precio" />
              </SelectTrigger>
              <SelectContent>
                {PRICE_DISCLOSURE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={disclosureMutation.isPending}
              onClick={() => setSelected([])}
            >
              Quitar la selección
            </Button>
          </div>
        </div>
      ) : null}

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? editor : null}

      <ConfirmDialog
        open={toggling !== null}
        onClose={() => setToggling(null)}
        title={toggling?.isActive ? "Desactivar prestación" : "Reactivar prestación"}
        description={
          toggling?.isActive
            ? `«${toggling?.name}» dejará de estar disponible para nuevas indicaciones. Los registros históricos no cambian.`
            : `«${toggling?.name}» volverá a estar disponible para nuevas indicaciones.`
        }
        confirmLabel={toggling?.isActive ? "Desactivar" : "Reactivar"}
        variant={toggling?.isActive ? "destructive" : "default"}
        onConfirm={() => {
          if (toggling) toggleMutation.mutate(toggling)
        }}
        pending={toggleMutation.isPending}
      />
    </div>
  )
}

function GroupTable({
  rows,
  columns,
  onSelect,
  activeId,
}: {
  rows: ServiceCatalogItem[]
  columns: ColumnDef<ServiceCatalogItem>[]
  onSelect: (row: ServiceCatalogItem) => void
  /** Oferta abierta en el detalle: la fila se marca mientras el panel está al costado. */
  activeId: string | null
}) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <DataTable table={table} onRowClick={onSelect} isRowActive={(row) => row.id === activeId} />
  )
}

/* ----------------------------- Detalle / edición --------------------------- */

const offerSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre").max(200, "Máximo 200 caracteres"),
  code: z.string().max(40, "Máximo 40 caracteres"),
  price: z
    .string()
    .refine((value) => value.trim() !== "", {
      message: "Indica el precio (usa 0 si va incluido sin costo)",
    })
    .refine((value) => /^\d+([.,]\d+)?$/.test(value.trim()), {
      message: "Precio inválido: usa números",
    }),
  durationMin: z.string().refine(
    (value) => {
      if (value.trim() === "") return true
      const n = Number(value)
      return Number.isInteger(n) && n >= 1 && n <= 1440
    },
    { message: "Duración: minutos enteros entre 1 y 1440" },
  ),
  specialtyId: z.string().min(1, "Elige la especialidad"),
  scope: z.string().min(1, "Elige el ámbito"),
  billingMode: z.enum(["treatment", "session"]),
  priceDisclosure: z.enum(["exacto", "desde", "evaluacion"]),
  /** Vacío: sin una evaluación propia. */
  evaluationServiceId: z.string(),
  /** Lo que deja en la pieza al completarse; vacío = nada. */
  leavesCondition: z.string(),
  leavesVariant: z.string(),
})

type OfferFormValues = z.infer<typeof offerSchema>

const emptyOfferValues: OfferFormValues = {
  name: "",
  code: "",
  price: "",
  durationMin: "",
  specialtyId: "",
  scope: "",
  billingMode: "treatment",
  // Un servicio nuevo nace «solo con evaluación»: la clínica habilita el precio donde quiera.
  priceDisclosure: "evaluacion",
  evaluationServiceId: "",
  leavesCondition: "",
  leavesVariant: "",
}

/** Valores del formulario para una oferta; `null` = alta de una prestación propia. */
function offerValues(offer: ServiceCatalogItem | null, locale: string): OfferFormValues {
  if (!offer) return emptyOfferValues
  return {
    name: offer.name,
    code: offer.code ?? "",
    price: formatMoneyInput(offer.priceCents, offer.currency, locale),
    durationMin: offer.durationMin === null ? "" : String(offer.durationMin),
    specialtyId: offer.specialtyId ?? "",
    scope: offer.scope ?? "",
    billingMode: offer.billingMode ?? "treatment",
    priceDisclosure: offer.priceDisclosure ?? "exacto",
    evaluationServiceId: offer.evaluationServiceId ?? "",
    leavesCondition: offer.leavesFinding?.condition ?? "",
    leavesVariant: offer.leavesFinding?.variant ?? "",
  }
}

/**
 * Formulario de la oferta. Cada apertura arranca prístina: `reset()` sin
 * valores limpia touched y errores, y el render siguiente carga los valores por
 * defecto de la oferta abierta (el panel no se desmonta al cerrar).
 */
function useOfferForm(
  offer: ServiceCatalogItem | null,
  open: boolean,
  onSubmit: (value: OfferFormValues) => Promise<void>,
  locale: string,
) {
  const form = useForm({
    defaultValues: offerValues(offer, locale),
    validators: { onSubmit: offerSchema },
    onSubmit: async ({ value }) => {
      await onSubmit(value)
    },
  })

  useEffect(() => {
    if (open) form.reset()
  }, [open, form])

  return form
}
type OfferForm = ReturnType<typeof useOfferForm>

function sourceLabel(offer: ServiceCatalogItem): string {
  return offer.source === "custom" ? "Propio de la clínica" : "De la biblioteca"
}

interface OfferEditorProps {
  /** Oferta editada; `null` es el alta de una prestación propia. */
  offer: ServiceCatalogItem | null
  /** Columna de `MasterDetail` en pantalla ancha; drawer modal por debajo del corte. */
  asPanel: boolean
  /** Visibilidad del drawer: el panel lo controla la página al montarlo. */
  open: boolean
  canWrite: boolean
  onClose: () => void
  /** Moneda y formato de la clínica (perfil ya cargado por la página). */
  orgCurrency: string
  orgLocale: string
  /** Llevar la vista a sus materiales al abrir («Empieza por estos 5»). */
  revealMaterials?: boolean
}
/**
 * Los materiales no se guardaron (el servicio sí, si había cambios): el
 * formulario sigue abierto con lo escrito para volver a intentarlo.
 */
class MaterialsNotSaved extends Error {
  constructor(
    readonly reason: unknown,
    readonly serviceSaved: boolean,
  ) {
    super("No se guardaron los materiales")
  }
}

/**
 * Superficie del tarifario: el mismo formulario en panel lateral o drawer, y el
 * detalle de lectura para quien no escribe. Un solo contenedor por vez —montar
 * panel y drawer juntos duplicaría los `id`/`htmlFor` de los campos— y el shell
 * aporta cabecera, scroll y pie de acciones (Cancelar + Guardar).
 */
function OfferEditor({
  offer,
  revealMaterials = false,
  asPanel,
  open,
  canWrite,
  onClose,
  orgCurrency,
  orgLocale,
}: OfferEditorProps) {
  const queryClient = useQueryClient()
  /** La tarifa se escribe y lee con la moneda y el formato de la clínica. */
  const currency = offer?.currency ?? orgCurrency
  const templateId = offer?.templateId ?? null
  const isTemplate = offer?.source === "template"
  const codeList = useClinicalProfile().services

  /**
   * El código vigente del servicio en la lista del país (ADR 0069): el de su
   * tratamiento si es de la biblioteca, el que eligió la clínica si es propio.
   */
  const officialQuery = useQuery({
    // Clave propia: `["services", "one", id]` guarda el servicio entero (ServiceSelect, la Agenda).
    queryKey: ["services", "official", offer?.id ?? null],
    enabled: offer !== null && codeList !== null,
    queryFn: async () => (offer ? (await fetchService(offer.id)).data.officialCoding : null),
  })
  const officialCoding = officialQuery.data ?? null
  /** Lo que el detalle dice del código: cargando, sin poder leerlo o el leído. */
  const official: OfficialState = {
    coding: officialCoding,
    status: officialQuery.isPending && offer !== null && codeList !== null ? "pending" : officialQuery.isError ? "error" : "ready",
  }
  /**
   * Un código propio que una edición nueva de la lista retiró: donde la lista
   * es obligatoria, hay que elegir otro. Un código de otra lista (la clínica
   * cambió de país) no es «retirado»: se pide el de la lista nueva.
   */
  const retiredCode =
    !isTemplate &&
    codeList?.required &&
    offer?.procedureCode &&
    offer.procedureSystem === codeList.system &&
    officialQuery.isSuccess &&
    !officialCoding
      ? offer.procedureCode
      : null
  const initialCode = useMemo<OfficialCoding | null>(
    () => (isTemplate ? null : officialCoding),
    [isTemplate, officialCoding],
  )
  const [officialCode, setOfficialCode] = useState<OfficialCoding | null>(initialCode)
  const [codeTouched, setCodeTouched] = useState(false)
  // Cada apertura arranca prístina, como el formulario: lo guardado y sin avisos.
  useEffect(() => {
    if (!open) return
    setOfficialCode(initialCode)
    setCodeTouched(false)
  }, [open, initialCode])
  /** Si no se pudo leer el código guardado, no se envía: guardar no lo pisa. */
  const codeChanged = (officialCode?.code ?? null) !== (initialCode?.code ?? null)
  // Sin leer el código guardado no se exige otro: guardar no lo envía (`codeChanged`).
  const codeIssue = isTemplate || (officialQuery.isError && !codeChanged)
    ? null
    : retiredCode && !officialCode
      ? `El código ${retiredCode} ya no está vigente en ${codeList?.listName ?? "la lista"}: elige otro`
      : missingOfficialCode(codeList, officialCode)

  /** El tratamiento de la biblioteca, por id directo (incluye retirados, solo lectura). */
  const linkedTemplateQuery = useQuery({
    queryKey: ["services", "templates", "linked", templateId],
    enabled: templateId !== null,
    staleTime: 300_000,
    queryFn: async (): Promise<TreatmentTemplateItem | null> => {
      if (!templateId) return null
      try {
        const page = await fetchTreatmentTemplate(templateId)
        return page.data
      } catch {
        return null
      }
    },
  })
  const linkedTemplate = templateId ? (linkedTemplateQuery.data ?? null) : null
  const templateName = linkedTemplate?.name ?? null

  /*
   * Materiales del servicio (ADR 0067, tablero 17). Viven en el mismo
   * formulario y se guardan con su «Guardar»: primero el servicio (si cambió) y
   * después la lista entera de materiales. Lo escrito se conserva en
   * `materialLines` hasta guardar; `null` es «tal como está guardado».
   */
  const can = useCan()
  const canWriteMaterials = can("inventory.write")
  const seesMaterials = canWriteMaterials || can("inventory.read") || can("inventory.stock")
  const seesMaterialCost = can("inventory.read")
  const materialsQuery = useQuery({
    queryKey: ["services", "materials", offer?.id ?? null],
    queryFn: () => fetchServiceMaterials(offer?.id as string),
    enabled: offer !== null && seesMaterials,
  })
  const savedMaterials = materialsQuery.data?.data
  const [materialLines, setMaterialLines] = useState<MaterialDraftLine[] | null>(null)
  const [materialErrors, setMaterialErrors] = useState<Record<string, string>>({})
  const [materialsSaveError, setMaterialsSaveError] = useState<string | null>(null)
  // Cada apertura empieza de lo guardado, como el formulario.
  useEffect(() => {
    if (!open) return
    setMaterialLines(null)
    setMaterialErrors({})
    setMaterialsSaveError(null)
  }, [open])
  const savedLines = useMemo(
    () => (savedMaterials?.items ?? []).map((item) => draftLineOf(item, orgLocale)),
    [savedMaterials, orgLocale],
  )
  const lines = materialLines ?? savedLines
  const materialsDirty =
    canWriteMaterials && materialLines !== null && materialsChanged(materialLines, savedMaterials?.items ?? [], orgLocale)
  const changeMaterials = (next: MaterialDraftLine[]) => {
    setMaterialLines(next)
    setMaterialErrors({})
    setMaterialsSaveError(null)
  }
  /** Lo que se guardará de los materiales, o los errores de cada fila (que se muestran). */
  const checkMaterials = (): { items: Array<{ productId: string; quantity: number }> } | null | false => {
    if (!materialsDirty) return null
    const result = materialsToSave(lines, orgLocale, MATERIAL_QUANTITY_MAX)
    if ("errors" in result) {
      setMaterialErrors(result.errors)
      return false
    }
    setMaterialErrors({})
    return result
  }

  const saveMutation = useMutation({
    mutationFn: async ({
      values,
      saveService,
      materials,
    }: {
      values: OfferFormValues
      saveService: boolean
      materials: Array<{ productId: string; quantity: number }> | null
    }) => {
      const body = {
        name: values.name.trim(),
        code: values.code.trim() === "" ? null : values.code.trim(),
        priceCents: parseMoney(values.price, currency, orgLocale),
        durationMin: values.durationMin.trim() === "" ? null : Number(values.durationMin),
        billingMode: values.billingMode,
        priceDisclosure: values.priceDisclosure,
        evaluationServiceId: values.evaluationServiceId === "" ? null : values.evaluationServiceId,
        // Lo tratado queda dibujado: lo que deja en la pieza al completarse.
        leavesFinding: leavesFindingBody(values.leavesCondition, values.leavesVariant),
      }
      // El código del país lo elige solo un servicio propio; sin lista no viaja, y al
      // editar solo viaja si cambió.
      const code = codeList && (!offer || codeChanged) ? { officialCode: officialCode?.code ?? null } : {}
      let serviceId = offer?.id ?? null
      if (saveService) {
        const saved = !offer
          ? await createServiceApi({ ...body, ...code, specialtyId: values.specialtyId, scope: values.scope })
          : await updateServiceApi(offer.id, {
              ...body,
              // La especialidad se elige siempre aquí; el ámbito de una oferta de la biblioteca viene de su plantilla.
              ...(values.specialtyId ? { specialtyId: values.specialtyId } : {}),
              ...(isTemplate ? {} : { scope: values.scope, ...code }),
            })
        serviceId = saved.data.id
      }
      if (materials && serviceId) {
        try {
          const result = await saveServiceMaterialsApi(serviceId, materials)
          queryClient.setQueryData(["services", "materials", serviceId], result)
        } catch (cause) {
          throw new MaterialsNotSaved(cause, saveService)
        }
      }
      return { savedService: saveService, savedMaterials: materials !== null }
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success(
        !offer
          ? result.savedMaterials
            ? "Servicio guardado y activo, con sus materiales"
            : "Servicio guardado y activo"
          : !result.savedService
            ? "Materiales guardados: se descuentan desde la próxima atención"
            : result.savedMaterials
              ? "Servicio y materiales guardados"
              : "Servicio actualizado",
      )
      onClose()
    },
    onError: (error) => {
      if (error instanceof MaterialsNotSaved) {
        const message = financeErrorMessage(error.reason)
        setMaterialsSaveError(message)
        if (error.serviceSaved) {
          // Lo del servicio ya quedó: la lista lo trae y el formulario deja de
          // tenerlo como cambio; los materiales siguen escritos para reintentar.
          void queryClient.invalidateQueries({ queryKey: ["services"] })
          if (!offer) {
            toast.error(`El servicio quedó guardado y activo, pero sus materiales no: ${message} Ábrelo para ponerlos.`)
            onClose()
            return
          }
          toast.error(`Los datos del servicio se guardaron, pero sus materiales no: ${message}`)
          return
        }
        toast.error(`No se guardaron los materiales: ${message}`)
        return
      }
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const form = useOfferForm(offer, open, async (value) => {
    const materials = checkMaterials()
    if (materials === false) return
    // Solo materiales: el servicio no se vuelve a enviar; un código nuevo sí.
    const saveService = !offer || serviceDirtyRef.current || codeChangedRef.current || materials === null
    await saveMutation
      .mutateAsync({ values: value, saveService, materials: materials?.items ?? null })
      .catch(() => undefined)
  }, orgLocale)
  // Suscripción explícita: la página no se entera de los cambios de meta del
  // formulario por sí sola, y el cierre protegido necesita saber si hay cambios.
  const serviceDirty = useStore(form.store, (state) => !state.isDefaultValue)
  const serviceDirtyRef = useRef(serviceDirty)
  serviceDirtyRef.current = serviceDirty
  const codeChangedRef = useRef(codeChanged)
  codeChangedRef.current = codeChanged
  const isDirty = serviceDirty || materialsDirty || codeChanged

  const headerContent = (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {offer ? (
          <>
            <Badge variant={offer.isActive ? "success" : "secondary"}>
              {offer.isActive ? "Activa" : "Inactiva"}
            </Badge>
            <Badge variant="outline">{sourceLabel(offer)}</Badge>
          </>
        ) : (
          <Badge variant="outline">Propio de la clínica</Badge>
        )}
      </div>
      {isTemplate && offer && templateName && templateName !== offer.name ? (
        <p className="text-xs text-muted-foreground">Variante de «{templateName}»</p>
      ) : null}
    </div>
  )

  const fields = (
    <div className="flex flex-col gap-4">
      <>
        <OfferFields
          form={form}
          offer={offer}
          allowSpecialtyScope={!isTemplate}
          currency={currency}
          locale={orgLocale}
          officialCodeField={
            isTemplate ? null : (
              <OfficialCodeField
                value={officialCode}
                onChange={(next) => {
                  setOfficialCode(next)
                  setCodeTouched(true)
                }}
                error={
                  officialQuery.isError && !codeTouched
                    ? "No se pudo leer el código guardado. Si no lo cambias, se conserva."
                    : codeTouched || retiredCode
                      ? codeIssue
                      : null
                }
                disabled={offer !== null && officialQuery.isPending && codeList !== null}
              />
            )
          }
        />
        {canWriteMaterials ? (
          <>
            <ServiceMaterialsEditor
              idPrefix={offer?.id ?? "nueva"}
              serviceId={offer?.id ?? null}
              lines={lines}
              onChange={changeMaterials}
              errors={materialErrors}
              saveError={materialsSaveError}
              loading={offer !== null && materialsQuery.isPending}
              loadError={offer !== null && materialsQuery.isError ? materialsQuery.error : null}
              onRetry={() => void materialsQuery.refetch()}
              disabled={saveMutation.isPending}
              locale={orgLocale}
              reveal={revealMaterials}
            />
            {seesMaterialCost && offer && savedMaterials ? (
              <ServiceMaterialsCost
                cost={savedMaterials.cost}
                count={savedMaterials.items.length}
                servicePriceCents={offer.priceCents}
                serviceCurrency={offer.currency}
                changed={materialsDirty}
                locale={orgLocale}
              />
            ) : null}
          </>
        ) : offer && seesMaterials ? (
          <ServiceMaterialsReadOnly
            data={savedMaterials}
            loading={materialsQuery.isPending}
            loadError={materialsQuery.isError ? materialsQuery.error : null}
            onRetry={() => void materialsQuery.refetch()}
            showCost={seesMaterialCost}
            servicePriceCents={offer.priceCents}
            serviceCurrency={offer.currency}
            locale={orgLocale}
          />
        ) : null}
        {offer ? <OfferDetails offer={offer} official={official} /> : null}
      </>
    </div>
  )

  // Quien no escribe lee la prestación en el detalle de lectura: mismos datos,
  // sin campos que no puede guardar. Quien ve Inventario lee también sus materiales.
  if (offer && !canWrite) {
    const readOnly = (
      <div className="flex flex-col gap-4">
        <OfferReadOnly offer={offer} official={official} locale={orgLocale} />
        {seesMaterials ? (
          <ServiceMaterialsReadOnly
            data={savedMaterials}
            loading={materialsQuery.isPending}
            loadError={materialsQuery.isError ? materialsQuery.error : null}
            onRetry={() => void materialsQuery.refetch()}
            showCost={seesMaterialCost}
            servicePriceCents={offer.priceCents}
            serviceCurrency={offer.currency}
            locale={orgLocale}
          />
        ) : null}
      </div>
    )
    return asPanel ? (
      <DetailPanel title={offer.name} headerContent={headerContent} onClose={onClose}>
        {readOnly}
      </DetailPanel>
    ) : (
      <DetailDrawer open={open} title={offer.name} headerContent={headerContent} onClose={onClose}>
        {readOnly}
      </DetailDrawer>
    )
  }

  const formSurface = {
    title: offer ? offer.name : "Servicio propio",
    description: offer
      ? undefined
      : "Lo que tu clínica ofrece y la biblioteca no trae. Queda activo al guardarlo.",
    headerContent,
    isDirty,
    isSubmitting: saveMutation.isPending,
    submitLabel: offer ? common.actions.save : "Guardar y activar",
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      setCodeTouched(true)
      // Los errores de los materiales se marcan aunque falte otro dato del servicio.
      checkMaterials()
      // Donde la lista es obligatoria, un servicio propio no se guarda sin su código.
      if (codeIssue) {
        void form.validateAllFields("submit")
        return
      }
      void form.handleSubmit()
    },
    onClose,
  }

  return (
    <>
      <PageDraftGuard dirty={open && isDirty} />
      {asPanel ? (
        <FormPanel {...formSurface}>{fields}</FormPanel>
      ) : (
        <FormDrawer open={open} {...formSurface}>
          {fields}
        </FormDrawer>
      )}
    </>
  )
}

/** El código vigente del servicio y si ya se pudo leer. */
interface OfficialState {
  coding: OfficialCoding | null
  status: "pending" | "error" | "ready"
}

/**
 * El código del servicio en la lista del país, como un dato más del detalle
 * («Código CPMS · D0140», decisión 4 del lienzo del issue 40). Sin lista en el
 * país no se muestra.
 */
function OfficialCodeDetail({ official, own }: { official: OfficialState; own: boolean }) {
  const list = useClinicalProfile().services
  if (!list) return null
  // Uno de la biblioteca toma el código de su tratamiento: no hay nada que elegir aquí.
  const missing = !list.required ? null : own ? "Sin código vigente: elígelo al editar" : "Sin código vigente"
  return (
    <DetailField label={capitalize(list.codeName)}>
      {official.status === "pending" ? (
        <Skeleton className="h-4 w-16" />
      ) : official.status === "error" ? (
        "No se pudo leer el código"
      ) : official.coding ? (
        official.coding.code
      ) : (
        missing
      )}
    </DetailField>
  )
}

/** Detalle de lectura de una prestación, para quien no puede escribir. */
function OfferReadOnly({
  offer,
  official,
  locale,
}: {
  offer: ServiceCatalogItem
  official: OfficialState
  locale: string
}) {
  const receptionName = useReceptionName()
  return (
    <div className="flex flex-col gap-4">
      <DetailList>
        <DetailField label={`Precio (${offer.currency})`}>
          {formatMoney(offer.priceCents, offer.currency, locale)}
        </DetailField>
        <DetailField label="Se cobra">{BILLING_MODE_LABELS[offer.billingMode]}</DetailField>
        <DetailField label={`Cómo dice el precio ${receptionName}`}>
          {PRICE_DISCLOSURE_OPTIONS.find((option) => option.value === offer.priceDisclosure)?.label}
        </DetailField>
        <DetailField label="Duración">
          {offer.durationMin === null ? null : `${offer.durationMin} min`}
        </DetailField>
        <DetailField label="Especialidad">{offer.specialtyName ?? null}</DetailField>
        <DetailField label="Ámbito">
          {offer.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : null}
        </DetailField>
        <DetailField label="Deja en la pieza">
          {offer.leavesFinding
            ? [
                conditionLabel(offer.leavesFinding.condition),
                variantLabel(offer.leavesFinding.condition, offer.leavesFinding.variant),
              ]
                .filter(Boolean)
                .join(" · ")
            : null}
        </DetailField>
        <DetailField label="Estado">{offer.isActive ? "Activa" : "Inactiva"}</DetailField>
        <OfficialCodeDetail official={official} own={offer.source === "custom"} />
        <DetailField label="Código interno">{offer.code}</DetailField>
      </DetailList>
    </div>
  )
}

/**
 * Datos que el formulario no edita, plegados para no cargar la tarjeta. El
 * código del país de uno de la biblioteca viene de su tratamiento y no se cambia.
 */
function OfferDetails({
  offer,
  official,
}: {
  offer: ServiceCatalogItem
  official: OfficialState
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          Detalles <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <DetailList columns={1}>
          {offer.source === "template" ? <OfficialCodeDetail official={official} own={false} /> : null}
          <DetailField label="Duración">
            {offer.durationMin === null ? null : `${offer.durationMin} min`}
          </DetailField>
          <DetailField label="Moneda">{offer.currency}</DetailField>
          <DetailField label="Especialidad">{offer.specialtyName ?? null}</DetailField>
          <DetailField label="Ámbito">
            {offer.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : null}
          </DetailField>
        </DetailList>
      </CollapsibleContent>
    </Collapsible>
  )
}

function OfferFields({
  form,
  offer,
  allowSpecialtyScope,
  currency,
  locale,
  officialCodeField,
}: {
  form: OfferForm
  /** Oferta editada; `null` es el alta de una prestación propia. */
  offer: ServiceCatalogItem | null
  allowSpecialtyScope: boolean
  /** Moneda de la oferta; en el alta, la de la clínica. */
  currency: string
  /** Formato de la clínica para escribir el importe. */
  locale: string
  /** El código del país de un servicio propio, debajo del nombre (tablero 3). */
  officialCodeField: ReactNode
}) {
  const isTemplate = offer?.source === "template"
  const idPrefix = offer?.id ?? "nueva"
  return (
    <>
      <form.Field name="name" validators={{ onChange: offerSchema.shape.name }}>
        {(field) => (
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-nombre`}>Nombre</FieldLabel>
            <Input
              id={`${idPrefix}-nombre`}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
      {officialCodeField}
      <div className="grid grid-cols-2 gap-3">
        <OfferSpecialtyField form={form} idPrefix={idPrefix} current={offer} />
        {allowSpecialtyScope ? (
          <form.Field name="scope" validators={{ onChange: offerSchema.shape.scope }}>
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-ambito`}>Dónde se hace</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v ?? "")}
                >
                  <SelectTrigger id={`${idPrefix}-ambito`}>
                    <SelectValue placeholder="Elige" />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_PLACE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
              </Field>
            )}
          </form.Field>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Dónde se hace</span>
            <p className="text-sm">{offer?.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : "—"}</p>
            <p className="text-xs text-muted-foreground">Viene de la biblioteca.</p>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <form.Field name="price" validators={{ onChange: offerSchema.shape.price }}>
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-precio`}>{`Precio (${currency})`}</FieldLabel>
              <Input
                id={`${idPrefix}-precio`}
                inputMode="decimal"
                placeholder={formatMoneyInput(0, currency, locale)}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
              <p className="text-xs text-muted-foreground">Usa 0 si no tiene costo.</p>
            </Field>
          )}
        </form.Field>
        <form.Field name="durationMin" validators={{ onChange: offerSchema.shape.durationMin }}>
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-dur`}>Duración (min)</FieldLabel>
              <Input
                id={`${idPrefix}-dur`}
                inputMode="numeric"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="billingMode" validators={{ onChange: offerSchema.shape.billingMode }}>
        {(field) => (
          <Field>
            <span id={`${idPrefix}-cobro`} className="text-sm font-medium">
              Cómo se cobra
            </span>
            <RadioChips
              labelledBy={`${idPrefix}-cobro`}
              value={field.state.value}
              options={BILLING_OPTIONS}
              onChange={(next) => field.handleChange(next)}
            />
            <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            <p className="text-xs text-muted-foreground">
              Por sesión: se cobra el precio en cada visita atendida.
            </p>
          </Field>
        )}
      </form.Field>
      <PriceDisclosureFields form={form} idPrefix={idPrefix} offerId={offer?.id ?? null} />
      <OfferLeavesFinding form={form} idPrefix={idPrefix} offer={offer} />
      <form.Field name="code" validators={{ onChange: offerSchema.shape.code }}>
        {(field) => (
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-codigo`}>
              {isTemplate ? "Código interno de la clínica (opcional)" : "Código interno (opcional)"}
            </FieldLabel>
            <Input
              id={`${idPrefix}-codigo`}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            <p className="text-xs text-muted-foreground">Solo para uso interno de la clínica.</p>
          </Field>
        )}
      </form.Field>
    </>
  )
}

/**
 * La especialidad del servicio, una sola y de la lista de la clínica
 * (decisiones 1 y 3 de la fase 4): de ella depende a quién ofrece la agenda.
 * Una archivada que ya tenía el servicio se sigue viendo.
 */
function OfferSpecialtyField({
  form,
  idPrefix,
  current,
}: {
  form: OfferForm
  idPrefix: string
  current: ServiceCatalogItem | null
}) {
  const specialtiesQuery = useClinicSpecialties()
  const all = specialtiesQuery.data?.data ?? []
  const options = all.filter((item) => item.isActive || item.id === current?.specialtyId)
  return (
    <form.Field name="specialtyId" validators={{ onChange: offerSchema.shape.specialtyId }}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-esp`}>Especialidad</FieldLabel>
          <Select
            value={field.state.value}
            items={Object.fromEntries(options.map((item) => [item.id, item.name]))}
            onValueChange={(v) => field.handleChange(v ?? "")}
            disabled={specialtiesQuery.isPending}
          >
            <SelectTrigger id={`${idPrefix}-esp`}>
              <SelectValue placeholder={specialtiesQuery.isPending ? "Cargando…" : "Elige"} />
            </SelectTrigger>
            <SelectContent>
              {options.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
          {specialtiesQuery.isError ? (
            <p className="text-xs text-destructive">No se pudieron cargar las especialidades.</p>
          ) : (
            <p className="text-xs text-muted-foreground">La agenda lo ofrece a quien atiende esta especialidad.</p>
          )}
        </Field>
      )}
    </form.Field>
  )
}

/**
 * «Deja en la pieza»: con el ámbito que se está editando (o el de la plantilla).
 * Cambiar dónde se hace limpia lo que ya no encaja.
 */
function OfferLeavesFinding({
  form,
  idPrefix,
  offer,
}: {
  form: OfferForm
  idPrefix: string
  offer: ServiceCatalogItem | null
}) {
  const scope = useStore(form.store, (state) =>
    offer?.source === "template" ? offer.scope : state.values.scope,
  )
  const condition = useStore(form.store, (state) => state.values.leavesCondition)
  const variant = useStore(form.store, (state) => state.values.leavesVariant)
  return (
    <LeavesFindingField
      idPrefix={idPrefix}
      scope={scope}
      condition={condition}
      variant={variant}
      onChange={(nextCondition, nextVariant) => {
        form.setFieldValue("leavesCondition", nextCondition)
        form.setFieldValue("leavesVariant", nextVariant)
      }}
    />
  )
}

/**
 * «Cómo dice el precio el agente» (ADR 0021): solo cambia lo que se le dice a
 * una persona; caja y presupuesto usan siempre la tarifa. Con «Desde» o «Solo
 * con evaluación» se elige qué evaluación ofrece.
 */
function PriceDisclosureFields({ form, idPrefix, offerId }: { form: OfferForm; idPrefix: string; offerId: string | null }) {
  const receptionName = useReceptionName()
  const disclosure = useStore(form.store, (state) => state.values.priceDisclosure)
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border p-3">
      <legend id={`${idPrefix}-precio-agente`} className="px-1 text-sm font-semibold">
        Cómo dice el precio {receptionName}
      </legend>
      <form.Field name="priceDisclosure">
        {(field) => (
          <Field>
            <RadioChips
              labelledBy={`${idPrefix}-precio-agente`}
              value={field.state.value}
              options={PRICE_DISCLOSURE_OPTIONS}
              onChange={(next) => field.handleChange(next as PriceDisclosure)}
            />
            <p className="text-xs text-muted-foreground">
              {PRICE_DISCLOSURE_OPTIONS.find((option) => option.value === field.state.value)?.says} Caja y presupuesto usan
              siempre la tarifa.
            </p>
          </Field>
        )}
      </form.Field>
      {disclosure === "exacto" ? null : (
        <form.Field name="evaluationServiceId">
          {(field) => (
            <Field>
              {/* Busca en todo el tarifario: con más de 100 servicios ninguno queda fuera. */}
              <ServiceSelect
                id={`${idPrefix}-evaluacion`}
                label="Evaluación que ofrece"
                value={field.state.value}
                excludeId={offerId}
                noneLabel="Ninguna en particular: ofrece agendar una evaluación"
                onChange={(service) => field.handleChange(service?.id ?? "")}
              />
            </Field>
          )}
        </form.Field>
      )}
    </fieldset>
  )
}
