import {
  Badge,
  Button,
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
  PageHeader,
  PageShell,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router"
import { Building2, Plus, Presentation } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { z } from "zod"
import { ApiError, api } from "../../lib/api"
import { rememberOrganizationsSearch } from "../../lib/organizations-search"
import { CreateDemoDrawer, DemoBadge, type DemoItem, DemoProgressDrawer, demoLine, PendingDemoCard, useDemos } from "../../components/demos"
import { type ProductChoice, ProductFilter, ProductMark } from "../../components/product"

interface ListSearch {
  q?: string
  producto?: ProductChoice
  precio?: "negociado"
  /** Reales o demos para presentar (ADR 0096). */
  clase?: "real" | "demo"
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
    ...(search.clase === "real" || search.clase === "demo" ? { clase: search.clase } : {}),
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


const assistedSchema = z
  .object({
    orgName: z.string().trim().min(2, "Nombre de la organización").max(120, "Escribe como mucho 120 caracteres"),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2, "Escribe al menos 2 caracteres")
      .max(63, "Escribe como mucho 63 caracteres")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Minúsculas, números y guiones"),
    email: z.string().trim().email("Correo inválido").max(320, "Escribe como mucho 320 caracteres"),
    countryCode: z.string().trim().length(2, "Elige el país"),
    currency: z.union([z.string().trim().length(3, "Moneda ISO de 3 letras"), z.literal("")]),
    billingStart: z.enum(["trial", "now"]),
    planCode: z.string(),
    sellerId: z.string().trim().max(120),
    isDemo: z.boolean(),
    product: z.enum(CLINICAL_PRODUCTS),
  })
  .superRefine((value, ctx) => {
    if (value.billingStart === "now" && !value.planCode) {
      ctx.addIssue({ code: "custom", path: ["planCode"], message: "Elige un plan para el cobro desde hoy" })
    }
  })

/** Cada producto, como se elige al dar de alta una clínica. */
const PRODUCT_CHOICES: Record<ClinicalProduct, string> = {
  dental: `${productWords("dental").name} · clínica dental`,
  medical: `${productWords("medical").name} · consultorio médico`,
}

/** Lo que dice el 502 `EMAIL_FAILED`: la clínica ya está creada, solo faltó el correo. */
function isEmailFailed(error: unknown): error is ApiError {
  return error instanceof ApiError && error.shape.code === "EMAIL_FAILED"
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
          ...(merged.clase ? { clase: merged.clase } : {}),
        }
      },
      replace: true,
    })
  // Lo recuerda para «← Organizaciones» de la ficha: al volver, la lista sigue como estaba.
  useEffect(() => {
    rememberOrganizationsSearch({
      ...(listSearch.q ? { q: listSearch.q } : {}),
      ...(listSearch.producto && listSearch.producto !== "todos" ? { producto: listSearch.producto } : {}),
      ...(listSearch.precio ? { precio: listSearch.precio } : {}),
      ...(listSearch.clase ? { clase: listSearch.clase } : {}),
    })
  }, [listSearch.q, listSearch.producto, listSearch.precio, listSearch.clase])
  const [assistedOpen, setAssistedOpen] = useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const [demoProgress, setDemoProgress] = useState<string | null>(null)
  const kindFilter = listSearch.clase

  const sessionQuery = useQuery({
    queryKey: ["admin-session"],
    queryFn: async () =>
      z
        .object({ actor: z.object({ role: z.string(), userId: z.string().optional() }) })
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
    queryKey: ["admin-organizations", activeSearch, onlyNegotiated, product, kindFilter],
    queryFn: async () => {
      const raw = await api<unknown>(
        `/api/admin/organizations?q=${encodeURIComponent(activeSearch)}&limit=30${onlyNegotiated ? "&negotiated=1" : ""}${product === "todos" ? "" : `&product=${product}`}${kindFilter ? `&clase=${kindFilter}` : ""}`,
      )
      return orgListSchema.parse(raw)
    },
  })
  // Las demos (ADR 0096): las listas son clínicas de la lista; las que se arman o fallaron, tarjetas aparte.
  const demosQuery = useDemos(kindFilter !== "real")
  // Una que ya es clínica (también mientras se vuelve a armar) va en su tarjeta, con su etiqueta.
  const demoOfOrg = new Map((demosQuery.data ?? []).flatMap((demo) => (demo.organizationId ? [[demo.organizationId, demo] as const] : [])))
  const pendingDemos = (demosQuery.data ?? []).filter(
    (demo) =>
      kindFilter !== "real" &&
      !demo.organizationId &&
      (product === "todos" || demo.product === product) &&
      (!activeSearch || `${demo.name} ${demo.slug}`.toLowerCase().includes(activeSearch.toLowerCase())),
  )

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
  const form = useAppForm({
    defaultValues: assistedDefaults,
    validators: { onSubmit: assistedSchema },
    onSubmit: async ({ value, formApi }) => {
      let raw: unknown
      try {
        raw = await api<unknown>("/api/admin/organizations/assisted", {
          method: "POST",
          body: JSON.stringify({
            ...value,
            slug: value.slug.trim().toLowerCase(),
            currency: value.currency || undefined,
            planCode: value.planCode || undefined,
            sellerId: value.sellerId || undefined,
          }),
        })
      } catch (error) {
        // La clínica ya existe: no se reintenta el alta; el aviso queda hasta cerrarlo.
        if (!isEmailFailed(error)) throw error
        toast.warning(error.shape.message ?? "Clínica creada, pero no se pudo enviar el correo: reenvíalo desde la ficha", {
          duration: Number.POSITIVE_INFINITY,
          closeButton: true,
        })
        setAssistedOpen(false)
        formApi.reset()
        invalidate()
        return
      }
      const created = z.object({ userId: z.string().nullable() }).safeParse(raw)
      toast.success(
        created.success && created.data.userId
          ? "Clínica creada; el correo ya tiene cuenta: acepta la invitación sin crear contraseña"
          : "Clínica creada e invitación enviada",
      )
      setAssistedOpen(false)
      formApi.reset()
      invalidate()
    },
  })
  const assistedSurface = useFormSurface(form)
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
        // Crear demos es de la administración (decisión 11): soporte no lo ve.
        {...(isAdmin ? { secondary: { label: "Crear demo", icon: <Presentation aria-hidden />, onClick: () => setDemoOpen(true) } } : {})}
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
        {/* El precio negociado es de la administración: soporte no filtra por él (ADR 0094). */}
        {isAdmin ? (
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
        ) : null}
        <Select
          value={kindFilter ?? "todas"}
          items={{ todas: "Todas", real: "Reales", demo: "Demos" }}
          onValueChange={(value) => setList({ clase: value === "real" || value === "demo" ? value : undefined })}
        >
          <SelectTrigger aria-label="Clase" className="w-44 shrink-0">
            <span className="text-muted-foreground">Clase:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas</SelectItem>
            <SelectItem value="real">Reales</SelectItem>
            <SelectItem value="demo">Demos</SelectItem>
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
      ) : items.length === 0 && pendingDemos.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Sin clínicas"
          description="Aún no hay clínicas registradas con este criterio."
        />
      ) : (
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {pendingDemos.map((demo) => (
            <li key={demo.id}>
              <PendingDemoCard demo={demo} onOpen={() => setDemoProgress(demo.id)} />
            </li>
          ))}
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
                  {demoOfOrg.get(item.id) ? (
                    <DemoBadge demo={demoOfOrg.get(item.id) as DemoItem} />
                  ) : !item.hasProfile || !item.hasBranch ? (
                    <Badge variant="warning">Alta incompleta</Badge>
                  ) : item.restricted ? (
                    <Badge variant="destructive">Restringida</Badge>
                  ) : (
                    <Badge variant={statusVariant(item.billingStatus)}>{statusLabel(item.billingStatus)}</Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {demoOfOrg.get(item.id) ? demoLine(demoOfOrg.get(item.id) as DemoItem) : `${item.slug} · ${item.memberCount} miembros`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateDemoDrawer
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        currentUserId={sessionQuery.data?.actor.userId ?? null}
        onCreated={(id) => {
          setDemoOpen(false)
          setDemoProgress(id)
        }}
      />
      <DemoProgressDrawer demoId={demoProgress} onClose={() => setDemoProgress(null)} />

      <FormDrawer
        {...assistedSurface}
        open={assistedOpen}
        onClose={() => setAssistedOpen(false)}
        title="Alta asistida"
        description="Crea la clínica una sola vez y siempre envía invitación de propietaria: entrar exige aceptación; quien ya tiene cuenta acepta sin crear contraseña."
        submitLabel="Crear clínica"
        cancelLabel={common.actions.cancel}
      >
        <div className="flex flex-col gap-4">
          {/* El producto no cambia después (decisión 9 del issue 229): la clínica abre en su dominio. */}
          <form.AppField name="product">
            {(field) => (
              <field.Control
                id="assisted-product"
                label="Producto"
                description="No se cambia después: la clínica abre en el dominio de su producto."
              >
                {(control) => (
                  <Select<ClinicalProduct>
                    value={field.state.value}
                    onValueChange={(next) => {
                      if (!next) return
                      field.handleChange(next)
                      // El plan elegido era del otro producto: se vuelve a elegir.
                      form.setFieldValue("planCode", "")
                    }}
                  >
                    <SelectTrigger
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    >
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
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="orgName">
            {(field) => <field.TextField id="assisted-org" label="Nombre de la clínica" maxLength={120} />}
          </form.AppField>
          <form.AppField name="slug">
            {(field) => (
              <field.TextField
                id="assisted-slug"
                label="Dirección personalizada"
                description="Será su dirección en el dominio de su producto, en minúsculas sin espacios."
                maxLength={63}
                autoCapitalize="none"
              />
            )}
          </form.AppField>
          <form.AppField name="email">
            {(field) => (
              <field.TextField id="assisted-email" label="Correo de la propietaria" type="email" maxLength={320} />
            )}
          </form.AppField>
          <form.AppField name="countryCode">
            {(field) => (
              <field.Control id="assisted-country" label="País">
                {(control) => (
                  <Select<string>
                    value={field.state.value || "PE"}
                    onValueChange={(next) => {
                      if (next) field.handleChange(next)
                    }}
                  >
                    <SelectTrigger
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    >
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
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="currency">
            {(field) => (
              <field.Control id="assisted-currency" label="Moneda (opcional: propone el país)">
                {(control) => (
                  <Select<string>
                    value={field.state.value || "__auto"}
                    onValueChange={(next) => field.handleChange(!next || next === "__auto" ? "" : next)}
                  >
                    <SelectTrigger
                      id={control.id}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    >
                      <SelectValue>{(selected: string) => (selected === "__auto" ? "La del país" : selected)}</SelectValue>
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
                )}
              </field.Control>
            )}
          </form.AppField>
          {isAdmin ? (
            <form.AppField name="billingStart">
              {(field) => (
                <field.Control id="assisted-billing" label="Inicio">
                  {(control) => (
                    <Select<string>
                      value={field.state.value}
                      onValueChange={(next) => field.handleChange(next === "now" ? "now" : "trial")}
                    >
                      <SelectTrigger
                        id={control.id}
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                      >
                        <SelectValue>{(selected: string) => (selected === "now" ? "Cobro desde hoy" : trialLabel)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="trial">{trialLabel}</SelectItem>
                        <SelectItem value="now">Cobro desde hoy</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : null}
          {isAdmin ? (
            <form.AppField name="planCode">
              {(field) => (
                <field.Control id="assisted-plan" label="Plan (para cobro desde hoy)">
                  {(control) => (
                    <Select<string>
                      value={field.state.value || "__none"}
                      onValueChange={(next) => field.handleChange(!next || next === "__none" ? "" : next)}
                    >
                      <SelectTrigger
                        id={control.id}
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                      >
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
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : null}
          {isAdmin ? (
            <form.AppField name="sellerId">
              {(field) => (
                <field.Control id="assisted-seller" label="Vendedora">
                  {(control) => (
                    <Select<string>
                      value={field.state.value || "__none"}
                      onValueChange={(next) => field.handleChange(!next || next === "__none" ? "" : next)}
                    >
                      <SelectTrigger
                        id={control.id}
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                      >
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
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : null}
          {isAdmin ? (
            <form.AppField name="isDemo">
              {(field) => <field.CheckboxField id="assisted-demo" label="Clínica de demostración (sin cobro)" />}
            </form.AppField>
          ) : null}
        </div>
      </FormDrawer>

    </PageShell>
  )
}
