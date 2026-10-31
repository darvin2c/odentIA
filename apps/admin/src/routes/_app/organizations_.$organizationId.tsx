/**
 * La ficha de una clínica en su propia página (lienzo «Gastos por
 * organización», decisión D3): Resumen, Gastos, Precio y prueba, Equipo,
 * Actividad y Cargar datos (ADR 0104). La pestaña y los filtros de Gastos
 * viven en la dirección, así que el enlace a «Gastos» de una clínica se puede
 * compartir. Soporte ve Resumen sin importes, Equipo y Actividad (decisión
 * D4, ADR 0094).
 */

import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import {
  Badge,
  Button,
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from "@odentia/ui"
import { ConfirmDialog, ErrorState, PageShell, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { OrgBillingSection } from "../../components/org-billing"
import { OrgImport } from "../../components/org-import"
import { OrgSpending, type SpendingAgent, type SpendingSearch } from "../../components/org-spending"
import { type BillingSummary, OrgSummary } from "../../components/org-summary"
import { ProductMark } from "../../components/product"
import { api } from "../../lib/api"
import { plural } from "../../lib/cost-format"
import { DemoBand, DemoShowcase, useDemoOfOrganization, useOpenDemo } from "../../components/demos"
import { domainOf, platformUrl } from "../../lib/host"
import {
  ORGANIZATION_TAB_NAMES,
  ORGANIZATION_TABS,
  type OrganizationTab,
  openOrganizationTab,
  organizationTabsFor,
} from "../../lib/organization-tabs"
import { rememberedOrganizationsSearch } from "../../lib/organizations-search"
import { useIsAdmin } from "../../lib/session"
import { OrganizationDetailPageSkeleton, OrganizationDetailSkeleton } from "../../components/skeletons/organization-detail"

/** Todo es opcional en la dirección: lo que falta es lo de siempre (Resumen, este mes, todo). */
const searchSchema = z.object({
  tab: z.enum(ORGANIZATION_TABS).optional().catch(undefined),
  agente: z.enum(["todo", "sofi", "clio", "argos", "sin_cobro"]).optional().catch(undefined),
  mes: z.enum(["actual", "anterior"]).optional().catch(undefined),
  profesional: z.string().optional().catch(undefined),
  canal: z.string().optional().catch(undefined),
  pagina: z.coerce.number().int().min(1).optional().catch(undefined),
})
type DetailSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute("/_app/organizations_/$organizationId")({
  pendingComponent: OrganizationDetailPageSkeleton,
  component: OrganizationPage,
  validateSearch: (search: Record<string, unknown>): DetailSearch => searchSchema.parse(search),
})

const detailSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  product: z.enum(CLINICAL_PRODUCTS).default("dental"),
  provisioning: z.object({
    hasProfile: z.boolean(),
    hasBranch: z.boolean(),
    complete: z.boolean(),
  }),
  members: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.string(),
      blocked: z.boolean(),
    }),
  ),
  invitations: z.array(
    z.object({
      id: z.string(),
      organizationId: z.string(),
      email: z.string(),
      role: z.string().nullable(),
      status: z.string(),
      expiresAt: z.string(),
    }),
  ),
  usage: z.object({
    members: z.number(),
    branches: z.number(),
    patients: z.number(),
    contacts: z.number(),
    pendingInvitations: z.number(),
  }),
  activity: z.array(
    z.object({ action: z.string(), actorRole: z.string().nullable(), createdAt: z.string() }),
  ),
  billing: z
    .object({
      status: z.string(),
      restricted: z.boolean(),
      isDemo: z.boolean(),
      plan: z.object({ name: z.string() }).nullable(),
    })
    .nullable(),
})

const STATUS_WORDS: Record<string, string> = {
  prueba: "En prueba",
  activa: "Activa",
  gracia: "En gracia",
  restringida: "Restringida",
  pausada: "Pausada",
  cancelada: "Cancelada",
  sin_suscripcion: "Sin suscripción",
}
const statusVariant = (status: string | null) =>
  status === "activa"
    ? "success"
    : status === "gracia" || status === "pausada"
      ? "warning"
      : status === "restringida"
        ? "destructive"
        : "secondary"
const ROLE_WORDS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  reception: "Recepción",
  clinician: "Profesional",
  cashier: "Caja",
  member: "Miembro",
}
const INVITATION_WORDS: Record<string, string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  canceled: "Cancelada",
  rejected: "Rechazada",
  expired: "Vencida",
}
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso))

