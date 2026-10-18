import { FDI_ADULT, FDI_CHILD } from "@odentia/clinical"
import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import {
  DataRefreshMarker,
  EmptyState,
  ErrorState,
  LoadingState,
  PageShell,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CalendarDays } from "lucide-react"
import { type ReactNode, useEffect } from "react"
import { AccesosPanel } from "../../components/patient/accesos-panel"
import { AccountTab } from "../../components/patient/account-tab"
import { AntecedentesTab } from "../../components/patient/antecedentes-tab"
import { CitasPanel } from "../../components/patient/citas-panel"
import { DocumentosSection } from "../../components/patient/documentos-panel"
import { HistoriaTab } from "../../components/patient/historia-tab"
import { OdontogramaTab } from "../../components/patient/odontograma-tab"
import { PersonHeader } from "../../components/patient/patient-header"
import { PlanTab } from "../../components/patient/plan-tab"
import { ResponsablesTab } from "../../components/patient/responsables-tab"
import { PersonChannels } from "../../components/person/person-channels"
import { PersonConversations } from "../../components/person/person-conversations"
import { PersonData } from "../../components/person/person-data"
import { PersonLinks } from "../../components/person/person-links"
import { PersonSummary } from "../../components/person/person-summary"
import { PatientPortalAccessSection } from "../../components/portal/portal-access-section"
import { apiFetch } from "../../lib/api"
import { useCan } from "../../lib/crm"
import { useOrgEvents } from "../../lib/org-events"
import {
  areaNav,
  clinicalSummaryFor,
  type DocumentFilter,
  documentFilterFromSearch,
  isPatientSectionId,
  PATIENT_AREAS,
  type PageOf,
  type PatientSectionId,
  resolveSection,
  sectionFromSearch,
  sectionOf,
  visibleAreas,
  visibleSections,
} from "../../lib/patient-areas"
import type { PatientFull, PatientSummary } from "../../lib/patients"
import { personOfPatientKey, rememberPatientSection, usePerson } from "../../lib/people"
import { QueryErrorState } from "../../lib/query-error"

const areaLabel = (id: string) => PATIENT_AREAS.find((area) => area.id === id)?.label ?? id

const searchId = (value: unknown): string | undefined =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined
const FILTER_KEYS = [
  "q",
  "sort",
  "estado",
  "decision",
  "ejecucion",
] as const
export type PersonSearch = {
  /** Sección abierta. La pestaña se deriva de ella (ver `lib/patient-areas`). */
  tab?: PatientSectionId
  tooth?: number
  planId?: string
  budgetId?: string
  documentId?: string
  itemId?: string
  /** Filtro de Documentos: lo que requiere acción o un tipo de papel. */
  tipo?: DocumentFilter
} & Partial<Record<(typeof FILTER_KEYS)[number], string>>

/** La búsqueda de la página, también la de los enlaces guardados de la ficha anterior (`?tab=`). */
export function validatePersonSearch(search: Record<string, unknown>): PersonSearch {
  const tab = sectionFromSearch(search.tab)
  // `?tab=recetas` de la ficha anterior abre Documentos con ese filtro.
  const tipo = tab === "documentos" ? documentFilterFromSearch(search.tab, search.tipo) : undefined
  const tooth = Number(search.tooth)
  const filters = Object.fromEntries(
    FILTER_KEYS.flatMap((key) =>
      typeof search[key] === "string" && search[key].length <= 200 ? [[key, search[key]]] : [],
    ),
  )
  return {
    ...filters,
    ...(tab ? { tab } : {}),
    ...(tipo ? { tipo } : {}),
    ...(FDI_ADULT.includes(tooth) || FDI_CHILD.includes(tooth) ? { tooth } : {}),
    planId: searchId(search.planId),
    budgetId: searchId(search.budgetId),
    documentId: searchId(search.documentId),
    itemId: searchId(search.itemId),
  }
}

/**
 * La página de una persona (ADR 0029): una por persona, siempre la misma,
 * desde que escribe por primera vez. Crece con ella: al registrarla aparecen
 * su número de historia, Clínica, Plan y Cobros, en la misma dirección. Cada
 * bloque se pide al servidor con su propio permiso.
 */
export const Route = createFileRoute("/_org/people/$personId")({
  validateSearch: validatePersonSearch,
  component: PersonPageRoute,
})

/** Pestañas: pocas y cortas; pueden envolver. La altura fija de la primitiva se libera para no solapar. */
const TAB_LIST_CLASS = "group-data-horizontal/tabs:h-auto max-w-full flex-wrap justify-start"
/** Secciones: una sola fila con scroll horizontal propio; en móvil no empujan ni tapan el contenido. */
const SECTION_SCROLL_CLASS = "max-w-full overflow-x-auto pb-1"
const SECTION_LIST_CLASS = "w-max flex-nowrap justify-start"

