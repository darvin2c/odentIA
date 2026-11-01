import {
  RiCalendarFill,
  RiCalendarLine,
  RiChat3Fill,
  RiChat3Line,
  RiFileListFill,
  RiFileListLine,
  RiInbox2Fill,
  RiInbox2Line,
  RiSettings3Fill,
  RiSettings3Line,
  RiUserFill,
  RiUserLine,
} from "@remixicon/react"
import type { ReactNode } from "react"
import type { SectionNavGroup, SectionNavItem } from "./types.js"

export const noop = () => {}

/** Link de router falso con el mismo contrato que usan panel y platform. */
export function StoryLink({
  to,
  search,
  children,
  ...rest
}: {
  to?: string
  search?: Record<string, string>
  children: ReactNode
  [key: string]: unknown
}) {
  return (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...rest}>
      {children}
    </a>
  )
}

export const secciones: SectionNavItem[] = [
  { label: "Resumen", to: "/pacientes/123", icon: RiFileListLine, iconActive: RiFileListFill },
  {
    label: "Historia",
    to: "/pacientes/123/historia",
    icon: RiFileListLine,
    iconActive: RiFileListFill,
  },
  {
    label: "Citas",
    to: "/pacientes/123/citas",
    icon: RiCalendarLine,
    iconActive: RiCalendarFill,
    badge: 2,
  },
  { label: "Pagos", to: "/pacientes/123/pagos", icon: RiInbox2Line, iconActive: RiInbox2Fill },
]

export const destinos: SectionNavItem[] = [
  { label: "Bandeja", to: "/bandeja", icon: RiInbox2Line, iconActive: RiInbox2Fill, badge: 3 },
  { label: "Chats", to: "/conversaciones", icon: RiChat3Line, iconActive: RiChat3Fill, badge: 12 },
  { label: "Agenda", to: "/agenda", icon: RiCalendarLine, iconActive: RiCalendarFill },
  { label: "Pacientes", to: "/pacientes", icon: RiUserLine, iconActive: RiUserFill },
  { label: "Ajustes", to: "/ajustes", icon: RiSettings3Line, iconActive: RiSettings3Fill },
]

/** Lista larga y sin grupos (la Configuración antes de agruparse): obliga a
 * resolver una navegación secundaria extensa con el selector. */
export const configuracion: SectionNavItem[] = [
  ["Organización", "/settings"],
  ["Sucursales", "/branches"],
  ["Equipo y permisos", "/members"],
  ["Disponibilidad", "/settings/availability"],
  ["Especialidades", "/settings/specialties"],
  ["Consentimientos", "/settings/forms"],
  ["Canales", "/settings/channels"],
  ["Chat web", "/settings/webchat"],
  ["Correo", "/settings/mail"],
  ["Agente", "/settings/agent"],
  ["Pipelines", "/settings/pipelines"],
  ["Registro de pacientes", "/settings/patient-registration"],
  ["Acceso de pacientes", "/settings/patient-access"],
  ["Auditoría", "/settings/audit"],
].map(([label, to]) => ({
  label,
  to,
  icon: RiSettings3Line,
  iconActive: RiSettings3Fill,
}))

/** La misma lista larga, leída por temas: grupos con nombre de trabajo. */
export const configuracionGrupos: SectionNavGroup[] = [
  {
    label: "La clínica",
    items: [
      { label: "Datos de la clínica", to: "/settings" },
      { label: "Sedes", to: "/settings/branches" },
      { label: "Equipo", to: "/settings/team" },
      { label: "Horarios y ausencias", to: "/settings/availability" },
    ],
  },
  {
    label: "Atención",
    items: [
      { label: "Especialidades", to: "/settings/specialties" },
      { label: "Consentimientos", to: "/settings/forms" },
    ],
  },
  {
    label: "Pacientes",
    items: [
      { label: "Registro de pacientes", to: "/settings/patient-registration" },
      { label: "Portal del paciente", to: "/settings/patient-access" },
    ],
  },
  {
    label: "Ventas y cobros",
    items: [
      { label: "Medios de pago y ticket", to: "/settings/payment-methods" },
      { label: "Etapas de venta", to: "/settings/pipelines" },
    ],
  },
]

/** Lo que no pertenece a un grupo: va al final, tras el separador. */
export const configuracionSueltas: SectionNavItem[] = [
  { label: "Integraciones", to: "/settings/integrations", badge: 1 },
  { label: "Actividad del equipo", to: "/settings/audit" },
]

/** Contenido de ejemplo: un bloque alto para ver el pegado al scrollear. */
export function SectionBody({
  title = "Historia clínica",
  note = "Contenido de la sección activa. Con scroll, la navegación queda pegada al borde.",
  placeholder = "Bloque alto para probar el pegado en ambos modos.",
}: {
  title?: string
  note?: string
  placeholder?: string
}) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{note}</p>
      <div className="mt-4 h-[160vh] rounded-md bg-card p-6 text-sm text-muted-foreground">
        {placeholder}
      </div>
    </>
  )
}
