import { Button, cn } from "@odentia/ui"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

export interface ExpandableTextProps {
  text: string
  lines?: 2 | 3
  label?: string
  className?: string
}

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect

/** El mismo texto, completo o acotado a líneas; ampliar nunca abre ni modifica el registro. */
export function ExpandableText({ text, lines = 2, label = "texto completo", className }: ExpandableTextProps) {
  const id = useId()
  const content = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useBeforePaint(() => {
    const element = content.current
    if (!element) return
    let alive = true
    const measure = () => {
      // Medir plegado también al ampliar o cambiar el ancho, sin copiar el texto al DOM.
      const previous = element.style.webkitLineClamp
      element.style.webkitLineClamp = String(lines)
      const clipped = element.scrollHeight > element.clientHeight + 1
      element.style.webkitLineClamp = previous
      setOverflows(clipped)
    }
    measure()
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return
      width = element.clientWidth
      measure()
    })
    observer.observe(element)
    void document.fonts?.ready.then(() => { if (alive) measure() })
    return () => { alive = false; observer.disconnect() }
  }, [text, lines, expanded])

  // biome-ignore lint/correctness/useExhaustiveDependencies: al cambiar el registro, el nuevo texto empieza plegado.
  useEffect(() => setExpanded(false), [text])

  return (
    <div className="min-w-0 max-w-full" data-slot="expandable-text">
      <div
        ref={content}
        id={id}
        className={cn("overflow-hidden whitespace-pre-wrap [display:-webkit-box] [-webkit-box-orient:vertical] [overflow-wrap:anywhere]", className)}
        style={{ WebkitLineClamp: expanded ? "unset" : lines }}
      >{text}</div>
      {overflows && (
        <Button
          ref={trigger}
          type="button"
          variant="link"
          size="sm"
          className="min-h-11 gap-1 px-0 text-xs font-medium"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${expanded ? "Ver menos" : "Ver más"}: ${label}`}
          onClick={(event) => {
            event.stopPropagation()
            const closing = expanded
            setExpanded(!expanded)
            if (closing) requestAnimationFrame(() => trigger.current?.scrollIntoView({ block: "nearest" }))
          }}
        >
          {expanded ? "Ver menos" : "Ver más"}
          <ChevronDown aria-hidden className={cn("size-3.5", expanded && "rotate-180")} />
        </Button>
      )}
    </div>
  )
}
