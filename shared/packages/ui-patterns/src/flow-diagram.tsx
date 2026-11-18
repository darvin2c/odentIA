import { cn } from "@odentia/ui"
import { Bot, Flag, Play, Split, User } from "lucide-react"
import type * as React from "react"

/** Quién hace un paso: el agente o una persona del equipo. */
export type FlowDiagramActor = "agente" | "persona"

export interface FlowDiagramStep {
  id: string
  /** `inicio` y `fin` abren y cierran el flujo; `decision` reparte en dos caminos. */
  kind: "inicio" | "paso" | "decision" | "fin"
  label: string
  /** Solo en los pasos: quién lo hace. */
  actor?: FlowDiagramActor | null
  /** «Sofi · agente», «Equipo de recepción · persona»: quién actúa, siempre con palabras. */
  actorLabel?: string | null
}

export interface FlowDiagramProps {
  /** Nombre del flujo para lectores de pantalla. */
  label: string
  /** Camino principal, en orden. */
  main: FlowDiagramStep[]
  /** Camino que sale de la decisión del principal cuando la respuesta es «no». */
  otherwise?: FlowDiagramStep[] | null
  yesLabel?: string
  noLabel?: string
  /** El flujo no está corriendo (apagado o en borrador): se ve entero, atenuado y sin movimiento. */
  idle?: boolean
  /** Control de un paso (su interruptor), bajo su texto. */
  renderControl?: (step: FlowDiagramStep) => React.ReactNode
  className?: string
}

const STEP_ICON = { inicio: Play, decision: Split, fin: Flag } as const

function StepBox({ step, idle, control }: { step: FlowDiagramStep; idle: boolean; control: React.ReactNode }) {
  const isPerson = step.actor === "persona"
  const Icon = step.kind === "paso" ? (isPerson ? User : Bot) : STEP_ICON[step.kind]
  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-sm @4xl:w-36",
        step.kind === "paso" && !isPerson && "border-agent-border bg-agent-soft",
        step.kind === "paso" && isPerson && "border-border bg-card",
        step.kind === "decision" && "border-dashed border-foreground/40 bg-card",
        (step.kind === "inicio" || step.kind === "fin") && "border-transparent bg-muted",
        idle && "opacity-70",
      )}
    >
      {step.actorLabel ? (
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Icon aria-hidden className="size-3.5 shrink-0" />
          {step.actorLabel}
        </span>
      ) : (
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="font-medium leading-snug">{step.label}</span>
      {control}
    </div>
  )
}

/** Unión entre dos pasos: una línea con su punta, horizontal en ancho y vertical en estrecho. */
function Link({ label, idle }: { label?: string; idle: boolean }) {
  return (
    <span aria-hidden className="flex items-center gap-1 self-stretch pl-6 @4xl:w-8 @4xl:shrink-0 @4xl:flex-col-reverse @4xl:justify-center @4xl:gap-0.5 @4xl:self-center @4xl:pl-0">
      <span
        className={cn(
          "flow-link h-5 w-0.5 rounded-full @4xl:h-0.5 @4xl:w-full",
          idle ? "bg-border" : "flow-link-live",
        )}
      />
      {label ? <span className="text-xs font-semibold text-muted-foreground">{label}</span> : null}
    </span>
  )
}

/**
 * Flujo de una automatización: un camino principal y, si hay una decisión, lo
 * que pasa cuando la respuesta es «no». Se dibuja desde datos, así que solo
 * muestra lo que de verdad se ejecuta: quien lo usa decide qué pasos le pasa.
 * Cada paso dice quién lo hace con icono y texto, nunca solo con color.
 *
 * Es una lista ordenada para lectores de pantalla. En ancho va de izquierda a
 * derecha con el camino del «no» debajo; en estrecho, de arriba hacia abajo.
 * Las uniones se mueven solo si el flujo está corriendo y el sistema no pide
 * movimiento reducido.
 */
export function FlowDiagram({
  label,
  main,
  otherwise = null,
  yesLabel = "Sí",
  noLabel = "No",
  idle = false,
  renderControl,
  className,
}: FlowDiagramProps): React.JSX.Element {
  const decision = main.findIndex((step) => step.kind === "decision")
  const branch = otherwise && decision >= 0 ? otherwise : null
  const item = (step: FlowDiagramStep, next: boolean, linkLabel?: string) => (
    <li key={step.id} className="flex min-w-0 flex-col @4xl:flex-row @4xl:items-center">
      <StepBox step={step} idle={idle} control={renderControl?.(step) ?? null} />
      {next ? <Link label={linkLabel} idle={idle} /> : null}
    </li>
  )
  return (
    <div className={cn("@container", className)}>
      <style>{FLOW_CSS}</style>
      <ol aria-label={label} className="flex flex-col @4xl:flex-row @4xl:items-start">
        {main.map((step, index) =>
          item(step, index < main.length - 1, branch && index === decision ? yesLabel : undefined),
        )}
      </ol>
      {branch ? (
        <div
          className="mt-3 flex flex-col gap-1 border-l-2 border-dashed border-border pl-4 @4xl:mt-0 @4xl:border-l-0 @4xl:pl-0"
          // En ancho, el camino del «no» arranca bajo la decisión.
          style={{ ["--flow-offset" as string]: String(decision) }}
        >
          <span aria-hidden className="text-xs font-semibold text-muted-foreground @4xl:ml-[calc(var(--flow-offset)*11rem+1.5rem)] @4xl:flex @4xl:h-8 @4xl:items-center @4xl:gap-1.5 @4xl:border-l-2 @4xl:border-dashed @4xl:border-border @4xl:pl-2">
            {noLabel}
          </span>
          <ol
            aria-label={`${label}: si la respuesta es «${noLabel.toLowerCase()}»`}
            className="flex flex-col @4xl:ml-[calc(var(--flow-offset)*11rem)] @4xl:flex-row @4xl:items-start"
          >
            {branch.map((step, index) => item(step, index < branch.length - 1))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

/**
 * La unión viva es una línea discontinua que avanza. En ancho el paso mide 9rem
 * y la unión 2rem: de ahí los 11rem por paso con que se alinea el camino del «no».
 */
const FLOW_CSS = `
.flow-link-live {
  background-image: linear-gradient(to bottom, var(--color-primary) 50%, transparent 50%);
  background-size: 2px 8px;
  animation: flow-link-down 0.9s linear infinite;
}
@keyframes flow-link-down { to { background-position: 0 8px; } }
@container (min-width: 56rem) {
  .flow-link-live {
    background-image: linear-gradient(to right, var(--color-primary) 50%, transparent 50%);
    background-size: 8px 2px;
    animation-name: flow-link-right;
  }
}
@keyframes flow-link-right { to { background-position: 8px 0; } }
@media (prefers-reduced-motion: reduce) {
  .flow-link-live { animation: none; }
}
`
