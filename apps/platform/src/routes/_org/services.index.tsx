import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
  FieldError as UiFieldError,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ChevronDown, Plus, Tag } from "lucide-react"
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { RadioChips } from "../../components/ui/radio-chips"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useOrgProfile } from "../../lib/org"
import { PageDraftGuard } from "../../lib/page-draft-guard"
import {
  BILLING_MODE_LABELS,
  type BillingMode,
  PRICE_DISCLOSURE_OPTIONS,
  PRICE_DISCLOSURE_TAG,
  type PriceDisclosure,
  createServiceApi,
  fetchServices,
  fetchTreatmentTemplate,
  fetchTreatmentTemplates,
  type ServiceCatalogItem,
  SERVICE_PLACE_OPTIONS,
  SPECIALTY_FILTER_OPTIONS,
  TREATMENT_SCOPE_LABELS,
  TREATMENT_SPECIALTIES,
  TREATMENT_SPECIALTY_LABELS,
  type TreatmentTemplateItem,
  updateServiceApi,
} from "../../lib/services"

/** Muestra el primer mensaje de validación de TanStack Form. */
function FieldError({ errors }: { errors: unknown }) {
  return <UiFieldError>{fieldErrorMessages(errors)[0]}</UiFieldError>
}

export const Route = createFileRoute("/_org/services/")({
  component: TarifarioPage,
})

const orgRouteApi = getRouteApi("/_org")

