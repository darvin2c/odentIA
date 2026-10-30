import { Badge, Button, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  common,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  FilterBar,
  FormDrawer,
  FormPanel,
  internationalText,
  isValidE164,
  MasterDetail,
  normalizeCountry,
  PageHeader,
  RowActions,
  submitErrorMessage,
  TimeZoneSelect,
  useAppForm,
  useDetailMode,
  useFormSurface,
  useListSearch,
  zonesForCountry,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Building2, MapPin, Plus } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import { z } from "zod"
import {
  type ClinicalCountryProfile,
  type PostalAddress,
  placeDirectionsUrl,
  postalAddressErrors,
  regionName,
} from "@odentia/clinical"
import { AddressStreetField } from "../../components/address/address-street-field"
import { BranchWarehouses } from "../../components/settings/branch-warehouses"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { SearchSelect } from "../../components/settings/search-select"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { staffAddressSource } from "../../lib/address-suggestions"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import { PageDraftGuard } from "../../lib/page-draft-guard"
import { countryChoices } from "../../lib/person-data"
import { appWords } from "../../lib/product-words"

export const Route = createFileRoute("/_org/settings/branches")({
  component: BranchesPage,
})

/** El mismo subtítulo con o sin permiso: el título de la página no cambia. */
const SUBTITLE = "Los locales de la clínica, con su dirección, su teléfono y su zona horaria."

/** La dirección tiene la forma de la del paciente (issue 36): los nombres de cada nivel los pone el país. */
interface Branch {
  id: string
  name: string
  addressLine1: string | null
  city: string | null
  district: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  /** El enlace corto para llegar (`/llegar/<slug>`), y la ficha de Google si se eligió de la lista. */
  slug: string
  googlePlaceId: string | null
  phone: string | null
  /** `null` = hereda la zona horaria de la clínica. */
  timezone: string | null
  isActive: boolean
}

// Los mismos topes que `branchInput` de la API; la dirección, con la regla del
// servicio (`postalAddressErrors`) en `branchSchemaFor`.
const branchFields = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de la sede").max(120, "Escribe como mucho 120 caracteres"),
  addressLine1: z.string(),
  city: z.string(),
  district: z.string(),
  region: z.string(),
  postalCode: z.string(),
  country: z.string(),
  googlePlaceId: z.string().nullable(),
  // El campo de teléfono emite E.164 (o `null` si se deja vacío); uno a medias lo frena el campo.
  phone: z
    .string()
    .nullable()
    .refine((value) => value === null || isValidE164(value), "Teléfono inválido"),
  timezoneInherited: z.boolean(),
  timezone: z.string().nullable(),
})

type BranchFormValues = z.infer<typeof branchFields>

/** El campo del formulario de cada parte de la dirección (`line` es la calle). */
const ADDRESS_FIELD: Record<keyof PostalAddress, keyof BranchFormValues> = {
  line: "addressLine1",
  city: "city",
  district: "district",
  region: "region",
  postalCode: "postalCode",
  country: "country",
}

function postalOf(value: Pick<Branch, "addressLine1" | "city" | "district" | "region" | "postalCode" | "country">): PostalAddress {
  return {
    line: value.addressLine1,
    city: value.city,
    district: value.district,
    region: value.region,
    postalCode: value.postalCode,
    country: value.country,
  }
}

/**
 * El esquema de la sede según el país de la clínica: la dirección se juzga como
 * en el servidor (la región guardada que no cambia no se vuelve a juzgar) y,
 * sin heredar la zona horaria, hay que elegir una.
 */
function branchSchemaFor(profile: ClinicalCountryProfile, previous: Branch | null) {
  return branchFields.superRefine((value, ctx) => {
    const errors = postalAddressErrors(profile, postalOf(value), previous ? postalOf(previous) : undefined)
    for (const [key, message] of Object.entries(errors) as Array<[keyof PostalAddress, string]>) {
      // Solo lo que tiene campo en pantalla; lo demás lo dice el servidor junto a los botones.
      if (key === "district" && !profile.address.districtLabel) continue
      if (key === "postalCode" && !profile.address.postalCode) continue
      ctx.addIssue({ code: "custom", path: [ADDRESS_FIELD[key]], message })
    }
    if (!value.timezoneInherited && !value.timezone)
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "Elige la zona horaria de la sede" })
  })
}

