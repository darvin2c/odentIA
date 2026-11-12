/**
 * La ficha del cliente (tablero 3 del lienzo del ARM, ADR 0184): una sola
 * ficha antes y después de tener cuenta. Arriba, quién es y su próximo paso;
 * «Anotar», «Escribir» y «Nueva tarea» a la mano, y lo que decide
 * Administración (Invitar, Dar de alta, No por ahora, Perdido). Las pestañas
 * viven en la dirección (`?tab=`): Resumen, Historial, Contactos, Venta y
 * Documentos siempre; Alta, Plan y pagos (solo Administración), Uso y Soporte
 * cuando tiene cuenta. Cada pestaña pide sus propios datos.
 */
import { Tabs, TabsTrigger, toast } from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageNotice,
  PageShell,
  ScrollingTabsList,
  submitErrorMessage,
} from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ListPlus, MessageSquareText, NotebookPen } from "lucide-react"
import * as React from "react"
import { AnnotateDrawer } from "../../components/arm/annotate-drawer"
import { ClientBillingTab } from "../../components/arm/client-billing-tab"
import { ClientContactsTab } from "../../components/arm/client-contacts-tab"
import { ClientFilesTab } from "../../components/arm/client-files-tab"
import { ClientHeaderFacts, ClientNextStep } from "../../components/arm/client-header"
import { ClientHistoryTab } from "../../components/arm/client-history-tab"
import { invalidateClient, type NextStep } from "../../components/arm/client-model"
import { ClientOnboardingTab } from "../../components/arm/client-onboarding-tab"
import { useClientDetail } from "../../components/arm/client-queries"
import { ClientSaleTab } from "../../components/arm/client-sale-tab"
import { ClientSummaryTab } from "../../components/arm/client-summary-tab"
import { ClientSupportTab } from "../../components/arm/client-support-tab"
import { CLIENT_TAB_NAMES, clientTabsFor, openClientTab } from "../../components/arm/client-tabs"
import { ClientUsageTab } from "../../components/arm/client-usage-tab"
import { DecideDrawer, type SaleDecision } from "../../components/arm/decide-drawer"
import { PresentationDrawer } from "../../components/arm/presentation-drawer"
import { TaskDrawer } from "../../components/arm/task-drawer"
import { WriteDrawer } from "../../components/arm/write-drawer"
import {
  ClientDetailPageSkeleton,
  ClientDetailSkeleton,
} from "../../components/skeletons/client-detail"
import { ApiError, api } from "../../lib/api"
import {
  type ClientSearch,
  type ClientTab,
  clientSearchOf,
  rememberedClientsSearch,
} from "../../lib/list-search"
import { useIsAdmin } from "../../lib/session"

export const Route = createFileRoute("/_app/clients_/$clientId")({
  // Cada clave va siempre: «?tab=xyz» abre el Resumen y «?historial=xyz», Todo.
  validateSearch: (search: Record<string, unknown>): ClientSearch => clientSearchOf(search),
  pendingComponent: ClientDetailPageSkeleton,
  component: ClientPage,
})

type Surface =
  | { kind: "anotar" }
  | { kind: "tarea" }
  | { kind: "mover"; taskId: string }
  | { kind: "escribir" }
  | { kind: "presentacion"; taskId: string }
  | { kind: "decidir"; decision: SaleDecision }

