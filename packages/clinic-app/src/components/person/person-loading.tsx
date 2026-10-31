import { useLocation, useNavigate, useSearch, Link } from "@tanstack/react-router"
import { LoadingState, PageShell } from "@odentia/ui-patterns"
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
import { PEOPLE_VIEWS } from "../../lib/people"
import { peopleHeader, peopleSubtitle, personHeaderRules } from "../../lib/screen-rules"
import { productUi } from "../../product/product-ui"
import { EncounterPageSkeleton } from "../skeletons/encounter"
import { PeoplePageSkeleton } from "../skeletons/people"
import { PersonPageSkeleton } from "../skeletons/person"
import { PersonSectionSkeleton, SubsectionTabs } from "../skeletons/person-sections"

/**
 * Lo que los esqueletos necesitan saber y no piden por su cuenta: el rol de quien
 * mira y la sección de la dirección. Sin ningún dato de la persona: mientras
 * llega se la supone paciente, que es lo que casi siempre abre esta página, y si
 * no lo es sus pestañas se ajustan al llegar.
 */

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
export function PersonSectionLoading({ section, pageOf = true }: { section: PatientSectionId; pageOf?: PageOf }) {
  const can = useCan()
  const product = productUi()
  return (
    <PersonSectionSkeleton
      section={section}
      can={can}
      clinicalSummary={clinicalSummaryFor(can, pageOf)}
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
  const section = resolveSection(sectionFromSearch(tab), can, true)
  if (!section)
    return (
      <PageShell>
        <LoadingState />
      </PageShell>
    )
  const current = sectionOf(section)
  const entries = areaNav(current.area, can, true)
  const areaLabel = PATIENT_AREAS.find((area) => area.id === current.area)?.label ?? current.area
  const subsections = subsectionNav(section, can, true)
  return (
    <PersonPageSkeleton
      crumb={<Link to="/people" />}
      actions={personHeaderRules(can, true)}
      onOpen={(next) => void navigate({ to: ".", search: { tab: next } } as never)}
      nav={{
        areas: visibleAreas(can, true),
        area: current.area,
        entries,
        current: current.parent ?? current.id,
        sideNav: SIDE_NAV_AREAS.has(current.area),
        mobileLabel: areaLabel === current.label ? current.label : `${areaLabel} · ${current.label}`,
      }}
    >
      {subsections.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-4">
          <SubsectionTabs label={`Dentro de ${areaLabel}`} value={section} items={subsections} />
          <PersonSectionLoading section={section} />
        </div>
      ) : (
        <PersonSectionLoading section={section} />
      )}
    </PersonPageSkeleton>
  )
}

/** La atención: quien escribe en la historia suele abrir un borrador; los demás, una ya cerrada. */
export function EncounterLoading() {
  return <EncounterPageSkeleton draft={usePermission("clinical.write")} />
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
