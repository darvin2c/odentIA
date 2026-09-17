import {
  Badge,
  Button,
  Checkbox,
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  FieldError as UiFieldError,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  fieldErrorMessages,
  LoadingState,
  PageHeader,
  RowActions,
  useListSearch,
  PageShell,
} from "@odentia/ui-patterns"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ChevronDown, Library, Plus, Tag } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { useCanWrite } from "../../lib/crm"
import {
  createServiceApi,
  fetchServices,
  fetchTreatmentTemplate,
  fetchTreatmentTemplates,
  formatMoney,
  formatPriceInput,
  incorporateTemplatesApi,
  parsePriceToCents,
  type ServiceCatalogItem,
  TREATMENT_SCOPE_LABELS,
  TREATMENT_SPECIALTIES,
  TREATMENT_SPECIALTY_LABELS,
  type TreatmentTemplateCatalog,
  type TreatmentTemplateItem,
  updateServiceApi,
} from "../../lib/services"

/** Muestra el primer mensaje de validación de TanStack Form. */
function FieldError({ errors }: { errors: unknown }) {
  return <UiFieldError>{fieldErrorMessages(errors)[0]}</UiFieldError>
}

export const Route = createFileRoute("/_org/services")({
  component: ServicesPage,
})

const orgRouteApi = getRouteApi("/_org")

const SPECIALTY_OPTIONS = [
  { value: "todas", label: "Todas" },
  ...TREATMENT_SPECIALTIES.map((s) => ({ value: s, label: TREATMENT_SPECIALTY_LABELS[s] ?? s })),
]

const STATE_OPTIONS = [
  { value: "active", label: "Activas" },
  { value: "inactive", label: "Inactivas" },
  { value: "unpriced", label: "Sin tarifa" },
  { value: "legacy", label: "Pendientes de revisar" },
]

const TARIFARIO_SORT_OPTIONS = [
  { value: "nombre", label: "Nombre" },
  { value: "precio", label: "Precio" },
  { value: "ambito", label: "Ámbito" },
]
const BIBLIOTECA_PAGE_LIMIT = 20

/** Tope de incorporación por envío: la API acepta 100 identificadores como máximo. */
const MAX_LIBRARY_SELECTION = 100

function stateLabel(state: string): string {
  return STATE_OPTIONS.find((o) => o.value === state)?.label ?? state
}

function priceLabel(item: ServiceCatalogItem): string {
  if (item.priceCents === null) return "Sin tarifa"
  return formatMoney(item.priceCents, item.currency)
}

function ServicesPage() {
  const { org } = orgRouteApi.useRouteContext()
  const canWrite = useCanWrite()
  const [view, setView] = useState<"tarifario" | "biblioteca">("tarifario")

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Tratamientos y tarifas"
        subtitle={`${org.name} · prestaciones de la clínica y su tarifa`}
      />
      <Tabs
        value={view}
        onValueChange={(next) => setView(next === "biblioteca" ? "biblioteca" : "tarifario")}
      >
        <TabsList>
          <TabsTrigger value="tarifario">Tarifario de la clínica</TabsTrigger>
          <TabsTrigger value="biblioteca">Biblioteca de prestaciones</TabsTrigger>
        </TabsList>
        <TabsContent value="tarifario">
          <TarifarioView canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="biblioteca">
          <BibliotecaView canWrite={canWrite} />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}

/* ------------------------------- Tarifario -------------------------------- */

