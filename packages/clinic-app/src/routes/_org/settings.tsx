import { canAccessAny, platformPathPermission, seesBilling } from "@odentia/auth/permissions"
import { PageShell, SectionNav, type SectionNavGroup, type SectionNavItem } from "@odentia/ui-patterns"
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { SettingsContentSkeleton } from "../../components/skeletons/settings"
import { useMyRole } from "../../lib/crm"
import { PLAN_PATH } from "../../lib/billing"
import { RouterLink } from "../../lib/router-link"
import { appWords } from "../../lib/product-words"

export const Route = createFileRoute("/_org/settings")({
  pendingComponent: SettingsLayoutPending,
  component: SettingsLayout,
})

/**
 * Los apartados, por grupos con nombre de trabajo. El nombre de la lista es el
 * título de su página y el de su tema en la guía de ayuda: `help.test.ts`
 * compara los tres, así que se cambian juntos.
 */
const grupos: SectionNavGroup[] = [
  {
    label: "La clínica",
    items: [
      { label: "Datos de la clínica", to: "/settings" },
      { label: "Sedes", to: "/settings/branches" },
      { label: "Equipo", to: "/settings/team" },
      { label: "Horarios y ausencias", to: "/settings/availability" },
      { label: "Protección de datos", to: "/settings/data-protection" },
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

/**
 * Lo que la clínica paga a odentIA (ADR 0065): al final, solo para quien ve
 * Facturación (`seesBilling`), que no es un permiso repartible.
 */
const cuentaOdentia: SectionNavGroup = {
  // Al leerlo, no al cargar el módulo: la app declara su producto después.
  get label() {
    return `Tu cuenta ${appWords().name}`
  },
  items: [{ label: "Plan y pagos", to: PLAN_PATH }],
}

/** Lo que no pertenece a un grupo: al final, tras un separador. */
const sueltas: SectionNavItem[] = [
  { label: "Integraciones", to: "/settings/integrations" },
  { label: "Actividad del equipo", to: "/settings/audit" },
]

function SettingsLayout() {
  return (
    <SettingsFrame>
      <Outlet />
    </SettingsFrame>
  )
}

/**
 * Al entrar desde fuera, mientras llega el código: la misma lista, que no
 * depende de ningún dato, y el esqueleto de la pantalla que se abre.
 */
function SettingsLayoutPending() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return (
    <SettingsFrame>
      <SettingsContentSkeleton pathname={pathname} />
    </SettingsFrame>
  )
}

/**
 * Configuración de la organización: los apartados viven en el nav de sección
 * (riel en web, selector en tablet y móvil) y cada página aporta su
 * `PageHeader` y su contenido. El `PageShell` es de este layout, para no anidar
 * fondos ni paddings.
 */
function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const role = useMyRole()
  // Un apartado solo se ofrece a quien puede abrirlo, con la misma regla que el guard.
  const canOpen = (item: SectionNavItem) => {
    const permissions = platformPathPermission(item.to)
    return permissions === null || canAccessAny(role, permissions)
  }
  const visibleGroups = grupos
    .map((group) => ({ ...group, items: group.items.filter(canOpen) }))
    .filter((group) => group.items.length > 0)
  if (seesBilling(role)) visibleGroups.push(cuentaOdentia)

  return (
    <PageShell>
      <SectionNav
        label="Configuración"
        groups={visibleGroups}
        items={sueltas.filter(canOpen)}
        pathname={pathname}
        LinkComponent={RouterLink}
      >
        {children}
      </SectionNav>
    </PageShell>
  )
}
