import { Button } from "@odentia/ui";
import { Plus } from "lucide-react";

/**
 * Botón canónico de creación a nivel de vista: primario, `Plus` + label
 * ("Nueva sucursal", "Nuevo producto"). Vive arriba a la derecha del header
 * de la vista o tarjeta. La creación de hijos dentro de una lista NO usa este
 * componente: va como primer ítem del `RowActions` del padre. Los estados
 * vacíos usan la acción propia de `EmptyState`. Sin props de estilo: si crea
 * algo a nivel de vista, es exactamente este botón.
 */
export type NewButtonProps = {
  /** Texto visible: "Nueva X" / "Nuevo X" desde el catálogo i18n. */
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export function NewButton({ label, onClick, disabled }: NewButtonProps) {
  return (
    <Button type="button" className="min-h-11" disabled={disabled} onClick={onClick}>
      <Plus aria-hidden />
      {label}
    </Button>
  );
}