function ClientPage() {
  const { clientId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const isAdmin = useIsAdmin()
  const detail = useClientDetail(clientId)
  const [surface, setSurface] = React.useState<Surface | null>(null)
  const close = () => setSurface(null)

  const done = useMutation({
    mutationFn: (step: NextStep) =>
      api(`/api/admin/clients/tasks/${encodeURIComponent(step.taskId)}/done`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (_, step) => {
      invalidateClient(queryClient, clientId)
      toast.success(`Hecho: ${step.title}`, {
        action: { label: "Anotar qué pasó", onClick: () => setSurface({ kind: "anotar" }) },
      })
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const reopen = useMutation({
    mutationFn: () =>
      api(`/api/admin/clients/${encodeURIComponent(clientId)}/reopen`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => {
      invalidateClient(queryClient, clientId)
      toast.success("Se abrió otra venta, en «Contacto»: la anterior sigue en su historial")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })

  const back = (
    <Link
      to="/clients"
      search={rememberedClientsSearch()}
      className="self-start text-sm text-muted-foreground hover:text-foreground"
    >
      ← Clientes
    </Link>
  )

  if (detail.isPending)
    return (
      <PageShell className="flex flex-col gap-4">
        {back}
        <ClientDetailSkeleton wanted={search.tab} />
      </PageShell>
    )
  if (detail.isError)
    return (
      <PageShell className="flex flex-col gap-4">
        {back}
        {detail.error instanceof ApiError && detail.error.status === 404 ? (
          <EmptyState
            title="No encuentro ese cliente"
            description="Puede que el enlace esté incompleto o que la ficha se haya unido con otra."
            actionLabel="Ver los clientes"
            onAction={() => void navigate({ to: "/clients", search: rememberedClientsSearch() })}
          />
        ) : (
          <ErrorState
            title="No pude cargar la ficha"
            error={detail.error instanceof ApiError ? detail.error.shape : detail.error}
            onRetry={() => void detail.refetch()}
          />
        )}
      </PageShell>
    )

  const client = detail.data
  const rules = { hasAccount: client.organization !== null, isAdmin }
  const tabs = clientTabsFor(rules)
  const tab = openClientTab(search.tab, rules)
  const goTab = (next: ClientTab) =>
    void navigate({
      search: (prev) => ({ ...prev, tab: next === "resumen" ? undefined : next }),
      replace: true,
    })
  const tabProps = {
    clientId: client.id,
    organizationId: client.organization?.id ?? null,
    organizationName: client.organization?.name ?? client.name,
    product: client.product,
    isAdmin,
  }

  return (
    <PageShell className="flex flex-col gap-4">
      {back}
      <PageHeader
        title={client.name}
        subtitle={<ClientHeaderFacts client={client} />}
        primary={{
          label: "Anotar",
          icon: <NotebookPen aria-hidden />,
          onClick: () => setSurface({ kind: "anotar" }),
        }}
        secondary={{
          label: "Escribir",
          icon: <MessageSquareText aria-hidden />,
          onClick: () => setSurface({ kind: "escribir" }),
        }}
        menu={[
          {
            label: "Nueva tarea",
            icon: <ListPlus aria-hidden />,
            onSelect: () => setSurface({ kind: "tarea" }),
          },
        ]}
      />
      {client.archivedAt ? (
        <PageNotice tone="aviso" label="Archivada">
          Esta ficha está archivada: no sale en las listas, pero se lee entera y su historial sigue.
        </PageNotice>
      ) : null}
      <ClientNextStep
        client={client}
        isAdmin={isAdmin}
        actions={{
          onDone: (step) =>
            step.kind === "presentacion"
              ? setSurface({ kind: "presentacion", taskId: step.taskId })
              : done.mutate(step),
          onMove: (step) => setSurface({ kind: "mover", taskId: step.taskId }),
          onTask: () => setSurface({ kind: "tarea" }),
          onDecide: (decision) => setSurface({ kind: "decidir", decision }),
          onReopen: () => reopen.mutate(),
          donePending: done.isPending,
          reopenPending: reopen.isPending,
        }}
      />

      <Tabs
        value={tab}
        onValueChange={(next) => goTab(next as ClientTab)}
        className="min-w-0 max-w-full"
      >
        <ScrollingTabsList aria-label="Secciones del cliente">
          {tabs.map((item) => (
            <TabsTrigger key={item} value={item} className="min-h-11 shrink-0 sm:min-h-9">
              {CLIENT_TAB_NAMES[item]}
            </TabsTrigger>
          ))}
        </ScrollingTabsList>
      </Tabs>

      {tab === "resumen" ? <ClientSummaryTab {...tabProps} /> : null}
      {tab === "historial" ? <ClientHistoryTab {...tabProps} /> : null}
      {tab === "contactos" ? <ClientContactsTab {...tabProps} /> : null}
      {tab === "venta" ? <ClientSaleTab {...tabProps} /> : null}
      {tab === "alta" ? <ClientOnboardingTab {...tabProps} /> : null}
      {tab === "pagos" ? <ClientBillingTab {...tabProps} /> : null}
      {tab === "uso" ? <ClientUsageTab {...tabProps} /> : null}
      {tab === "soporte" ? <ClientSupportTab {...tabProps} /> : null}
      {tab === "documentos" ? <ClientFilesTab {...tabProps} /> : null}

      <AnnotateDrawer clientId={client.id} open={surface?.kind === "anotar"} onClose={close} />
      <TaskDrawer
        clientId={client.id}
        open={surface?.kind === "tarea" || surface?.kind === "mover"}
        taskId={surface?.kind === "mover" ? surface.taskId : null}
        onClose={close}
      />
      <WriteDrawer clientId={client.id} open={surface?.kind === "escribir"} onClose={close} />
      <PresentationDrawer
        clientId={client.id}
        open={surface?.kind === "presentacion"}
        taskId={surface?.kind === "presentacion" ? surface.taskId : null}
        onClose={close}
      />
      {surface?.kind === "decidir" ? (
        <DecideDrawer clientId={client.id} open decision={surface.decision} onClose={close} />
      ) : null}
    </PageShell>
  )
}
