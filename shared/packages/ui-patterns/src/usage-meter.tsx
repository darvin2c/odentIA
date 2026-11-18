import { cn } from "@odentia/ui"

export interface UsageMeterProps {
  /** Qué se mide: «Crédito del mes», «Tope por encima del crédito». */
  label: string
  /** Cuánto va usado, en las unidades de `total`. */
  value: number
  total: number
  /** La cifra dicha con las palabras de la pantalla: «USD 29 de USD 29». */
  valueText: string
  /** Lo que conviene saber del medidor: cuándo se acabó, qué pasa al llegar. */
  description?: string
  /**
   * Desde qué parte del total avisa y alarma (0 a 1): los niveles de los
   * avisos de cobro, que entrega el servidor con las condiciones comerciales.
   */
  warnAt: number
  alarmAt: number
  className?: string
}

/** Nivel del medidor: también se dice en texto, nunca solo con color. */
export function usageMeterLevel(value: number, total: number, warnAt: number, alarmAt: number): "normal" | "aviso" | "alarma" | "lleno" {
  if (total <= 0) return value > 0 ? "lleno" : "normal"
  const ratio = value / total
  if (ratio >= 1) return "lleno"
  if (ratio >= alarmAt) return "alarma"
  if (ratio >= warnAt) return "aviso"
  return "normal"
}

const LEVEL_WORDS = { normal: null, aviso: "Cerca del límite", alarma: "Casi en el límite", lleno: "Completo" } as const

/**
 * Medidor de consumo: cuánto se usó de un crédito, un saldo o un tope. Un
 * `meter` accesible (valor, mínimo, máximo y texto), con el nivel también
 * dicho en palabras; el color usa los tokens de estado del tema.
 */
export function UsageMeter({ label, value, total, valueText, description, warnAt, alarmAt, className }: UsageMeterProps) {
  const level = usageMeterLevel(value, total, warnAt, alarmAt)
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : level === "lleno" ? 1 : 0
  const words = LEVEL_WORDS[level]
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-sm tabular-nums">
          {valueText}
          {words ? (
            <span className={cn("ml-2 text-xs font-medium", level === "aviso" ? "text-warning" : "text-destructive")}>{words}</span>
          ) : null}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(total, 0)}
        aria-valuenow={Math.min(Math.max(value, 0), Math.max(total, 0))}
        aria-valuetext={words ? `${valueText}. ${words}` : valueText}
        className="h-2 overflow-hidden rounded-full bg-secondary"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] motion-reduce:transition-none",
            level === "normal" ? "bg-primary" : level === "aviso" ? "bg-warning" : "bg-destructive",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}
