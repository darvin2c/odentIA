import { Button, cn } from "@odentia/ui"
import type { ReactNode } from "react"

export interface PageNoticeProps {
  /** `aviso` informa, `alarma` pide actuar pronto, `limite` ya pasó algo (pausa, tope, restricción). */
  tone: "aviso" | "alarma" | "limite"
  /** Rótulo corto que dice el nivel en palabras, no solo con color: «Aviso», «Alarma», «En pausa». */
  label: string
  children: ReactNode
  /** La acción que resuelve el aviso: un enlace o un botón. */
  action?: ReactNode
  /** Si se puede ocultar hasta el siguiente nivel; lo que ya pasó no se oculta. */
  onDismiss?: () => void
  className?: string
}

/**
 * Aviso de una pantalla: con el nivel, lo que pasa y la acción que lo
 * resuelve, dentro de la pantalla donde importa («Recepción está apagada» en
 * la Bandeja, lo pendiente de un registro en la administración). Lo que afecta
 * a toda la clínica va en la franja (`NoticeStrip`), no aquí (ADR 0065).
 * `alarma` y `limite` se anuncian como alerta.
 */
export function PageNotice({ tone, label, children, action, onDismiss, className }: PageNoticeProps) {
  return (
    <div
      role={tone === "aviso" ? "status" : "alert"}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-4 py-2 text-sm",
        tone === "aviso" && "border-border bg-card",
        tone === "alarma" && "border-warning/40 bg-warning-soft",
        tone === "limite" && "border-destructive/40 bg-destructive/5",
        className,
      )}
    >
      <span
        className={cn(
          "shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold",
          tone === "aviso" && "bg-muted text-foreground",
          tone === "alarma" && "bg-warning text-background",
          tone === "limite" && "bg-destructive text-destructive-foreground",
        )}
      >
        {label}
      </span>
      <p className="min-w-0 flex-1 basis-60">{children}</p>
      {action ? <span className="shrink-0">{action}</span> : null}
      {onDismiss && tone !== "limite" ? (
        <Button variant="ghost" size="sm" onClick={onDismiss} aria-label="Ocultar aviso">
          Ocultar
        </Button>
      ) : null}
    </div>
  )
}
