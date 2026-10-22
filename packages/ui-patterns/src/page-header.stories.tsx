import { Button } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { Bell, Bot, CalendarPlus, Search } from "lucide-react"
import { HeaderUtilitiesProvider } from "./header-utilities.js"
import { PageHeader } from "./page-header.js"
import { PageShell } from "./page-shell.js"

/**
 * Encabezado de una sola línea, en todos los anchos: título (se recorta), las
 * utilidades globales, una acción principal y el menú ⋯ con lo demás. En el
 * teléfono, la acción principal y las utilidades solo muestran icono; desde
 * tableta, icono y texto. El contexto (sede, recuento) va en su propia fila,
 * bajo el encabezado. Cambia el viewport a 360 px para ver la versión del
 * teléfono.
 */
const meta = {
  title: "Patrones/PageHeader",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

/** Las utilidades globales de la clínica, como las monta el layout. */
const utilities = (
  <>
    <Button type="button" variant="outline" className="h-9 gap-2 rounded-full px-3 max-md:w-9 max-md:px-0 max-md:gap-0" aria-label="Buscar en todo">
      <Search className="size-4" aria-hidden />
      <span className="hidden md:inline">Buscar</span>
    </Button>
    <Button type="button" variant="outline" className="h-9 gap-2 rounded-full px-3 max-md:w-9 max-md:px-0 max-md:gap-0" aria-label="Avisos, 2 sin leer">
      <Bell className="size-4" aria-hidden />
      <span className="hidden md:inline">Avisos</span>
    </Button>
    <Button type="button" variant="outline" className="h-9 gap-2 rounded-full px-3 max-md:w-9 max-md:px-0 max-md:gap-0" aria-label="Agente">
      <Bot className="size-4" aria-hidden />
      <span className="hidden md:inline">Agente</span>
    </Button>
  </>
)

/** Pacientes: «Nuevo paciente» es la acción principal; lo demás, en ⋯. */
export const UnaLinea: Story = {
  render: () => (
    <PageShell className="flex flex-col gap-3">
      <PageHeader
        title="Pacientes"
        primary={{ label: "Nuevo paciente", icon: <CalendarPlus className="size-4" aria-hidden />, onClick: noop }}
        menu={[{ label: "Nuevo contacto", onSelect: noop }]}
      />
    </PageShell>
  ),
}

/** Con las utilidades globales de la clínica y su ⋯ con «Ayuda» bajo web. */
export const ConUtilidades: Story = {
  render: () => (
    <HeaderUtilitiesProvider value={{ utilities, menuItems: <span>Ayuda</span> }}>
      <PageShell className="flex flex-col gap-3">
        <PageHeader
          title="Finanzas"
          primary={{ label: "Cobrar", icon: <CalendarPlus className="size-4" aria-hidden />, onClick: noop }}
          menu={[
            { label: "Registrar gasto", onSelect: noop },
            { label: "Cerrar caja", onSelect: noop },
          ]}
        />
      </PageShell>
    </HeaderUtilitiesProvider>
  ),
}

/** Sin acción principal: solo título, utilidades y el ⋯ de «Ayuda» bajo web. */
export const SinAccion: Story = {
  render: () => (
    <HeaderUtilitiesProvider value={{ utilities, menuItems: <span>Ayuda</span> }}>
      <PageShell className="flex flex-col gap-3">
        <PageHeader title="Inicio" subtitle="Miércoles 21 de octubre" />
      </PageShell>
    </HeaderUtilitiesProvider>
  ),
}

/** Título largo: se recorta con puntos suspensivos y la fila no se parte. */
export const TituloLargo: Story = {
  render: () => (
    <HeaderUtilitiesProvider value={{ utilities, menuItems: <span>Ayuda</span> }}>
      <PageShell className="flex flex-col gap-3">
        <PageHeader
          title="Plan de tratamiento de María de los Ángeles Quispe Flores de la Cruz"
          primary={{ label: "Agendar", icon: <CalendarPlus className="size-4" aria-hidden />, onClick: noop }}
          menu={[{ label: "Enviar presupuesto", onSelect: noop }]}
        />
      </PageShell>
    </HeaderUtilitiesProvider>
  ),
}

/** El contexto (la sede) va en su propia fila, bajo el encabezado. */
export const ConContexto: Story = {
  render: () => (
    <HeaderUtilitiesProvider value={{ utilities, menuItems: <span>Ayuda</span> }}>
      <PageShell className="flex flex-col gap-3">
        <PageHeader
          title="Agenda"
          subtitle={
            <Button type="button" variant="outline" size="sm" className="rounded-full">
              Sede Miraflores
            </Button>
          }
          primary={{ label: "Nueva cita", icon: <CalendarPlus className="size-4" aria-hidden />, onClick: noop }}
        />
      </PageShell>
    </HeaderUtilitiesProvider>
  ),
}
