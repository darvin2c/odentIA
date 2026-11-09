/**
 * A quién es un ticket (ADR 0172): su paciente o, en una venta de mostrador,
 * quien compró (un contacto o un nombre escrito) o nadie. Una sola regla para
 * la pantalla, el PDF, las listas de Finanzas y el buscador.
 */
import { paymentTicket } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, eq, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { patientPerson } from "./patient-identity.js"

/** El nombre con que se dice una venta de mostrador sin nadie que la compre. */
export const COUNTER_SALE_LABEL = "Venta de mostrador"

/** La persona que compró en el mostrador, cuando la consulta ya usa `contact` y `patient_person`. */
export const buyerPerson = alias(contact, "buyer_person")

/** Une el ticket con quien compró en el mostrador (la misma organización, por la clave compuesta). */
export function joinBuyerPerson(): SQL {
  return and(
    eq(buyerPerson.organizationId, paymentTicket.organizationId),
    eq(buyerPerson.id, paymentTicket.buyerContactId),
  )!
}

/**
 * El nombre de un ticket en una lista: su paciente; si no tiene, quien compró
 * (el contacto, o el nombre escrito) o «Venta de mostrador». Pide la ficha y su
 * persona unidas con `left join` y la de quien compró con `joinBuyerPerson`.
 */
export function ticketPartyNameSql(): SQL<string> {
  return sql<string>`coalesce(${patientPerson.displayName}, ${buyerPerson.displayName}, ${paymentTicket.buyerName}, ${COUNTER_SALE_LABEL})`
}

/**
 * A quién es un ticket o una devolución, como se imprime: «Paciente: …»,
 * «Cliente: …» (una venta de mostrador a alguien) o solo «Venta de mostrador».
 */
export function ticketPartyOf(frozen: {
  patient?: { displayName: string } | null
  buyer?: { displayName: string } | null
}): { label: "Paciente" | "Cliente" | null; name: string } {
  if (frozen.patient) return { label: "Paciente", name: frozen.patient.displayName }
  if (frozen.buyer?.displayName) return { label: "Cliente", name: frozen.buyer.displayName }
  return { label: null, name: COUNTER_SALE_LABEL }
}
