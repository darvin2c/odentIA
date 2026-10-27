import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
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
  common,
  countryOptions,
  EmptyState,
  ErrorState,
  FormDrawer,
  fieldErrorMessages,
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import { useForm, useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router"
import { Building2, Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { type ProductChoice, ProductFilter, ProductMark } from "../../components/product"

interface ListSearch {
  q?: string
  producto?: ProductChoice
  precio?: "negociado"
  /** Enlace de antes: abría la ficha al lado; ahora la ficha es su propia página. */
  org?: string
}

export const Route = createFileRoute("/_app/organizations")({
  component: OrganizationsPage,
  // La búsqueda y los filtros viven en la dirección: al volver de una ficha siguen como estaban.
  validateSearch: (search: Record<string, unknown>): ListSearch => ({
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    ...(search.producto === "dental" || search.producto === "medical" ? { producto: search.producto } : {}),
    ...(search.precio === "negociado" ? { precio: "negociado" as const } : {}),
    ...(typeof search.org === "string" ? { org: search.org } : {}),
  }),
  beforeLoad: ({ search }) => {
    if (search.org) throw redirect({ to: "/organizations/$organizationId", params: { organizationId: search.org } })
  },
})

const orgItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  memberCount: z.number(),
  ownerCount: z.number(),
  pendingInvitations: z.number(),
  hasProfile: z.boolean(),
  hasBranch: z.boolean(),
  billingStatus: z.string().nullable(),
  restricted: z.boolean(),
  /** Precio negociado vigente (issue 168). */
  negotiated: z.object({ discountBps: z.number(), endsAt: z.string().nullable() }).nullable().default(null),
  product: z.enum(CLINICAL_PRODUCTS).default("dental"),
})

/** «20 % negociado · vence 30 abr»; en rojo si faltan 7 días o menos. */
function NegotiatedBadge({ deal }: { deal: { discountBps: number; endsAt: string | null } }) {
  const percent = `${deal.discountBps / 100} %`
  if (!deal.endsAt) return <Badge variant="warning">{percent} negociado</Badge>
  const end = new Date(deal.endsAt)
  const days = Math.ceil((end.getTime() - Date.now()) / 86_400_000)
  if (days <= 7) {
    return <Badge variant="destructive">{`${percent} · vence en ${Math.max(days, 0)} ${days === 1 ? "día" : "días"}`}</Badge>
  }
  const day = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" }).format(end).replaceAll(".", "")
  return <Badge variant="warning">{`${percent} negociado · vence ${day}`}</Badge>
}

const orgListSchema = z.object({
  items: z.array(orgItemSchema),
  total: z.number(),
  byProduct: z.object({ dental: z.number(), medical: z.number() }).default({ dental: 0, medical: 0 }),
})

/** El estado de la clínica como pastilla: verde si está activa, ámbar si algo falta, rojo si está restringida. */
function statusVariant(status: string | null): "success" | "warning" | "destructive" | "secondary" {
  if (status === "activa") return "success"
  if (status === "gracia" || status === "pausada") return "warning"
  if (status === "restringida") return "destructive"
  return "secondary"
}


const assistedSchema = z.object({
  orgName: z.string().trim().min(2, "Nombre de la organización"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Minúsculas, números y guiones"),
  email: z.string().trim().email("Correo inválido"),
  countryCode: z.string().trim().length(2, "Elige el país"),
  currency: z.union([z.string().trim().length(3, "Moneda ISO de 3 letras"), z.literal("")]),
  billingStart: z.enum(["trial", "now"]),
  planCode: z.string(),
  sellerId: z.string().trim().max(120),
  isDemo: z.boolean(),
  product: z.enum(CLINICAL_PRODUCTS),
})

/** Cada producto, como se elige al dar de alta una clínica. */
const PRODUCT_CHOICES: Record<ClinicalProduct, string> = {
  dental: `${productWords("dental").name} · clínica dental`,
  medical: `${productWords("medical").name} · consultorio médico`,
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? common.errors.generic
  return error instanceof Error ? error.message : common.errors.generic
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "prueba":
      return "En prueba"
    case "activa":
      return "Activa"
    case "gracia":
      return "En gracia"
    case "restringida":
      return "Restringida"
    case "pausada":
      return "Pausada"
    case "cancelada":
      return "Cancelada"
    case "sin_suscripcion":
      return "Sin suscripción"
    default:
      return "Sin dato"
  }
}

