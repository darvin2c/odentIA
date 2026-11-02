import { DetailDrawer, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createContext, lazy, type ReactNode, Suspense, useCallback, useContext, useMemo, useState } from "react"
import { apiFetch } from "../../lib/api"
import { type DocumentFilter, isPatientSectionId, sectionOf } from "../../lib/patient-areas"
import type { PatientFull } from "../../lib/patients"
import { productUi } from "../../product/product-ui"

const AntecedentesTab = lazy(() => import("./antecedentes-tab").then((m) => ({ default: m.AntecedentesTab })))
const DocumentosSection = lazy(() => import("./documentos-panel").then((m) => ({ default: m.DocumentosSection })))
const HistoriaTab = lazy(() => import("./historia-tab").then((m) => ({ default: m.HistoriaTab })))
const PlanTab = lazy(() => import("./plan-tab").then((m) => ({ default: m.PlanTab })))
const ResponsablesTab = lazy(() => import("./responsables-tab").then((m) => ({ default: m.ResponsablesTab })))

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
  if (isPatientSectionId(id)) return sectionOf(id).label
  return productUi().record.sections.find((item) => item.id === id)?.label ?? id
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
  const open = useCallback((next: WideTarget) => setTarget(next), [])
  const value = useMemo(() => open, [open])
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
    if (target.id === "documentos") return <DocumentosSection patientId={patientId} filter={target.documentFilter} tooth={target.place} />
    if (target.id === "plan")
      return <PlanTab patientId={patientId} patientName={name} initialBudgetId={target.budgetId} initialItemId={target.itemId} />
    if (target.id === "responsables") return <ResponsablesTab patientId={patientId} startGranting={target.grant} />
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
    <OpenWide.Provider value={patientId ? value : null}>
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
