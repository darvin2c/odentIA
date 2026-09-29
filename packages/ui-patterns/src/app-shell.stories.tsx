import { Badge, Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { Contact, Inbox, Kanban, Plus, Smile, Tag } from "lucide-react"
import { useMemo, type ReactNode } from "react"
import { AppShell, type AppShellNavEntry } from "./app-shell.js"
import { KpiCard } from "./kpi-card.js"
import { FilterBar, type FilterDef, type SortOption } from "./list-filtering/index.js"
import { PageHeader } from "./page-header.js"
import { PageShell } from "./page-shell.js"
import { FormDrawer } from "./form/index.js"
import { DetailList, DetailField, DetailSection } from "./detail/index.js"
import {
  DemoDetailBody,
  DemoFields,
  DemoTable,
  demoSubmit,
} from "./story-fixtures.js"

/**
 * Shell completo de una pantalla de trabajo: `AppShell` aporta sidebar y pie,
 * `PageShell` el fondo y padding, y `PageHeader` la única fila de cabecera con
 * el disparador del menú en todos los anchos. Cada arquetipo (lista, detalle,
 * formulario, tablero) compone esas tres piezas sin cabeceras propias: así se
 * ve igual en todas las pantallas. Cambia el viewport de Storybook a 390px
 * para comprobar el corte móvil (sidebar como drawer, tabla como lista).
 */
const meta = {
  title: "Patrones/AppShell",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function AnchorLink({
  to,
  search,
  children,
  ...rest
}: {
  to?: string
  search?: Record<string, string>
  children: ReactNode
  [key: string]: unknown
}) {
  return (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...rest}>
      {children}
    </a>
  )
}

const NAV_ITEMS: AppShellNavEntry[] = [
  { label: "Bandeja", to: "/inbox", icon: Inbox },
  { label: "Contactos", to: "/contacts", icon: Contact },
  { label: "Pacientes", to: "/patients", icon: Smile },
  { label: "Pipeline", to: "/pipeline", icon: Kanban },
  { label: "Servicios", to: "/services", icon: Tag },
]

const FILTERS: FilterDef[] = [
  {
    key: "estado",
    label: "Estado",
    type: "select",
    options: [
      { value: "activo", label: "Activos" },
      { value: "archivado", label: "Archivados" },
    ],
  },
  { key: "canal", label: "Canal", type: "multi", options: [{ value: "whatsapp", label: "WhatsApp" }] },
]

const SORT_OPTIONS: SortOption[] = [
  { value: "nombre", label: "Nombre" },
  { value: "recientes", label: "Recientes" },
]

/** Router de memoria: `FilterBar` lee y escribe search plano de la URL. */
function StoryRouter({ children }: { children: ReactNode }) {
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet })
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => children,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
  }, [children])
  return <RouterProvider router={router} />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      items={NAV_ITEMS}
      LinkComponent={AnchorLink}
      pathname="/contacts"
      user={{ name: "Ana Torres", email: "ana@odentia.dev" }}
      brand={<span className="text-base font-semibold">odentIA</span>}
      onSignOut={() => {}}
    >
      {children}
    </AppShell>
  )
}

/** Lista operativa: cabecera con acción primaria, filtros y tabla compartida. */
export const Lista: Story = {
  render: () => (
    <StoryRouter>
      <Shell>
        <PageShell className="flex flex-col gap-4">
          <PageHeader
            title="Contactos"
            subtitle="Pacientes y conversaciones asociadas"
            actions={
              <Button type="button">
                <Plus className="size-4" />
                Nuevo contacto
              </Button>
            }
          />
          <FilterBar filters={FILTERS} sortOptions={SORT_OPTIONS} searchPlaceholder="Buscar por nombre, teléfono…" />
          <DemoTable />
        </PageShell>
      </Shell>
    </StoryRouter>
  ),
}

/** Detalle de lectura: la misma cabecera, con contexto y acciones propias. */
export const Detalle: Story = {
  render: () => (
    <StoryRouter>
      <Shell>
        <PageShell className="flex flex-col gap-6">
          <PageHeader
            title="Rosa Quispe"
            subtitle="HC-000001 · contacto desde hace 3 días"
            actions={<Button type="button" variant="outline">Reanudar atención</Button>}
          />
          <div className="flex flex-col gap-6 rounded-md bg-card p-6">
            <DemoDetailBody />
            <DetailSection title="Responsables">
              <DetailList>
                <DetailField label="Responsable">Jorge Quispe (padre)</DetailField>
                <DetailField label="Vigencia">Hasta 12/2027</DetailField>
              </DetailList>
            </DetailSection>
          </div>
        </PageShell>
      </Shell>
    </StoryRouter>
  ),
}

/** Formulario modal sobre la lista: el drawer aporta cabecera y acciones fijas. */
export const Formulario: Story = {
  render: () => (
    <StoryRouter>
      <Shell>
        <PageShell className="flex flex-col gap-4">
          <PageHeader title="Contactos" subtitle="Pacientes y conversaciones asociadas" />
          <DemoTable />
          <FormDrawer
            open
            onClose={() => {}}
            title="Nuevo contacto"
            description="Los datos de contacto alimentan todas las vías de conversación."
            onSubmit={demoSubmit}
            submitLabel="Guardar"
            cancelLabel="Cancelar"
          >
            <DemoFields />
          </FormDrawer>
        </PageShell>
      </Shell>
    </StoryRouter>
  ),
}

/** Tablero: métricas compartidas y secciones bajo la misma cabecera. */
export const Tablero: Story = {
  render: () => (
    <StoryRouter>
      <Shell>
        <PageShell className="flex flex-col gap-6">
          <PageHeader title="Inicio" subtitle="Tu jornada · lunes 28 · America/Lima" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard title="Citas de hoy" value={12} description="Abrir agenda" />
            <KpiCard title="Esperan respuesta" value={3} description="2 con atención humana" />
            <KpiCard title="Tareas vencidas" value={3} description="8 tareas abiertas" />
            <KpiCard title="Cuentas con saldo" value={3} description="Revisar cobranza · por moneda" />
          </div>
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <section className="flex min-w-0 flex-col gap-3 rounded-md bg-card p-5">
              <h2 className="font-semibold">Agenda de hoy</h2>
              <ul className="divide-y">
                <li className="flex items-center justify-between gap-4 py-3">
                  <span className="font-medium">Rosa Quispe</span>
                  <Badge variant="secondary">Confirmada</Badge>
                </li>
                <li className="flex items-center justify-between gap-4 py-3">
                  <span className="font-medium">Diego Salazar</span>
                  <Badge variant="secondary">En sala</Badge>
                </li>
              </ul>
            </section>
            <section className="flex min-w-0 flex-col gap-3 rounded-md bg-card p-5">
              <h2 className="font-semibold">Cobranza pendiente</h2>
              <ul className="divide-y">
                <li className="py-3">
                  <p className="font-medium">S/ 1 240.00</p>
                  <p className="text-sm text-muted-foreground">Vencido: S/ 320.00</p>
                </li>
              </ul>
            </section>
          </div>
        </PageShell>
      </Shell>
    </StoryRouter>
  ),
}
