import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import {
  Archive,
  Contact,
  Download,
  Inbox,
  Kanban,
  MoreHorizontal,
  Plus,
  Settings,
  Smile,
  Tag,
} from "lucide-react"
import type { ReactNode } from "react"
import { AppShell, type AppShellNavEntry, type AppShellNavItem } from "./app-shell.js"
import { PageHeader } from "./page-header.js"
import { PageShell } from "./page-shell.js"
import { DemoPage } from "./story-fixtures.js"

/**
 * Header mínimo: una sola fila siempre, también en móvil. El título se recorta
 * antes que partir las acciones a una segunda línea, y las acciones nunca se
 * envuelven. Cambia el viewport de Storybook a 360px para ver cada adaptación
 * en el ancho que decide el diseño.
 */
const meta = {
  title: "Patrones/PageHeader",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

/**
 * Link del router. En Storybook no hay router de TanStack, así que el contrato
 * `ShellLinkComponent` lo cumple este `<a>`: mismo papel que `RouterLink` en
 * platform, sin adaptadores.
 */
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

/** Mismo nav que el layout `_org` de platform. */
const NAV_ITEMS: AppShellNavEntry[] = [
  { label: "Bandeja", to: "/inbox", icon: Inbox },
  { label: "Contactos", to: "/contacts", icon: Contact },
  { label: "Pacientes", to: "/patients", icon: Smile },
  { label: "Pipeline", to: "/pipeline", icon: Kanban },
  { label: "Servicios", to: "/services", icon: Tag },
]

const FOOTER_ITEMS: AppShellNavItem[] = [
  { label: "Configuración", to: "/settings", icon: Settings },
]

/** Caso base: título, una línea de contexto y la acción primaria de la página. */
export const Base: Story = {
  render: () => (
    <DemoPage>
      <PageHeader
        title="Pacientes"
        subtitle="Fichas clínicas de la organización"
        actions={
          <Button size="sm">
            <Plus /> Nuevo paciente
          </Button>
        }
      />
    </DemoPage>
  ),
}

/** Sin subtítulo: el título ocupa las dos líneas del bloque y nada más. */
export const SinSubtitulo: Story = {
  render: () => (
    <DemoPage>
      <PageHeader
        title="Prestaciones"
        actions={
          <Button variant="outline" size="sm">
            <Download /> Exportar
          </Button>
        }
      />
    </DemoPage>
  ),
}

/**
 * Título largo: se recorta con puntos suspensivos. El nombre completo vive en
 * el detalle; aquí la fila nunca crece de alto ni empuja las acciones.
 */
export const TituloLargo: Story = {
  render: () => (
    <DemoPage>
      <PageHeader
        title="María de los Ángeles Quispe Flores de la Cruz"
        subtitle="Contacto desde hace 3 meses"
        actions={
          <Button size="sm">
            <Plus /> Nueva atención
          </Button>
        }
      />
    </DemoPage>
  ),
}

/**
 * Acción primaria más secundarias: la secundaria se pliega por debajo del corte
 * móvil (`hidden sm:inline-flex`) y deja el ancho al título. Es la adaptación
 * para dos o tres acciones sin comerse el encabezado.
 */
export const SecundariaSePliega: Story = {
  render: () => (
    <DemoPage>
      <PageHeader
        title="Sucursales"
        subtitle="Clínica Odontológica Sur"
        actions={
          <>
            <Button variant="outline" size="sm" className="hidden sm:inline-flex">
              <Download /> Exportar
            </Button>
            <Button size="sm">
              <Plus /> Nueva sucursal
            </Button>
          </>
        }
      />
    </DemoPage>
  ),
}

/**
 * Muchas acciones: una primaria visible y el resto dentro de un menú «⋯». La
 * fila mantiene un solo botón de ancho fijo en cualquier viewport.
 */
export const AccionesEnMenu: Story = {
  render: () => (
    <DemoPage>
      <PageHeader
        title="Contactos"
        subtitle="Pacientes y conversaciones asociadas"
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon-sm" aria-label="Más acciones" />}
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>
                  <Download /> Exportar
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Archive /> Archivar seleccionados
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm">
              <Plus /> Nuevo
            </Button>
          </>
        }
      />
    </DemoPage>
  ),
}

/** Barra densa de página completa: nada entre el header y su scroll propio. */
export const EnPaginaDensa: Story = {
  render: () => (
    <DemoPage>
      <div className="flex h-[60vh] min-h-0 flex-col gap-3">
        <PageHeader
          title="Bandeja"
          subtitle="WhatsApp y Telegram · 12 sin leer"
          actions={
            <Button variant="outline" size="sm">
              <Inbox /> Filtros
            </Button>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md bg-card p-6 text-sm text-muted-foreground">
          El contenido administra su propio scroll por debajo del header.
        </div>
      </div>
    </DemoPage>
  ),
}

/**
 * Con el shell real: en móvil el header monta el disparador del drawer —es el
 * único de la app— y en escritorio queda oculto (el menú se colapsa desde el
 * riel). Baja el viewport de 768px y pulsa el botón para abrirlo.
 */
export const EnElShell: Story = {
  render: () => (
    <AppShell
      items={NAV_ITEMS}
      LinkComponent={AnchorLink}
      pathname="/patients"
      user={{ name: "Lucía Ramos", email: "recepcion@clinicasur.pe" }}
      footerItems={FOOTER_ITEMS}
      brand={<span className="text-base font-semibold">odentIA</span>}
      onSignOut={noop}
    >
      <PageShell className="flex flex-col gap-6">
        <PageHeader
          title="Pacientes"
          subtitle="Fichas clínicas de la organización"
          actions={
            <Button size="sm">
              <Plus /> Nuevo paciente
            </Button>
          }
        />
        <div className="rounded-md bg-card p-6 text-sm text-muted-foreground">
          El contenido de la página sigue al header, dentro del mismo `PageShell`.
        </div>
      </PageShell>
    </AppShell>
  ),
}
