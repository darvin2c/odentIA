import { PageShell, SectionNav, type SectionNavItem } from "@odentia/ui-patterns"
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"
import { BadgePercent, Library, Tag } from "lucide-react"
import { ServicesLayoutSkeleton } from "../../components/skeletons/services"
import { RouterLink } from "../../lib/router-link"

export const Route = createFileRoute("/_org/services")({
  pendingComponent: ServicesLayoutSkeleton,
  component: ServicesLayout,
})

const secciones: SectionNavItem[] = [
  { label: "Servicios y precios", to: "/services", icon: Tag },
  { label: "Agregar servicios", to: "/services/biblioteca", icon: Library },
  { label: "Promociones", to: "/services/promotions", icon: BadgePercent },
]

/**
 * Servicios y precios: la lista de servicios y la biblioteca viven en el nav de
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
        label="Servicios y precios"
        items={secciones}
        pathname={pathname}
        LinkComponent={RouterLink}
      >
        <Outlet />
      </SectionNav>
    </PageShell>
  )
}