const STATE_OPTIONS = [
  { value: "active", label: "Activas" },
  { value: "inactive", label: "Inactivas" },
  { value: "legacy", label: "Pendientes de revisar" },
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

const RESOLVE_OPTIONS: ReadonlyArray<{ value: "plantilla" | "propia"; label: string }> = [
  { value: "plantilla", label: "Vincular a la biblioteca" },
  { value: "propia", label: "Confirmar como propia" },
]

function stateLabel(state: string): string {
  return STATE_OPTIONS.find((o) => o.value === state)?.label ?? state
}

/* ------------------------------- Tarifario -------------------------------- */

/** Oferta abierta en la superficie lateral del tarifario, o el alta de una nueva. */
type EditorTarget = { kind: "offer"; id: string } | { kind: "create" }

/**
 * Tarifario de la clínica: listado agrupado por especialidad con el detalle al
 * costado (`MasterDetail`). El panel deja la lista a la vista mientras se edita
 * la tarifa; por debajo del corte, ese mismo formulario se abre como drawer.
 */
function TarifarioPage() {
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
  /** Moneda y formato de la clínica: los importes se leen con su locale. */
  const profileQuery = useOrgProfile()
  const profileLocale = profileQuery.data?.locale
  const profileCurrency = profileQuery.data?.currency
  const [target, setTarget] = useState<EditorTarget | null>(null)
  /** Se cierra sin desmontar: el drawer necesita su salida y `MasterDetail` su colapso. */
  const [surfaceOpen, setSurfaceOpen] = useState(false)
  const [toggling, setToggling] = useState<ServiceCatalogItem | null>(null)

  const pagesQuery = useQuery({
    queryKey: ["services", "tarifario", search, specialtyFilter, estadoFilter],
    enabled: canViewTariff,
    queryFn: () =>
      fetchServices({
        q: search.trim() || undefined,
        specialty: specialtyFilter === "todas" ? undefined : specialtyFilter,
        state: estadoFilter as "active" | "inactive" | "legacy",
        limit: 100,
      }),
  })

  const rows = useMemo(() => pagesQuery.data?.data ?? [], [pagesQuery.data])
  /** Fila vigente de la oferta abierta: si el filtro la deja fuera, no hay detalle. */
  const editing =
    target?.kind === "offer" ? (rows.find((row) => row.id === target.id) ?? null) : null

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

  const groups = useMemo(() => {
    const map = new Map<string, ServiceCatalogItem[]>()
    for (const row of sortedRows) {
      const key = row.source === "legacy" ? "legacy" : (row.specialty ?? "sin-especialidad")
      const list = map.get(key) ?? []
      list.push(row)
      map.set(key, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [sortedRows])

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
  const openOffer = useCallback((offer: ServiceCatalogItem | null) => {
    setTarget(offer ? { kind: "offer", id: offer.id } : { kind: "create" })
    setSurfaceOpen(true)
  }, [])

  /** Cierra sin desmontar: `MasterDetail` colapsa la columna y el drawer anima su salida. */
  const closeOffer = useCallback(() => setSurfaceOpen(false), [])

  const columns = useMemo<ColumnDef<ServiceCatalogItem>[]>(
    () => [
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
            {row.original.source === "template" ? (
              <span className="text-xs text-muted-foreground">De la biblioteca</span>
            ) : row.original.source === "legacy" ? (
              <span className="text-xs text-muted-foreground">Heredada · pendiente de revisar</span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Propia de la clínica · sin código oficial
              </span>
            )}
          </span>
        ),
      },
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
      },
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
                ...(row.original.source === "legacy"
                  ? []
                  : [
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
                    ]),
              ]}
            />
          ) : null,
      },
    ],
    [canManage, openOffer, profileLocale],
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
        <FilterBar
          filters={[
            {
              key: "especialidad",
              label: "Especialidad",
              type: "select",
              options: SPECIALTY_FILTER_OPTIONS,
            },
            { key: "estado", label: "Estado", type: "select", options: STATE_OPTIONS },
          ]}
          sortOptions={TARIFARIO_SORT_OPTIONS}
          searchPlaceholder="Buscar por nombre o código interno"
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
            {groups.map(([key, groupRows]) => (
              <section
                key={key}
                aria-label={
                  key === "legacy"
                    ? "Pendientes de revisar"
                    : (TREATMENT_SPECIALTY_LABELS[key] ?? key)
                }
              >
                <h3 className="mb-2 text-sm font-semibold">
                  {key === "legacy"
                    ? "Pendientes de revisar"
                    : (TREATMENT_SPECIALTY_LABELS[key] ?? "Sin especialidad")}
                </h3>
                <GroupTable
                  rows={groupRows}
                  columns={columns}
                  onSelect={openOffer}
                  activeId={activeOfferId}
                />
              </section>
            ))}
          </div>
        )}
      </MasterDetail>

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
  specialty: z.string().min(1, "Elige la especialidad"),
  scope: z.string().min(1, "Elige el ámbito"),
  billingMode: z.enum(["treatment", "session"]),
  priceDisclosure: z.enum(["exacto", "desde", "evaluacion"]),
  /** Vacío: sin una evaluación propia. */
  evaluationServiceId: z.string(),
})

type OfferFormValues = z.infer<typeof offerSchema>

const emptyOfferValues: OfferFormValues = {
  name: "",
  code: "",
  price: "",
  durationMin: "",
  specialty: "",
  scope: "",
  billingMode: "treatment",
  // Un servicio nuevo nace «solo con evaluación»: la clínica habilita el precio donde quiera.
  priceDisclosure: "evaluacion",
  evaluationServiceId: "",
}

