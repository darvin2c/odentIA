import { cn, ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from "@odentia/ui"
import * as React from "react"

/** Corte del modo panel: el ancho donde tabla y tarjeta caben a la vez. */
const PANEL_QUERY = "(min-width: 1280px)"

export type DetailMode = "panel" | "drawer"

/** Anchos predefinidos de la columna de detalle: de formulario compacto a wizard. */
export type DetailPanelSize = "md" | "lg" | "xl"

const PANEL_SIZES: Record<DetailPanelSize, { default: string; min: string; max: string }> = {
  md: { default: "24rem", min: "20rem", max: "32rem" },
  lg: { default: "32rem", min: "26rem", max: "40rem" },
  xl: { default: "40rem", min: "32rem", max: "52rem" },
}

// Corrige el modo antes del primer paint (sin flash drawer→panel); en el
// servidor cae a `useEffect` para no emitir el aviso de `useLayoutEffect`.
// Mismo patrón que `useResolvedView` de data-table-view.
const useEffectBeforePaint: typeof React.useEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * Modo efectivo del detalle: `panel` cuando hay ancho para la tabla y la
 * tarjeta lateral a la vez, `drawer` en el resto. El estado inicial es el
 * estrecho a propósito, igual que `useResolvedView`.
 *
 * No usa `useIsMobile` (corta en 768px): tabla + panel de 24rem necesitan
 * bastante más. Vive aquí y no en `packages/ui` porque el corte debe coincidir
 * con lo que la página renderiza como alternativa (`FormDrawer`).
 */
export function useDetailMode(): DetailMode {
  const [isWide, setIsWide] = React.useState(false)

  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia(PANEL_QUERY)
    const apply = () => setIsWide(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  return isWide ? "panel" : "drawer"
}

export interface MasterDetailProps {
  /** Contenido maestro: filtros, tabla y sus estados de carga/vacío/error. */
  children: React.ReactNode
  /** Detalle lateral; `null` colapsa la columna y devuelve el ancho al maestro. */
  panel?: React.ReactNode | null
  /** Ancho de la columna de detalle según el tipo de formulario (compacto → wizard). */
  panelSize?: DetailPanelSize
  className?: string
}

/**
 * Lista maestra con detalle lateral sobre `ResizablePanelGroup`: el borde entre
 * columnas se arrastra (y se redimensiona por teclado desde el handle), y el
 * detalle se abre/cierra colapsando su panel, sin remontar el maestro.
 *
 * - Modo `drawer` (<1280px): no hay group; el maestro va a ancho completo y la
 *   página monta el formulario en un `FormDrawer`.
 * - Modo `panel` con detalle abierto: el group acota su alto al viewport menos
 *   el padding de la página y cada columna scrollea por dentro, así el detalle
 *   y su footer de acciones quedan siempre a la vista.
 * - Detalle cerrado: el panel colapsa a 0 y el handle se apaga (`w-0` +
 *   `disabled`), así el maestro recupera todo el ancho sin gutter fantasma.
 * - El ancho del detalle lo elige la página con `panelSize`: `md` para
 *   formularios compactos, `lg`/`xl` para formularios de dos columnas o
 *   asistentes (wizard), que a 24rem quedan apretados.
 *
 * Abrir/cerrar es instantáneo: la librería escribe `flex-basis` imperativo y no
 * trae transición; animarlo exigiría una clase condicional solo para cambios
 * programáticos, que pelearía con el drag.
 */
export function MasterDetail({ children, panel, panelSize = "md", className }: MasterDetailProps) {
  const mode = useDetailMode()
  const open = panel != null
  const size = PANEL_SIZES[panelSize]
  const detailRef = usePanelRef()
  // El panel de detalle y el handle no se montan hasta la primera apertura:
  // `collapse()` antes de la primera medición del group no sobrevive al layout
  // inicial (la librería relayoutea con `defaultSize` y deja una columna vacía).
  const [everOpened, setEverOpened] = React.useState(open)

  // Expandir/colapsar sin remontar: la librería ajusta el tamaño imperativamente.
  // Effect de layout para que el colapso inicial ocurra antes del paint.
  React.useLayoutEffect(() => {
    const detail = detailRef.current
    if (!detail) return
    if (open) detail.expand()
    else detail.collapse()
  }, [open, detailRef])

  React.useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])

  if (mode === "drawer") {
    return <div className={cn("flex min-w-0 flex-col gap-6", className)}>{children}</div>
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      // Por `style` y no por clase: el wrapper trae `h-full` de base y el merge
      // de clases no garantiza que gane el alto fijo; la librería solo bloquea
      // display/flex-direction/flex-wrap/overflow, así que `height` es nuestro.
      style={{ height: open ? "calc(100dvh - 3rem)" : "auto" }}
      className={className}
    >
      <ResizablePanel
        id="master"
        minSize="32rem"
        className="flex h-full min-w-0 flex-col gap-6 overflow-y-auto"
      >
        {children}
      </ResizablePanel>
      {everOpened ? (
        <>
          <ResizableHandle
            withHandle
            disabled={!open}
            className={cn("w-6 bg-transparent", !open && "w-0 overflow-hidden")}
          />
          <ResizablePanel
            id="detail"
            panelRef={detailRef}
            collapsible
            collapsedSize={0}
            defaultSize={size.default}
            minSize={size.min}
            maxSize={size.max}
            className="h-full min-w-0"
          >
            {open ? panel : null}
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  )
}