function OrganizationPage() {
  const { organizationId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const [cancelTarget, setCancelTarget] = useState<{ id: string; email: string } | null>(null)

  const isAdmin = useIsAdmin()
  const detail = useQuery({
    queryKey: ["admin-organization", organizationId],
    queryFn: async () =>
      detailSchema.parse(await api<unknown>(`/api/admin/organizations/${organizationId}`)),
  })
  // Si es una demo para presentar (ADR 0096): su franja y lo que tiene hoy para mostrar.
  const demo = useDemoOfOrganization(organizationId)
  const openDemo = useOpenDemo()
  const billing = useQuery({
    queryKey: ["admin", "organizations", organizationId, "billing"],
    enabled: isAdmin,
    queryFn: () => api<BillingSummary | null>(`/api/admin/organizations/${organizationId}/billing`),
  })

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin-organization", organizationId] })
  const resend = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/admin/organizations/invitations/${id}/resend`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Invitación reenviada")
      invalidate()
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const cancel = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/admin/organizations/invitations/${id}/cancel`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Invitación cancelada")
      setCancelTarget(null)
      invalidate()
    },
  })

  const go = (next: DetailSearch) =>
    void navigate({
      search: (previous) => {
        const merged = { ...previous, ...next }
        return {
          ...(merged.tab && merged.tab !== "resumen" ? { tab: merged.tab } : {}),
          ...(merged.agente && merged.agente !== "todo" ? { agente: merged.agente } : {}),
          ...(merged.mes && merged.mes !== "actual" ? { mes: merged.mes } : {}),
          ...(merged.profesional ? { profesional: merged.profesional } : {}),
          ...(merged.canal ? { canal: merged.canal } : {}),
          ...(merged.pagina && merged.pagina > 1 ? { pagina: merged.pagina } : {}),
        }
      },
    })
  const spending: SpendingSearch = {
    agente: search.agente ?? "todo",
    mes: search.mes ?? "actual",
    pagina: search.pagina ?? 1,
    ...(search.profesional ? { profesional: search.profesional } : {}),
    ...(search.canal ? { canal: search.canal } : {}),
  }
  // Soporte no abre lo que tiene importes, aunque llegue con el enlace (la API tampoco se lo da).
  const tabs = organizationTabsFor(isAdmin)
  const tab = openOrganizationTab(search.tab, isAdmin)
  const back = (
    <Link
      to="/organizations"
      search={rememberedOrganizationsSearch()}
      className="self-start text-sm text-muted-foreground hover:text-foreground"
    >
      ← Organizaciones
    </Link>
  )

  if (detail.isPending)
    return (
      <PageShell className="flex flex-col gap-4">
        {back}
        <OrganizationDetailSkeleton wanted={search.tab} overview={spending.agente === "todo"} />
      </PageShell>
    )
  if (detail.isError)
    return (
      <PageShell className="flex flex-col gap-4">
        {back}
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </PageShell>
    )
  const org = detail.data
  const status = org.billing?.status ?? null
  const terms = billing.data
  const cycle = terms
    ? terms.billingCycle === "quincenal"
      ? `se factura a los ${terms.halfCycleDays} días y al cerrar el mes`
      : "se factura cada mes"
    : null
  const facts = [
    org.slug,
    isAdmin && org.billing?.plan ? org.billing.plan.name : null,
    isAdmin && terms ? (terms.seller ? `vendedor: ${terms.seller.name}` : "sin vendedor") : null,
    // Una demo no se factura (ADR 0096): el ciclo no aplica.
    isAdmin && !org.billing?.isDemo ? cycle : null,
    plural(org.usage.members, "miembro", "miembros"),
    plural(org.usage.patients, "paciente", "pacientes"),
    plural(org.usage.branches, "sede", "sedes"),
  ].filter(Boolean)

  return (
    <PageShell className="flex flex-col gap-4">
      {back}
      <header className="flex flex-col gap-1.5">
        <ProductMark product={org.product} kind className="text-sm" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading text-2xl font-semibold">{org.name}</h1>
          <Badge variant={org.billing?.restricted ? "destructive" : statusVariant(status)}>
            {STATUS_WORDS[status ?? ""] ?? "Sin dato"}
          </Badge>
          {org.billing?.isDemo ? <Badge variant="outline">Demo</Badge> : null}
          {demo.data?.status === "lista" ? (
            <Button type="button" variant="link" className="h-auto p-0 text-sm underline sm:ml-auto" onClick={() => demo.data && openDemo.mutate(demo.data)}>
              Abrir en {org.slug}.{domainOf(org.product)} ↗
            </Button>
          ) : (
            <a
              className="text-sm underline sm:ml-auto"
              href={platformUrl(org.slug, "/home", org.product)}
              target="_blank"
              rel="noreferrer"
            >
              Abrir en {org.slug}.{domainOf(org.product)} ↗
            </a>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p>
        {!org.provisioning.complete ? (
          <p className="text-sm text-muted-foreground">
            Alta incompleta: {!org.provisioning.hasProfile ? "falta el perfil legal; " : ""}
            {!org.provisioning.hasBranch ? "falta la primera sede. " : ""}La persona invitada la
            completa desde el panel sin crear otra clínica.
          </p>
        ) : null}
      </header>

      {demo.data ? (
        <DemoBand
          demo={demo.data}
          isAdmin={isAdmin}
          onDeleted={() => void navigate({ to: "/organizations", search: rememberedOrganizationsSearch() })}
        />
      ) : null}

      <Tabs value={tab} onValueChange={(value) => go({ tab: value as OrganizationTab })}>
        <ScrollArea horizontal className="min-w-0 max-w-full">
          <TabsList aria-label="Secciones de la clínica" className="max-w-full justify-start">
            {tabs.map((item) => (
              <TabsTrigger key={item} value={item}>
                {ORGANIZATION_TAB_NAMES[item]}
              </TabsTrigger>
            ))}
          </TabsList>
        </ScrollArea>
      </Tabs>

      {tab === "resumen" && demo.data ? <DemoShowcase demo={demo.data} /> : null}
      {tab === "resumen" ? (
        <OrgSummary
          organizationId={org.id}
          isAdmin={isAdmin}
          members={org.usage.members}
          pendingInvitations={org.usage.pendingInvitations}
          onSpending={(agent: SpendingAgent) =>
            go({
              tab: "gastos",
              agente: agent,
              pagina: 1,
              profesional: undefined,
              canal: undefined,
            })
          }
          onTeam={() => go({ tab: "equipo" })}
        />
      ) : null}
      {tab === "gastos" ? (
        <OrgSpending
          organizationId={org.id}
          search={spending}
          onSearch={(next) =>
            go({
              ...next,
              ...("profesional" in next ? { profesional: next.profesional } : {}),
              ...("canal" in next ? { canal: next.canal } : {}),
            })
          }
        />
      ) : null}
      {tab === "precio" ? <OrgBillingSection organizationId={org.id} /> : null}
      {tab === "carga" ? <OrgImport organizationId={org.id} organizationName={org.name} /> : null}
      {tab === "equipo" ? (
        <div className="flex flex-col gap-4">
          <section
            className="flex flex-col gap-2 rounded-xl border bg-card p-4"
            aria-labelledby="miembros"
          >
            <h2 id="miembros" className="text-base font-medium">
              Miembros · {org.members.length}
            </h2>
            <ul className="flex flex-col divide-y text-sm">
              {org.members.map((item) => (
                <li
                  key={item.userId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2"
                >
                  <span className="font-medium">{item.name}</span>
                  <span className="text-muted-foreground">{item.email}</span>
                  <span className="text-muted-foreground">
                    {ROLE_WORDS[item.role] ?? item.role}
                  </span>
                  {item.blocked ? <Badge variant="destructive">Bloqueado</Badge> : null}
                </li>
              ))}
            </ul>
          </section>
          <section
            className="flex flex-col gap-2 rounded-xl border bg-card p-4"
            aria-labelledby="invitaciones"
          >
            <h2 id="invitaciones" className="text-base font-medium">
              Invitaciones
            </h2>
            {org.invitations.length ? (
              <ul className="flex flex-col divide-y text-sm">
                {org.invitations.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="min-w-0 truncate font-medium">{item.email}</span>
                    <span className="text-muted-foreground">
                      {item.role ? (ROLE_WORDS[item.role] ?? item.role) : "—"}
                    </span>
                    <Badge variant={item.status === "pending" ? "warning" : "outline"}>
                      {INVITATION_WORDS[item.status] ?? item.status}
                    </Badge>
                    {item.status === "pending" ? (
                      <span className="ml-auto flex gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={resend.isPending}
                          onClick={() => resend.mutate(item.id)}
                        >
                          Reenviar
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setCancelTarget({ id: item.id, email: item.email })}
                        >
                          Cancelar
                        </Button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Sin invitaciones.</p>
            )}
          </section>
        </div>
      ) : null}
      {tab === "actividad" ? (
        <section
          className="flex flex-col gap-2 rounded-xl border bg-card p-4"
          aria-labelledby="actividad"
        >
          <h2 id="actividad" className="text-base font-medium">
            Lo que se hizo desde la administración
          </h2>
          {org.activity.length ? (
            <ul className="flex flex-col divide-y text-sm">
              {org.activity.map((item) => (
                <li
                  key={`${item.createdAt}-${item.action}-${item.actorRole ?? "personal"}`}
                  className="flex flex-wrap justify-between gap-2 py-2"
                >
                  <span>
                    {item.action} · {item.actorRole ?? "Personal"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {dateTime(item.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Sin actividad registrada.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Las restricciones de suscripción se gestionan en Cobros.
          </p>
        </section>
      ) : null}

      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancelar invitación"
        description={`Se cancelará la invitación de ${cancelTarget?.email ?? ""}. Podrás crear otra después.`}
        confirmLabel="Cancelar invitación"
        variant="destructive"
        pending={cancel.isPending}
        error={cancel.isError ? submitErrorMessage(cancel.error) : null}
        onConfirm={() => {
          if (cancelTarget) cancel.mutate(cancelTarget.id)
        }}
        onClose={() => {
          cancel.reset()
          setCancelTarget(null)
        }}
      />
    </PageShell>
  )
}
