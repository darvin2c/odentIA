import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { Info } from "lucide-react"

/**
 * «Así se calcula»: el texto del servidor que dice de dónde sale una cifra
 * (`howCalculated`). Se abre junto a la cifra con el teclado o el dedo y se
 * cierra con Esc o al tocar fuera; el foco vuelve al botón. La cifra nunca la
 * pone Kairós: la pone el cálculo.
 */
export function HowCalculated({
  text,
  what,
  className,
}: {
  text: string
  what: string
  className?: string
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("h-auto min-h-8 px-2 text-xs text-muted-foreground", className)}
            aria-label={`Así se calcula: ${what}`}
          />
        }
      >
        <Info aria-hidden className="size-3.5" />
        Así se calcula
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <p className="text-sm font-semibold">{what}</p>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{text}</p>
      </PopoverContent>
    </Popover>
  )
}
