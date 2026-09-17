import { Button, Spinner } from "@odentia/ui"
import type { ComponentProps, ReactNode } from "react"
import { common } from "../common.js"

/**
 * Botón de mutación: deshabilita + muestra Spinner manteniendo el label.
 * El label NUNCA se reemplaza por un "Cargando…" genérico: cambiar el texto
 * mueve el layout y pierde el contexto de qué se está guardando.
 * `size` es la escala shadcn del Button; `className` solo para layout
 * (anchos) y alturas táctiles operativas (p. ej. `min-h-12 w-full` en POS).
 */
export type SubmitButtonProps = {
  children: ReactNode
  /** Mutación en vuelo: deshabilita y muestra el Spinner. */
  pending?: boolean
  disabled?: boolean
  variant?: ComponentProps<typeof Button>["variant"]
  size?: ComponentProps<typeof Button>["size"]
  type?: "button" | "submit"
  onClick?: () => void
  className?: string
}

export function SubmitButton({
  children,
  pending = false,
  disabled = false,
  variant = "default",
  size = "default",
  type = "button",
  onClick,
  className,
}: SubmitButtonProps) {
  return (
    <Button
      type={type}
      variant={variant}
      size={size}
      disabled={disabled || pending}
      aria-busy={pending}
      onClick={onClick}
      className={className}
    >
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <Spinner className="size-4" aria-label={common.states.loading} />
          <span>{children}</span>
        </span>
      ) : (
        children
      )}
    </Button>
  )
}
