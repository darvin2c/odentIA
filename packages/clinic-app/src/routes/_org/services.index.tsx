import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLegend,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  applySubmitError,
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
  SkeletonRegion,
  MasterDetail,
  PageHeader,
  RowActions,
  submitErrorMessage,
  submitErrorOf,
  useAppForm,
  useDetailMode,
  useFieldContext,
  useFieldControl,
  useFormSurface,
  useListSearch,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ChevronDown, Tag } from "lucide-react"
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { z } from "zod"
import {
  capitalize,
  missingOfficialCode,
  OfficialCodeField,
  officialCodeText,
} from "../../components/official-code-field"
import {
  EMPTY_GUIDE,
  GuideSummary,
  guideDraftOf,
  guideSchema,
  guideToSave,
  hasGuide,
  ServiceGuideSection,
} from "../../components/service-guide"
import {
  ServiceMaterialsCost,
  ServiceMaterialsEditor,
  ServiceMaterialsReadOnly,
  ServicesWithoutMaterialsCard,
} from "../../components/service-materials"
import { ServiceSelect } from "../../components/service-select"
import { ServicesListPageSkeleton, ServicesListSkeleton } from "../../components/skeletons/services"
import { RadioChips } from "../../components/ui/radio-chips"
import { useReceptionName } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { fetchConsentTemplates, useClinicSpecialties } from "../../lib/clinical-forms"
import { formatDate } from "../../lib/clinical-journey"
import { useCan, useMemberName, usePermission } from "../../lib/crm"
import { fetchConsentTemplateServices } from "../../lib/encounter-documents"
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
  createServiceApi,
  fetchService,
  fetchServiceMaterials,
  fetchServices,
  fetchTemplatePatientGuide,
  fetchTreatmentTemplate,
  MATERIAL_QUANTITY_MAX,
  type OfficialCoding,
  PRICE_DISCLOSURE_BATCH,
  PRICE_DISCLOSURE_OPTIONS,
  PRICE_DISCLOSURE_TAG,
  type PriceDisclosure,
  SERVICE_PLACE_OPTIONS,
  type ServiceCatalogItem,
  saveServiceMaterialsApi,
  setServicesPriceDisclosureApi,
  TREATMENT_SCOPE_LABELS,
  type TreatmentTemplateItem,
  updateServiceApi,
} from "../../lib/services"
import { productUi } from "../../product/product-ui"
import { hasPlaces, servicesAccess, servicesHeader } from "../../lib/screen-rules"

