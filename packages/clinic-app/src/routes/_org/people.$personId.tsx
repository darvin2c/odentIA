import { ContactScreenBanner } from "../../components/inbox-contact-screen"
import {
  Button,
  ScrollArea,
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
  PageShell,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { CalendarDays } from "lucide-react"
import { lazy, type ReactNode, Suspense, useEffect } from "react"
import { AccesosPanel } from "../../components/patient/accesos-panel"
import { CitasPanel } from "../../components/patient/citas-panel"
import { DataRequestsPanel } from "../../components/patient/data-requests-panel"
import { SectionSideNav } from "../../components/person/section-side-nav"
import { dataRequestsKey, fetchDataRequests } from "../../lib/data-requests"
import { PersonHeader } from "../../components/patient/patient-header"
import { PersonChannels } from "../../components/person/person-channels"
import { PersonConversations } from "../../components/person/person-conversations"
import { PersonData } from "../../components/person/person-data"
import { PersonLoading, PersonSectionLoading } from "../../components/person/person-loading"
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
  navSectionOf,
  PATIENT_AREAS,
  type PageOf,
  type PatientSectionId,
  resolveSection,
  SIDE_NAV_AREAS,
  sectionFromSearch,
  sectionGroup,
  sectionOf,
  subsectionNav,
  visibleAreas,
  visibleSections,
} from "../../lib/patient-areas"
import type { PatientFull, PatientSummary } from "../../lib/patients"
import { personOfPatientKey, personShapeOf, rememberPatientSection, rememberPersonOfPatient, usePerson } from "../../lib/people"
import { QueryErrorState } from "../../lib/query-error"
import { isRecordLocked, LockedRecordNotice, LockedRecordPage } from "../../components/person/locked-record"
import { productUi } from "../../product/product-ui"
import { openBookingAnywhere } from "../../components/agenda/schedule-host"

// Cada pestaña grande se baja al abrirla: la ficha abre con lo que se ve
// (resumen y datos) y no con el visor de documentos, la cuenta o el plan.
const AccountTab = lazy(() => import("../../components/patient/account-tab").then((m) => ({ default: m.AccountTab })))
const AntecedentesTab = lazy(() =>
  import("../../components/patient/antecedentes-tab").then((m) => ({ default: m.AntecedentesTab })),
)
const DocumentosSection = lazy(() =>
  import("../../components/patient/documentos-panel").then((m) => ({ default: m.DocumentosSection })),
)
const HistoriaTab = lazy(() => import("../../components/patient/historia-tab").then((m) => ({ default: m.HistoriaTab })))
const PlanTab = lazy(() => import("../../components/patient/plan-tab").then((m) => ({ default: m.PlanTab })))
const ResponsablesTab = lazy(() =>
  import("../../components/patient/responsables-tab").then((m) => ({ default: m.ResponsablesTab })),
)

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
  /** El lugar elegido (odentIA: la pieza), si el producto registra dónde. */
  tooth?: number
  planId?: string
  budgetId?: string
  documentId?: string
  itemId?: string
  /** Filtro de Documentos: lo que requiere acción o un tipo de papel. */
  tipo?: DocumentFilter
  /** Viene de registrarlo con «Atender ahora»: abre su atención. */
  atender?: boolean
  /** «Cobrar» de Pendientes: Cobros con el cobro ya abierto. */
  cobrar?: boolean
  /** Lo abierto dentro de una sección del producto (odentIA: el periodontograma, desde Historia o el Resumen). */
  periodontograma?: string
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
    ...(productUi().site?.isPlace(tooth) ? { tooth } : {}),
    planId: searchId(search.planId),
    budgetId: searchId(search.budgetId),
    documentId: searchId(search.documentId),
    itemId: searchId(search.itemId),
    ...(search.atender === true || search.atender === "true" ? { atender: true } : {}),
    ...(search.cobrar === true || search.cobrar === "true" ? { cobrar: true } : {}),
    periodontograma: searchId(search.periodontograma),
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
  pendingComponent: PersonLoading,
  component: PersonPageRoute,
})

