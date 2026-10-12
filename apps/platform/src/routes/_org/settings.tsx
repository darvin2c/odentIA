import { PageShell, SectionNav, type SectionNavItem } from "@odentia/ui-patterns"
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { Bot, Building2, CalendarDays, ClipboardList, Kanban, MessageCircle, ShieldCheck, Stethoscope, Tag, Users, Wallet } from "lucide-react"
import { RouterLink } from "../../lib/router-link"

export const Route = createFileRoute("/_org/settings")({
  component: SettingsLayout,
})

const secciones: SectionNavItem[] = [
  { label: "Organización", to: "/settings", icon: Building2 },
  { label: "Sucursales", to: "/branches", icon: Building2 },
  { label: "Equipo y permisos", to: "/members", icon: Users },
  { label: "Tarifario", to: "/services", icon: Tag },
  { label: "Medios de pago", to: "/settings/payment-methods", icon: Wallet },
  { label: "Disponibilidad", to: "/settings/availability", icon: CalendarDays },
  { label: "Especialidades", to: "/settings/specialties", icon: Stethoscope },
  { label: "Formularios y consentimientos", to: "/settings/forms", icon: ClipboardList },
  { label: "Canales", to: "/settings/channels", icon: MessageCircle },
  { label: "Chat web", to: "/settings/webchat", icon: MessageCircle },
  { label: "Correo", to: "/settings/mail", icon: MessageCircle },
  { label: "Agente", to: "/settings/agent", icon: Bot },
  { label: "Pipelines", to: "/settings/pipelines", icon: Kanban },
  { label: "Campos", to: "/settings/fields", icon: Tag },
  { label: "Registro de pacientes", to: "/settings/patient-registration", icon: ClipboardList },
  { label: "Acceso de pacientes", to: "/settings/patient-access", icon: Users },
  { label: "Auditoría", to: "/settings/audit", icon: ShieldCheck },
]

/**
 * Configuración de la organización: los apartados viven en el nav de sección
 * (riel en web, barra en tablet y móvil) y cada página aporta su `PageHeader` y
 * su contenido. El `PageShell` es de este layout, para no anidar fondos ni
 * paddings.
 */
function SettingsLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <PageShell>
      <SectionNav
        label="Configuración"
        items={secciones}
        pathname={pathname}
        LinkComponent={RouterLink}
      >
        <Outlet />
      </SectionNav>
    </PageShell>
  )
}