function TarifarioView({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const specialtyFilter = listSearch.get("especialidad") ?? "todas"
  const estadoFilter = listSearch.get("estado") ?? "active"
  const sortParam = listSearch.get("sort") ?? ""
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [toggling, setToggling] = useState<ServiceCatalogItem | null>(null)

  const pagesQuery = useQuery({
    queryKey: ["services", "tarifario", search, specialtyFilter, estadoFilter],
    queryFn: () =>
      fetchServices({
        q: search.trim() || undefined,
        specialty: specialtyFilter === "todas" ? undefined : specialtyFilter,
        state: estadoFilter as "active" | "inactive" | "unpriced" | "legacy",
        limit: 100,
      }),
  })

  const rows = useMemo(() => pagesQuery.data?.data ?? [], [pagesQuery.data])
  const selected = rows.find((row) => row.id === selectedId) ?? null

  const sortedRows = useMemo(() => {
    if (!sortParam) return rows
    const desc = sortParam.startsWith("-")
    const field = desc ? sortParam.slice(1) : sortParam
    const factor = desc ? -1 : 1
    return [...rows].sort((a, b) => {
      if (field === "precio") {
        if (a.priceCents === null && b.priceCents === null) return 0
        if (a.priceCents === null) return 1
        if (b.priceCents === null) return -1
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

  const openDetail = (row: ServiceCatalogItem) => {
    setSelectedId(row.id)
    setSheetOpen(true)
  }
  const columns = useMemo<ColumnDef<ServiceCatalogItem>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Prestación",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="font-medium break-words">{row.original.name}</span>
            {row.original.source === "template" ? (
              <span className="text-xs text-muted-foreground">
                De la biblioteca · nombre comercial editable
              </span>
            ) : row.original.source === "legacy" ? (
              <span className="text-xs text-muted-foreground">Heredada · pendiente de revisar</span>
            ) : (
              <span className="text-xs text-muted-foreground">
                Prestación propia de la clínica · sin código oficial asociado
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
          row.original.priceCents === null ? (
            <Badge variant="secondary">Sin tarifa</Badge>
          ) : (
            formatMoney(row.original.priceCents, row.original.currency)
          ),
      },
      {
        accessorKey: "isActive",
        header: "Activa",
        cell: ({ getValue }) => (
          <Badge variant={getValue<boolean>() ? "success" : "secondary"}>
            {getValue<boolean>() ? "Sí" : "No"}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canWrite ? (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[
                {
                  key: "edit",
                  label: "Ver y editar",
                  onSelect: () => openDetail(row.original),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canWrite],
  )

  const hasFilters = search.trim() !== "" || specialtyFilter !== "todas" || sortParam !== ""

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        filters={[
          {
            key: "especialidad",
            label: "Especialidad",
            type: "select",
            options: SPECIALTY_OPTIONS,
          },
          { key: "estado", label: "Estado", type: "select", options: STATE_OPTIONS },
        ]}
        sortOptions={TARIFARIO_SORT_OPTIONS}
        searchPlaceholder="Buscar por nombre o código interno"
      />
      {canWrite ? (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden />
            Nueva prestación propia
          </Button>
        </div>
      ) : null}

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
          title="Sin prestaciones en el tarifario"
          description="Incorpora prestaciones desde la biblioteca o crea una prestación propia. Sin tarifa no se puede cotizar: no es gratuita, falta configurarla."
          actionLabel="Ir a la biblioteca"
          onAction={() =>
            document.querySelector<HTMLButtonElement>('[value="biblioteca"]')?.click()
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="Sin resultados"
          description={`Ninguna prestación ${stateLabel(estadoFilter).toLowerCase()} coincide con la búsqueda.`}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]">
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
                  onSelect={openDetail}
                  selectedId={selectedId}
                />
              </section>
            ))}
          </div>
          <aside className="hidden lg:block" aria-label="Detalle de la prestación">
            {selected ? (
              <OfferDetail
                key={selected.id}
                offer={selected}
                canWrite={canWrite}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Elige una prestación del listado para ver su detalle y editar su tarifa.
              </p>
            )}
          </aside>
        </div>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          className="w-full sm:max-w-lg lg:hidden"
          aria-label="Detalle de la prestación"
        >
          <SheetHeader>
            <SheetTitle>{selected?.name ?? "Prestación"}</SheetTitle>
          </SheetHeader>
          {selected ? (
            <OfferDetail
              key={selected.id}
              offer={selected}
              canWrite={canWrite}
              onClose={() => setSheetOpen(false)}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      {canWrite ? (
        <CreateOfferDrawer open={createOpen} onClose={() => setCreateOpen(false)} />
      ) : null}

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
  selectedId,
}: {
  rows: ServiceCatalogItem[]
  columns: ColumnDef<ServiceCatalogItem>[]
  onSelect: (row: ServiceCatalogItem) => void
  selectedId: string | null
}) {
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  void selectedId
  return <DataTable table={table} onRowClick={onSelect} />
}

/* ----------------------------- Detalle / edición --------------------------- */

const offerSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre").max(200, "Máximo 200 caracteres"),
  code: z.string().max(40, "Máximo 40 caracteres"),
  price: z.string().refine(
    (value) => {
      if (value.trim() === "") return true
      try {
        parsePriceToCents(value)
        return true
      } catch {
        return false
      }
    },
    { message: "Tarifa inválida: usa números con hasta 2 decimales" },
  ),
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
  isActive: z.boolean(),
})

type OfferFormValues = z.infer<typeof offerSchema>

function toOfferValues(item: ServiceCatalogItem): OfferFormValues {
  return {
    name: item.name,
    code: item.code ?? "",
    price: item.priceCents === null ? "" : formatPriceInput(item.priceCents),
    durationMin: item.durationMin === null ? "" : String(item.durationMin),
    specialty: item.specialty ?? "",
    scope: item.scope ?? "",
    isActive: item.isActive,
  }
}
function useOfferForm(
  offer: ServiceCatalogItem,
  onSubmit: (value: OfferFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues: toOfferValues(offer),
    validators: { onSubmit: offerSchema },
    onSubmit: async ({ value }) => {
      await onSubmit(value)
    },
  })
}

type OfferForm = ReturnType<typeof useOfferForm>

function OfferDetail({
  offer,
  canWrite,
  onClose,
}: {
  offer: ServiceCatalogItem
  canWrite: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [resolveMode, setResolveMode] = useState<"plantilla" | "propia">("plantilla")

  /**
   * Plantilla vinculada por ID directo (incluye retiradas en solo lectura).
   * Los mapeos llegan con el primario primero: se usa `codings[0]`.
   */
  const linkedTemplateQuery = useQuery({
    queryKey: ["services", "templates", "linked", offer.templateId],
    enabled: offer.templateId !== null,
    staleTime: 300_000,
    queryFn: async (): Promise<TreatmentTemplateItem | null> => {
      const target = offer.templateId
      if (!target) return null
      try {
        const page = await fetchTreatmentTemplate(target)
        return page.data
      } catch {
        return null
      }
    },
  })
  const linkedTemplate = offer.templateId ? (linkedTemplateQuery.data ?? null) : null
  const templateName = linkedTemplate?.name ?? null
  const linkedCoding = linkedTemplate?.codings[0] ?? null

  const saveMutation = useMutation({
    mutationFn: (values: OfferFormValues) =>
      updateServiceApi(offer.id, {
        name: values.name.trim(),
        code: values.code.trim() === "" ? null : values.code.trim(),
        priceCents: values.price.trim() === "" ? null : parsePriceToCents(values.price),
        durationMin: values.durationMin.trim() === "" ? null : Number(values.durationMin),
        ...(offer.source === "custom" ? { specialty: values.specialty, scope: values.scope } : {}),
        ...(offer.source === "legacy"
          ? { templateId: null, specialty: values.specialty, scope: values.scope, isActive: true }
          : { isActive: values.isActive }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success("Prestación actualizada")
      onClose()
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const linkTemplateMutation = useMutation({
    mutationFn: (templateId: string) => updateServiceApi(offer.id, { templateId, isActive: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success("Prestación vinculada y reactivada")
      onClose()
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const form = useOfferForm(offer, async (value) => {
    await saveMutation.mutateAsync(value)
  })
  const isTemplate = offer.source === "template"
  const isLegacy = offer.source === "legacy"

  return (
    <div className="flex flex-col gap-4 rounded-xl border p-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={offer.isActive ? "success" : "secondary"}>
            {offer.isActive ? "Activa" : "Inactiva"}
          </Badge>
          <Badge variant="outline">
            {isLegacy
              ? "Heredada"
              : offer.source === "custom"
                ? "Prestación de la clínica"
                : "De la biblioteca"}
          </Badge>
          {offer.priceCents === null && !isLegacy ? (
            <Badge variant="secondary">Sin tarifa</Badge>
          ) : null}
        </div>
        {isTemplate && templateName && templateName !== offer.name ? (
          <p className="text-xs text-muted-foreground">Variante de «{templateName}»</p>
        ) : null}
        {isTemplate ? (
          linkedCoding ? (
            <p className="text-xs text-muted-foreground">
              Código oficial {linkedCoding.system}{" "}
              <span className="font-mono">{linkedCoding.code}</span>
              {" · "}edición {linkedCoding.version} · «{linkedCoding.display}». La tarifa y el
              nombre comercial de esta oferta son propios de la clínica y no alteran el código
              oficial.
            </p>
          ) : linkedTemplateQuery.isPending ? (
            <p className="text-xs text-muted-foreground">Buscando el código oficial vinculado…</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Oferta vinculada a la biblioteca; el código oficial se consulta en la biblioteca.
            </p>
          )
        ) : null}
        {offer.source === "custom" ? (
          <p className="text-xs text-muted-foreground">
            Prestación propia de la clínica, sin código oficial asociado.
          </p>
        ) : null}
      </div>

      {isLegacy ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3" role="note">
          <p className="text-sm">
            Prestación heredada del catálogo anterior: conserva nombre, código y precio como
            registro previo. Vincúlala a la biblioteca o confírmala como propia antes de
            reactivarla; no se usa para nuevas indicaciones hasta entonces.
          </p>
          {canWrite ? (
            <>
              <div className="flex gap-2" role="tablist" aria-label="Modo de resolución">
                <Button
                  type="button"
                  size="sm"
                  variant={resolveMode === "plantilla" ? "default" : "outline"}
                  onClick={() => setResolveMode("plantilla")}
                >
                  Vincular plantilla
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={resolveMode === "propia" ? "default" : "outline"}
                  onClick={() => setResolveMode("propia")}
                >
                  Confirmar propia
                </Button>
              </div>
              {resolveMode === "plantilla" ? (
                <LegacyTemplateLink
                  pending={linkTemplateMutation.isPending}
                  onSelect={(id) => linkTemplateMutation.mutate(id)}
                />
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void form.handleSubmit()
                  }}
                  className="flex flex-col gap-3"
                >
                  <OfferFields form={form} offer={offer} allowSpecialtyScope />
                  <FormActions
                    pending={saveMutation.isPending}
                    submitLabel="Confirmar y reactivar"
                    onCancel={() => {
                      form.reset()
                      onClose()
                    }}
                  />
                </form>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {(!isLegacy || (isLegacy && canWrite && resolveMode === "propia")) && !isLegacy ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
          className="flex flex-col gap-3"
        >
          <OfferFields form={form} offer={offer} allowSpecialtyScope={offer.source === "custom"} />
          {canWrite ? (
            <FormActions
              pending={saveMutation.isPending}
              submitLabel="Guardar cambios"
              onCancel={() => {
                form.reset()
                onClose()
              }}
            />
          ) : null}
        </form>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger className="text-sm font-medium">
          <span className="flex items-center gap-1">
            Detalles <ChevronDown aria-hidden className="size-4" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Código interno</dt>
            <dd>{offer.code ?? "—"}</dd>
            {isTemplate ? (
              <>
                <dt className="text-muted-foreground">Código oficial</dt>
                <dd>
                  {linkedCoding ? (
                    <>
                      <span className="font-mono">{linkedCoding.code}</span>{" "}
                      <span className="text-muted-foreground">
                        ({linkedCoding.system} · {linkedCoding.version})
                      </span>
                    </>
                  ) : (
                    "Ver en la biblioteca"
                  )}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Duración</dt>
            <dd>{offer.durationMin === null ? "—" : `${offer.durationMin} min`}</dd>
            <dt className="text-muted-foreground">Moneda</dt>
            <dd>{offer.currency}</dd>
            <dt className="text-muted-foreground">Especialidad</dt>
            <dd>
              {offer.specialty
                ? (TREATMENT_SPECIALTY_LABELS[offer.specialty] ?? offer.specialty)
                : "—"}
            </dd>
          </dl>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function OfferFields({
  form,
  offer,
  allowSpecialtyScope,
}: {
  form: OfferForm
  offer: ServiceCatalogItem
  allowSpecialtyScope: boolean
}) {
  const isTemplate = offer.source === "template"
  return (
    <>
      <form.Field
        name="name"
        validators={{ onChange: offerSchema.shape.name }}
        children={(field) => (
          <Field>
            <FieldLabel htmlFor={`${offer.id}-nombre`}>Nombre comercial</FieldLabel>
            <Input
              id={`${offer.id}-nombre`}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
          </Field>
        )}
      />
      {isTemplate ? (
        <p className="text-xs text-muted-foreground">
          La especialidad y el ámbito se derivan de la plantilla y no se editan aquí.
        </p>
      ) : null}
      {allowSpecialtyScope ? (
        <div className="grid grid-cols-2 gap-3">
          <form.Field
            name="specialty"
            validators={{ onChange: offerSchema.shape.specialty }}
            children={(field) => (
              <Field>
                <FieldLabel htmlFor={`${offer.id}-esp`}>Especialidad</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v ?? "")}
                >
                  <SelectTrigger id={`${offer.id}-esp`}>
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
          />
          <form.Field
            name="scope"
            validators={{ onChange: offerSchema.shape.scope }}
            children={(field) => (
              <Field>
                <FieldLabel htmlFor={`${offer.id}-ambito`}>Ámbito</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(v) => field.handleChange(v ?? "")}
                >
                  <SelectTrigger id={`${offer.id}-ambito`}>
                    <SelectValue placeholder="Elige" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TREATMENT_SCOPE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
              </Field>
            )}
          />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <form.Field
          name="price"
          validators={{ onChange: offerSchema.shape.price }}
          children={(field) => (
            <Field>
              <FieldLabel htmlFor={`${offer.id}-precio`}>Tarifa ({offer.currency})</FieldLabel>
              <Input
                id={`${offer.id}-precio`}
                inputMode="decimal"
                placeholder="Sin tarifa"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
              <p className="text-xs text-muted-foreground">
                Vacío = Sin tarifa (no cotizable, no gratuita).
              </p>
            </Field>
          )}
        />
        <form.Field
          name="durationMin"
          validators={{ onChange: offerSchema.shape.durationMin }}
          children={(field) => (
            <Field>
              <FieldLabel htmlFor={`${offer.id}-dur`}>Duración (min)</FieldLabel>
              <Input
                id={`${offer.id}-dur`}
                inputMode="numeric"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            </Field>
          )}
        />
      </div>
      <form.Field
        name="code"
        validators={{ onChange: offerSchema.shape.code }}
        children={(field) => (
          <Field>
            <FieldLabel htmlFor={`${offer.id}-codigo`}>
              {isTemplate ? "Código interno de la clínica (opcional)" : "Código interno (opcional)"}
            </FieldLabel>
            <Input
              id={`${offer.id}-codigo`}
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
      />
    </>
  )
}

function FormActions({
  pending,
  submitLabel,
  onCancel,
}: {
  pending: boolean
  submitLabel: string
  onCancel: () => void
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancelar
      </Button>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando…" : submitLabel}
      </Button>
    </div>
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
  useEffect(() => {
    setCursor(undefined)
    setPreviousCursors([])
  }, [search])
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
        onChange={(event) => setQ(event.target.value)}
        placeholder="Buscar por código o nombre…"
        aria-label="Buscar plantilla por código o nombre"
      />
      {catalog ? (
        <p className="text-xs text-muted-foreground">
          {catalog.system} · edición {catalog.version}
        </p>
      ) : null}
      {templatesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : templatesQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          No se pudo cargar la biblioteca.{" "}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void templatesQuery.refetch()}
          >
            Reintentar
          </Button>
        </p>
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
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!nextCursor || templatesQuery.isFetching}
                onClick={goNext}
              >
                {templatesQuery.isFetching ? "Cargando…" : "Siguiente"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* --------------------------- Alta de prestación propia --------------------- */

const createSchema = z.object({
  name: z.string().min(1, "Ingresa el nombre").max(200, "Máximo 200 caracteres"),
  specialty: z.string().min(1, "Elige la especialidad"),
  scope: z.string().min(1, "Elige el ámbito"),
  code: z.string().max(40, "Máximo 40 caracteres"),
  price: z.string().refine(
    (value) => {
      if (value.trim() === "") return true
      try {
        parsePriceToCents(value)
        return true
      } catch {
        return false
      }
    },
    { message: "Tarifa inválida: usa números con hasta 2 decimales" },
  ),
  durationMin: z.string().refine(
    (value) => {
      if (value.trim() === "") return true
      const n = Number(value)
      return Number.isInteger(n) && n >= 1 && n <= 1440
    },
    { message: "Duración: minutos enteros entre 1 y 1440" },
  ),
})

type CreateValues = z.infer<typeof createSchema>

function CreateOfferDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const createMutation = useMutation({
    mutationFn: (values: CreateValues) =>
      createServiceApi({
        name: values.name.trim(),
        specialty: values.specialty,
        scope: values.scope,
        code: values.code.trim() === "" ? null : values.code.trim(),
        priceCents: values.price.trim() === "" ? null : parsePriceToCents(values.price),
        durationMin: values.durationMin.trim() === "" ? null : Number(values.durationMin),
      }),
    onSuccess: async () => {
      onClose()
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      toast.success("Prestación creada")
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const form = useForm({
    defaultValues: {
      name: "",
      specialty: "",
      scope: "",
      code: "",
      price: "",
      durationMin: "",
    } as CreateValues,
    validators: { onSubmit: createSchema },
    onSubmit: async ({ value }) => {
      await createMutation.mutateAsync(value)
    },
  })

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Nueva prestación propia"
      description="Prestación de la clínica con su tarifa. Sin código obligatorio."
      onSubmit={() => void form.handleSubmit()}
      submitLabel={createMutation.isPending ? "Guardando…" : "Crear prestación"}
      submitDisabled={createMutation.isPending}
    >
      <form.Field
        name="name"
        validators={{ onChange: createSchema.shape.name }}
        children={(field) => (
          <Field>
            <FieldLabel htmlFor="nueva-nombre">Nombre</FieldLabel>
            <Input
              id="nueva-nombre"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
          </Field>
        )}
      />
      <div className="grid grid-cols-2 gap-3">
        <form.Field
          name="specialty"
          validators={{ onChange: createSchema.shape.specialty }}
          children={(field) => (
            <Field>
              <FieldLabel htmlFor="nueva-esp">Especialidad</FieldLabel>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v ?? "")}>
                <SelectTrigger id="nueva-esp">
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
        />
        <form.Field
          name="scope"
          validators={{ onChange: createSchema.shape.scope }}
          children={(field) => (
            <Field>
              <FieldLabel htmlFor="nueva-ambito">Ámbito</FieldLabel>
              <Select value={field.state.value} onValueChange={(v) => field.handleChange(v ?? "")}>
                <SelectTrigger id="nueva-ambito">
                  <SelectValue placeholder="Elige" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TREATMENT_SCOPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            </Field>
          )}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <form.Field
          name="price"
          validators={{ onChange: createSchema.shape.price }}
          children={(field) => (
            <Field>
              <FieldLabel htmlFor="nueva-precio">Tarifa</FieldLabel>
              <Input
                id="nueva-precio"
                inputMode="decimal"
                placeholder="Sin tarifa"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            </Field>
          )}
        />
        <form.Field
          name="durationMin"
          validators={{ onChange: createSchema.shape.durationMin }}
          children={(field) => (
            <Field>
              <FieldLabel htmlFor="nueva-dur">Duración (min)</FieldLabel>
              <Input
                id="nueva-dur"
                inputMode="numeric"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
              <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
            </Field>
          )}
        />
      </div>
      <form.Field
        name="code"
        validators={{ onChange: createSchema.shape.code }}
        children={(field) => (
          <Field>
            <FieldLabel htmlFor="nueva-codigo">Código interno (opcional)</FieldLabel>
            <Input
              id="nueva-codigo"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
            <FieldError errors={fieldErrorMessages(field.state.meta.errors)} />
          </Field>
        )}
      />
    </FormDrawer>
  )
}

/* -------------------------------- Biblioteca ------------------------------- */

/** Todos los templateId ya incorporados (recorre el cursor de cada estado). */
async function fetchAllOwnedTemplateIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const state of ["active", "inactive", "unpriced"] as const) {
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

function BibliotecaView({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const specialtyFilter = listSearch.get("especialidad") ?? "todas"
  const cursor = listSearch.get("cursor")
  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  const [checked, setChecked] = useState<string[]>([])

  useEffect(() => {
    if (!cursor) setPreviousCursors([])
  }, [cursor])

  // Al cambiar búsqueda o filtro se vuelve a la primera página: el cursor anterior
  // pertenece al resultado previo y la selección por página se conserva aparte.
  const filterKey = `${search}||${specialtyFilter}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current === filterKey) return
    prevFilterKey.current = filterKey
    setPreviousCursors([])
    if (cursor) listSearch.setParam("cursor", undefined)
  })

  const libraryQuery = useQuery({
    queryKey: ["services", "biblioteca", search, specialtyFilter, cursor],
    queryFn: () =>
      fetchTreatmentTemplates({
        q: search.trim() || undefined,
        specialty: specialtyFilter === "todas" ? undefined : specialtyFilter,
        cursor: cursor ?? undefined,
        limit: BIBLIOTECA_PAGE_LIMIT,
      }),
  })

  const ownedQuery = useQuery({
    queryKey: ["services", "owned-templates"],
    queryFn: fetchAllOwnedTemplateIds,
    staleTime: 60_000,
  })

  const rows = useMemo(() => libraryQuery.data?.data ?? [], [libraryQuery.data])
  const nextCursor = libraryQuery.data?.nextCursor ?? null
  const total = libraryQuery.data?.total ?? rows.length
  const catalog: TreatmentTemplateCatalog | null = libraryQuery.data?.catalog ?? null
  const pageNumber = previousCursors.length + 1
  const owned = ownedQuery.data ?? new Set<string>()
  const selectable = rows.filter((row) => !owned.has(row.id))
  /** Selección acumulada de todas las páginas visitadas (ya incorporadas excluidas). */
  const checkedPending = checked.filter((id) => !owned.has(id))
  const incorporateMutation = useMutation({
    mutationFn: (templateIds: string[]) => incorporateTemplatesApi(templateIds),
    onSuccess: async (result) => {
      setChecked([])
      await queryClient.invalidateQueries({ queryKey: ["services"] })
      const created = result.data.created.length
      toast.success(
        created > 0
          ? `${created} prestación(es) incorporada(s) sin tarifa: configúralas en el tarifario`
          : "Esas prestaciones ya estaban en tu tarifario",
      )
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? (error.shape.message ?? error.message) : error.message,
      )
    },
  })

  const toggle = (id: string) => {
    if (!checked.includes(id) && checkedPending.length >= MAX_LIBRARY_SELECTION) {
      toast.info(`Máximo ${MAX_LIBRARY_SELECTION} prestaciones por incorporación`)
      return
    }
    setChecked((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
  }

  /** Casillas de esta página marcadas (la selección global se conserva al navegar). */
  const checkedOnPage = selectable.filter((row) => checked.includes(row.id))
  const allSelected = selectable.length > 0 && checkedOnPage.length === selectable.length
  const togglePage = (value: boolean) => {
    if (value) {
      const fresh = selectable.map((row) => row.id).filter((id) => !checked.includes(id))
      const room = MAX_LIBRARY_SELECTION - checkedPending.length
      if (room <= 0) {
        toast.info(`Máximo ${MAX_LIBRARY_SELECTION} prestaciones por incorporación`)
        return
      }
      if (fresh.length > room) {
        toast.info(`Solo se seleccionan ${room} más (máximo ${MAX_LIBRARY_SELECTION})`)
      }
      setChecked((prev) => [...prev, ...fresh.slice(0, room)])
      return
    }
    setChecked((prev) => {
      const pageIds = new Set(selectable.map((row) => row.id))
      return prev.filter((id) => !pageIds.has(id))
    })
  }

  const columns = useMemo<ColumnDef<TreatmentTemplateItem>[]>(
    () => [
      {
        id: "select",
        meta: { view: { role: "select" } },
        header: () => (
          <Checkbox
            checked={allSelected}
            disabled={!canWrite || selectable.length === 0}
            onCheckedChange={(value) => togglePage(value === true)}
            aria-label="Seleccionar las prestaciones disponibles de esta página"
          />
        ),
        cell: ({ row }) => {
          const incorporated = owned.has(row.original.id)
          return (
            <Checkbox
              checked={checked.includes(row.original.id)}
              disabled={!canWrite || incorporated}
              onCheckedChange={() => toggle(row.original.id)}
              aria-label={`Incorporar ${row.original.name}`}
            />
          )
        },
      },
      {
        accessorKey: "name",
        header: "Prestación",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="flex min-w-0 max-w-xl flex-col whitespace-normal">
            <span className="font-medium break-words">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {TREATMENT_SPECIALTY_LABELS[row.original.specialty] ?? row.original.specialty} ·{" "}
              {TREATMENT_SCOPE_LABELS[row.original.scope] ?? row.original.scope}
              {row.original.surfaceCountMin !== null
                ? ` · ${row.original.surfaceCountMin}–${row.original.surfaceCountMax ?? "…"} superficies`
                : ""}
            </span>
          </span>
        ),
      },
      {
        id: "codigo",
        header: "Código oficial",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          // Cada plantilla proyecta UN código oficial: se muestra completo, sin recortes.
          const coding = row.original.codings[0]
          if (!coding) {
            return <span className="text-muted-foreground">Sin código oficial</span>
          }
          return (
            <span className="flex min-w-0 flex-col whitespace-normal">
              <span className="font-mono font-medium break-all">{coding.code}</span>
              <span className="text-xs text-muted-foreground break-words">
                {coding.system} · edición {coding.version}
              </span>
            </span>
          )
        },
      },
      {
        id: "estado",
        header: "Estado",
        cell: ({ row }) =>
          owned.has(row.original.id) ? (
            <Badge variant="secondary">En tu tarifario</Badge>
          ) : (
            <Badge variant="outline">Disponible</Badge>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const incorporated = owned.has(row.original.id)
          return (
            <RowActions
              label={`Acciones de ${row.original.name}`}
              items={[
                {
                  key: "incorporar",
                  label: "Incorporar a mi tarifario",
                  disabled: incorporated || !canWrite || incorporateMutation.isPending,
                  onSelect: () => incorporateMutation.mutate([row.original.id]),
                },
              ]}
            />
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allSelected, canWrite, checked, owned, selectable, incorporateMutation.isPending],
  )

  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

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

  const hasFilters = search.trim() !== "" || specialtyFilter !== "todas"

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        filters={[
          {
            key: "especialidad",
            label: "Especialidad",
            type: "select",
            options: SPECIALTY_OPTIONS,
          },
        ]}
        sortOptions={[]}
        searchPlaceholder="Buscar por código o nombre"
      />
      {catalog ? (
        <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm" role="note">
          <p className="font-medium">
            Biblioteca {catalog.system} · edición {catalog.version}
          </p>
          <p className="text-xs text-muted-foreground">
            Cobertura limitada a esta edición y su ámbito ({catalog.scope}):{" "}
            {catalog.availableCount} de {catalog.expectedCount} procedimientos disponibles. Cada
            prestación corresponde a un solo código oficial.
          </p>
          <p className="text-xs">
            <a
              href={catalog.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Ver fuente oficial
            </a>
          </p>
        </div>
      ) : libraryQuery.data ? (
        <p
          className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground"
          role="note"
        >
          Sin edición oficial importada: la biblioteca no muestra cobertura ni fuente.
        </p>
      ) : null}
      {canWrite ? (
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            disabled={checkedPending.length === 0 || incorporateMutation.isPending}
            onClick={() => incorporateMutation.mutate(checkedPending)}
          >
            <Library aria-hidden />
            {incorporateMutation.isPending
              ? "Incorporando…"
              : checkedPending.length > 0
                ? `Incorporar a mi tarifario (${checkedPending.length})`
                : "Incorporar a mi tarifario"}
          </Button>
          {checkedPending.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              La selección se conserva al cambiar de página (máximo {MAX_LIBRARY_SELECTION} por
              envío). Se incorporan sin tarifa.
            </p>
          ) : null}
        </div>
      ) : null}
      {libraryQuery.isPending ? (
        <LoadingState />
      ) : libraryQuery.isError ? (
        <ErrorState
          error={libraryQuery.error instanceof ApiError ? libraryQuery.error.shape : null}
          onRetry={() => void libraryQuery.refetch()}
        />
      ) : rows.length === 0 && !hasFilters ? (
        <EmptyState
          icon={Library}
          title="Biblioteca vacía"
          description="Aún no hay prestaciones publicadas."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Library}
          title="Sin resultados"
          description="Ninguna prestación de la biblioteca coincide con la búsqueda."
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Denominación oficial completa con su código único
            {catalog ? ` (${catalog.system} · edición ${catalog.version})` : ""}, sin precios
            propuestos. Al incorporarlas quedan «Sin tarifa» hasta que configures cada monto en el
            tarifario; el nombre incorporado es comercial y editable, el código oficial no se
            altera.
          </p>
          <DataTable table={table} />
          <div className="flex flex-wrap items-center justify-between gap-2 py-2">
            <p className="text-xs text-muted-foreground">
              Página {pageNumber} · {rows.length} en esta página · {total} con este filtro
              {nextCursor ? " · hay más resultados" : " · fin del listado"}
              {catalog
                ? ` · cobertura de la edición: ${catalog.availableCount} de ${catalog.expectedCount}`
                : ""}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={previousCursors.length === 0 || libraryQuery.isFetching}
                onClick={goPrevious}
              >
                Anterior
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!nextCursor || libraryQuery.isFetching}
                onClick={goNext}
              >
                {libraryQuery.isFetching ? "Cargando…" : "Siguiente"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
