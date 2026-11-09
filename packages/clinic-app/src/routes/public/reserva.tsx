import { createFileRoute } from "@tanstack/react-router"
import {
  PersonalLinkPage,
  personalLinkHead,
  validatePersonalLinkSearch,
} from "../../components/public/personal-link-page"

/**
 * «Elige tu cita» (ADR 0167): el enlace que envía el agente para reservar lleva
 * directo a elegir con quién, el día y la hora y, al revisar, sus datos. Si ya
 * eligió la hora en el chat, el enlace la trae (`sede`, `con`, `hora`). Cuando
 * el enlace ya no ofrece reservar (ya reservó, o es el de sus pendientes), lleva
 * a `/pendientes` con el mismo token: así siguen abriendo los QR y los mensajes
 * de antes, también los que llegaban a «Tus mensajes» con `#mensajes`.
 */
export const Route = createFileRoute("/reserva")({
  validateSearch: validatePersonalLinkSearch,
  head: personalLinkHead,
  component: BookingPage,
})

function BookingPage() {
  return <PersonalLinkPage entry="reserva" search={Route.useSearch()} />
}
