import type { Meta, StoryObj } from "@storybook/react"
import { CreditCard } from "lucide-react"
import { type Place, PlaceSwitcher } from "./place-switcher.js"

/**
 * El selector de lugares de la barra lateral: el lugar actual con qué es y el rol, lo suyo arriba
 * y los demás lugares. Con lugares de más de un tipo, agrupados por app con su color.
 */
const meta = {
  title: "Patrones/PlaceSwitcher",
  component: PlaceSwitcher,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlaceSwitcher>

export default meta
type Story = StoryObj<typeof meta>

const dental: Place = {
  id: "1",
  name: "Dental Smile",
  brand: "odentia",
  role: "Recepción",
  href: "#dental-smile",
}
const sonrisa: Place = {
  id: "2",
  name: "Clínica Dental Sonrisa Norte de Los Olivos",
  brand: "odentia",
  role: "Odontólogo",
  href: "#sonrisa",
}
const pediatria: Place = {
  id: "3",
  name: "Pediatría Los Olivos",
  brand: "latidia",
  role: "Recepción",
  href: "#pediatria",
}
const optica: Place = {
  id: "4",
  name: "Óptica Visión Clara",
  brand: "vistia",
  role: "Propietario",
  href: "#optica",
}
const tienda: Place = {
  id: "5",
  name: "Rosita Moda",
  brand: "gestoria",
  role: "Dueña",
  href: "#rosita",
}

const plan = { label: "Plan y pagos", icon: <CreditCard aria-hidden />, onSelect: () => {} }
const cambiar = { label: "Cambiar de clínica", href: "#panel" }

/** Clínicas de un solo tipo: la lista simple, el lugar actual marcado. */
export const UnSoloTipo: Story = {
  args: {
    current: dental,
    places: [dental, sonrisa],
    actions: [plan],
    footerActions: [cambiar],
    menuLabel: "Menú de la clínica",
  },
}

/** Rosa en Dental Smile, con un consultorio de latidIA, una óptica y su tienda. */
export const VariasApps: Story = {
  args: {
    current: dental,
    places: [dental, sonrisa, pediatria, optica, tienda],
    actions: [plan],
    footerActions: [cambiar],
    menuLabel: "Menú de la clínica",
  },
}

/** Lo de cobro que pide actuar marca el lugar y su acción. */
export const ConAviso: Story = {
  args: {
    current: dental,
    places: [dental, pediatria],
    alert: { label: "Pago vencido", tone: "danger" },
    actions: [{ ...plan, badge: { label: "Pago vencido", tone: "danger" } }],
    footerActions: [cambiar],
    menuLabel: "Menú de la clínica",
  },
}

/** Un solo lugar: sin lista, solo lo suyo. */
export const UnSoloLugar: Story = {
  args: {
    current: tienda,
    places: [tienda],
    actions: [{ label: "Plan y pagos", onSelect: () => {} }],
    menuLabel: "Menú de la tienda",
  },
}
