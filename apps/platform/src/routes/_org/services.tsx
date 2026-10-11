import { PageShell, SectionNav, type SectionNavItem } from "@odentia/ui-patterns"
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { BadgePercent, Library, Tag } from "lucide-react"
import { RouterLink } from "../../lib/router-link"

export const Route = createFileRoute("/_org/services")({
  component: ServicesLayout,
})

const secciones: SectionNavItem[] = [
  { label: "Tarifario de la clínica", to: "/services", icon: Tag },
  { label: "Biblioteca de prestaciones", to: "/services/biblioteca", icon: Library },
  { label: "Promociones", to: "/services/promotions", icon: BadgePercent },
]

/**
 * Tratamientos y tarifas: el tarifario y la biblioteca viven en el nav de
 * sección (riel en web, barra en tablet y móvil) y cada página aporta su
 * `PageHeader` y su contenido. El `PageShell` es de este layout, para no anidar
 * fondos ni paddings: sin él, el tarifario —que mide el alto del viewport—
 * quedaría fuera de la pantalla.
 */
function ServicesLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  return (
    <PageShell>
      <SectionNav
        label="Tratamientos y tarifas"
        items={secciones}
        pathname={pathname}
        LinkComponent={RouterLink}
      >
        <Outlet />
      </SectionNav>
    </PageShell>
  )
}