export const Route = createFileRoute("/_org/services/")({
  /** Los filtros los lee `useListSearch`; aquí solo se tipa la especialidad para los enlaces (Especialidades abre la lista filtrada). */
  validateSearch: (search: Record<string, unknown>): { especialidad?: string } => ({
    ...search,
    especialidad: typeof search.especialidad === "string" ? search.especialidad : undefined,
  }),
  pendingComponent: ServicesListPageSkeleton,
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
  const { seesMaterials, writeMaterials: canWriteMaterials } = servicesAccess(can)
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

  const rows = useMemo(
    () => (pagesQuery.data?.pages ?? []).flatMap((page) => page.data),
    [pagesQuery.data],
  )
  const total = pagesQuery.data?.pages[0]?.total ?? 0
  /**
   * Fila vigente de la oferta abierta: si el filtro la deja fuera, no hay
   * detalle, salvo la que se abrió desde «Empieza por estos 5».
   */
  const editing =
    target?.kind === "offer"
      ? (rows.find((row) => row.id === target.id) ??
        (extraOffer?.id === target.id ? extraOffer : null))
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
    mutationFn: (priceDisclosure: PriceDisclosure) =>
      setServicesPriceDisclosureApi(selected, priceDisclosure),
    onSuccess: async (result, priceDisclosure) => {
      const label =
        PRICE_DISCLOSURE_OPTIONS.find((option) => option.value === priceDisclosure)?.label ??
        priceDisclosure
      const updated = result.data.updated
      setSelected([])
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success(
        updated === 1
          ? `Listo: ${receptionName} dice ese precio como «${label}».`
          : `Listo: ${receptionName} dice esos ${updated} precios como «${label}».`,
      )
    },
    // Si falla, lo elegido se conserva y el motivo queda en la barra de la selección.
  })

  const toggleMutation = useMutation({
    mutationFn: (service: ServiceCatalogItem) =>
      updateServiceApi(service.id, { isActive: !service.isActive }),
    onSuccess: async () => {
      setToggling(null)
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success("Estado actualizado")
    },
    // Si falla, el diálogo sigue abierto y dice por qué (`error`).
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
      ...(hasPlaces()
        ? [
            {
              accessorKey: "scope",
              header: "Ámbito",
              meta: { view: { primary: true } },
              cell: ({ row }) =>
                row.original.scope
                  ? (TREATMENT_SCOPE_LABELS[row.original.scope] ?? row.original.scope)
                  : "—",
            } satisfies ColumnDef<ServiceCatalogItem>,
          ]
        : []),
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
                <Badge variant="secondary">
                  {PRICE_DISCLOSURE_TAG[row.original.priceDisclosure]}
                </Badge>
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
  const editor = !profileReady ? (
    <DetailPanel title="Servicios y precios" headerContent={null} onClose={closeOffer}>
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
          {...servicesHeader(can, { add: () => void navigate({ to: "/services/biblioteca" }), own: () => openOffer(null) })}
        />
        {canWriteMaterials && profileLocale !== undefined ? (
          <ServicesWithoutMaterialsCard
            locale={profileLocale}
            onOpen={(id) => void openOfferById(id)}
          />
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
          sortOptions={
            hasPlaces()
              ? TARIFARIO_SORT_OPTIONS
              : TARIFARIO_SORT_OPTIONS.filter((option) => option.value !== "ambito")
          }
          searchPlaceholder="Buscar por nombre o código interno"
          searchLabel="Buscar en servicios"
        />

        {pagesQuery.isPending ? (
          <SkeletonRegion message="Cargando los servicios…">
            <ServicesListSkeleton select={canManage} code={usesInternalCode} places={hasPlaces()} materials={seesMaterials} actions={canManage} />
          </SkeletonRegion>
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
            onAction={canManage ? () => void navigate({ to: "/services/biblioteca" }) : undefined}
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
            {selected.length >= PRICE_DISCLOSURE_BATCH
              ? ` · como mucho ${PRICE_DISCLOSURE_BATCH} a la vez`
              : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value=""
              disabled={disclosureMutation.isPending}
              onValueChange={(value) => disclosureMutation.mutate(value as PriceDisclosure)}
            >
              <SelectTrigger
                className="min-h-11 w-auto"
                aria-label={`Cómo dice el precio ${receptionName}`}
                aria-invalid={disclosureMutation.isError || undefined}
                aria-describedby={
                  disclosureMutation.isError ? "tarifario-como-dice-error" : undefined
                }
              >
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
              onClick={() => {
                disclosureMutation.reset()
                setSelected([])
              }}
            >
              Quitar la selección
            </Button>
          </div>
          {disclosureMutation.isError ? (
            <p
              id="tarifario-como-dice-error"
              role="alert"
              className="basis-full text-sm text-destructive"
            >
              {`No se cambió cómo dice el precio. ${submitErrorMessage(disclosureMutation.error)}`}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? editor : null}

      <ConfirmDialog
        open={toggling !== null}
        onClose={() => {
          toggleMutation.reset()
          setToggling(null)
        }}
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
        error={toggleMutation.isError ? submitErrorMessage(toggleMutation.error) : null}
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

/** Una fila de materiales tal como la escribe el formulario. */
const materialLineSchema = z.object({
  productId: z.string(),
  name: z.string(),
  unit: z.string(),
  quantityText: z.string(),
  discounted: z.boolean(),
})

/** Lo que dice el campo del precio si `parseMoney` no lo acepta: el mismo que lo convierte al guardar. */
function priceIssue(raw: string, currency: string, locale: string): string | null {
  if (raw.trim() === "") return "Indica el precio (usa 0 si va incluido sin costo)"
  try {
    parseMoney(raw, currency, locale)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : "Precio inválido"
  }
}

/**
 * Lo que exige el formulario de la oferta, con los límites de la API. Cada
 * regla tiene su campo en pantalla: el ámbito solo se pide si se elige aquí,
 * el precio pasa por el mismo `parseMoney` que lo envía, el código oficial
 * dice lo que le falta (`codeIssue`) y cada material, su cantidad.
 */
function offerSchemaFor(rules: {
  currency: string
  locale: string
  /** «Dónde se hace» está en pantalla: odentIA y un servicio propio. */
  scopeShown: boolean
  codeIssue: (value: OfficialCoding | null) => string | null
}) {
  return z.object({
    name: z.string().trim().min(1, "Ingresa el nombre").max(200, "Máximo 200 caracteres"),
    code: z.string().trim().max(40, "Máximo 40 caracteres"),
    price: z.string().superRefine((value, ctx) => {
      const message = priceIssue(value, rules.currency, rules.locale)
      if (message) ctx.addIssue({ code: "custom", message })
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
    scope: rules.scopeShown ? z.string().min(1, "Elige dónde se hace") : z.string(),
    billingMode: z.enum(["treatment", "session"]),
    priceDisclosure: z.enum(["exacto", "desde", "evaluacion"]),
    /** Vacío: sin una evaluación propia. */
    evaluationServiceId: z.string(),
    /** Lo que deja en la pieza al completarse; vacío = nada. */
    leavesCondition: z.string(),
    leavesVariant: z.string(),
    /** El código del país de un servicio propio (ADR 0069). */
    officialCode: z.custom<OfficialCoding | null>().superRefine((value, ctx) => {
      const message = rules.codeIssue(value)
      if (message) ctx.addIssue({ code: "custom", message })
    }),
    /** Los materiales que se descuentan cada vez (ADR 0067), cada uno con su cantidad. */
    /** Lo que se le explica al paciente. */
    patientGuide: guideSchema,
    materials: z.array(materialLineSchema).superRefine((lines, ctx) => {
      const result = materialsToSave(lines, rules.locale, MATERIAL_QUANTITY_MAX)
      if (!("errors" in result)) return
      lines.forEach((line, index) => {
        const message = result.errors[line.productId]
        if (message) ctx.addIssue({ code: "custom", path: [index, "quantityText"], message })
      })
    }),
  })
}
type OfferSchema = ReturnType<typeof offerSchemaFor>
type OfferFormValues = z.infer<OfferSchema>

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
  officialCode: null,
  patientGuide: EMPTY_GUIDE,
  materials: [],
}

/**
 * Valores del formulario para una oferta; `null` = alta de una prestación
 * propia. El código guardado y los materiales llegan con sus consultas.
 */
function offerValues(
  offer: ServiceCatalogItem | null,
  locale: string,
  loaded: { officialCode: OfficialCoding | null; materials: MaterialDraftLine[] },
): OfferFormValues {
  // Sin «dónde» (latidIA), todo servicio es general: no hay ámbito que elegir ni que falte.
  const scope = offer?.scope ?? (hasPlaces() ? "" : "general")
  if (!offer) return { ...emptyOfferValues, scope, ...loaded }
  return {
    name: offer.name,
    code: offer.code ?? "",
    price: formatMoneyInput(offer.priceCents, offer.currency, locale),
    durationMin: offer.durationMin === null ? "" : String(offer.durationMin),
    specialtyId: offer.specialtyId ?? "",
    scope,
    billingMode: offer.billingMode ?? "treatment",
    priceDisclosure: offer.priceDisclosure ?? "exacto",
    evaluationServiceId: offer.evaluationServiceId ?? "",
    leavesCondition: offer.leavesFinding?.condition ?? "",
    leavesVariant: offer.leavesFinding?.variant ?? "",
    patientGuide: guideDraftOf(offer.patientGuide),
    ...loaded,
  }
}

/** Los datos del servicio, sin el código oficial, los materiales ni la explicación (que se comparan aparte). */
function serviceKey(values: OfferFormValues): string {
  return JSON.stringify({
    ...values,
    officialCode: undefined,
    materials: undefined,
    patientGuide: undefined,
  })
}

/**
 * Cómo se llama en el formulario lo que señala el servidor: el precio viaja
 * en céntimos, lo que deja en la pieza en sus dos selectores y cada material
 * por su fila (`items[i]` del cuerpo de materiales es la fila `i` de la lista).
 */
function offerFieldName(serverField: string): string | undefined {
  if (serverField === "priceCents") return "price"
  if (serverField === "leavesFinding" || serverField === "leavesFinding.condition")
    return "leavesCondition"
  if (serverField === "leavesFinding.variant") return "leavesVariant"
  const row = /^items\[(\d+)\]\./.exec(serverField)
  return row ? `materials[${row[1]}].quantityText` : undefined
}

/** El formulario de la oferta: sus valores, su esquema y lo que hace al guardar. */
function useOfferForm(
  defaultValues: OfferFormValues,
  schema: OfferSchema,
  onSubmit: (value: OfferFormValues) => Promise<void>,
) {
  return useAppForm({
    defaultValues,
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => onSubmit(value),
  })
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
  const codeText = officialCodeText(codeList)
  const codeFieldId = `${offer?.id ?? "nueva"}-codigo-oficial`

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
    status:
      officialQuery.isPending && offer !== null && codeList !== null
        ? "pending"
        : officialQuery.isError
          ? "error"
          : "ready",
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
  /** ¿El código elegido es otro que el guardado? Si no se pudo leer el guardado y no se cambia, no se envía. */
  const codeChangedIn = (value: OfficialCoding | null) =>
    (value?.code ?? null) !== (initialCode?.code ?? null)

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
   * Materiales del servicio (ADR 0067, tablero 17). Son un dato más del
   * formulario (`materials`) y se guardan con su «Guardar»: primero el
   * servicio (si cambió) y después la lista entera de materiales.
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
  const savedLines = useMemo(
    () => (savedMaterials?.items ?? []).map((item) => draftLineOf(item, orgLocale)),
    [savedMaterials, orgLocale],
  )

  /** El servicio ya guardado en esta apertura (alta o edición) y con qué datos: reintentar no lo repite. */
  const savedService = useRef<{ id: string; key: string } | null>(null)
  /** El rechazo de los materiales: si no es de ninguna fila, se dice que fueron ellos. */
  const materialsFailure = useRef<unknown>(null)
  /** El servicio quedó guardado y sus materiales no: se dice en la sección, junto a lo que falta. */
  const [pendingNote, setPendingNote] = useState<string | null>(null)
  /** Lo que llegó tarde (el código guardado, los materiales) ya entró al formulario en esta apertura. */
  const [codeTaken, setCodeTaken] = useState(false)
  const [materialsTaken, setMaterialsTaken] = useState(false)

  const defaultValues = useMemo(
    () => offerValues(offer, orgLocale, { officialCode: initialCode, materials: savedLines }),
    [offer, orgLocale, initialCode, savedLines],
  )
  const defaultServiceKey = serviceKey(defaultValues)
  const materialsDirtyIn = (values: OfferFormValues) =>
    canWriteMaterials &&
    (offer === null || materialsTaken) &&
    materialsChanged(values.materials, savedMaterials?.items ?? [], orgLocale)

  const save = async (value: OfferFormValues) => {
    materialsFailure.current = null
    const guide = offer ? guideToSave(offer.patientGuide, value.patientGuide) : null
    const codeChanged = codeChangedIn(value.officialCode)
    const officialCode = { officialCode: value.officialCode?.code ?? null }
    const body = {
      name: value.name.trim(),
      code: value.code.trim() === "" ? null : value.code.trim(),
      // El esquema ya lo pasó por `parseMoney`: aquí no falla.
      priceCents: parseMoney(value.price, currency, orgLocale),
      durationMin: value.durationMin.trim() === "" ? null : Number(value.durationMin),
      billingMode: value.billingMode,
      priceDisclosure: value.priceDisclosure,
      evaluationServiceId: value.evaluationServiceId === "" ? null : value.evaluationServiceId,
      // Lo tratado queda dibujado: lo que deja en la pieza al completarse.
      leavesFinding:
        productUi().services.leaves?.body(value.leavesCondition, value.leavesVariant) ?? null,
    }
    const toSave = materialsDirtyIn(value)
      ? materialsToSave(value.materials, orgLocale, MATERIAL_QUANTITY_MAX)
      : null
    const materials = toSave && "items" in toSave ? toSave.items : null
    const sentKey = JSON.stringify([serviceKey(value), officialCode.officialCode])
    const saved = savedService.current
    const targetId = offer?.id ?? saved?.id ?? null
    // Solo materiales: el servicio no se vuelve a enviar (un código nuevo sí), ni lo
    // que ya se guardó igual en esta apertura.
    const saveService =
      !targetId ||
      (saved?.key !== sentKey &&
        (offer === null ||
          serviceKey(value) !== defaultServiceKey ||
          codeChanged ||
          (materials === null && !guide)))
    let serviceId = targetId
    // Solo la explicación: viaja sola, sin pedir arreglar lo demás del servicio.
    if (!saveService && guide && targetId) await updateServiceApi(targetId, guide)
    if (saveService) {
      const result = targetId
        ? await updateServiceApi(targetId, {
            ...body,
            ...guide,
            // La especialidad se elige siempre aquí; el ámbito de una oferta de la biblioteca viene de su plantilla.
            ...(value.specialtyId ? { specialtyId: value.specialtyId } : {}),
            // El código del país lo elige solo un servicio propio; sin lista no viaja, y al
            // editar solo viaja si cambió.
            ...(isTemplate
              ? {}
              : {
                  scope: value.scope,
                  ...(codeList && (!offer || codeChanged) ? officialCode : {}),
                }),
          })
        : await createServiceApi({
            ...body,
            ...(codeList ? officialCode : {}),
            specialtyId: value.specialtyId,
            scope: value.scope,
          })
      serviceId = result.data.id
      savedService.current = { id: result.data.id, key: sentKey }
    }
    if (materials && serviceId) {
      try {
        const result = await saveServiceMaterialsApi(serviceId, materials)
        queryClient.setQueryData(["services", "materials", serviceId], result)
      } catch (error) {
        materialsFailure.current = error
        if (savedService.current) {
          // Lo del servicio ya quedó: la lista lo trae y reintentar solo guarda los materiales.
          void queryClient.invalidateQueries({ queryKey: ["services"] })
          setPendingNote(
            offer
              ? "Los datos del servicio ya se guardaron; faltan sus materiales."
              : "El servicio ya quedó guardado y activo; faltan sus materiales.",
          )
        }
        throw error
      }
    }
    await queryClient.invalidateQueries({ queryKey: ["services"] })
    toast.success(
      !offer
        ? materials
          ? "Servicio guardado y activo, con sus materiales"
          : "Servicio guardado y activo"
        : !saveService
          ? guide
            ? materials
              ? "Explicación y materiales guardados"
              : "Explicación guardada"
            : "Materiales guardados: se descuentan desde la próxima atención"
          : materials
            ? "Servicio y materiales guardados"
            : "Servicio actualizado",
    )
    onClose()
  }

  /*
   * Lo que se le explica al paciente: un dato más del formulario y se guarda con
   * su «Guardar». El texto sugerido solo llena estos campos.
   */
  const memberName = useMemberName()
  const canReadConsents = can("clinical.read") || can("settings.read")
  const canOpenForms = can("settings.read")
  const suggestionQuery = useQuery({
    queryKey: ["services", "patient-guide", templateId],
    queryFn: () => fetchTemplatePatientGuide(templateId as string),
    enabled: canWrite && templateId !== null && !hasGuide(offer?.patientGuide),
    staleTime: 300_000,
  })
  const consentLinksQuery = useQuery({
    queryKey: ["consent-template-services"],
    queryFn: fetchConsentTemplateServices,
    enabled: offer !== null && canReadConsents,
    staleTime: 60_000,
  })
  const consentKeys = (consentLinksQuery.data?.data ?? [])
    .filter((row) => offer !== null && row.serviceIds.includes(offer.id))
    .map((row) => row.templateKey)
  const consentTemplatesQuery = useQuery({
    queryKey: ["consent-templates", "publicado"],
    queryFn: () => fetchConsentTemplates({ status: "publicado" }),
    enabled: consentKeys.length > 0,
    staleTime: 60_000,
  })
  const consentTitles = [
    ...new Set(
      (consentTemplatesQuery.data?.data ?? [])
        .filter((row) => consentKeys.includes(row.key))
        .map((row) => row.title),
    ),
  ]
  const consentLine =
    consentTitles.length > 0 ? (
      <p className="text-sm text-muted-foreground">
        Riesgos y qué pasa si no se trata salen de su consentimiento:{" "}
        {canOpenForms ? (
          <Link
            to="/settings/forms"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {consentTitles.join(", ")}
          </Link>
        ) : (
          consentTitles.join(", ")
        )}
        .
      </p>
    ) : null
  const reviewedWords =
    offer?.patientGuideReviewedAt && hasGuide(offer.patientGuide)
      ? offer.patientGuideReviewedBy
        ? `Revisado por ${memberName(offer.patientGuideReviewedBy)} el ${formatDate(offer.patientGuideReviewedAt)}`
        : `Revisado el ${formatDate(offer.patientGuideReviewedAt)}`
      : null
  const [guideSaving, setGuideSaving] = useState(false)

  const form = useOfferForm(
    defaultValues,
    offerSchemaFor({
      currency,
      locale: orgLocale,
      scopeShown: hasPlaces() && !isTemplate,
      // Sin leer el código guardado no se exige otro: guardar no lo envía si no se cambia.
      codeIssue: (value) =>
        isTemplate || (officialQuery.isError && !codeChangedIn(value))
          ? null
          : missingOfficialCode(codeList, value),
    }),
    save,
  )

  // Cada apertura arranca prístina: lo guardado, sin avisos ni lo enviado la vez anterior
  // (el panel no se desmonta al cerrar).
  useEffect(() => {
    if (!open) return
    form.reset()
    savedService.current = null
    materialsFailure.current = null
    setPendingNote(null)
    setCodeTaken(false)
    setMaterialsTaken(false)
  }, [open, form])
  // Lo que llega tarde entra una vez por apertura y sin contar como cambio, aunque ya se haya
  // escrito otro dato; después no pisa lo que se elija.
  const codeLoaded = offer === null || codeList === null || isTemplate || officialQuery.isSuccess
  useEffect(() => {
    if (!open || codeTaken || !codeLoaded) return
    form.setFieldValue("officialCode", initialCode, { dontUpdateMeta: true })
    setCodeTaken(true)
  }, [open, codeTaken, codeLoaded, initialCode, form])
  useEffect(() => {
    if (!open || materialsTaken || offer === null || !materialsQuery.isSuccess) return
    form.setFieldValue("materials", savedLines, { dontUpdateMeta: true })
    setMaterialsTaken(true)
  }, [open, materialsTaken, offer, materialsQuery.isSuccess, savedLines, form])

  // El cierre protegido necesita saber si hay cambios: del servicio, del código o de los materiales.
  const serviceDirty = useStore(
    form.store,
    (state) => serviceKey(state.values) !== defaultServiceKey,
  )
  const codeChanged = useStore(form.store, (state) => codeChangedIn(state.values.officialCode))
  const materialsDirty = useStore(form.store, (state) => materialsDirtyIn(state.values))
  const guideDirty = useStore(
    form.store,
    (state) => guideToSave(offer?.patientGuide, state.values.patientGuide) !== null,
  )
  const isDirty = serviceDirty || materialsDirty || codeChanged || guideDirty
  const surface = useFormSurface(form, {
    fieldMap: offerFieldName,
    formMessage: (error) =>
      error === materialsFailure.current
        ? `No se guardaron los materiales: ${submitErrorOf(error).form ?? ""}`
        : null,
  })

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
      <OfferFields
        form={form}
        offer={offer}
        allowSpecialtyScope={!isTemplate}
        currency={currency}
        locale={orgLocale}
        officialCodeField={
          isTemplate || !codeText ? null : (
            <form.AppField name="officialCode">
              {(field) => (
                <field.Control
                  id={codeFieldId}
                  label={codeText.label}
                  description={
                    officialQuery.isError && !codeChangedIn(field.state.value)
                      ? "No se pudo leer el código guardado. Si no lo cambias, se conserva."
                      : retiredCode && !field.state.value
                        ? `El código ${retiredCode} ya no está vigente en ${codeList?.listName ?? "la lista"}: elige otro.`
                        : codeText.description
                  }
                >
                  {(control) => (
                    <OfficialCodeField
                      id={control.id}
                      value={field.state.value}
                      onChange={(next) => field.handleChange(next)}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      disabled={offer !== null && officialQuery.isPending && codeList !== null}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          )
        }
      />
      {offer ? (
        <ServiceGuideSection
          form={form}
          fields="patientGuide"
          idPrefix={`${offer.id}-guia`}
          saved={offer.patientGuide}
          suggestion={suggestionQuery.data?.data.suggestion}
          reviewedWords={guideDirty ? null : reviewedWords}
          consents={consentLine}
          disabled={surface.isSubmitting || guideSaving}
        />
      ) : null}
      {canWriteMaterials ? (
        <>
          <ServiceMaterialsEditor
            form={form}
            fields={{ materials: "materials" }}
            idPrefix={offer?.id ?? "nueva"}
            serviceId={offer?.id ?? null}
            loading={offer !== null && !materialsTaken && !materialsQuery.isError}
            loadError={offer !== null && materialsQuery.isError ? materialsQuery.error : null}
            onRetry={() => void materialsQuery.refetch()}
            disabled={surface.isSubmitting}
            locale={orgLocale}
            reveal={revealMaterials}
            pendingNote={pendingNote}
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
    </div>
  )

  // Quien no escribe lee la prestación en el detalle de lectura: mismos datos,
  // sin campos que no puede guardar. Quien ve Inventario lee también sus materiales.
  if (offer && !canWrite) {
    const readOnly = (
      <div className="flex flex-col gap-4">
        <OfferReadOnly offer={offer} official={official} locale={orgLocale} />
        {hasGuide(offer.patientGuide) ? (
          <section aria-label="Lo que se le explica al paciente" className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Lo que se le explica al paciente</h3>
            <GuideSummary guide={offer.patientGuide} />
            {reviewedWords ? (
              <p className="text-xs text-muted-foreground">{reviewedWords}</p>
            ) : null}
            {consentLine}
          </section>
        ) : null}
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
    ...surface,
    title: offer ? offer.name : "Servicio propio",
    description: offer
      ? undefined
      : "Lo que tu clínica ofrece y la biblioteca no trae. Queda activo al guardarlo.",
    headerContent,
    isDirty,
    submitLabel: offer ? common.actions.save : "Guardar y activar",
    isSubmitting: surface.isSubmitting || guideSaving,
    onSubmit: (event: FormEvent) => {
      const values = form.state.values
      // Explicar un servicio no pide arreglar lo demás: uno de antes, sin código o
      // sin ámbito, también se explica (la API lo permite igual).
      if (
        offer &&
        guideDirty &&
        !serviceDirty &&
        !codeChanged &&
        !materialsDirty &&
        guideSchema.safeParse(values.patientGuide).success
      ) {
        event.preventDefault()
        event.stopPropagation()
        setGuideSaving(true)
        void save(values)
          .catch((error: unknown) => applySubmitError(form, error, { fieldMap: offerFieldName }))
          .finally(() => setGuideSaving(false))
        return
      }
      surface.onSubmit(event)
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
  const missing = !list.required
    ? null
    : own
      ? "Sin código vigente: elígelo al editar"
      : "Sin código vigente"
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
  const leaves = productUi().services.leaves
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
        {hasPlaces() ? (
          <DetailField label="Ámbito">
            {offer.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : null}
          </DetailField>
        ) : null}
        {leaves ? (
          <DetailField label={leaves.label}>
            {offer.leavesFinding ? leaves.words(offer.leavesFinding) : null}
          </DetailField>
        ) : null}
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
function OfferDetails({ offer, official }: { offer: ServiceCatalogItem; official: OfficialState }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-sm font-medium">
        <span className="flex items-center gap-1">
          Detalles <ChevronDown aria-hidden className="size-4" />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <DetailList columns={1}>
          {offer.source === "template" ? (
            <OfficialCodeDetail official={official} own={false} />
          ) : null}
          <DetailField label="Duración">
            {offer.durationMin === null ? null : `${offer.durationMin} min`}
          </DetailField>
          <DetailField label="Moneda">{offer.currency}</DetailField>
          <DetailField label="Especialidad">{offer.specialtyName ?? null}</DetailField>
          {hasPlaces() ? (
            <DetailField label="Ámbito">
              {offer.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : null}
            </DetailField>
          ) : null}
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
      <form.AppField name="name">
        {(field) => <field.TextField id={`${idPrefix}-nombre`} label="Nombre" />}
      </form.AppField>
      {officialCodeField}
      <div className="grid grid-cols-2 gap-3">
        <OfferSpecialtyField form={form} idPrefix={idPrefix} current={offer} />
        {!hasPlaces() ? null : allowSpecialtyScope ? (
          <form.AppField name="scope">
            {(field) => (
              <field.SelectField
                id={`${idPrefix}-ambito`}
                label="Dónde se hace"
                placeholder="Elige"
                options={SERVICE_PLACE_OPTIONS}
              />
            )}
          </form.AppField>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Dónde se hace</span>
            <p className="text-sm">
              {offer?.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Viene de la biblioteca.</p>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <form.AppField name="price">
          {(field) => (
            <field.TextField
              id={`${idPrefix}-precio`}
              label={`Precio (${currency})`}
              description="Usa 0 si no tiene costo."
              inputMode="decimal"
              placeholder={formatMoneyInput(0, currency, locale)}
            />
          )}
        </form.AppField>
        <form.AppField name="durationMin">
          {(field) => (
            <field.TextField id={`${idPrefix}-dur`} label="Duración (min)" inputMode="numeric" />
          )}
        </form.AppField>
      </div>
      <form.AppField name="billingMode">
        {(field) => (
          <field.Group
            id={`${idPrefix}-cobro-opciones`}
            legend={<span id={`${idPrefix}-cobro`}>Cómo se cobra</span>}
            description="Por sesión: se cobra el precio en cada visita atendida."
          >
            {(control) => (
              <RadioChips
                id={control.id}
                aria-labelledby={`${idPrefix}-cobro`}
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
      <PriceDisclosureFields form={form} idPrefix={idPrefix} offerId={offer?.id ?? null} />
      <OfferLeavesFinding form={form} idPrefix={idPrefix} offer={offer} />
      <form.AppField name="code">
        {(field) => (
          <field.TextField
            id={`${idPrefix}-codigo`}
            label={
              isTemplate ? "Código interno de la clínica (opcional)" : "Código interno (opcional)"
            }
            description="Solo para uso interno de la clínica."
          />
        )}
      </form.AppField>
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
  const options = all
    .filter((item) => item.isActive || item.id === current?.specialtyId)
    .map((item) => ({ value: item.id, label: item.name }))
  return (
    <form.AppField name="specialtyId">
      {(field) => (
        <field.SelectField
          id={`${idPrefix}-esp`}
          label="Especialidad"
          placeholder={specialtiesQuery.isPending ? "Cargando…" : "Elige"}
          disabled={specialtiesQuery.isPending}
          options={options}
          description={
            specialtiesQuery.isError ? (
              <span role="alert" className="text-destructive">
                No se pudieron cargar las especialidades.
              </span>
            ) : (
              "La agenda lo ofrece a quien atiende esta especialidad."
            )
          }
        />
      )}
    </form.AppField>
  )
}

/**
 * «Deja en la pieza»: con el ámbito que se está editando (o el de la plantilla).
 * Cambiar dónde se hace limpia lo que ya no encaja. Lo que diga el servidor del
 * hallazgo o de su variante se dice junto a su selector.
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
  const leaves = productUi().services.leaves
  if (!leaves) return null
  return (
    <form.Field name="leavesCondition">
      {(condition) => (
        <form.Field name="leavesVariant">
          {(variant) => (
            <leaves.Field
              idPrefix={idPrefix}
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
        </form.Field>
      )}
    </form.Field>
  )
}

/**
 * «Cómo dice el precio el agente» (ADR 0021): solo cambia lo que se le dice a
 * una persona; caja y presupuesto usan siempre la tarifa. Con «Desde» o «Solo
 * con evaluación» se elige qué evaluación ofrece.
 */
function PriceDisclosureFields({
  form,
  idPrefix,
  offerId,
}: {
  form: OfferForm
  idPrefix: string
  offerId: string | null
}) {
  const receptionName = useReceptionName()
  const disclosure = useStore(form.store, (state) => state.values.priceDisclosure)
  const legendId = `${idPrefix}-precio-agente`
  return (
    <FieldSet className="flex flex-col gap-3 rounded-xl border p-3">
      <FieldLegend id={legendId} className="px-1 text-sm font-semibold">
        Cómo dice el precio {receptionName}
      </FieldLegend>
      <form.AppField name="priceDisclosure">
        {() => <DisclosureChoice id={`${idPrefix}-como-dice`} legendId={legendId} />}
      </form.AppField>
      {disclosure === "exacto" ? null : (
        <form.AppField name="evaluationServiceId">
          {(field) => (
            <field.Control id={`${idPrefix}-evaluacion`} label="Evaluación que ofrece">
              {(control) => (
                // Busca en todo el tarifario: con más de 100 servicios ninguno queda fuera.
                <ServiceSelect
                  id={control.id}
                  placeholder="Buscar evaluación que ofrece…"
                  value={field.state.value}
                  excludeId={offerId}
                  noneLabel="Ninguna en particular: ofrece agendar una evaluación"
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  onChange={(service) => field.handleChange(service?.id ?? "")}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      )}
    </FieldSet>
  )
}

/** Las tres formas de decir el precio, nombradas por la leyenda del grupo, con lo que dice la elegida. */
function DisclosureChoice({ id, legendId }: { id: string; legendId: string }) {
  const field = useFieldContext<PriceDisclosure>()
  const { control, errors, descriptionId, errorId } = useFieldControl({ id, hasDescription: true })
  return (
    <Field data-invalid={control.invalid || undefined}>
      <RadioChips
        id={control.id}
        aria-labelledby={legendId}
        aria-describedby={control.describedBy}
        invalid={control.invalid}
        onBlur={control.onBlur}
        value={field.state.value}
        options={PRICE_DISCLOSURE_OPTIONS}
        onChange={(next) => field.handleChange(next)}
      />
      <FieldDescription id={descriptionId} className="text-xs">
        {PRICE_DISCLOSURE_OPTIONS.find((option) => option.value === field.state.value)?.says} Caja y
        presupuesto usan siempre la tarifa.
      </FieldDescription>
      {control.invalid ? (
        <FieldError id={errorId} errors={errors.map((message) => ({ message }))} />
      ) : null}
    </Field>
  )
}
