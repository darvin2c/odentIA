import { DropdownMenuItem } from "@odentia/ui"
import { useHeaderCompact } from "@odentia/ui-patterns"
import { CircleHelp } from "lucide-react"
import { OPEN_HELP_EVENT } from "./help-panel"

/**
 * «Ayuda» en el menú ⋯ del encabezado, solo con la fila compacta (teléfono, o
 * cuando la fila no cabe): si no, el botón ya está en la fila. Lo añade el
 * layout a las opciones de cada página.
 */
export function HeaderHelpMenuItem() {
  const compact = useHeaderCompact()
  if (!compact) return null
  return (
    <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(OPEN_HELP_EVENT))}>
      <CircleHelp aria-hidden />
      Ayuda
    </DropdownMenuItem>
  )
}
