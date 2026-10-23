import { cn, TabsList } from "@odentia/ui"
import { ChevronRight } from "lucide-react"
import * as React from "react"

/**
 * Franja de pestañas que se desliza cuando no cabe (Bandeja y Pacientes en el
 * teléfono). Mientras queden pestañas a la derecha, el borde se desvanece y una
 * flecha «›» lo anuncia: tocarla avanza la franja. Con el teclado no hace
 * falta: las flechas del grupo ya llevan cada pestaña a la vista.
 */
export function ScrollingTabsList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const [more, setMore] = React.useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: con otras pestañas hay que observar las nuevas.
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === "undefined") return
    const check = () => setMore(list.scrollLeft + list.clientWidth < list.scrollWidth - 1)
    // Los recuentos llegan después: también cambia el ancho de cada pestaña.
    const observer = new ResizeObserver(check)
    observer.observe(list)
    for (const tab of Array.from(list.children)) observer.observe(tab)
    list.addEventListener("scroll", check, { passive: true })
    check()
    return () => {
      observer.disconnect()
      list.removeEventListener("scroll", check)
    }
  }, [children])

  const scrollForward = () => {
    const list = listRef.current
    list?.scrollBy({ left: list.clientWidth * 0.7, behavior: "smooth" })
  }

  return (
    <div className="relative min-w-0 max-w-full">
      <TabsList
        ref={listRef}
        className={cn(
          "max-w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className,
        )}
        {...props}
      >
        {children}
      </TabsList>
      {more ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-px right-px w-20 rounded-r-full bg-linear-to-r from-transparent to-secondary to-55%"
          />
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={scrollForward}
            className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-background text-foreground shadow-sm"
          >
            <ChevronRight className="size-4" />
          </button>
        </>
      ) : null}
    </div>
  )
}
