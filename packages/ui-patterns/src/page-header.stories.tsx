import { Button, cn, DropdownMenuItem } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import { Bell, Bot, CalendarPlus, CircleHelp, Search } from "lucide-react"
import type * as React from "react"
import { HeaderUtilitiesProvider, useHeaderCompact } from "./header-utilities.js"
import { PageHeader } from "./page-header.js"
import { PageShell } from "./page-shell.js"

/**
 * Encabezado de una sola línea, en todos los anchos: título (se recorta), las
 * utilidades globales, una acción principal y el menú ⋯ con lo demás. En el
 * teléfono, botones de 44 px solo con icono y «Agente» y «Ayuda» en ⋯; desde
 * 768 px, icono y texto. Si la fila no cabe, queda compacta: utilidades solo en
 * íconos y «Ayuda» en ⋯. El contexto (sede, recuento) va en su propia fila,
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

/** Un botón de utilidad: con la fila compacta, solo el icono. */
function Utility({ label, icon, name, className }: { label: string; icon: React.ReactNode; name: string; className?: string }) {
  const compact = useHeaderCompact()
  return (
    <Button
      type="button"
      variant="outline"
      className={cn("h-9 gap-2 rounded-full px-3 max-md:size-11", compact && "w-9 gap-0 px-0", className)}
      aria-label={name}
    >
      {icon}
      {compact ? null : <span className="hidden md:inline">{label}</span>}
    </Button>
  )
}

/** «Ayuda» deja la fila cuando está compacta y pasa a ⋯. */
function HelpUtility() {
  const compact = useHeaderCompact()
  return compact ? null : <Utility label="Ayuda" name="Ayuda" icon={<CircleHelp className="size-4" aria-hidden />} />
}

function HelpMenuItem() {
  return useHeaderCompact() ? <DropdownMenuItem>Ayuda</DropdownMenuItem> : null
}

/** Las utilidades globales de la clínica, como las monta el layout. */
const utilities = (
  <>
    <Utility label="Buscar" name="Buscar en todo" icon={<Search className="size-4" aria-hidden />} />
    <HelpUtility />
    <Utility label="Avisos" name="Avisos, 2 sin leer" icon={<Bell className="size-4" aria-hidden />} />
    <Utility label="Agente" name="Agente" className="max-md:hidden" icon={<Bot className="size-4" aria-hidden />} />
  </>
)
const menuItems = (
  <>
    <HelpMenuItem />
    <DropdownMenuItem className="md:hidden">Agente</DropdownMenuItem>
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
    <HeaderUtilitiesProvider value={{ utilities, menuItems }}>
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
    <HeaderUtilitiesProvider value={{ utilities, menuItems }}>
      <PageShell className="flex flex-col gap-3">
        <PageHeader title="Inicio" subtitle="Miércoles 21 de octubre" />
      </PageShell>
    </HeaderUtilitiesProvider>
  ),
}

/** Título largo: se recorta con puntos suspensivos y la fila no se parte. */
export const TituloLargo: Story = {
  render: () => (
    <HeaderUtilitiesProvider value={{ utilities, menuItems }}>
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
    <HeaderUtilitiesProvider value={{ utilities, menuItems }}>
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

/**
 * Red de seguridad: con poco ancho (un panel lateral abierto, zoom al 125 %)
 * la fila queda compacta. Aquí, el contenido mide 620 px.
 */
export const Compacta: Story = {
  render: () => (
    <HeaderUtilitiesProvider value={{ utilities, menuItems }}>
      <PageShell className="flex max-w-[620px] flex-col gap-3">
        <PageHeader
          title="Configuración"
          primary={{ label: "Guardar cambios", icon: <CalendarPlus className="size-4" aria-hidden />, onClick: noop }}
        />
      </PageShell>
    </HeaderUtilitiesProvider>
  ),
}
