/**
 * «Qué pasó» de un movimiento en una frase de la clínica (tablero 11): llegó
 * de una compra, usado en una atención, vendido en un cobro, conteo, dado de
 * baja, trasladado, inventario inicial. Cada enlace abre lo suyo: la persona
 * su página, la compra al lado y la atención en la historia (si quien mira la
 * lee). Lo usan Movimientos y el producto al lado.
 */
import { Link } from "@tanstack/react-router"
import type * as React from "react"
import { formatWhole, type MovementItem, unitsText } from "../../lib/inventory"
import { PersonLink } from "../person-link"
import { useInventory } from "./inventory-scope"

const LINK = "font-medium text-primary hover:underline"

/** Lo que va después de un separador del motivo («Atención del 19 oct · Limpieza» → «Limpieza»). */
function after(reason: string, separator: string): string | null {
  const index = reason.indexOf(separator)
  return index >= 0 ? reason.slice(index + separator.length).trim() || null : null
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLocaleLowerCase("es") + text.slice(1) : text
}

/** El lote de un movimiento: su código, salvo que sea el número de la compra (un lote sin código de esa compra). */
function lotOf(item: MovementItem): string | null {
  if (!item.lotId) return null
  if (!item.lotCode) return "lote sin código"
  if (item.lotCode === item.purchaseOrderLabel) return null
  return `lote ${item.lotCode}`
}

export function MovementWhat({ item }: { item: MovementItem }) {
  const { open, can } = useInventory()
  const person = item.patientName ? (
    <PersonLink patientId={item.patientId} contactId={item.personId} isPatient className={LINK}>
      {item.patientName}
    </PersonLink>
  ) : null
  const order =
    item.purchaseOrderId && item.purchaseOrderLabel ? (
      <button type="button" className={LINK} onClick={() => open.order(item.purchaseOrderId as string)}>
        {item.purchaseOrderLabel}
      </button>
    ) : null
  const encounter =
    item.encounterId && item.patientId && can.clinical ? (
      <Link to="/patients/$patientId/encounters/$encounterId" params={{ patientId: item.patientId, encounterId: item.encounterId }} className={LINK}>
        la atención
      </Link>
    ) : (
      "la atención"
    )
  const lot = lotOf(item)
  const tail = (...parts: Array<React.ReactNode | null | undefined>) =>
    parts.filter((part) => part !== null && part !== undefined && part !== "").map((part, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: partes fijas de una frase, siempre en el mismo orden.
      <span key={index}> · {part}</span>
    ))

  switch (item.kind) {
    case "ingreso":
      if (order) return <span>Llegó de {order}{tail(lot)}</span>
      return <span>{item.reason}{tail(lot)}</span>
    case "consumo":
      if (item.encounterId && person) {
        const correction = item.reason.startsWith("Corrección") ? after(item.reason, ": ") : null
        if (correction) return <span>Corrección de {encounter} de {person}{tail(correction)}</span>
        return <span>Usado en {encounter} de {person}{tail(after(item.reason, " · "))}</span>
      }
      if (person) return <span>Usado con {person}{tail(item.reason === "Uso fuera de una atención" ? null : item.reason)}</span>
      return <span>{item.reason === "Uso fuera de una atención" ? "Usado fuera de una atención" : `Usado: ${lowerFirst(item.reason)}`}</span>
    case "venta":
      return <span>Vendido a {person ?? "un paciente"}{tail(item.chargeDescription)}</span>
    case "devolucion":
      if (item.encounterId && person) {
        const correction = after(item.reason, ": ")
        return <span>Corrección de {encounter} de {person}{tail(correction)}</span>
      }
      return <span>{item.reason}{tail(person)}</span>
    case "traslado":
      return item.quantityDelta < 0 ? (
        <span>Trasladado a {item.toBranchName ?? "otra sede"}{tail(lot)}</span>
      ) : (
        <span>Llegó de {item.fromBranchName ?? "otra sede"}{tail(lot)}</span>
      )
    case "cobertura":
      return <span>Cubrió lo que se usó sin haber{tail(order, lot)}</span>
    default: {
      // Ajustes: el conteo y el inventario inicial se dicen tal cual; lo demás, con su motivo.
      if (item.encounterId && person) return <span>Corrección de {encounter} de {person}{tail(after(item.reason, ": "))}</span>
      if (item.reason.startsWith("Conteo") || item.reason === "Inventario inicial") return <span>{item.reason}{tail(lot)}</span>
      if (item.reason === "Venció") return <span>Dado de baja: venció{tail(lot)}</span>
      return <span>Ajuste: {lowerFirst(item.reason)}{tail(lot)}</span>
    }
  }
}

/** La cantidad con su signo, en la unidad de uso: «+800 guantes», «−2 guantes». */
export function movementAmount(item: MovementItem): string {
  // El factor del producto pudo cambiar después de la compra: no se reconvierte a cajas.
  return `${item.quantityDelta < 0 ? "−" : "+"}${unitsText(item.quantity, item.unit)}`
}

/** La cantidad corta del producto al lado: «+800», «−2». */
export function movementShort(item: MovementItem): string {
  return `${item.quantityDelta < 0 ? "−" : "+"}${formatWhole(item.quantity)}`
}
