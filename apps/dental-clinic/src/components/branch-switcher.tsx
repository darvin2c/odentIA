import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { Check, ChevronDown } from "lucide-react"
import type { BranchOption } from "../lib/active-branch"

/**
 * Selector de sede de una pantalla que trabaja por sede. Va siempre en el
 * mismo sitio: bajo el título, en el `subtitle` de `PageHeader`. Con una sola
 * sede no hay nada que elegir y queda como texto.
 */
export function BranchSwitcher({
  branches,
  value,
  fallbackName,
  onChange,
}: {
  branches: BranchOption[]
  value: string
  /** Nombre de la sede cuando la lista aún no ha cargado. */
  fallbackName: string
  onChange: (id: string) => void
}) {
  const current = branches.find((item) => item.id === value)?.name ?? fallbackName
  if (branches.length <= 1) return <span className="truncate">{current}</span>
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            title="Cambiar de sede"
            className="-ml-2.5 h-7 gap-1 px-2.5 font-normal text-muted-foreground"
          />
        }
      >
        <span className="truncate">{current}</span>
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {branches.map((item) => (
          <DropdownMenuItem key={item.id} onClick={() => onChange(item.id)}>
            {item.name}
            {item.id === value ? <Check aria-hidden className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