function PersonPageRoute() {
  const { personId } = Route.useParams()
  const { tab, tooth, planId, budgetId, documentId, itemId, tipo } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const can = useCan()
  const personQuery = usePerson(personId, can("patients.read"))
  const person = personQuery.data?.data ?? null
  const patientId = person?.patient?.id ?? null
  const isPatient = Boolean(patientId)
  // Lo que la página muestra depende de lo que es la persona: con ficha, por registrar o solo responsable.
  const pageOf: PageOf = isPatient ? true : person?.kind === "responsable" ? "responsable" : false
  const section = resolveSection(tab, can, pageOf)
  // Los enlaces internos de la ficha conocen al paciente: su persona queda en caché.
  useEffect(() => {
    if (patientId) queryClient.setQueryData(personOfPatientKey(patientId), { data: { personId } })
  }, [patientId, personId, queryClient])
  // La miga de una atención vuelve a la pestaña donde estaba quien la abrió.
  useEffect(() => {
    if (patientId && section) rememberPatientSection(patientId, section)
  }, [patientId, section])
  useOrgEvents(["contact.updated", "stream.reconnected"], (kind) => {
    // Al conectar o reconectar se concilia lo que ya se muestra. Si la persona
    // no llegó (error o aún cargando), no se vuelve a pedir sola: un fallo se
    // reintenta con «Reintentar» y un 403 o un 404 no cambian por reconectar.
    if (kind === "stream.reconnected" && !personQuery.data) return
    void queryClient.invalidateQueries({ queryKey: ["person", personId] })
  })
  // Ficha administrativa (filiación, vínculos, alergias para quien las ve): no es una lectura clínica.
  const detail = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: Boolean(patientId),
    retry: false,
  })
  // Para quien lee la clínica, abrir la página es una lectura clínica (ADR
  // 0035, que precisa el 0029): su Resumen es el clínico y el resumen se pide
  // al abrirla, en cualquier pestaña, y deja su traza en «Consultas a la
  // historia». Recepción y caja nunca lo piden.
  const clinicalSummary = clinicalSummaryFor(can, pageOf)
  const summary = useQuery({
    queryKey: ["patient-summary", patientId],
    queryFn: () => apiFetch<{ data: PatientSummary }>(`/api/patients/${patientId}/summary`),
    enabled: Boolean(patientId) && clinicalSummary,
    retry: false,
  })
  const openTab = (
    next: PatientSectionId,
    nextTooth?: number,
    nextItemId?: string,
    nextPlanId?: string,
    nextBudgetId?: string,
  ) => {
    void navigate({
      search: {
        tab: next,
        ...(nextTooth ? { tooth: nextTooth } : {}),
        ...(nextItemId ? { itemId: nextItemId } : {}),
        ...(nextPlanId ? { planId: nextPlanId } : {}),
        ...(nextBudgetId ? { budgetId: nextBudgetId } : {}),
      },
    })
  }
  // El recorrido de un tratamiento vive en Plan, al lado de sus fases (ADR 0034).
  const openItem = (nextItemId: string) => openTab("plan", undefined, nextItemId)

  if (!can("patients.read") || (person && section === null))
    return (
      <PageShell>
        <ErrorState
          title="Sin acceso"
          message="No tienes permiso para ver a esta persona. Pide acceso a quien administra la clínica."
        />
      </PageShell>
    )
  if (personQuery.isPending && !person)
    return (
      <PageShell>
        <LoadingState message="Cargando…" />
      </PageShell>
    )
  if (!person || section === null)
    return (
      <PageShell>
        <QueryErrorState
          error={personQuery.error}
          onRetry={() => {
            void personQuery.refetch()
          }}
          notFound="Esta persona no existe o ya no está disponible. Vuelve a la lista de pacientes."
        />
      </PageShell>
    )

  const patientDetail = detail.data?.data
  const current = sectionOf(section)
  const areas = visibleAreas(can, pageOf)
  const entries = areaNav(current.area, can, pageOf)
  const openEncounterId = summary.data?.data.openEncounterId ?? undefined

  const needsPatient = (render: (id: string, full: PatientFull) => ReactNode): ReactNode => {
    if (!patientId) return null
    if (!patientDetail) {
      if (detail.isError)
        return <QueryErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      return <LoadingState message="Cargando la ficha…" />
    }
    return render(patientId, patientDetail)
  }

  const content = (): ReactNode => {
    switch (section) {
      case "resumen":
        return (
          <PersonSummary
            person={person}
            detail={patientDetail}
            summary={clinicalSummary ? summary : undefined}
            onSection={openTab}
          />
        )
      case "conversaciones":
        return <PersonConversations person={person} />
      case "citas":
        return patientId ? (
          <CitasPanel patientId={patientId} />
        ) : (
          <EmptyState
            icon={CalendarDays}
            title="Sin citas"
            description="Al reservarle una cita se crea su ficha con lo mínimo, ya unida a esta persona."
            actionLabel={
              can("appointments.write") && can("crm.read") && !person.archived
                ? "Reservar cita"
                : undefined
            }
            onAction={
              can("appointments.write") && can("crm.read") && !person.archived
                ? () => void navigate({ to: "/agenda", search: { contactId: person.id } })
                : undefined
            }
          />
        )
      case "odontograma":
        return needsPatient((id, full) => (
          <OdontogramaTab
            patientId={id}
            initialTooth={tooth}
            birthDate={full.patient.birthDate}
            onOpenItem={openItem}
            onOpenPlans={() => openTab("plan")}
          />
        ))
      case "plan":
        // Una sola sección para todos: cada rol ve lo suyo dentro (ADR 0034).
        return patientId ? (
          <PlanTab
            patientId={patientId}
            initialPlanId={planId}
            initialBudgetId={budgetId}
            initialItemId={itemId}
          />
        ) : null
      case "historia":
        return patientId ? (
          <HistoriaTab
            patientId={patientId}
            initialTooth={tooth}
            onOdontogramSelect={(next) => openTab("odontograma", next)}
          />
        ) : null
      case "antecedentes":
        return patientId ? <AntecedentesTab patientId={patientId} /> : null
      case "documentos":
        return patientId ? (
          <DocumentosSection
            patientId={patientId}
            filter={tipo}
            encounterId={openEncounterId}
            initialTooth={tooth}
            documentId={documentId}
          />
        ) : null
      case "cuenta":
        return patientId ? <AccountTab patientId={patientId} part="cuenta" /> : null
      case "filiacion":
        return <PersonData person={person} detail={patientDetail} />
      case "contactos":
        return <PersonLinks person={person} detail={patientDetail} />
      case "canales":
        return <PersonChannels person={person} />
      case "responsables":
        return patientId ? <ResponsablesTab patientId={patientId} /> : null
      case "portal":
        return patientId ? <PatientPortalAccessSection patientId={patientId} /> : null
      case "accesos":
        return patientId ? <AccesosPanel patientId={patientId} /> : null
    }
  }

  // En móvil las filas de pestañas ocupan media pantalla: un único selector
  // de sección agrupado por pestaña las reemplaza (mismo ?tab=).
  const allSections = visibleSections(can, pageOf)
  const mobileNav = (
    <div className="sm:hidden">
      <label
        htmlFor="person-section-mobile"
        className="mb-1 block text-xs font-medium text-muted-foreground"
      >
        Sección
      </label>
      <Select
        items={Object.fromEntries(
          allSections.map((s) => [
            s.id,
            areaLabel(s.area) === s.label ? s.label : `${areaLabel(s.area)} · ${s.label}`,
          ]),
        )}
        value={section}
        onValueChange={(value) => {
          if (isPatientSectionId(value)) openTab(value)
        }}
      >
        <SelectTrigger id="person-section-mobile" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {areas.map((area) => (
            <SelectGroup key={area.id}>
              <SelectLabel>{area.label}</SelectLabel>
              {allSections
                .filter((s) => s.area === area.id)
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <PageShell className="flex min-w-0 flex-col gap-6">
      {personQuery.isFetching && !personQuery.isPending ? <DataRefreshMarker /> : null}
      {personQuery.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            No se pudo actualizar la página; se conservan los datos cargados.{" "}
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => void personQuery.refetch()}
            >
              Reintentar
            </Button>
          </p>
        </div>
      ) : null}
      <PersonHeader
        person={person}
        detail={patientDetail}
        summary={summary.data?.data}
        onSection={openTab}
      />
      <Tabs
        className="min-w-0 w-full"
        value={current.area}
        onValueChange={(value) => {
          const target = areas.find((area) => area.id === value)?.target
          if (target) openTab(target)
        }}
      >
        {mobileNav}
        <div className="hidden max-w-full overflow-x-auto border-b pb-1 sm:block">
          <TabsList className={TAB_LIST_CLASS} variant="line" aria-label="Pestañas de la página">
            {areas.map((area) => (
              <TabsTrigger key={area.id} value={area.id}>
                {area.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value={current.area} className="pt-4">
          {entries.length > 1 ? (
            <Tabs
              className="min-w-0 w-full gap-4"
              value={current.id}
              onValueChange={(value) => {
                if (isPatientSectionId(value)) openTab(value)
              }}
            >
              <div className={`hidden sm:block ${SECTION_SCROLL_CLASS}`}>
                <TabsList
                  className={SECTION_LIST_CLASS}
                  aria-label={`Secciones de ${areas.find((area) => area.id === current.area)?.label ?? "la página"}`}
                >
                  {entries.map((item) => (
                    <TabsTrigger key={item.value} value={item.value}>
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value={current.id}>{content()}</TabsContent>
            </Tabs>
          ) : (
            content()
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
