import { DetailDrawer, ListSearchScope, LoadingState, useScopedListSearch } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { createContext, lazy, type ReactNode, Suspense, useContext, useEffect, useState } from "react"
import { apiFetch } from "../../lib/api"
import { type DocumentFilter, isPatientSectionId, sectionOf } from "../../lib/patient-areas"
import type { PatientFull } from "../../lib/patients"
import { productUi } from "../../product/product-ui"

const AntecedentesTab = lazy(() => import("./antecedentes-tab").then((m) => ({ default: m.AntecedentesTab })))
const DocumentosSection = lazy(() => import("./documentos-panel").then((m) => ({ default: m.DocumentosSection })))
const HistoriaTab = lazy(() => import("./historia-tab").then((m) => ({ default: m.HistoriaTab })))
const PlanTab = lazy(() => import("./plan-tab").then((m) => ({ default: m.PlanTab })))
const ResponsablesTab = lazy(() => import("./responsables-tab").then((m) => ({ default: m.ResponsablesTab })))
const PortalSection = lazy(() =>
  import("../portal/portal-access-section").then((m) => ({ default: m.PatientPortalAccessSection })),
)

/** Qué sección abrir encima y, si hace falta, en qué parte de ella. */
export interface WideTarget {
  id: string
  /** «Revisar» de Pendientes: Antecedentes con su formulario ya abierto. */
  review?: boolean
  /** La pieza o el sitio que se quiere ver. */
  place?: number
  /** El periodontograma que se abre de una vez. */
  opened?: string
  /** El recorrido de un tratamiento o el presupuesto, dentro del Plan. */
  itemId?: string
  budgetId?: string
  /** El filtro de Documentos. */
  documentFilter?: DocumentFilter
  /** «Registrar responsable»: Responsables con su formulario ya abierto. */
  grant?: boolean
}

const OpenWide = createContext<((target: WideTarget) => void) | null>(null)

/**
 * Abre una sección de la persona encima de donde se está, en la página y en el
 * Contexto de la Bandeja. `null` si la persona aún no tiene ficha: sin ficha no
 * hay secciones que abrir.
 */
export function useOpenWide(): ((target: WideTarget) => void) | null {
  return useContext(OpenWide)
}

function sectionName(id: string): string {
  // Desde el «…» de la ficha se abre solo el portal: su enlace tiene su propia entrada.
  if (id === "portal") return "Portal del paciente"
  if (isPatientSectionId(id)) return sectionOf(id).label
  return productUi().record.sections.find((item) => item.id === id)?.label ?? id
}

/** Documentos encima: sus filtros, la pieza y el visor viven aquí, no en la dirección de la pantalla de debajo. */
function DocumentosOver({ patientId, target }: { patientId: string; target: WideTarget }) {
  const search = useScopedListSearch({
    tipo: target.documentFilter,
    tooth: target.place ? String(target.place) : undefined,
  })
  const tooth = Number(search.get("tooth"))
  return (
    <ListSearchScope value={search}>
      <DocumentosSection
        patientId={patientId}
        filter={search.get("tipo") as DocumentFilter | undefined}
        tooth={tooth > 0 ? tooth : undefined}
        documentId={search.get("documentId")}
      />
    </ListSearchScope>
  )
}

/**
 * Antecedentes, Historia, Documentos, Plan y lo del producto (Odontograma y
 * Periodontograma), grandes y encima: al cerrar se sigue donde se estaba. Son
 * las mismas secciones de la página, sin copias: cada una pide sus datos con su
 * permiso y deja su traza. Una sola a la vez: lo que se abre desde dentro la
 * reemplaza.
 */
export function WideSectionProvider({
  patientId,
  name,
  closeLabel,
  children,
}: {
  /** Sin ficha no hay secciones que abrir: el árbol es el mismo, para no perder estado al registrarla. */
  patientId: string | null
  name: string
  closeLabel?: string
  children: ReactNode
}) {
  const [target, setTarget] = useState<WideTarget | null>(null)
  // Un enlace de dentro lleva a otra sección de la página: se ve esa, no lo que estaba
  // encima. Elegir sede también queda en la dirección (`?branch=`) y no cierra nada.
  const place = useLocation({
    select: (location) => {
      const { branch: _branch, ...rest } = location.search as Record<string, unknown>
      return `${location.pathname}?${JSON.stringify(rest)}`
    },
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: se cierra al cambiar la dirección.
  useEffect(() => setTarget(null), [place])
  const own = target ? productUi().record.sections.find((item) => item.id === target.id) : undefined
  // La ficha ya cargó al paciente: misma clave, sin otra petición.
  const record = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: Boolean(own && patientId),
    retry: false,
  })
  const content = (): ReactNode => {
    if (!target || !patientId) return null
    if (target.id === "antecedentes") return <AntecedentesTab patientId={patientId} startEditing={target.review} />
    if (target.id === "historia") return <HistoriaTab patientId={patientId} initialTooth={target.place} />
    if (target.id === "documentos") return <DocumentosOver key={`${target.documentFilter}-${target.place}`} patientId={patientId} target={target} />
    if (target.id === "plan")
      return <PlanTab patientId={patientId} patientName={name} initialBudgetId={target.budgetId} initialItemId={target.itemId} />
    if (target.id === "responsables") return <ResponsablesTab patientId={patientId} startGranting={target.grant} />
    if (target.id === "portal") return <PortalSection patientId={patientId} withLink={false} />
    if (!own) return null
    return own.render({
      patientId,
      record: record.data?.data ?? null,
      place: target.place,
      opened: target.opened,
      openSection: (next, options) => setTarget({ id: next, place: options?.place, itemId: options?.itemId }),
    })
  }
  return (
    <OpenWide.Provider value={patientId ? setTarget : null}>
      {children}
      <DetailDrawer
        open={target !== null && Boolean(patientId)}
        onClose={() => setTarget(null)}
        size="xl"
        className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(60rem,calc(100vw-2rem))]"
        title={target ? `${sectionName(target.id)} de ${name}` : ""}
        closeLabel={closeLabel}
      >
        <Suspense fallback={<LoadingState message="Cargando…" />}>{content()}</Suspense>
      </DetailDrawer>
    </OpenWide.Provider>
  )
}