function OrganizationsPage() {
  const queryClient = useQueryClient()
  const listSearch = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const activeSearch = listSearch.q ?? ""
  const [search, setSearch] = useState(activeSearch)
  const onlyNegotiated = listSearch.precio === "negociado"
  const product: ProductChoice = listSearch.producto ?? "todos"
  const setList = (next: Partial<ListSearch>) =>
    void navigate({
      search: (previous) => {
        const merged = { ...previous, ...next }
        return {
          ...(merged.q ? { q: merged.q } : {}),
          ...(merged.producto && merged.producto !== "todos" ? { producto: merged.producto } : {}),
          ...(merged.precio ? { precio: merged.precio } : {}),
        }
      },
      replace: true,
    })
  const [assistedOpen, setAssistedOpen] = useState(false)

  const sessionQuery = useQuery({
    queryKey: ["admin-session"],
    queryFn: async () =>
      z
        .object({ actor: z.object({ role: z.string() }) })
        .parse(await api<unknown>("/api/admin/access/session")),
  })
  const isAdmin = sessionQuery.data?.actor.role === "admin"

  const sellersSchema = z.array(z.object({ id: z.string(), displayName: z.string() }))
  const sellersQuery = useQuery({
    queryKey: ["admin-sellers"],
    enabled: isAdmin && assistedOpen,
    queryFn: async () => sellersSchema.parse(await api<unknown>("/api/admin/billing/sellers")),
  })
  const sellers = sellersQuery.data ?? []
  function sellerNameOf(id: string): string {
    if (id === "__none") return "Sin vendedora"
    return sellers.find((seller) => seller.id === id)?.displayName ?? "Vendedora"
  }

  const plansSchema = z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      currency: z.string(),
      priceCents: z.number(),
      trialDays: z.number(),
      isDefault: z.boolean(),
      isActive: z.boolean(),
      product: z.enum(CLINICAL_PRODUCTS),
    }),
  )
  const plansQuery = useQuery({
    queryKey: ["admin-plans"],
    enabled: isAdmin && assistedOpen,
    queryFn: async () => plansSchema.parse(await api<unknown>("/api/admin/billing/plans")),
  })
  // La prueba del alta dura lo que dice el plan por defecto de su producto;
  // sin él, las condiciones comerciales (la base decide igual al crear la clínica).
  const termsQuery = useQuery({
    queryKey: ["admin", "billing", "terms"],
    enabled: isAdmin && assistedOpen,
    queryFn: () => api<{ values: { trialDays: number } }>("/api/admin/billing/terms"),
  })

  const countries = useMemo(
    () =>
      countryOptions("PE", undefined, "es").map((item) => ({
        code: item.value,
        label: item.label,
      })),
    [],
  )
  const currencies = useMemo(() => {
    const names = new Intl.DisplayNames(["es"], { type: "currency" })
    return Intl.supportedValuesOf("currency").map((code) => ({
      code,
      label: names.of(code) ?? code,
    }))
  }, [])
  function countryNameOf(code: string): string {
    return countries.find((country) => country.code === code)?.label ?? code
  }

  const listQuery = useQuery({
    queryKey: ["admin-organizations", activeSearch, onlyNegotiated, product],
    queryFn: async () => {
      const raw = await api<unknown>(
        `/api/admin/organizations?q=${encodeURIComponent(activeSearch)}&limit=30${onlyNegotiated ? "&negotiated=1" : ""}${product === "todos" ? "" : `&product=${product}`}`,
      )
      return orgListSchema.parse(raw)
    },
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin-organizations"] })
    void queryClient.invalidateQueries({ queryKey: ["admin-organization"] })
  }

  interface AssistedFormValues {
    orgName: string
    slug: string
    email: string
    countryCode: string
    currency: string
    billingStart: "trial" | "now"
    planCode: string
    sellerId: string
    isDemo: boolean
    product: ClinicalProduct
  }
  const assistedDefaults: AssistedFormValues = {
    orgName: "",
    slug: "",
    email: "",
    countryCode: "PE",
    currency: "",
    billingStart: "trial",
    planCode: "",
    sellerId: "",
    isDemo: false,
    product: "dental",
  }
  const form = useForm({
    defaultValues: assistedDefaults,
    validators: { onSubmit: assistedSchema },
    onSubmit: async ({ value }) => {
      if (value.billingStart === "now" && !value.planCode) {
        toast.error("Elige un plan para el cobro desde hoy")
        return
      }
      try {
        const raw = await api<unknown>("/api/admin/organizations/assisted", {
          method: "POST",
          body: JSON.stringify({
            ...value,
            currency: value.currency || undefined,
            planCode: value.planCode || undefined,
            sellerId: value.sellerId || undefined,
          }),
        })
        const created = z.object({ status: z.string(), userId: z.string().nullable() }).parse(raw)
        toast.success(
          created.userId
            ? "Clínica creada; el correo ya tiene cuenta: acepta la invitación sin crear contraseña"
            : "Clínica creada e invitación enviada",
        )
        setAssistedOpen(false)
        form.reset()
        invalidate()
      } catch (error) {
        toast.error(messageOf(error))
      }
    },
  })
  // Solo los planes del producto elegido (ADR 0093).
  const assistedProduct = useStore(form.store, (state) => state.values.product)
  const productPlans = (plansQuery.data ?? []).filter((plan) => plan.product === assistedProduct)
  const trialDays = productPlans.find((plan) => plan.isDefault && plan.isActive)?.trialDays ?? termsQuery.data?.values.trialDays
  const trialLabel = trialDays ? `Prueba de ${trialDays} días` : "Prueba"
  const plans = productPlans.map((plan) => ({
    code: plan.code,
    label: `${plan.name} · ${plan.currency} ${(plan.priceCents / 100).toFixed(2)}`,
  }))
  function planNameOf(code: string): string {
    if (code === "__none") return "Sin plan (prueba)"
    return plans.find((plan) => plan.code === code)?.label ?? "Plan"
  }

  const items = listQuery.data?.items ?? []

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Clínicas"
        subtitle="Las de odentIA y las de latidIA, con suscripción, uso, miembros y actividad."
        primary={{ label: "Alta asistida", icon: <Plus aria-hidden />, onClick: () => setAssistedOpen(true) }}
      />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          setList({ q: search.trim() || undefined })
        }}
      >
        <div className="flex min-w-64 flex-1 gap-2">
          <Input
            aria-label="Buscar clínicas"
            placeholder="Buscar por nombre o slug"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit" variant="outline">
            Buscar
          </Button>
        </div>
        {/* Cuenta cada producto con la misma búsqueda, sin contar el filtro de producto. */}
        <ProductFilter
          value={product}
          onChange={(value) => setList({ producto: value })}
          counts={
            listQuery.data
              ? {
                  todos: listQuery.data.byProduct.dental + listQuery.data.byProduct.medical,
                  dental: listQuery.data.byProduct.dental,
                  medical: listQuery.data.byProduct.medical,
                }
              : undefined
          }
        />
        <Select
          value={onlyNegotiated ? "negociado" : "todas"}
          items={{ todas: "Todas", negociado: "Con precio negociado" }}
          onValueChange={(value) => setList({ precio: value === "negociado" ? "negociado" : undefined })}
        >
          <SelectTrigger aria-label="Precio" className="w-60 shrink-0">
            <span className="text-muted-foreground">Precio:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas</SelectItem>
            <SelectItem value="negociado">Con precio negociado</SelectItem>
          </SelectContent>
        </Select>
      </form>

      {listQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : listQuery.isError ? (
        <ErrorState error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Sin clínicas"
          description="Aún no hay clínicas registradas con este criterio."
        />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                to="/organizations/$organizationId"
                params={{ organizationId: item.id }}
                className="flex h-full w-full flex-col gap-1.5 rounded-xl border bg-card p-3 text-left text-sm hover:border-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ProductMark product={item.product} />
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {item.negotiated ? <NegotiatedBadge deal={item.negotiated} /> : null}
                  {!item.hasProfile || !item.hasBranch ? (
                    <Badge variant="warning">Alta incompleta</Badge>
                  ) : item.restricted ? (
                    <Badge variant="destructive">Restringida</Badge>
                  ) : (
                    <Badge variant={statusVariant(item.billingStatus)}>{statusLabel(item.billingStatus)}</Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.slug} · {item.memberCount} miembros
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <FormDrawer
        open={assistedOpen}
        onClose={() => setAssistedOpen(false)}
        title="Alta asistida"
        description="Crea la clínica una sola vez y siempre envía invitación de propietaria: entrar exige aceptación; quien ya tiene cuenta acepta sin crear contraseña."
        isSubmitting={form.state.isSubmitting}
        submitLabel="Crear clínica"
        cancelLabel={common.actions.cancel}
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <div className="flex flex-col gap-4">
          {/* El producto no cambia después (decisión 9 del issue 229): la clínica abre en su dominio. */}
          <form.Field name="product">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="assisted-product">Producto</FieldLabel>
                <Select<ClinicalProduct>
                  value={field.state.value}
                  onValueChange={(next) => {
                    if (!next) return
                    field.handleChange(next)
                    // El plan elegido era del otro producto: se vuelve a elegir.
                    form.setFieldValue("planCode", "")
                  }}
                >
                  <SelectTrigger id="assisted-product">
                    <SelectValue>{(selected: ClinicalProduct) => PRODUCT_CHOICES[selected]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CLINICAL_PRODUCTS.map((product) => (
                      <SelectItem key={product} value={product}>
                        {PRODUCT_CHOICES[product]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>No se cambia después: la clínica abre en el dominio de su producto.</FieldDescription>
              </Field>
            )}
          </form.Field>
          <form.Field name="orgName">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="assisted-org">Nombre de la clínica</FieldLabel>
                <Input
                  id="assisted-org"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="assisted-slug">Dirección personalizada</FieldLabel>
                <Input
                  id="assisted-slug"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value.toLowerCase())}
                  aria-describedby="assisted-slug-help"
                />
                <FieldDescription id="assisted-slug-help">
                  Será su dirección en el dominio de su producto, en minúsculas sin espacios.
                </FieldDescription>
              </Field>
            )}
          </form.Field>
          <form.Field name="email">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="assisted-email">Correo de la propietaria</FieldLabel>
                <Input
                  id="assisted-email"
                  type="email"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="countryCode">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="assisted-country">País</FieldLabel>
                <Select<string>
                  value={field.state.value || "PE"}
                  onValueChange={(next) => {
                    if (next) field.handleChange(next)
                  }}
                >
                  <SelectTrigger id="assisted-country">
                    <SelectValue>{(selected: string) => countryNameOf(selected)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {countries.map((item) => (
                      <SelectItem key={item.code} value={item.code}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </form.Field>
          <form.Field name="currency">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="assisted-currency">
                  Moneda (opcional: propone el país)
                </FieldLabel>
                <Select<string>
                  value={field.state.value || "__auto"}
                  onValueChange={(next) =>
                    field.handleChange(!next || next === "__auto" ? "" : next)
                  }
                >
                  <SelectTrigger id="assisted-currency">
                    <SelectValue>
                      {(selected: string) => (selected === "__auto" ? "La del país" : selected)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto">La del país</SelectItem>
                    {currencies.map((item) => (
                      <SelectItem key={item.code} value={item.code}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
              </Field>
            )}
          </form.Field>
          {isAdmin ? (
            <form.Field name="billingStart">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="assisted-billing">Inicio</FieldLabel>
                  <Select<string>
                    value={field.state.value}
                    onValueChange={(next) => field.handleChange(next === "now" ? "now" : "trial")}
                  >
                    <SelectTrigger id="assisted-billing">
                      <SelectValue>
                        {(selected: string) =>
                          selected === "now" ? "Cobro desde hoy" : trialLabel
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="trial">{trialLabel}</SelectItem>
                      <SelectItem value="now">Cobro desde hoy</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
          ) : null}
          {isAdmin ? (
            <form.Field name="planCode">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="assisted-plan">Plan (para cobro desde hoy)</FieldLabel>
                  <Select<string>
                    value={field.state.value || "__none"}
                    onValueChange={(next) =>
                      field.handleChange(!next || next === "__none" ? "" : next)
                    }
                  >
                    <SelectTrigger id="assisted-plan">
                      <SelectValue>{(selected: string) => planNameOf(selected)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Sin plan (prueba)</SelectItem>
                      {plans.map((plan) => (
                        <SelectItem key={plan.code} value={plan.code}>
                          {plan.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
                </Field>
              )}
            </form.Field>
          ) : null}
          {isAdmin ? (
            <form.Field name="sellerId">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="assisted-seller">Vendedora</FieldLabel>
                  <Select<string>
                    value={field.state.value || "__none"}
                    onValueChange={(next) =>
                      field.handleChange(!next || next === "__none" ? "" : next)
                    }
                  >
                    <SelectTrigger id="assisted-seller">
                      <SelectValue>{(selected: string) => sellerNameOf(selected)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Sin vendedora</SelectItem>
                      {sellers.map((seller) => (
                        <SelectItem key={seller.id} value={seller.id}>
                          {seller.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError>{fieldErrorMessages(field.state.meta.errors)[0]}</FieldError>
                </Field>
              )}
            </form.Field>
          ) : null}
          {isAdmin ? (
            <form.Field name="isDemo">
              {(field) => (
                <Field>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={field.state.value}
                      onChange={(event) => field.handleChange(event.target.checked)}
                    />
                    Clínica de demostración (sin cobro)
                  </label>
                </Field>
              )}
            </form.Field>
          ) : null}
        </div>
      </FormDrawer>

    </PageShell>
  )
}
