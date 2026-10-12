import { Badge, Button } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import type { WorkspaceHome } from "../lib/workspace"

/** Los tres pasos de una clínica nueva; solo los recibe quien puede configurarla. */
function setupSteps(setup: NonNullable<WorkspaceHome["setup"]>) {
  return [
    { title: "Definir horarios", description: "Indica cuándo atiende cada profesional.", href: "/settings/availability", done: setup.availability },
    { title: "Preparar un sillón", description: "Añade el espacio donde se atenderán las citas.", href: "/agenda", done: setup.chairs },
    { title: "Registrar un paciente", description: "Busca primero para evitar fichas duplicadas.", href: "/patients", done: setup.patients },
  ]
}

/**
 * Hay que preparar la clínica: quien puede configurarla aún no completó los
 * tres pasos, no hay trabajo registrado y hoy no le espera nada. Es el único
 * caso en que Inicio muestra la puesta en marcha en vez de sus dos bloques.
 */
export function needsSetup(data: WorkspaceHome): boolean {
  if (!data.setup || data.activity.recorded || data.waiting.length > 0) return false
  if ((data.today?.summary.total ?? 0) > 0) return false
  return setupSteps(data.setup).some(step => !step.done)
}

/** «Prepara tu primera atención»: orienta el primer uso sin convertir una jornada activa en un tutorial. */
export function HomeStart({ setup }: { setup: NonNullable<WorkspaceHome["setup"]> }) {
  const steps = setupSteps(setup)
  const next = steps.find(step => !step.done)
  if (!next) return null
  return <section aria-label="Siguiente paso" className="enter elevated rounded-xl border bg-card p-6">
    <Badge variant="secondary" className="mb-3">{steps.some(step => step.done) ? "Configuración parcial" : "Sin configurar"}</Badge>
    <h2 className="text-lg font-semibold">Prepara tu primera atención</h2>
    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Completa estos pasos para empezar a reservar y atender.</p>
    <Button nativeButton={false} render={<Link to={next.href} />} className="mt-4 min-h-11">
      {next.title}<ArrowRight className="size-4 shrink-0" aria-hidden />
    </Button>
    <ol aria-label="Puesta en marcha" className="mt-5 grid gap-4 sm:grid-cols-3">
      {steps.map((step, index) => <li key={step.href} className="flex gap-3 text-sm">
        {step.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Preparado" /> : <span className="text-muted-foreground" aria-hidden>{index + 1}.</span>}
        <div><p className="font-medium">{step.title}{step.done ? " · Preparado" : ""}</p><p className="mt-1 text-muted-foreground">{step.description}</p></div>
      </li>)}
    </ol>
  </section>
}
