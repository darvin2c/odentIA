import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui";
import { Ellipsis } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Tono del ítem: `danger` pinta en rojo (eliminar, archivar). Mismo
 * vocabulario que el resto de acciones terminales.
 */
export type RowActionTone = "default" | "danger";

export interface RowActionItem {
  key: string;
  label: string;
  icon?: ReactNode;
  tone?: RowActionTone;
  disabled?: boolean;
  onSelect: () => void;
}

export interface RowActionsProps {
  /** Etiqueta accesible del botón (p. ej. `Acciones de Mesa T1`). */
  label: string;
  items: RowActionItem[];
  align?: "start" | "end";
}

/**
 * Acciones de fila: un solo botón icono (ellipsis) con dropdown.
 * Obligatorio en toda lista/tabla con más de una acción por fila:
 * mantiene las filas compactas y el gesto táctil en 44px.
 */
export function RowActions({ label, items, align = "end" }: RowActionsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            className="min-h-11 min-w-11"
          >
            <Ellipsis aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align={align}>
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            disabled={item.disabled}
            variant={item.tone === "danger" ? "destructive" : "default"}
            onClick={() => item.onSelect()}
          >
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
