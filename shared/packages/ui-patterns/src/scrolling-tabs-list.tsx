import { cn, TabsList } from "@odentia/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"
import * as React from "react"

/** Lo que tapan la flecha y el borde que se desvanece: la pestaña elegida queda fuera de eso. */
const EDGE = 44

/** La pestaña elegida queda entera a la vista, fuera de las flechas; `smooth` cuando la elige la persona. */
export function revealActiveTab(list: HTMLElement, behavior: ScrollBehavior): void {
  const tab = list.querySelector<HTMLElement>('[data-slot="tabs-trigger"][data-active]')
  if (!tab) return
  const box = list.getBoundingClientRect()
  const rect = tab.getBoundingClientRect()
  let delta = 0
  if (rect.left < box.left + EDGE) delta = rect.left - (box.left + EDGE)
  else if (rect.right > box.right - EDGE)
    delta = Math.min(rect.right - (box.right - EDGE), rect.left - (box.left + EDGE))
  // Entre 0 y el final: la primera pestaña queda pegada a su borde, sin flecha delante.
  const left = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, list.scrollLeft + delta))
  if (Math.abs(left - list.scrollLeft) < 1) return
  if (typeof list.scrollTo === "function") list.scrollTo({ left, behavior })
  else list.scrollLeft = left
}

/**
 * Franja de pestañas que se desliza cuando no cabe (Bandeja y Pacientes en el
 * teléfono). La pestaña elegida queda siempre a la vista: al montarse y cada vez
 * que cambia. Mientras queden pestañas a un lado, ese borde se desvanece y una
 * flecha («‹» o «›») lo anuncia: tocarla mueve la franja. Con el teclado no hace
 * falta: las flechas del grupo llevan cada pestaña a la vista, fuera de las flechas
 * (`scroll-padding`).
 */
export function ScrollingTabsList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const [more, setMore] = React.useState({ before: false, after: false })
  // La persona movió la franja a mano (dedo, rueda o flechas): lo que cambie de ancho después no
  // la devuelve a la elegida. Elegir otra pestaña vuelve a dejarla a cargo de la franja.
  const movedByHand = React.useRef(false)

  // Una sola vez: al montar y cada vez que cambia la elegida. No depende de `children`, que es
  // otro objeto en cada dibujo del padre (un recuento nuevo en la Bandeja no mueve la franja).
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    // Al montar, sin animación: la franja ya aparece con la elegida a la vista.
    revealActiveTab(list, "auto")
    // Elegir otra pestaña (con el dedo, el ratón o desde fuera, como una dirección) la trae entera.
    const active =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            movedByHand.current = false
            revealActiveTab(list, reduced ? "auto" : "smooth")
          })
    active?.observe(list, { subtree: true, attributes: true, attributeFilter: ["data-active"] })
    const byHand = () => {
      movedByHand.current = true
    }
    for (const event of ["wheel", "touchstart", "pointerdown"] as const) {
      list.addEventListener(event, byHand, { passive: true })
    }
    return () => {
      active?.disconnect()
      for (const event of ["wheel", "touchstart", "pointerdown"] as const) {
        list.removeEventListener(event, byHand)
      }
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: con otras pestañas hay que observar las nuevas.
  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const check = () => {
      const before = list.scrollLeft > 1
      const after = list.scrollLeft + list.clientWidth < list.scrollWidth - 1
      setMore((now) => (now.before === before && now.after === after ? now : { before, after }))
    }
    // Los recuentos llegan después: también cambia el ancho de cada pestaña. Si nadie movió la
    // franja a mano, la elegida sigue a la vista.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (!movedByHand.current) revealActiveTab(list, "auto")
            check()
          })
    observer?.observe(list)
    for (const tab of Array.from(list.children)) observer?.observe(tab)
    list.addEventListener("scroll", check, { passive: true })
    check()
    return () => {
      observer?.disconnect()
      list.removeEventListener("scroll", check)
    }
  }, [children])

  const scrollBy = (direction: 1 | -1) => {
    const list = listRef.current
    movedByHand.current = true
    list?.scrollBy({ left: direction * list.clientWidth * 0.7, behavior: "smooth" })
  }

  return (
    <div className="relative min-w-0 max-w-full">
      <TabsList
        ref={listRef}
        className={cn(
          // El margen de las flechas: con el teclado, la pestaña enfocada no queda debajo de ellas.
          "max-w-full scroll-px-11 justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className,
        )}
        {...props}
      >
        {children}
      </TabsList>
      {more.before ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-px left-px w-20 rounded-l-full bg-linear-to-l from-transparent to-secondary to-55%"
          />
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            data-edge="before"
            onClick={() => scrollBy(-1)}
            className="absolute top-1/2 left-1 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-background text-foreground shadow-sm"
          >
            <ChevronLeft className="size-4" />
          </button>
        </>
      ) : null}
      {more.after ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-px right-px w-20 rounded-r-full bg-linear-to-r from-transparent to-secondary to-55%"
          />
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            data-edge="after"
            onClick={() => scrollBy(1)}
            className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-background text-foreground shadow-sm"
          >
            <ChevronRight className="size-4" />
          </button>
        </>
      ) : null}
    </div>
  )
}
