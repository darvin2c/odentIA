import { type ReactNode, useEffect, useRef } from "react"

/**
 * El título de una pantalla que se abre en el mismo lugar (el enlace, el
 * registro recibido): al abrirla, el foco va a él y el lector lo dice, en vez
 * de quedar en la página (revisión final del 15 nov, ux U7). Cada pantalla
 * nueva lleva su propia `key` para que el foco se mueva al cambiar.
 */
export function FocusedTitle({ className, children }: { className?: string; children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <h1 ref={ref} tabIndex={-1} className={`outline-none ${className ?? ""}`}>
      {children}
    </h1>
  )
}
