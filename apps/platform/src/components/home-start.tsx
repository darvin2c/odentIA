import { Badge } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { ArrowRight, CheckCircle2 } from "lucide-react"
import { usePermission } from "../lib/crm"
import type { WorkspaceHome } from "../lib/workspace"

/** Orienta el primer uso sin convertir una jornada activa en un tutorial. */
export function HomeStart({ data }: { data: WorkspaceHome }) {
  const canRegister = usePermission("patients.write")
  const setup = data.setup
  const steps = setup ? [
    { title: "Definir horarios", description: "Indica cuándo atiende cada profesional.", href: "/settings/availability", done: setup.availability },
    { title: "Preparar un sillón", description: "Añade el espacio donde se atenderán las citas.", href: "/agenda", done: setup.chairs },
    { title: "Registrar un paciente", description: "Busca primero para evitar fichas duplicadas.", href: "/patients", done: setup.patients },
  ] : []
  const next = !data.activity.recorded ? steps.find(step => !step.done) : undefined
  const partiallyConfigured = setup && (setup.availability || setup.chairs || setup.patients)
  const primary = next ?? (data.access.finance && !data.access.appointments
    ? { title: "Revisar cuentas", href: "/finance" }
    : data.access.clinical && !data.access.configure
      ? { title: "Revisar agenda", href: "/agenda" }
      : canRegister && !data.activity.recorded && !setup?.patients
        ? { title: "Registrar un paciente", href: "/patients" }
        : data.access.appointments
          ? { title: "Abrir agenda", href: "/agenda" }
          : data.access.tasks
            ? { title: "Ver mis tareas", href: "/tasks" }
            : null)
  const title = next ? "Prepara tu primera atención"
    : data.activity.completedToday ? "Todo atendido en este resumen"
      : data.activity.recorded ? "Sin pendientes en este resumen" : "Sin actividad todavía"
  const description = next ? "Completa estos pasos para empezar a reservar y atender."
    : data.activity.completedToday ? "Hay trabajo registrado hoy y no quedan pendientes en las secciones que puedes consultar. No acredita que todos los casos estén resueltos."
      : data.activity.recorded ? "No hay citas por atender hoy, mensajes por responder ni otros pendientes visibles aquí. Puedes consultar el detalle de tu trabajo."
        : "Aún no hay actividad operativa registrada para tu trabajo. Empieza por el siguiente paso; los ceros no indican que todo esté atendido."
  return <section aria-label="Siguiente paso" className="enter elevated rounded-xl border bg-card p-6">
    {next && <Badge variant="secondary" className="mb-3">{partiallyConfigured ? "Configuración parcial" : "Sin configurar"}</Badge>}
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p>
    {primary && <Link to={primary.href} className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
      {primary.title}<ArrowRight className="size-4 shrink-0" aria-hidden />
    </Link>}
    {next ? <ol aria-label="Puesta en marcha" className="mt-5 grid gap-4 sm:grid-cols-3">
      {steps.map((step, index) => <li key={step.href} className="flex gap-3 text-sm">
        {step.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Preparado" /> : <span className="text-muted-foreground" aria-hidden>{index + 1}.</span>}
        <div><p className="font-medium">{step.title}{step.done ? " · Preparado" : ""}</p><p className="mt-1 text-muted-foreground">{step.description}</p></div>
      </li>)}
    </ol> : <nav aria-label="Continuar mi trabajo" className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
      {data.access.patients && primary?.href !== "/patients" && <Link to="/patients" className="inline-flex min-h-11 items-center text-primary underline">Consultar pacientes</Link>}
      {data.access.conversations && <Link to="/inbox" search={{ conversation: undefined }} className="inline-flex min-h-11 items-center text-primary underline">Revisar conversaciones</Link>}
      {data.access.tasks && primary?.href !== "/tasks" && <Link to="/tasks" className="inline-flex min-h-11 items-center text-primary underline">Ver tareas</Link>}
    </nav>}
  </section>
}