/** Pestañas de la página: píldoras en una sola fila; en tableta se desliza y no se parte (lienzo «Pestañas de la ficha»). */
const TAB_LIST_CLASS = "w-max flex-nowrap justify-start"
/** Secciones: una sola fila con scroll horizontal propio; en móvil no empujan ni tapan el contenido. */
const SECTION_SCROLL_CLASS = "max-w-full pb-1"
const SECTION_LIST_CLASS = "w-max flex-nowrap justify-start"

function PersonPageRoute() {
  const { personId } = Route.useParams()
  const { tab, tooth, planId, budgetId, documentId, itemId, tipo, periodontograma, cobrar } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const can = useCan()
  const personQuery = usePerson(personId, can("patients.read"))
  const person = personQuery.data?.data ?? null
  const patientId = person?.patient?.id ?? null
  const isPatient = Boolean(patientId)
  // Lo que la página muestra depende de lo que es la persona: con ficha, por registrar o solo responsable.
  const pageOf: PageOf = person ? personShapeOf(person).pageOf : false
  const section = resolveSection(tab, can, pageOf)
  // Los enlaces internos de la ficha conocen al paciente: su persona queda en caché.
  useEffect(() => {
    if (!patientId) return
    queryClient.setQueryData(personOfPatientKey(patientId), { data: { personId } })
    rememberPersonOfPatient(patientId, personId)
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
  // Los pedidos sobre sus datos pendientes: su número va junto a la sección (ADR 0080).
  const dataRequests = useQuery({
    queryKey: dataRequestsKey(patientId ?? ""),
    queryFn: () => fetchDataRequests(patientId ?? ""),
    enabled: Boolean(patientId) && can("patients.write"),
    retry: false,
  })
  const pendingDataRequests = dataRequests.data?.requests.filter((r) => r.status === "pendiente").length ?? 0
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
  if (!can("patients.read") || (person && section === null))
    return (
      <PageShell>
        <ErrorState
          title="Sin acceso"
          message="No tienes permiso para ver a esta persona. Pide acceso a quien administra la clínica."
        />
      </PageShell>
    )
  if (personQuery.isPending && !person) return <PersonLoading />
  // Historia bloqueada (ADR 0080): Administración ve por qué y la abre con motivo; los demás, 404.
  // También al bloquearla con la página abierta, o al vencer la hora para leerla.
  if (isRecordLocked(personQuery.error)) return <LockedRecordPage personId={personId} />
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
      return (
        <SkeletonRegion message="Cargando la ficha…">
          <PersonSectionLoading section={section} pageOf={pageOf} />
        </SkeletonRegion>
      )
    }
    return render(patientId, patientDetail)
  }

  // Lo que cuelga de una sección se elige dentro de ella: «Odontograma · Periodontograma».
  const subsections = subsectionNav(section, can, pageOf)
  const withSubsections = (node: ReactNode): ReactNode =>
    subsections.length > 1 ? (
      <div className="flex min-w-0 flex-col gap-4">
        <Tabs
          value={section}
          onValueChange={(value) => {
            if (isPatientSectionId(value)) openTab(value)
          }}
        >
          <TabsList aria-label={`Dentro de ${sectionOf(navSectionOf(section)).label}`}>
            {subsections.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {node}
      </div>
    ) : (
      node
    )

  const content = (): ReactNode => (
    <Suspense
      fallback={
        <SkeletonRegion message="Cargando…">
          <PersonSectionLoading section={section} pageOf={pageOf} />
        </SkeletonRegion>
      }
    >
      {sectionContent()}
    </Suspense>
  )
  const sectionContent = (): ReactNode => {
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
          <CitasPanel patientId={patientId} patientName={person.displayName} />
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
                ? () => openBookingAnywhere({ person: { contactId: person.id, name: person.displayName, phone: person.phone } })
                : undefined
            }
          />
        )
      case "plan":
        // Una sola sección para todos: cada rol ve lo suyo dentro (ADR 0034).
        return patientId ? (
          <PlanTab
            patientId={patientId}
            patientName={person.displayName}
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
            tooth={tooth}
            documentId={documentId}
          />
        ) : null
      case "cuenta":
        return patientId ? (
          <AccountTab
            patientId={patientId}
            part="cuenta"
            openCollect={cobrar === true}
            onCollectOpened={() =>
              void navigate({ search: (prev) => ({ ...prev, cobrar: undefined }), replace: true })
            }
          />
        ) : null
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
      case "pedidos":
        return patientId ? <DataRequestsPanel patientId={patientId} /> : null
    }
    // Las secciones que agrega el producto (odentIA: Odontograma y Periodontograma).
    const own = productUi().record.sections.find((item) => item.id === section)
    if (!own || !patientId) return null
    const props = {
      patientId,
      place: tooth,
      opened: periodontograma,
      openSection: (next: string, options?: { place?: number; itemId?: string }) =>
        openTab(next, options?.place, options?.itemId),
    }
    return withSubsections(
      own.needsRecord
        ? needsPatient((id, full) => own.render({ ...props, patientId: id, record: full }))
        : own.render({ ...props, record: patientDetail ?? null }),
    )
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
          {areas.flatMap((area) => {
            // Lo que va en un grupo («Sus datos y la ley») sale con su propio título.
            const own = allSections.filter((s) => s.area === area.id)
            const titles = [area.label, ...new Set(own.map((s) => sectionGroup(s.id)).filter((g): g is string => !!g))]
            return titles.map((title, index) => (
              <SelectGroup key={`${area.id}-${title}`}>
                <SelectLabel>{title}</SelectLabel>
                {own
                  .filter((s) => (index === 0 ? !sectionGroup(s.id) : sectionGroup(s.id) === title))
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
              </SelectGroup>
            ))
          })}
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
      {person.recordLocked ? <LockedRecordNotice personId={person.id} /> : null}
      <PersonHeader
        person={person}
        detail={patientDetail}
        summary={summary.data?.data}
        onSection={openTab}
      />
      {/* En Spam o bloqueada: el mismo aviso de la Bandeja, con «No es spam» o «Desbloquear» (ADR 0054). */}
      <ContactScreenBanner
        target={{ base: `/api/people/${person.id}`, contactName: person.displayName }}
        view={person.screen}
        canWrite={can("conversations.write")}
        canBlock={can("crm.write")}
        canMarkSpam={false}
        className="rounded-xl border"
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
        <ScrollArea horizontal className={`hidden sm:block ${SECTION_SCROLL_CLASS}`}>
          <TabsList className={TAB_LIST_CLASS} aria-label="Pestañas de la página">
            {areas.map((area) => (
              <TabsTrigger key={area.id} value={area.id}>
                {area.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </ScrollArea>
        <TabsContent value={current.area} className="pt-4">
          {entries.length > 1 && SIDE_NAV_AREAS.has(current.area) ? (
            // Muchas secciones: menú lateral en vez de una barra que se desborda.
            <div className="flex min-w-0 flex-col gap-6 sm:flex-row sm:items-start">
              <SectionSideNav
                label={`Secciones de ${areas.find((area) => area.id === current.area)?.label ?? "la página"}`}
                entries={entries}
                current={navSectionOf(current.id)}
                badges={pendingDataRequests > 0 ? { pedidos: pendingDataRequests } : {}}
                onOpen={openTab}
              />
              <div className="min-w-0 flex-1">{content()}</div>
            </div>
          ) : entries.length > 1 ? (
            <Tabs
              className="min-w-0 w-full gap-4"
              value={navSectionOf(current.id)}
              onValueChange={(value) => {
                if (isPatientSectionId(value)) openTab(value)
              }}
            >
              <ScrollArea horizontal className={`hidden sm:block ${SECTION_SCROLL_CLASS}`}>
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
              </ScrollArea>
              <TabsContent value={navSectionOf(current.id)}>{content()}</TabsContent>
            </Tabs>
          ) : (
            content()
          )}
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
