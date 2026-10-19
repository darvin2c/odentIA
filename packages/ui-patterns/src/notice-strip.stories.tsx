import type { Meta, StoryObj } from "@storybook/react"
import { NoticeStrip, type StripNotice } from "./notice-strip.js"

/**
 * La franja de avisos de la clínica (ADR 0065). Verla en tema oscuro y en
 * ancho de teléfono: una sola línea de 44 px con el texto corto, que se abre
 * al tocarlo. Los avisos son de ejemplo; qué ve cada persona lo decide el
 * servidor (`getClinicNotices`).
 */
const meta = {
  title: "Patrones/NoticeStrip",
  component: NoticeStrip,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof NoticeStrip>

export default meta
type Story = StoryObj<typeof meta>

const noop = () => undefined

const cargo: StripNotice = {
  id: "cargo",
  tone: "aviso",
  message: "Tu cargo de octubre (USD 32.76) vence el viernes 30 de octubre.",
  short: "Tu cargo vence el vie 30 oct",
  action: { label: "Registrar pago", shortLabel: "Pagar", onSelect: noop },
  onDismiss: noop,
}
const tope: StripNotice = {
  id: "tope-alarma",
  tone: "alarma",
  message: "Los agentes llevan USD 9.10 de tu tope de USD 10.00 este mes. A este ritmo llegas el jueves 22 de octubre.",
  short: "Llevas USD 9.10 de tu tope de USD 10.00",
  action: { label: "Subir tope", shortLabel: "Subir", onSelect: noop },
  onDismiss: noop,
}
const soloLectura: StripNotice = {
  id: "solo-lectura",
  tone: "limite",
  message: "La clínica está en solo lectura: falta pagar el cargo de septiembre (USD 32.76). El agente no responde.",
  short: "Solo lectura: falta un pago",
  action: { label: "Registrar pago", shortLabel: "Pagar", onSelect: noop },
}
const soporte: StripNotice = {
  id: "soporte",
  tone: "aviso",
  message: "Diste acceso a soporte de odentIA hasta las 15:40 por el caso «No se envían los recordatorios». Solo ve la configuración, no pacientes.",
  short: "Soporte tiene acceso hasta las 15:40",
  action: { label: "Quitar acceso", shortLabel: "Quitar", onSelect: noop },
  onDismiss: noop,
}

export const Aviso: Story = { args: { notices: [cargo] } }
export const Alarma: Story = { args: { notices: [tope] } }
export const Limite: Story = { args: { notices: [soloLectura] } }
/** Tres a la vez: se ve el más grave, con «y 2 avisos más». */
export const Varios: Story = { args: { notices: [soporte, tope, soloLectura] } }
