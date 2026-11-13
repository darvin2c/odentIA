import { Button } from "@odentia/ui"
import {
  DetailDrawer,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PageShell,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { createFileRoute } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useState } from "react"
import { HomeRow, Line } from "../../components/arm/hoy-rows"
import { demosSearchOf } from "../../components/arm/hoy-search"
import {
  CreateDemoDrawer,
  DemoBadge,
  DemoBand,
  type DemoItem,
  DemoProgressDrawer,
  DemoShowcase,
  demoLine,
  useDemoOfOrganization,
  useDemos,
  useOpenDemo,
} from "../../components/demos"
import { countByProduct, type ProductChoice, ProductFilter } from "../../components/product"
import {
  DEMOS_SUBTITLE,
  DEMOS_TITLE,
  DemosListSkeleton,
  DemosPageSkeleton,
} from "../../components/skeletons/demos"
import { useAdminUserId, useIsAdmin } from "../../lib/session"
import { supportDay } from "../../lib/support-words"

export const Route = createFileRoute("/_app/demos")({
  validateSearch: demosSearchOf,
  pendingComponent: DemosPageSkeleton,
  component: DemosPage,
})

/**
 * Demos (ADR 0096): las clínicas inventadas para presentar, que antes vivían
 * en Organizaciones. Crearlas, verlas armarse, abrirlas, volver a empezar y
 * borrarlas (`components/demos.tsx`). Crear, volver a empezar y borrar son de
 * Administración y el servidor lo exige. Una demo nunca es cliente.
 *
 * Fuera por ahora: «dónde se usó» (las presentaciones con cada demo). La API
 * de demos no lo da todavía; se ve en la Venta de cada cliente.
 */
function DemosPage() {
  const isAdmin = useIsAdmin()
  const myUserId = useAdminUserId()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const product: ProductChoice = search.producto ?? "todos"
  const demos = useDemos()
  const openDemo = useOpenDemo()
  const [creating, setCreating] = useState(false)
  const setSearch = (next: Partial<typeof search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
  const all = demos.data ?? []
  const shown = all.filter((demo) => product === "todos" || demo.product === product)
  const opened = search.demo ? all.find((demo) => demo.id === search.demo) : undefined
  const close = () => setSearch({ demo: undefined })
  // Borrada la demo no queda nada por guardar: el cierre no pasa por el aviso de borradores,
  // que todavía puede ver escrito el nombre de la confirmación y frenar la navegación.
  const closeDeleted = () =>
    void navigate({
      search: (prev) => ({ ...prev, demo: undefined }),
      replace: true,
      ignoreBlocker: true,
    })
  const building = (demo: DemoItem) => demo.status !== "lista" || !demo.organizationId

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={DEMOS_TITLE}
        subtitle={DEMOS_SUBTITLE}
        // Crear demos es de la administración: soporte no lo ve (y la API se lo niega).
        {...(isAdmin
          ? {
              primary: {
                label: "Crear demo",
                icon: <Plus aria-hidden />,
                onClick: () => setCreating(true),
              },
            }
          : {})}
      />
      <ProductFilter
        value={product}
        onChange={(next) => setSearch({ producto: next === "todos" ? undefined : next })}
        counts={countByProduct(all, (demo) => demo.product)}
      />
      {demos.isPending ? (
        <SkeletonRegion message="Consultando las demos…">
          <DemosListSkeleton />
        </SkeletonRegion>
      ) : demos.isError ? (
        <ErrorState error={demos.error} onRetry={() => void demos.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState
          title="Todavía no hay demos"
          description={
            isAdmin
              ? "Una demo es una clínica inventada, con su historia, para presentar el producto. Se arma sola en un par de minutos."
              : "Las crea Administración. Cuando haya una, sale aquí para abrirla en una presentación."
          }
          {...(isAdmin ? { actionLabel: "Crear demo", onAction: () => setCreating(true) } : {})}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title="No hay demos de este producto"
          description="Las que hay son de otros productos."
          actionLabel="Ver todas"
          onAction={() => setSearch({ producto: undefined })}
        />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {shown.map((demo) => (
            <HomeRow
              key={demo.id}
              name={
                <>
                  <span>{demo.name}</span>
                  <DemoBadge demo={demo} />
                </>
              }
              product={demo.product}
              action={
                <>
                  {building(demo) ? null : (
                    <Button type="button" size="sm" onClick={() => openDemo.mutate(demo)}>
                      Abrir la demo
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSearch({ demo: demo.id })}
                  >
                    {building(demo)
                      ? demo.status === "fallida"
                        ? "Ver qué pasó"
                        : "Ver el avance"
                      : "Ver"}
                  </Button>
                </>
              }
            >
              <Line
                parts={[
                  demoLine(demo),
                  `la presenta ${demo.presenter.name}`,
                  demo.status === "lista"
                    ? `abierta por última vez el ${supportDay(demo.lastUsedAt)}`
                    : null,
                ]}
              />
            </HomeRow>
          ))}
        </ul>
      )}

      <CreateDemoDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          setSearch({ demo: id })
        }}
        currentUserId={myUserId}
      />
      {/* La que se arma o falló: su avance. La lista: su franja y lo que tiene para mostrar. */}
      <DemoProgressDrawer demoId={opened && building(opened) ? opened.id : null} onClose={close} />
      {search.demo && opened && !building(opened) ? (
        <ReadyDemoDrawer demo={opened} isAdmin={isAdmin} onClose={close} onDeleted={closeDeleted} />
      ) : null}
      {search.demo && demos.isSuccess && !opened ? (
        <DetailDrawer open onClose={close} title="Esa demo ya no está" closeLabel="Cerrar">
          <EmptyState
            title="Esa demo ya no está"
            description="Se borró, o el enlace es de otra. Las que hay están en la lista."
          />
        </DetailDrawer>
      ) : null}
    </PageShell>
  )
}

/** Una demo lista: quién la presenta y su receta, «Volver a empezar» y «Borrar demo», y lo que tiene hoy para mostrar. */
function ReadyDemoDrawer({
  demo,
  isAdmin,
  onClose,
  onDeleted,
}: {
  demo: DemoItem
  isAdmin: boolean
  onClose: () => void
  onDeleted: () => void
}) {
  const detail = useDemoOfOrganization(demo.organizationId ?? "")
  const openDemo = useOpenDemo()
  return (
    <DetailDrawer
      open
      onClose={onClose}
      size="lg"
      title={demo.name}
      description={`${demo.kindName} · ${demo.sizeName.toLowerCase()} · ${demo.months} meses · ${demo.countryName}`}
      closeLabel="Cerrar"
      isLoading={detail.isPending}
      actions={
        <Button type="button" onClick={() => openDemo.mutate(demo)}>
          Abrir la demo
        </Button>
      }
    >
      {detail.isPending ? (
        <LoadingState message="Consultando la demo…" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !detail.data ? (
        <EmptyState title="Esa demo ya no está" description="Se borró mientras la mirabas." />
      ) : (
        <div className="flex flex-col gap-4">
          <DemoBand demo={detail.data} isAdmin={isAdmin} onDeleted={onDeleted} />
          <DemoShowcase demo={detail.data} />
        </div>
      )}
    </DetailDrawer>
  )
}
