import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@odentia/ui"
import { CircleHelp, MoreHorizontal } from "lucide-react"
import { OPEN_HELP_EVENT } from "./help-panel"

/** En el teléfono, lo que no cabe en la fila del encabezado va aquí: hoy, la ayuda. */
export function HeaderMoreMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button type="button" variant="outline" size="icon" className="size-11 rounded-full sm:hidden" aria-label="Más opciones" />
        }
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(OPEN_HELP_EVENT))}>
          <CircleHelp aria-hidden />
          Ayuda
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
