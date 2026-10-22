import { DropdownMenuItem } from "@odentia/ui"
import { CircleHelp } from "lucide-react"
import { OPEN_HELP_EVENT } from "./help-panel"

/**
 * «Ayuda» en el menú ⋯ del encabezado, solo bajo web: en web el botón ya está en
 * la fila. Lo añade el layout a las opciones de cada página.
 */
export function HeaderHelpMenuItem() {
  return (
    <DropdownMenuItem className="lg:hidden" onClick={() => window.dispatchEvent(new Event(OPEN_HELP_EVENT))}>
      <CircleHelp aria-hidden />
      Ayuda
    </DropdownMenuItem>
  )
}
