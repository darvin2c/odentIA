import { Badge, buttonVariants, cn } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import { ADMIN_NAME, CLINICAL_NAME, RECEPTION_DEFAULT_NAME, useReceptionName } from "../lib/agent-names"
import type { SetupOn, WorkspaceHome } from "../lib/workspace"
import { appWords } from "../lib/product-words"

/**
 * Los pasos de una clínica nueva; solo los recibe quien puede configurarla. El
 * de encender a Sofi y a Argos, solo quien puede encenderlos: sin
 * ellos «Recordar la cita» y los avisos de la cita no salen.
 */
function setupSteps(setup: NonNullable<WorkspaceHome["setup"]>, receptionName = RECEPTION_DEFAULT_NAME) {
  return [
    { title: "Definir horarios", description: "Indica cuándo atiende cada profesional.", href: "/settings/availability", done: setup.availability },
    { title: `Preparar una ${appWords().room.one}`, description: "Añade el espacio donde se atenderán las citas.", href: "/agenda", done: setup.rooms },
    { title: "Registrar un paciente", description: "Busca primero para evitar fichas duplicadas.", href: "/people", done: setup.patients },
    ...(setup.agent === undefined
      ? []
      : [{
          title: `Encender a ${receptionName} y a ${ADMIN_NAME}`,
          description: "Sin ellos no salen los recordatorios ni los avisos de la cita, aunque «Recordar la cita» esté prendida.",
          href: "/agent/administrador",
          done: setup.agent,
        }]),
  ]
}

/**
 * Hay que preparar la clínica: quien puede configurarla aún no completó los
 * pasos, no hay trabajo registrado y hoy no le espera nada. Es el único
 * caso en que Inicio muestra la puesta en marcha en vez de sus dos bloques.
 */
export function needsSetup(data: WorkspaceHome): boolean {
  if (!data.setup || data.activity.recorded || data.waiting.length > 0) return false
  if ((data.today?.summary.total ?? 0) > 0) return false
  return setupSteps(data.setup).some(step => !step.done)
}

/**
 * «Tu clínica viene con esto encendido» (ADR 0141): solo lo que está encendido de verdad, cada
 * cosa con su enlace a donde se apaga. No pide nada: la clínica decide qué deja.
 */
function bornOn(on: SetupOn, receptionName: string) {
  return [
    on.reception ? { text: `${receptionName} responde a quien escriba, desde que conectes un canal.`, href: "/agent/recepcion", action: "Ver o apagar" } : null,
    on.admin
      ? {
          text: `${ADMIN_NAME}, con ${on.lines === 1 ? "1 línea" : `${on.lines} líneas`}: recuerda las citas, sigue los presupuestos y avisa lo pendiente.`,
          href: "/agent/administrador",
          action: "Ver o apagar",
        }
      : null,
    on.clio ? { text: `${CLINICAL_NAME}, para dictar la atención.`, href: "/agent/asistente-clinico", action: "Ver o apagar" } : null,
    on.registration
      ? {
          text: on.noticeSuggested
            ? "El registro en línea, con un aviso de privacidad sugerido, sin revisar."
            : "El registro en línea de pacientes.",
          href: "/settings/patient-registration",
          action: on.noticeSuggested ? "Revisar el aviso" : "Ver o apagar",
        }
      : null,
    on.portal ? { text: "El portal del paciente: el acceso lo da recepción a cada persona.", href: "/settings/patient-access", action: "Ver o apagar" } : null,
    on.digest ? { text: "Tu resumen del lunes, por correo.", href: "/reports", action: "Ver o apagar" } : null,
  ].filter((item): item is { text: string; href: string; action: string } => item !== null)
}

/** «Prepara tu primera atención»: orienta el primer uso sin convertir una jornada activa en un tutorial. */
export function HomeStart({ setup }: { setup: NonNullable<WorkspaceHome["setup"]> }) {
  const receptionName = useReceptionName()
  const steps = setupSteps(setup, receptionName)
  const next = steps.find(step => !step.done)
  const born = setup.on ? bornOn(setup.on, receptionName) : []
  if (!next) return null
  return <section aria-label="Siguiente paso" className="enter elevated rounded-xl border bg-card p-6">
    <Badge variant="secondary" className="mb-3">{steps.some(step => step.done) ? "Configuración parcial" : "Sin configurar"}</Badge>
    <h2 className="text-lg font-semibold">Prepara tu primera atención</h2>
    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Completa estos pasos para empezar a reservar y atender.</p>
    <Link to={next.href} className={cn(buttonVariants(), "mt-4 min-h-11")}>
      {next.title}<ArrowRight className="size-4 shrink-0" aria-hidden />
    </Link>
    <ol aria-label="Puesta en marcha" className={cn("mt-5 grid gap-4", steps.length > 3 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3")}>
      {steps.map((step, index) => <li key={step.href} className="flex gap-3 text-sm">
        {step.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Preparado" /> : <span className="text-muted-foreground" aria-hidden>{index + 1}.</span>}
        <div><p className="font-medium">{step.title}{step.done ? " · Preparado" : ""}</p><p className="mt-1 text-muted-foreground">{step.description}</p></div>
      </li>)}
    </ol>
    {born.length > 0 ? <div className="mt-6 border-t pt-5">
      <h3 className="text-sm font-semibold">Tu clínica viene con esto encendido</h3>
      <p className="mt-1 text-sm text-muted-foreground">Cada cosa se apaga donde se configura.</p>
      <ul aria-label="Viene encendido" className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        {born.map(item => <li key={item.href} className="flex flex-col gap-0.5">
          <span>{item.text}</span>
          <Link to={item.href} className="inline-flex min-h-11 items-center font-semibold text-primary-soft-foreground underline-offset-2 hover:underline sm:min-h-0">{item.action}</Link>
        </li>)}
      </ul>
    </div> : null}
  </section>
}