const emptyValues: BranchFormValues = {
  name: "",
  addressLine1: "",
  city: "",
  district: "",
  region: "",
  postalCode: "",
  country: "",
  googlePlaceId: null,
  phone: null,
  timezoneInherited: true,
  timezone: null,
}

/** Valores del formulario para una sede; `null` = alta nueva. */
function branchValues(branch: Branch | null): BranchFormValues {
  if (!branch) return emptyValues
  return {
    name: branch.name,
    addressLine1: branch.addressLine1 ?? "",
    city: branch.city ?? "",
    district: branch.district ?? "",
    region: branch.region ?? "",
    postalCode: branch.postalCode ?? "",
    country: branch.country ?? "",
    googlePlaceId: branch.googlePlaceId ?? null,
    phone: branch.phone ?? null,
    timezoneInherited: branch.timezone === null,
    timezone: branch.timezone ?? null,
  }
}

/**
 * Sedes de la clínica: se crean y se editan en la superficie lateral.
 * Desactivar una sede la saca de la agenda sin borrar nada, y se puede
 * reactivar desde esta misma lista.
 */
function BranchesPage() {
  const queryClient = useQueryClient()
  const listSearch = useListSearch()
  const search = listSearch.get("q") ?? ""
  const estadoFilter = listSearch.get("estado")
  const sort = listSearch.get("sort")
  const hasCriteria = search !== "" || estadoFilter !== undefined
  const canRead = usePermission("settings.read")
  const canWrite = usePermission("settings.write")
  // Los almacenes de cada sede los lleva quien lleva el inventario (ADR 0067).
  const canWarehouses = usePermission("inventory.write")

  // País y zonas del perfil: definen la máscara del teléfono y las sugerencias.
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  // Cómo se llama cada nivel de la dirección y si la región se elige de una lista.
  const clinical = useClinicalProfile()
  const countries = useMemo(() => countryChoices(clinical.country), [clinical.country])
  const clinicName = profile.data?.tradeName || profile.data?.legalName || null
  const sedeAddressSource = useMemo(() => staffAddressSource("sede"), [])
  /** El nombre con que la sede aparece en Google, si se eligió así (solo mientras se edita). */
  const [placeName, setPlaceName] = useState<string | null>(null)
  /** Cambia cada vez que se abre el formulario: «Calle y número» empieza sin lo elegido en otra sede. */
  const [opening, setOpening] = useState(0)

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Branch[] }>("/api/branches"),
    enabled: canRead,
  })
  const branches = branchesQuery.data?.data

  const mode = useDetailMode()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Branch | null>(null)
  const [deactivating, setDeactivating] = useState<Branch | null>(null)
  /** Lo que se quiso abrir con cambios sin guardar en el formulario. */
  const [pendingOpen, setPendingOpen] = useState<{ branch: Branch | null } | null>(null)

  const saveMutation = useMutation({
    mutationFn: async (values: BranchFormValues) => {
      const body = JSON.stringify({
        name: values.name.trim(),
        // `null` y no omitir: el PATCH es parcial y una clave ausente deja el
        // valor anterior; vaciar un campo debe persistirse como NULL.
        addressLine1: values.addressLine1.trim() || null,
        city: values.city.trim() || null,
        district: values.district.trim() || null,
        region: values.region.trim() || null,
        postalCode: values.postalCode.trim() || null,
        country: values.country || null,
        googlePlaceId: values.googlePlaceId,
        phone: values.phone || null,
        // `null` = la sede hereda la zona horaria de la clínica.
        timezone: values.timezoneInherited ? null : values.timezone || null,
      })
      if (editing) {
        await apiFetch(`/api/branches/${editing.id}`, { method: "PATCH", body })
      } else {
        await apiFetch("/api/branches", { method: "POST", body })
      }
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: (branch: Branch) => apiFetch(`/api/branches/${branch.id}`, { method: "DELETE" }),
    onSuccess: async (_result, branch) => {
      setDeactivating(null)
      toast.success(`${branch.name} quedó desactivada`)
      await queryClient.invalidateQueries({ queryKey: ["branches"] })
    },
  })

  // Reactivar no quita nada: vuelve con lo que tenía, sin pedir confirmación.
  const { mutate: reactivate, isPending: reactivating } = useMutation({
    mutationFn: (branch: Branch) =>
      apiFetch(`/api/branches/${branch.id}/reactivate`, { method: "POST" }),
    onSuccess: async (_result, branch) => {
      toast.success(`${branch.name} vuelve a estar activa`)
      await queryClient.invalidateQueries({ queryKey: ["branches"] })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  const branchSchema = useMemo(() => branchSchemaFor(clinical, editing), [clinical, editing])
  // `defaultValues` deriva de la fila en edición: `useAppForm` reaplica las
  // opciones en cada render y, mientras el formulario no está tocado, sincroniza
  // los valores con `defaultValues`. Así abrir una fila la vuelca en los campos
  // y `isDirty` significa exactamente "cambios sin guardar". (`form.reset(values)`
  // solo no alcanza: el siguiente render lo pisaría con los `defaultValues` de
  // las opciones.)
  const form = useAppForm({
    defaultValues: branchValues(editing),
    validators: { onSubmit: branchSchema },
    // Un rechazo del servidor lo reparte la superficie: cada dato en su campo.
    onSubmit: async ({ value }) => {
      await saveMutation.mutateAsync(value)
      const message = editing ? "Sede guardada" : "Sede creada"
      closeBranchForm()
      toast.success(message)
      await queryClient.invalidateQueries({ queryKey: ["branches"] })
    },
  })
  const surface = useFormSurface(form)
  // «Cambios sin guardar» = distinto de lo guardado (volver al valor original no cuenta).
  const isDirty = useStore(form.store, (state) => !state.isDefaultValue)

  /** Deja el formulario prístino sobre esa sede (o una nueva) y lo abre. */
  const showBranchForm = useCallback(
    (branch: Branch | null) => {
      // `reset()` sin valores limpia touched/errores y deja que el render
      // siguiente cargue la fila.
      form.reset()
      setPlaceName(null)
      setOpening((count) => count + 1)
      setEditing(branch)
      setFormOpen(true)
    },
    [form],
  )

  /**
   * Abre el formulario sobre una sede (o una nueva). El panel lateral no es
   * modal: sin overlay que impida seguir usando la tabla, antes de reemplazar
   * lo escrito se pregunta.
   */
  const openBranchForm = useCallback(
    (branch: Branch | null) => {
      if (formOpen && isDirty) setPendingOpen({ branch })
      else showBranchForm(branch)
    },
    [formOpen, isDirty, showBranchForm],
  )

  /**
   * Cierra y deja el formulario prístino. El `reset()` es obligatorio: sin él los
   * field-meta (`isTouched`/`isDirty`) sobreviven al cierre con los valores ya
   * guardados, y el próximo abrir preguntaría por cambios que no existen.
   */
  function closeBranchForm() {
    setFormOpen(false)
    setEditing(null)
    form.reset()
  }

  const activeCount = (branches ?? []).filter((row) => row.isActive).length

  /** El enlace corto de la clínica para llegar a la sede: para Instagram o la firma del correo. */
  async function copyShortLink(site: Branch) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/llegar/${encodeURIComponent(site.slug)}`)
      toast.success("Enlace para llegar copiado")
    } catch {
      toast.error("No pudimos copiar el enlace")
    }
  }

  const columns = useMemo<ColumnDef<Branch>[]>(
    () => [
      { accessorKey: "name", header: "Nombre" },
      {
        id: "address",
        header: "Dirección",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          // Dos líneas: la calle; el distrito y la región por su nombre.
          const place = [row.original.city, regionName(clinical, row.original.region)].filter(Boolean).join(", ")
          if (!row.original.addressLine1 && !place) {
            return canWrite ? (
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">Sin dirección</span>
                <Button type="button" variant="link" className="h-auto p-0" onClick={() => openBranchForm(row.original)}>
                  Agregarla
                </Button>
              </span>
            ) : (
              "—"
            )
          }
          return (
            <span className="flex flex-col">
              <span>{row.original.addressLine1 ?? place}</span>
              {row.original.addressLine1 && place ? <span className="text-xs text-muted-foreground">{place}</span> : null}
            </span>
          )
        },
      },
      {
        accessorKey: "phone",
        header: "Teléfono",
        cell: ({ getValue }) => {
          const phone = getValue<string | null>()
          return phone ? internationalText(phone) : "—"
        },
      },
      {
        accessorKey: "isActive",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ getValue }) => (
          <Badge variant={getValue<boolean>() ? "success" : "secondary"}>
            {getValue<boolean>() ? "Activa" : "Desactivada"}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const site = row.original
          // «Cómo llegar» abre su ficha de Google Maps; el enlace corto es el que manda Sofi (issue 36).
          const directions = site.isActive
            ? placeDirectionsUrl(clinical, {
                name: clinicName,
                address: { line: site.addressLine1, city: site.city, region: site.region, country: site.country },
                placeId: site.googlePlaceId,
              })
            : null
          const items = [
            ...(canWrite ? [{ key: "edit", label: "Editar", onSelect: () => openBranchForm(site) }] : []),
            ...(directions
              ? [
                  { key: "directions", label: "Cómo llegar", onSelect: () => window.open(directions, "_blank", "noopener,noreferrer") },
                  { key: "copy-link", label: "Copiar el enlace para llegar", onSelect: () => void copyShortLink(site) },
                ]
              : []),
            ...(canWrite
              ? [
                  site.isActive
                    ? { key: "deactivate", label: "Desactivar", tone: "danger" as const, onSelect: () => setDeactivating(site) }
                    : { key: "reactivate", label: "Reactivar", disabled: reactivating, onSelect: () => reactivate(site) },
                ]
              : []),
          ]
          return items.length ? <RowActions label={`Acciones de ${site.name}`} items={items} /> : null
        },
      },
    ],
    [canWrite, clinical, clinicName, openBranchForm, reactivate, reactivating],
  )
  const filtered = useMemo(() => {
    const needle = search.toLowerCase()
    const rows = (branches ?? []).filter((row) => {
      const haystack = [row.name, row.addressLine1, row.city].filter(Boolean).join(" ").toLowerCase()
      if (needle && !haystack.includes(needle)) return false
      if (estadoFilter === "activa" && !row.isActive) return false
      if (estadoFilter === "inactiva" && row.isActive) return false
      return true
    })
    if (!sort) return rows
    const desc = sort.startsWith("-")
    const field = desc ? sort.slice(1) : sort
    const direction = desc ? -1 : 1
    return [...rows].sort((a, b) => {
      if (field === "estado") return direction * (Number(b.isActive) - Number(a.isActive))
      if (field === "nombre") return direction * a.name.localeCompare(b.name, "es")
      return 0
    })
  }, [branches, search, estadoFilter, sort])

  const table = useReactTable({
    data: filtered,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Sedes" subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const regions = clinical.address.regions
  const formFields = (
    <div className="flex flex-col gap-4">
      <form.AppField name="name">
        {(field) => <field.TextField id="branch-name" label="Nombre" maxLength={120} />}
      </form.AppField>
      <form.AppField name="addressLine1">
        {(field) => (
          <field.Control id="branch-address" label="Calle y número">
            {(control) => (
              // Google sugiere la calle o la sede por su nombre (issue 36); lo escrito a mano sirve igual.
              <AddressStreetField
                key={opening}
                id={control.id}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
                value={field.state.value}
                source={sedeAddressSource}
                placeholder="La calle o el nombre de la sede en Google Maps"
                pickedHint="Lo llenó Google Maps; puedes corregirlo. Agrega el interior en la calle."
                onChange={(next) => {
                  field.handleChange(next)
                  // Escribir a mano suelta la ficha de Google: «Cómo llegar» buscará lo escrito.
                  if (form.getFieldValue("googlePlaceId")) {
                    form.setFieldValue("googlePlaceId", null)
                    setPlaceName(null)
                  }
                }}
                onPick={(pick) => {
                  form.setFieldValue("city", pick.city ?? "")
                  form.setFieldValue("district", pick.district ?? "")
                  form.setFieldValue("region", pick.region ?? "")
                  form.setFieldValue("postalCode", pick.postalCode ?? "")
                  if (pick.country) form.setFieldValue("country", pick.country)
                  form.setFieldValue("googlePlaceId", pick.placeId)
                  setPlaceName(pick.placeName)
                }}
              />
            )}
          </field.Control>
        )}
      </form.AppField>
      <form.Subscribe selector={(state) => state.values}>
        {(values) => {
          const url = values.googlePlaceId
            ? placeDirectionsUrl(clinical, {
                name: clinicName,
                address: { line: values.addressLine1, city: values.city, region: values.region, country: values.country },
                placeId: values.googlePlaceId,
              })
            : null
          return url ? (
            <div className="flex items-center gap-3 rounded-xl bg-primary-soft px-3 py-2.5 text-primary-soft-foreground">
              <MapPin aria-hidden className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs">«Cómo llegar» abre su ficha de Google Maps</span>
                {placeName ? <span className="truncate text-sm font-semibold">{placeName}</span> : null}
              </span>
              <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold underline-offset-4 hover:underline">
                Ver ↗
              </a>
            </div>
          ) : null
        }}
      </form.Subscribe>
      {/* Los mismos niveles que la dirección del paciente, con los nombres del país. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <form.AppField name="city">
          {(field) => <field.TextField id="branch-city" label={clinical.address.cityLabel} maxLength={100} />}
        </form.AppField>
        {clinical.address.districtLabel ? (
          <form.AppField name="district">
            {(field) => <field.TextField id="branch-district" label={clinical.address.districtLabel} maxLength={100} />}
          </form.AppField>
        ) : null}
        <form.AppField name="region">
          {(field) =>
            regions ? (
              <field.Control id="branch-region" label={clinical.address.regionLabel}>
                {(control) => (
                  <ChoiceSelect
                    id={control.id}
                    name={control.name}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    <option value="">Sin elegir</option>
                    {/* Lo guardado que no está en la lista se conserva a la vista. */}
                    {field.state.value && !regions.some((item) => item.code === field.state.value) ? (
                      <option value={field.state.value}>{field.state.value}</option>
                    ) : null}
                    {regions.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            ) : (
              <field.TextField id="branch-region" label={clinical.address.regionLabel} maxLength={100} />
            )
          }
        </form.AppField>
        {clinical.address.postalCode ? (
          <form.AppField name="postalCode">
            {(field) => <field.TextField id="branch-postal" label="Código postal" maxLength={20} />}
          </form.AppField>
        ) : null}
        <form.AppField name="country">
          {(field) => (
            <field.Control id="branch-country" label="País">
              {(control) => (
                <SearchSelect
                  id={control.id}
                  label="País"
                  placeholder="Buscar país…"
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  value={field.state.value || clinical.country || ""}
                  options={countries}
                  onChange={(next) => {
                    field.handleChange(next)
                    field.handleBlur()
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
      <form.AppField name="phone">
        {(field) => <field.PhoneField id="branch-phone" label="Teléfono" defaultCountry={countryCode} />}
      </form.AppField>
      <div className="flex flex-col gap-4">
        <form.AppField
          name="timezoneInherited"
          listeners={{
            // Volver a heredar quita el aviso de «elige la zona»: ya no hace falta.
            onChange: ({ value }) => {
              if (value) void form.validateField("timezone", "change")
            },
          }}
        >
          {(field) => <field.CheckboxField id="branch-inherit-timezone" label="Usar la zona horaria de la clínica" />}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.timezoneInherited}>
          {(inherited) => (
            <form.AppField name="timezone">
              {(field) => (
                <field.Control id="branch-timezone" label="Zona horaria de la sede">
                  {(control) => (
                    <TimeZoneSelect
                      id={control.id}
                      name={control.name}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      value={field.state.value}
                      onChange={(next) => {
                        field.handleChange(next)
                        field.handleBlur()
                      }}
                      suggested={zonesForCountry(countryCode)}
                      disabled={inherited}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          )}
        </form.Subscribe>
      </div>
      {editing && canWarehouses ? <BranchWarehouses branchId={editing.id} branchName={editing.name} /> : null}
    </div>
  )

  // Idénticos para los dos contenedores: solo cambia dónde se monta el shell.
  const formProps = {
    ...surface,
    isDirty,
    onClose: closeBranchForm,
    title: editing ? `Editar ${editing.name}` : "Nueva sede",
    submitLabel: common.actions.save,
    cancelLabel: common.actions.cancel,
  }

  // Lo que nunca llegó se dice; un fallo al actualizar no retira la lista que ya estaba.
  const neverLoaded = branchesQuery.isError && branches === undefined
  const lastActive = deactivating?.isActive === true && activeCount <= 1

  return (
    <div className="flex flex-col gap-6">
      <PageDraftGuard dirty={formOpen && isDirty} />
      <MasterDetail
        panel={
          mode === "panel" && formOpen ? <FormPanel {...formProps}>{formFields}</FormPanel> : null
        }
      >
        <PageHeader
          title="Sedes"
          subtitle={SUBTITLE}
          primary={
            canWrite
              ? { label: "Nueva sede", icon: <Plus aria-hidden />, onClick: () => openBranchForm(null) }
              : undefined
          }
        />
        <FilterBar
          filters={[
            {
              key: "estado",
              label: "Estado",
              type: "select",
              options: [
                { value: "activa", label: "Activa" },
                { value: "inactiva", label: "Desactivada" },
              ],
            },
          ]}
          sortOptions={[
            { value: "nombre", label: "Nombre" },
            { value: "estado", label: "Estado" },
          ]}
          searchPlaceholder="Buscar sede"
        />
        {neverLoaded ? (
          <ErrorState
            title="No pudimos cargar las sedes"
            message="Comprueba tu conexión y vuelve a intentarlo."
            onRetry={() => void branchesQuery.refetch()}
          />
        ) : branches === undefined ? (
          <DataTableSkeleton columnCount={5} rowCount={3} label="Cargando las sedes…" />
        ) : filtered.length === 0 ? (
          hasCriteria ? (
            <EmptyState
              icon={Building2}
              title={common.filters.noResults}
              description={
                search
                  ? `Ninguna sede coincide con “${search}”.`
                  : "Ninguna sede coincide con los filtros elegidos."
              }
            />
          ) : (
            <EmptyState
              icon={Building2}
              title="Aún no hay sedes"
              description="Sin una sede no se puede abrir la agenda. Agrega la primera."
              actionLabel={canWrite ? "Nueva sede" : undefined}
              onAction={canWrite ? () => openBranchForm(null) : undefined}
            />
          )
        ) : (
          <DataTable table={table} isRowActive={(row) => formOpen && editing?.id === row.id} />
        )}
      </MasterDetail>

      {/* Un solo contenedor montado a la vez: montar panel y drawer juntos
          duplicaría los id/htmlFor de los campos. */}
      {mode === "drawer" ? (
        <FormDrawer open={formOpen} {...formProps}>
          {formFields}
        </FormDrawer>
      ) : null}

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => {
          deactivateMutation.reset()
          setDeactivating(null)
        }}
        onConfirm={() => deactivating && deactivateMutation.mutate(deactivating)}
        title={`Desactivar ${deactivating?.name ?? ""}`}
        description={
          lastActive
            ? `Es la única sede activa: la agenda y las reservas dejarán de funcionar hasta que reactives una. Sus citas, horarios y ${appWords().room.many} se conservan.`
            : `Dejará de aparecer en la agenda y no se podrán reservar citas en ella. Sus citas, horarios y ${appWords().room.many} se conservan, y puedes reactivarla cuando quieras.`
        }
        confirmLabel="Desactivar"
        variant="destructive"
        pending={deactivateMutation.isPending}
        error={deactivateMutation.error ? submitErrorMessage(deactivateMutation.error) : null}
      />

      <ConfirmDialog
        open={pendingOpen !== null}
        onClose={() => setPendingOpen(null)}
        onConfirm={() => {
          if (pendingOpen) showBranchForm(pendingOpen.branch)
          setPendingOpen(null)
        }}
        title="Hay cambios sin guardar"
        description={`Si abres otra sede se pierde lo que escribiste en ${editing ? editing.name : "la sede nueva"}.`}
        confirmLabel="Descartar cambios"
        cancelLabel="Seguir editando"
        variant="destructive"
      />
    </div>
  )
}
