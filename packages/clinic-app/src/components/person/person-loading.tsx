import { useQueryClient } from "@tanstack/react-query"
import { useLocation, useNavigate, useParams, useSearch, Link } from "@tanstack/react-router"
import { LoadingState, PagePending, PageShell } from "@odentia/ui-patterns"
import { useCan, usePermission } from "../../lib/crm"
import {
  areaNav,
  clinicalSummaryFor,
  PATIENT_AREAS,
  type PageOf,
  type PatientSectionId,
  resolveSection,
  sectionFromSearch,
  sectionOf,
  SIDE_NAV_AREAS,
  subsectionNav,
  visibleAreas,
} from "../../lib/patient-areas"
import { PEOPLE_VIEWS, type PersonPage, type PersonShape, personQueryKey, personShapeKey, personShapeOf } from "../../lib/people"
import { peopleHeader, peopleSubtitle, personHeaderRules } from "../../lib/screen-rules"
import { productUi } from "../../product/product-ui"
import { EncounterPageSkeleton } from "../skeletons/encounter"
import { PeoplePageSkeleton } from "../skeletons/people"
import { PersonPageSkeleton } from "../skeletons/person"
import { PersonSectionSkeleton, SubsectionTabs } from "../skeletons/person-sections"

/**
 * Lo que los esqueletos necesitan saber y no piden por su cuenta: el rol de quien
 * mira, la sección de la dirección y lo que ya se sepa de la persona. Lo que aún
 * no se sabe no se anticipa: su pestaña o su botón es un hueco sin nombre, que
 * toma su nombre al llegar o se va sin haber ofrecido nada.
 */

/** Lo ya sabido de quien se abre; `null` lo que falta. */
function useKnownPerson(seesAll: boolean): { pageOf: PersonShape["pageOf"] | null; archived: boolean | null } {
  const queryClient = useQueryClient()
  const { personId, patientId } = useParams({ strict: false }) as { personId?: string; patientId?: string }
  if (personId) {
    const page = queryClient.getQueryData<{ data: PersonPage }>(personQueryKey(personId))?.data
    const shape = page ? personShapeOf(page) : queryClient.getQueryData<PersonShape>(personShapeKey(personId))
    if (shape) return shape
  }
  // La dirección de una ficha es de un paciente, y quien no lee el CRM solo llega a pacientes.
  return { pageOf: patientId || !seesAll ? true : null, archived: null }
}

/** Las pestañas de la lista de Pacientes que el rol ve. */
export function visiblePeopleViews(seesAll: boolean) {
  return PEOPLE_VIEWS.filter((item) => seesAll || item.id !== "por_registrar")
}

/** La lista de Pacientes mientras llega su código (también `/contacts` y `/patients`, que solo redirigen). */
export function PeopleLoading() {
  const can = useCan()
  const { ver } = useSearch({ strict: false }) as { ver?: unknown }
  const views = visiblePeopleViews(can("crm.read"))
  const active = views.find((item) => item.id === ver)?.id ?? "pacientes"
  return <PeoplePageSkeleton views={views} active={active} subtitle={peopleSubtitle(can)} {...peopleHeader(can)} />
}

/** La sección abierta de la persona, con lo que el rol ve en ella. */
export function PersonSectionLoading({ section, pageOf = true, unknownKind = false }: { section: PatientSectionId; pageOf?: PageOf; unknownKind?: boolean }) {
  const can = useCan()
  const product = productUi()
  const clinicalSummary = clinicalSummaryFor(can, pageOf)
  return (
    <PersonSectionSkeleton
      section={section}
      can={can}
      clinicalSummary={clinicalSummary && unknownKind ? "unknown" : clinicalSummary}
      placeLabel={product.site?.placeLabel}
      budgetOptional={!product.plan.budgetRequired}
      own={product.record.sections.find((item) => item.id === section)?.skeleton}
    />
  )
}

/** La página de una persona antes de saber nada de ella: cabecera, pestañas y sección de la dirección. */
export function PersonLoading() {
  const can = useCan()
  const navigate = useNavigate()
  const { tab } = useSearch({ strict: false }) as { tab?: unknown }
  const known = useKnownPerson(can("crm.read"))
  const unknownKind = known.pageOf === null
  // Casi siempre es paciente: su forma es la que se dibuja, y lo que solo tiene un paciente va como hueco.
  const pageOf = known.pageOf ?? true
  const section = resolveSection(sectionFromSearch(tab), can, pageOf)
  if (!section)
    return (
      <PageShell>
        <LoadingState />
      </PageShell>
    )
  const current = sectionOf(section)
  const areaLabel = PATIENT_AREAS.find((area) => area.id === current.area)?.label ?? current.area
  const subsections = subsectionNav(section, can, pageOf)
  const rules = personHeaderRules(can, pageOf === true)
  // «Responsable» es lo que menos tiene: lo que también ve es de cualquier persona.
  const anyPersonAreas = new Set<string>(visibleAreas(can, "responsable").map((area) => area.id))
  const anyPersonEntries = new Set<string>(areaNav(current.area, can, "responsable").map((entry) => entry.value))
  return (
    <PersonPageSkeleton
      crumb={<Link to="/people" />}
      actions={known.archived ? { ...rules, message: false, book: false, encounter: false } : rules}
      actionsUnsure={unknownKind || known.archived === null}
      onOpen={(next) => void navigate({ to: ".", search: { tab: next } } as never)}
      nav={{
        areas: visibleAreas(can, pageOf).map((area) => ({ ...area, unsure: unknownKind && !anyPersonAreas.has(area.id) })),
        area: current.area,
        entries: areaNav(current.area, can, pageOf).map((entry) => ({ ...entry, unsure: unknownKind && !anyPersonEntries.has(entry.value) })),
        current: current.parent ?? current.id,
        sideNav: SIDE_NAV_AREAS.has(current.area),
        mobileLabel: areaLabel === current.label ? current.label : `${areaLabel} · ${current.label}`,
      }}
    >
      {subsections.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-4">
          <SubsectionTabs label={`Dentro de ${areaLabel}`} value={section} items={subsections} />
          <PersonSectionLoading section={section} pageOf={pageOf} unknownKind={unknownKind} />
        </div>
      ) : (
        <PersonSectionLoading section={section} pageOf={pageOf} unknownKind={unknownKind} />
      )}
    </PersonPageSkeleton>
  )
}

/** La atención: quien escribe en la historia suele abrir un borrador; los demás, una ya cerrada. */
export function EncounterLoading() {
  const canRead = usePermission("clinical.read")
  const canWrite = usePermission("clinical.write")
  if (!canRead && !canWrite) return <PagePending />
  return <EncounterPageSkeleton draft={canWrite} />
}

/**
 * Lo que cuelga de `/patients/:id`: esta dirección es de la persona, pero sus
 * hijas (la atención y las impresiones) no deben mostrar la página de la persona.
 */
export function PatientRoutePending() {
  const pathname = useLocation({ select: (location) => location.pathname })
  if (pathname.includes("/encounters/")) return <EncounterLoading />
  if (pathname.endsWith("/print")) return <LoadingState kind="indeterminate" message="Preparando el documento…" />
  return <PersonLoading />
}