/** Valores del formulario para una oferta; `null` = alta de una prestación propia. */
function offerValues(offer: ServiceCatalogItem | null, locale: string): OfferFormValues {
  if (!offer) return emptyOfferValues
  return {
    name: offer.name,
    code: offer.code ?? "",
    price: formatMoneyInput(offer.priceCents, offer.currency, locale),
    durationMin: offer.durationMin === null ? "" : String(offer.durationMin),
    specialty: offer.specialty ?? "",
    scope: offer.scope ?? "",
    billingMode: offer.billingMode ?? "treatment",
    priceDisclosure: offer.priceDisclosure ?? "exacto",
    evaluationServiceId: offer.evaluationServiceId ?? "",
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
  if (offer.source === "legacy") return "Heredada"
  return offer.source === "custom" ? "Prestación de la clínica" : "De la biblioteca"
}

/** Código oficial de la plantilla vinculada: se lee, nunca se edita aquí. */
function officialCodingLabel(coding: TreatmentTemplateItem["codings"][number]): string {
  return `${coding.code} (${coding.system} · edición ${coding.version})`
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
}
/**
 * Superficie del tarifario: el mismo formulario en panel lateral o drawer, y el
 * detalle de lectura para quien no escribe. Un solo contenedor por vez —montar
 * panel y drawer juntos duplicaría los `id`/`htmlFor` de los campos— y el shell
 * aporta cabecera, scroll y pie de acciones (Cancelar + Guardar).
 */
function OfferEditor({
  offer,
  asPanel,
  open,
  canWrite,
  onClose,
  orgCurrency,
  orgLocale,
}: OfferEditorProps) {
  const queryClient = useQueryClient()
  const [resolveMode, setResolveMode] = useState<"plantilla" | "propia">("plantilla")
  /** La tarifa se escribe y lee con la moneda y el formato de la clínica. */
  const currency = offer?.currency ?? orgCurrency
  const templateId = offer?.templateId ?? null
  const isTemplate = offer?.source === "template"
  const isLegacy = offer?.source === "legacy"
  /** Vincular una plantilla no se envía desde el formulario: cada fila vincula al instante. */
  const pickingTemplate = isLegacy && resolveMode === "plantilla"

  /**
   * Plantilla vinculada por ID directo (incluye retiradas en solo lectura).
   * Los mapeos llegan con el primario primero: se usa `codings[0]`.
   */
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
  const linkedCoding = linkedTemplate?.codings[0] ?? null

  const saveMutation = useMutation({
    mutationFn: (values: OfferFormValues) => {
      const body = {
        name: values.name.trim(),
        code: values.code.trim() === "" ? null : values.code.trim(),
        priceCents: parseMoney(values.price, currency, orgLocale),
        durationMin: values.durationMin.trim() === "" ? null : Number(values.durationMin),
        billingMode: values.billingMode,
        priceDisclosure: values.priceDisclosure,
        evaluationServiceId: values.evaluationServiceId === "" ? null : values.evaluationServiceId,
      }
      if (!offer) {
        return createServiceApi({ ...body, specialty: values.specialty, scope: values.scope })
      }
      return updateServiceApi(offer.id, {
        ...body,
        // Especialidad y ámbito de una oferta de la biblioteca vienen de su plantilla.
        ...(isTemplate ? {} : { specialty: values.specialty, scope: values.scope }),
        // Confirmar una heredada como propia la desvincula y la deja activa.
        ...(isLegacy ? { templateId: null, isActive: true } : {}),
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success(offer ? "Servicio actualizado" : "Servicio guardado y activo")
      onClose()
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const form = useOfferForm(offer, open, async (value) => {
    await saveMutation.mutateAsync(value)
  }, orgLocale)
  // Suscripción explícita: la página no se entera de los cambios de meta del
  // formulario por sí sola, y el cierre protegido necesita saber si hay cambios.
  const isDirty = useStore(form.store, (state) => !state.isDefaultValue)

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
          <Badge variant="outline">Prestación de la clínica</Badge>
        )}
      </div>
      {isTemplate && offer && templateName && templateName !== offer.name ? (
        <p className="text-xs text-muted-foreground">Variante de «{templateName}»</p>
      ) : null}
      {isTemplate ? (
        linkedCoding ? (
          <p className="text-xs text-muted-foreground">
            Código oficial {linkedCoding.system}{" "}
            <span className="font-mono">{linkedCoding.code}</span>
            {" · "}edición {linkedCoding.version} · «{linkedCoding.display}». El precio y el nombre
            comercial de esta oferta son propios de la clínica y no alteran el código oficial.
          </p>
        ) : linkedTemplateQuery.isPending ? (
          <Skeleton className="h-3 w-56" />
        ) : (
          <p className="text-xs text-muted-foreground">
            Oferta vinculada a la biblioteca; el código oficial se consulta en la biblioteca.
          </p>
        )
      ) : null}
      {offer?.source === "custom" ? (
        <p className="text-xs text-muted-foreground">
          Prestación propia de la clínica, sin código oficial asociado.
        </p>
      ) : null}
    </div>
  )

  const fields = (
    <div className="flex flex-col gap-4">
      {isLegacy ? (
        <LegacyNote>
          <RadioChips
            aria-label="Cómo resolverla"
            value={resolveMode}
            options={RESOLVE_OPTIONS}
            onChange={setResolveMode}
          />
          {pickingTemplate && offer ? (
            <LegacyTemplatePicker offer={offer} onLinked={onClose} />
          ) : null}
        </LegacyNote>
      ) : null}
      {pickingTemplate ? null : (
        <>
          <OfferFields
            form={form}
            offer={offer}
            allowSpecialtyScope={!isTemplate}
            currency={currency}
            locale={orgLocale}
          />
          {offer ? <OfferDetails offer={offer} linkedCoding={linkedCoding} /> : null}
        </>
      )}
    </div>
  )

  // Quien no escribe lee la prestación en el detalle de lectura: mismos datos,
  // sin campos que no puede guardar.
  if (offer && !canWrite) {
    return asPanel ? (
      <DetailPanel title={offer.name} headerContent={headerContent} onClose={onClose}>
        <OfferReadOnly offer={offer} linkedCoding={linkedCoding} locale={orgLocale} />
      </DetailPanel>
    ) : (
      <DetailDrawer open={open} title={offer.name} headerContent={headerContent} onClose={onClose}>
        <OfferReadOnly offer={offer} linkedCoding={linkedCoding} locale={orgLocale} />
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
    submitLabel: !offer
      ? "Guardar y activar"
      : isLegacy
        ? "Confirmar y reactivar"
        : common.actions.save,
    hideSubmit: pickingTemplate,
    onSubmit: (event: FormEvent) => {
      event.preventDefault()
      if (pickingTemplate) return
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

/** Aviso de la prestación heredada: sin resolver no sirve para nuevas indicaciones. */
function LegacyNote({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3" role="note">
      <p className="text-sm">
        Prestación heredada del catálogo anterior: conserva nombre, código y precio como registro
        previo. Vincúlala a la biblioteca o confírmala como propia antes de reactivarla; no se usa
        para nuevas indicaciones hasta entonces.
      </p>
      {children}
    </div>
  )
}

/** Detalle de lectura de una prestación, para quien no puede escribir. */
function OfferReadOnly({
  offer,
  linkedCoding,
  locale,
}: {
  offer: ServiceCatalogItem
  linkedCoding: TreatmentTemplateItem["codings"][number] | null
  locale: string
}) {
  return (
    <div className="flex flex-col gap-4">
      {offer.source === "legacy" ? <LegacyNote /> : null}
      <DetailList>
        <DetailField label="Código interno">{offer.code}</DetailField>
        {offer.source === "template" ? (
          <DetailField label="Código oficial">
            {linkedCoding ? officialCodingLabel(linkedCoding) : "Ver en la biblioteca"}
          </DetailField>
        ) : null}
        <DetailField label={`Precio (${offer.currency})`}>
          {formatMoney(offer.priceCents, offer.currency, locale)}
        </DetailField>
        <DetailField label="Se cobra">{BILLING_MODE_LABELS[offer.billingMode]}</DetailField>
        <DetailField label="Cómo dice el precio el agente">
          {PRICE_DISCLOSURE_OPTIONS.find((option) => option.value === offer.priceDisclosure)?.label}
        </DetailField>
        <DetailField label="Duración">
          {offer.durationMin === null ? null : `${offer.durationMin} min`}
        </DetailField>
        <DetailField label="Especialidad">
          {offer.specialty
            ? (TREATMENT_SPECIALTY_LABELS[offer.specialty] ?? offer.specialty)
            : null}
        </DetailField>
        <DetailField label="Ámbito">
          {offer.scope ? (TREATMENT_SCOPE_LABELS[offer.scope] ?? offer.scope) : null}
        </DetailField>
        <DetailField label="Estado">{offer.isActive ? "Activa" : "Inactiva"}</DetailField>
      </DetailList>
    </div>
  )
}

/** Datos que el formulario no edita, plegados para no cargar la tarjeta. */
function OfferDetails({
  offer,
  linkedCoding,
}: {
  offer: ServiceCatalogItem
  linkedCoding: TreatmentTemplateItem["codings"][number] | null
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
          <DetailField label="Código interno">{offer.code}</DetailField>
          {offer.source === "template" ? (
            <DetailField label="Código oficial">
              {linkedCoding ? officialCodingLabel(linkedCoding) : "Ver en la biblioteca"}
            </DetailField>
          ) : null}
          <DetailField label="Duración">
            {offer.durationMin === null ? null : `${offer.durationMin} min`}
          </DetailField>
          <DetailField label="Moneda">{offer.currency}</DetailField>
          <DetailField label="Especialidad">
            {offer.specialty
              ? (TREATMENT_SPECIALTY_LABELS[offer.specialty] ?? offer.specialty)
              : null}
          </DetailField>
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
}: {
  form: OfferForm
  /** Oferta editada; `null` es el alta de una prestación propia. */
  offer: ServiceCatalogItem | null
  allowSpecialtyScope: boolean
  /** Moneda de la oferta; en el alta, la de la clínica. */
  currency: string
  /** Formato de la clínica para escribir el importe. */
  locale: string
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
      {isTemplate ? (
        <p className="text-xs text-muted-foreground">
          La especialidad y el ámbito se derivan de la plantilla y no se editan aquí.
        </p>
      ) : null}
      {allowSpecialtyScope ? (
        <div className="grid grid-cols-2 gap-3">
          <form.Field name="specialty" validators={{ onChange: offerSchema.shape.specialty }}>
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-esp`}>Especialidad</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v ?? "")}
                >
                  <SelectTrigger id={`${idPrefix}-esp`}>
                    <SelectValue placeholder="Elige" />
                  </SelectTrigger>
                  <SelectContent>
                    {TREATMENT_SPECIALTIES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {TREATMENT_SPECIALTY_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
              </Field>
            )}
          </form.Field>
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
        </div>
      ) : null}
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
            {isTemplate ? (
              <p className="text-xs text-muted-foreground">
                Solo uso interno de la clínica. El código oficial de la biblioteca no se edita aquí.
              </p>
            ) : null}
          </Field>
        )}
      </form.Field>
    </>
  )
}

/**
 * Vinculación de una prestación heredada: elegir plantilla la desvincula del
 * origen anterior y la reactiva. La mutación vive aquí porque vincular exige
 * una oferta, y en el formulario la oferta puede ser el alta de una nueva.
 */
function LegacyTemplatePicker({
  offer,
  onLinked,
}: {
  offer: ServiceCatalogItem
  onLinked: () => void
}) {
  const queryClient = useQueryClient()
  const linkMutation = useMutation({
    mutationFn: (templateId: string) => updateServiceApi(offer.id, { templateId, isActive: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success("Prestación vinculada y reactivada")
      onLinked()
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  return (
    <LegacyTemplateLink
      pending={linkMutation.isPending}
      onSelect={(id) => linkMutation.mutate(id)}
    />
  )
}

function LegacyTemplateLink({
  pending,
  onSelect,
}: {
  pending: boolean
  onSelect: (id: string) => void
}) {
  const [q, setQ] = useState("")
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  const search = q.trim()
  /** Cambiar la búsqueda vuelve a la primera página del listado de plantillas. */
  const searchTemplates = (value: string) => {
    setQ(value)
    setCursor(undefined)
    setPreviousCursors([])
  }
  const templatesQuery = useQuery({
    queryKey: ["services", "templates", "link", search, cursor],
    queryFn: () => fetchTreatmentTemplates({ q: search || undefined, limit: 10, cursor }),
    staleTime: 60_000,
  })
  const rows = templatesQuery.data?.data ?? []
  const total = templatesQuery.data?.total ?? rows.length
  const catalog = templatesQuery.data?.catalog ?? null
  const nextCursor = templatesQuery.data?.nextCursor ?? null
  const goNext = () => {
    if (!nextCursor) return
    setPreviousCursors((stack) => [...stack, cursor ?? ""])
    setCursor(nextCursor)
  }
  const goPrevious = () => {
    const copy = [...previousCursors]
    const previous = copy.pop()
    setPreviousCursors(copy)
    setCursor(previous || undefined)
  }
  return (
    <div className="flex flex-col gap-2">
      <Input
        value={q}
        onChange={(event) => searchTemplates(event.target.value)}
        placeholder="Buscar por código o nombre…"
        aria-label="Buscar plantilla por código o nombre"
      />
      {catalog ? (
        <p className="text-xs text-muted-foreground">
          {catalog.system} · edición {catalog.version}
        </p>
      ) : null}
      {templatesQuery.isPending ? (
        <LoadingState />
      ) : templatesQuery.isError ? (
        <ErrorState
          message="No se pudo cargar la biblioteca"
          onRetry={() => void templatesQuery.refetch()}
        />
      ) : (
        <>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {rows.map((tpl) => {
              const coding = tpl.codings[0]
              return (
                <li key={tpl.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start py-2 text-left"
                    disabled={pending}
                    onClick={() => onSelect(tpl.id)}
                  >
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="font-medium break-words">{tpl.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {coding ? (
                          <>
                            <span className="font-mono">{coding.code}</span> ·{" "}
                          </>
                        ) : null}
                        {TREATMENT_SPECIALTY_LABELS[tpl.specialty] ?? tpl.specialty} ·{" "}
                        {TREATMENT_SCOPE_LABELS[tpl.scope] ?? tpl.scope}
                      </span>
                    </span>
                  </Button>
                </li>
              )
            })}
            {rows.length === 0 ? (
              <li className="text-sm text-muted-foreground">Sin resultados.</li>
            ) : null}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{total} resultado(s) con este filtro</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={previousCursors.length === 0 || templatesQuery.isFetching}
                onClick={goPrevious}
              >
                {common.filters.previous}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!nextCursor || templatesQuery.isFetching}
                onClick={goNext}
              >
                {common.filters.next}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * «Cómo dice el precio el agente» (ADR 0021): solo cambia lo que se le dice a
 * una persona; caja y presupuesto usan siempre la tarifa. Con «Desde» o «Solo
 * con evaluación» se elige qué evaluación ofrece.
 */
function PriceDisclosureFields({ form, idPrefix, offerId }: { form: OfferForm; idPrefix: string; offerId: string | null }) {
  const disclosure = useStore(form.store, (state) => state.values.priceDisclosure)
  const evaluationsQuery = useQuery({
    queryKey: ["services", "evaluation-options"],
    queryFn: () => fetchServices({ state: "active", limit: 100 }),
    enabled: disclosure !== "exacto",
    staleTime: 60_000,
  })
  const evaluations = (evaluationsQuery.data?.data ?? []).filter((item) => item.id !== offerId)
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border p-3">
      <legend id={`${idPrefix}-precio-agente`} className="px-1 text-sm font-semibold">
        Cómo dice el precio el agente
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
              <FieldLabel htmlFor={`${idPrefix}-evaluacion`}>Evaluación que ofrece</FieldLabel>
              <ChoiceSelect
                id={`${idPrefix}-evaluacion`}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                disabled={evaluationsQuery.isPending}
              >
                <option value="">Ninguna en particular: ofrece agendar una evaluación</option>
                {evaluations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </ChoiceSelect>
            </Field>
          )}
        </form.Field>
      )}
    </fieldset>
  )
}
