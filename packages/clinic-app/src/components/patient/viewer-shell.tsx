import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { Maximize, Minimize, X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import type { PatientFull } from "../../lib/patients"
import type { ZoomPan } from "../../lib/use-zoom-pan"

/**
 * El armazón de los visores de imagen (radiografía, foto y tomografía): toda la
 * ventana en oscuro, como la imagen radiológica; arriba quién y qué es, a la
 * derecha lo que se hace con el archivo, y la imagen como lo principal.
 */

/**
 * El nombre de la persona, de la ficha ya cargada (misma clave, sin otra
 * petición): con el visor abierto la ficha queda tapada y quién es debe verse.
 */
export function usePatientName(patientId: string): string | null {
  const canRead = usePermission("clinical.read")
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canRead,
    staleTime: 5 * 60 * 1000,
  })
  return patient.data?.data.patient.displayName ?? null
}

/**
 * Pantalla completa del navegador, solo donde se puede (en el iPhone no). Va
 * sobre la página entera, no sobre el visor: los menús y avisos se abren fuera
 * del visor y en pantalla completa no se verían.
 */
function useFullscreen() {
  const [active, setActive] = useState(false)
  const target = typeof document !== "undefined" ? document.documentElement : null
  const available = Boolean(
    target && document.fullscreenEnabled && typeof target.requestFullscreen === "function",
  )
  useEffect(() => {
    const update = () => setActive(Boolean(document.fullscreenElement))
    document.addEventListener("fullscreenchange", update)
    return () => document.removeEventListener("fullscreenchange", update)
  }, [])
  /** Al cerrar el visor se sale; pasar de una radiografía a una tomografía no. */
  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
  const toggle = () => {
    if (!target) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void target.requestFullscreen().catch(() => {})
  }
  return { available, active, toggle, exit }
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

export function ViewerShell({
  open,
  onClose,
  title,
  subtitle,
  actions,
  toolbar,
  children,
  onKeyDown,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  /** Botones de la barra superior, antes de pantalla completa y «Cerrar». */
  actions?: ReactNode
  /** La fila de herramientas, debajo de la barra superior. */
  toolbar?: ReactNode
  children: ReactNode
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
}) {
  const fullscreen = useFullscreen()
  const close = () => {
    fullscreen.exit()
    onClose()
  }
  const toggleRef = useRef(fullscreen.toggle)
  toggleRef.current = fullscreen.toggle
  useEffect(() => {
    if (!open || !fullscreen.available) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "f" && event.key !== "F") return
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return
      event.preventDefault()
      toggleRef.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, fullscreen.available])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        className="dark top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-[#05080c] p-0 text-slate-100 sm:max-w-none"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 sm:gap-3 sm:px-4 sm:py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">{title}</DialogTitle>
            <DialogDescription className="truncate text-xs text-slate-400">
              {subtitle}
            </DialogDescription>
          </div>
          {actions}
          {fullscreen.available && (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={fullscreen.active ? "Salir de pantalla completa" : "Pantalla completa"}
              aria-keyshortcuts="F"
              title={fullscreen.active ? "Salir de pantalla completa (F)" : "Pantalla completa (F)"}
              onClick={fullscreen.toggle}
            >
              {fullscreen.active ? (
                <Minimize aria-hidden="true" />
              ) : (
                <Maximize aria-hidden="true" />
              )}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={close}>
            <X aria-hidden="true" />
            Cerrar
          </Button>
        </div>
        {toolbar && (
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2 sm:gap-3 sm:px-4">
            {toolbar}
          </div>
        )}
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** «− 100 % +» sobre la imagen: acerca, aleja y, tocando el porcentaje, ajusta. */
export function ZoomControls({ zoom, className }: { zoom: ZoomPan; className?: string }) {
  const percent = Math.round(zoom.zoom.scale * 100)
  return (
    <fieldset
      className={`pointer-events-auto flex items-center rounded-full border border-slate-700 bg-[#0d131b]/95 p-0.5 text-slate-100 ${className ?? ""}`}
    >
      <legend className="sr-only">Acercar</legend>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Alejar"
        aria-keyshortcuts="-"
        onClick={zoom.zoomOut}
        disabled={percent <= 100}
      >
        <span aria-hidden="true" className="text-base leading-none">
          −
        </span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`Ajustar a la pantalla; ahora al ${percent} %`}
        aria-keyshortcuts="0"
        onClick={zoom.fit}
        className="min-w-14 px-1 tabular-nums"
      >
        <span aria-live="polite">{percent} %</span>
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Acercar"
        aria-keyshortcuts="+"
        onClick={zoom.zoomIn}
        disabled={percent >= 800}
      >
        <span aria-hidden="true" className="text-base leading-none">
          +
        </span>
      </Button>
    </fieldset>
  )
}
