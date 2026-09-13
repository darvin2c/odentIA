import { cn } from "@odentia/ui";
import type { ReactNode } from "react";

/**
 * Riel de navegación vertical para secciones de una vista (settings, paneles
 * con muchas secciones). NO es un tab: las Tabs quedan para alternar vistas
 * horizontales (2–5 pares, p. ej. Lista/Plano). SideNav navega entre
 * superficies distintas: filas full-width con icono opcional, texto a la
 * izquierda y estado activo por fila completa, mismo lenguaje que el menú
 * del AppShell. El estado vive en la URL del lado del consumidor.
 */
export type SideNavItem = {
  /** Valor estable que identifica la sección (va a la URL). */
  value: string;
  label: string;
  icon?: ReactNode;
};

export type SideNavProps = {
  "aria-label": string;
  items: readonly SideNavItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
};

export function SideNav({ "aria-label": ariaLabel, items, value, onValueChange, className }: SideNavProps) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = item.value === value;
          return (
            <li key={item.value}>
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onValueChange(item.value)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium leading-none transition-colors",
                  active
                    ? "bg-surface-muted text-foreground"
                    : "text-muted-foreground hover:bg-surface-muted/70 hover:text-foreground",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
