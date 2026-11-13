import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  DatePickerButton,
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  SkeletonRegion,
  submitErrorMessage,
  ViewTabs,
} from "@odentia/ui-patterns"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { z } from "zod"
import {
  ClientName,
  type ClientTab,
  invalidateArm,
  OpenClientButton,
} from "../../components/arm/hoy-links"
import {
  HomeRow,
  HomeSection,
  Line,
  moreLink,
  Rows,
  type Said,
} from "../../components/arm/hoy-rows"
import { todaySearchOf } from "../../components/arm/hoy-search"
import {
  KairosItemCard,
  KairosUnconfirmed,
  kairosItemsSchema,
} from "../../components/arm/kairos-items"
import { WAITLIST_STAGE_WORDS } from "../../components/arm/sale-words"
import { type ProductChoice, ProductFilter, useOrgProducts } from "../../components/product"
import {
  HomeCountersSkeleton,
  HomePageSkeleton,
  HomeSkeleton,
} from "../../components/skeletons/home"
import { TodayBilling } from "../../components/today-billing"
import { UnknownReportActions } from "../../components/unknown-report-actions"
import { api } from "../../lib/api"
import { useFocusOnLeave } from "../../lib/focus"
import { invitationDueWords, limaDayWords } from "../../lib/invitation-words"
import { rememberedWaitlistFilters } from "../../lib/list-search"
import { SUPPORT_KIND_LABEL, supportDay, supportWaitWords } from "../../lib/support-words"

export const Route = createFileRoute("/_app/")({
  validateSearch: todaySearchOf,
  pendingComponent: HomePageSkeleton,
  component: AdminHome,
})
const appRoute = getRouteApi("/_app")

/**
 * Hoy (`GET /api/admin/kairos/today`): lo que Kairós dejó listo, las tareas de
 * hoy (mías o de todas), quién se enfría, quién está en riesgo y, debajo, las
 * filas de Inicio de siempre. Cada fila dice por qué está y abre la ficha del
 * cliente en su pestaña. Solo lee y enlaza, salvo el sí a lo de Kairós y
 * «Hecho» o «Mover» una tarea, que usan las mismas operaciones de la ficha.
 */

const productShape = z.enum(CLINICAL_PRODUCTS)
const personShape = z.object({ userId: z.string(), name: z.string() }).nullable()
const signalShape = z.object({
  code: z.string(),
  words: z.string(),
  adminOnly: z.boolean(),
  fact: z.string(),
})

// Los tipos y estados van como texto: uno nuevo del servidor no rompe Hoy entero.
const todaySchema = z.object({
  today: z.string(),
  answerWithin: z.string(),
  kairosReady: kairosItemsSchema,
  tasks: z.array(
    z.object({
      id: z.string(),
      clientId: z.string(),
      clientName: z.string(),
      product: productShape,
      kind: z.string(),
      title: z.string(),
      dueOn: z.string(),
      dueAt: z.string().nullable(),
      assignee: personShape,
      byKairos: z.boolean(),
      overdue: z.boolean(),
      why: z.string(),
      // «Revisar en Zoho si salió el informe N.º n»: con qué resolverla aquí (solo Administración).
      report: z
        .object({
          organizationId: z.string(),
          number: z.number(),
          to: z.string().nullable(),
          canResend: z.boolean(),
        })
        .optional(),
    }),
  ),
  cooling: z.array(
    z.object({
      clientId: z.string(),
      name: z.string(),
      product: productShape,
      owner: personShape,
      lastContactAt: z.string().nullable(),
      signals: z.array(signalShape),
      why: z.string(),
    }),
  ),
  atRisk: z.array(
    z.object({
      clientId: z.string(),
      name: z.string(),
      product: productShape,
      owner: personShape,
      organizationId: z.string(),
      signals: z.array(signalShape),
      why: z.string(),
    }),
  ),
  prospects: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      why: z.string(),
      clinicName: z.string(),
      product: productShape,
      stage: z.string(),
      reason: z.string().nullable(),
      answer: z.object({ due: z.string(), day: z.string() }).nullable(),
      inviteExpiresAt: z.string().nullable(),
      followUp: z
        .object({
          on: z.string(),
          overdue: z.boolean(),
          body: z.string(),
          authorName: z.string().nullable(),
          createdAt: z.string(),
        })
        .nullable(),
      overdue: z.boolean(),
    }),
  ),
  support: z.array(
    z.object({
      id: z.string(),
      clientId: z.string().nullable(),
      why: z.string(),
      organizationName: z.string(),
      product: productShape.nullable(),
      kind: z.string(),
      assigneeName: z.string().nullable(),
      waitingSince: z.string(),
      answerBy: z.string().nullable(),
      accessUntil: z.string().nullable(),
    }),
  ),
  owners: z.array(
    z.object({
      clientId: z.string().nullable(),
      why: z.string(),
      organizationId: z.string(),
      organizationName: z.string(),
      product: productShape,
      invitationId: z.string(),
      invitedAt: z.string(),
      expiresAt: z.string(),
      trialStartedAt: z.string().nullable(),
    }),
  ),
  expiring: z.array(
    z.object({
      clientId: z.string().nullable(),
      why: z.string(),
      organizationId: z.string(),
      organizationName: z.string(),
      kind: z.string(),
      endsAt: z.string(),
      discountBps: z.number().nullable(),
    }),
  ),
})
type Today = z.infer<typeof todaySchema>
type Prospect = Today["prospects"][number]
type TaskRow = Today["tasks"][number]

/**
 * Las otras colas (`/api/admin/overview`). La dirección se lee como texto y
 * solo se enlaza la de una pantalla que existe: una cola nueva del servidor,
 * o una que apunta a una pantalla que ya no está en el menú, no rompe Hoy.
 * La lista de espera y Organizaciones viven ahora en Clientes.
 */
const QUEUE_PATHS: Record<
  string,
  "/support" | "/billing" | "/commissions" | "/users" | "/complaints" | "/clients"
> = {
  "/support": "/support",
  "/billing": "/billing",
  "/commissions": "/commissions",
  "/users": "/users",
  "/complaints": "/complaints",
  "/clients": "/clients",
  "/organizations": "/clients",
  "/waitlist": "/clients",
}
const overviewSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      description: z.string(),
      path: z.string(),
    }),
  ),
})

/** Las colas que ya son filas en Hoy: su número va en el menú, no entre «Otras colas». */
const LISTED_QUEUES = new Set(["waitlist", "support-open"])

/** La pestaña de la ficha donde se resuelve una tarea. */
function taskTab(kind: string, isAdmin: boolean): ClientTab {
  if (kind === "presentacion" || kind === "propuesta") return "venta"
  if (kind === "alta") return "alta"
  if (kind === "cobro") return isAdmin ? "pagos" : "resumen"
  return "resumen"
}

/** La pestaña de una clínica en riesgo, según su primera señal. */
function riskTab(codes: string[], isAdmin: boolean): ClientTab {
  const first = codes[0]
  if (first === "comprobante_rechazado") return isAdmin ? "pagos" : "resumen"
  if (first === "sin_sesiones" || first === "mensajes_caen") return "uso"
  if (first === "caso_esperando") return "soporte"
  return "resumen"
}

/** El plazo de una solicitud en Hoy: el mismo de la lista de espera y la ficha. */
function prospectDeadline(row: Prospect, now: Date): Said | null {
  if (row.reason === "invitacion" && row.inviteExpiresAt) {
    const due = invitationDueWords(row.inviteExpiresAt, now)
    return { text: `La invitación ${due.text}`, urgent: due.urgent }
  }
  if (row.answer?.due === "vencida")
    return { text: `Respuesta vencida el ${limaDayWords(row.answer.day)}`, urgent: true }
  if (row.answer?.due === "hoy") return { text: "Responder hoy", urgent: true }
  if (row.answer)
    return { text: `Responder hasta el ${limaDayWords(row.answer.day)}`, urgent: false }
  return { text: row.why, urgent: row.overdue }
}

/** Días desde que empezó la prueba: «la prueba ya corre hace 7 días». */
function trialWords(startedAt: string | null, now: Date): string | null {
  if (!startedAt) return null
  const days = Math.floor((now.getTime() - new Date(startedAt).getTime()) / 86_400_000)
  if (days < 0) return null
  if (days === 0) return "la prueba empezó hoy"
  return `la prueba ya corre hace ${days} ${days === 1 ? "día" : "días"}`
}

const matches = (choice: ProductChoice, product: ClinicalProduct | null | undefined) =>
  choice === "todos" || product === choice

function AdminHome() {
  const { adminSession } = appRoute.useRouteContext()
  // Soporte no ve cobros: ni sus filas ni sus importes (ADR 0094). La API tampoco se los da.
  const isAdmin = adminSession.actor.role === "admin"
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const who = search.tareas === "todas" ? "todas" : "mias"
  const product: ProductChoice = search.producto ?? "todos"
  const today = useQuery({
    queryKey: ["admin", "kairos", "today", who],
    queryFn: async () =>
      todaySchema.parse(await api<unknown>(`/api/admin/kairos/today?who=${who}`)),
    // Al pasar de «Mías» a «Todas» lo demás no parpadea: solo cambian las tareas.
    placeholderData: keepPreviousData,
  })
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: async () => overviewSchema.parse(await api<unknown>("/api/admin/overview")),
  })
  const products = useOrgProducts().data ?? {}
  const now = new Date()
  const setSearch = (next: Partial<typeof search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })

  const data = today.data
  const readyTotal = data?.kairosReady.total ?? 0
  const todayDay = data?.today ?? ""
  const answerWithin = data?.answerWithin ?? ""
  const ready = (data?.kairosReady.items ?? []).filter((item) => matches(product, item.product))
  const tasks = (data?.tasks ?? []).filter((row) => matches(product, row.product))
  const cooling = (data?.cooling ?? []).filter((row) => matches(product, row.product))
  const atRisk = (data?.atRisk ?? []).filter((row) => matches(product, row.product))
  // Las fechas de seguimiento pasaron a ser tareas: aquí solo lo que espera respuesta.
  const prospects = (data?.prospects ?? []).filter(
    (row) => row.reason !== null && matches(product, row.product),
  )
  const cases = (data?.support ?? []).filter((row) => matches(product, row.product))
  const owners = (data?.owners ?? []).filter((row) => matches(product, row.product))
  const expiring = (data?.expiring ?? []).filter((row) =>
    matches(product, products[row.organizationId]),
  )
  const counters = (overview.data?.items ?? []).filter(
    (item) => item.count > 0 && !LISTED_QUEUES.has(item.key) && QUEUE_PATHS[item.path],
  )
  const nothing =
    today.isSuccess &&
    overview.isSuccess &&
    ready.length +
      tasks.length +
      cooling.length +
      atRisk.length +
      prospects.length +
      cases.length +
      owners.length +
      expiring.length +
      counters.length ===
      0

  return (
    <PageShell className="space-y-6">
      <PageHeader title="Hoy" subtitle="Lo que Kairós dejó listo y lo que toca hoy." />
      <ProductFilter
        value={product}
        onChange={(next) => setSearch({ producto: next === "todos" ? undefined : next })}
      />
      <KairosUnconfirmed product={product === "todos" ? undefined : product} />
      {today.isPending ? (
        <SkeletonRegion message="Consultando lo de hoy…">
          <HomeSkeleton />
        </SkeletonRegion>
      ) : today.isError ? (
        <section aria-labelledby="hoy-error" className="space-y-3">
          <h2 id="hoy-error" className="text-base font-semibold">
            Lo de hoy
          </h2>
          <ErrorState error={today.error} onRetry={() => void today.refetch()} />
        </section>
      ) : (
        <>
          {ready.length > 0 ? (
            <AgentSurface aria-labelledby="kairos-listo" className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 id="kairos-listo" className="flex items-center gap-2 text-base font-semibold">
                  <AgentMark size="sm" />
                  Kairós dejó listo
                </h2>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {product === "todos" && readyTotal > ready.length
                    ? `${ready.length} de ${readyTotal}`
                    : ready.length}
                </span>
                <Link to="/kairos" className={`ml-auto text-sm ${moreLink}`}>
                  Ver todo en Kairós
                </Link>
              </div>
              <p className="text-sm text-muted-foreground">
                Nada sale a una clínica sin tu sí. Lo que no decidas vence a las 48 horas.
              </p>
              <ul className="flex flex-col gap-3">
                {ready.map((item) => (
                  <KairosItemCard key={item.id} item={item} isAdmin={isAdmin} now={now} />
                ))}
              </ul>
            </AgentSurface>
          ) : null}

          <HomeSection
            id="tareas"
            title={who === "mias" ? "Tus tareas de hoy" : "Las tareas de hoy"}
            count={tasks.length}
            lead={
              <ViewTabs
                label="De quién son las tareas"
                value={who}
                options={[
                  { value: "mias", label: "Mías" },
                  { value: "todas", label: "Todas" },
                ]}
                onValueChange={(next) =>
                  setSearch({ tareas: next === "todas" ? "todas" : undefined })
                }
              />
            }
            note={
              tasks.length > 0
                ? "Lo vencido va arriba. «Mover» la pasa a otro día; «Hecho» la cierra."
                : null
            }
          >
            {tasks.length === 0 ? (
              nothing ? null : (
                <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                  {who === "mias"
                    ? "No tienes tareas para hoy ni vencidas."
                    : "Nadie tiene tareas para hoy ni vencidas."}
                </p>
              )
            ) : (
              <Rows>
                {tasks.map((row) => (
                  <TaskItem key={row.id} row={row} today={todayDay} who={who} isAdmin={isAdmin} />
                ))}
              </Rows>
            )}
          </HomeSection>

          {cooling.length > 0 ? (
            <HomeSection
              id="se-enfrian"
              title="Se enfrían"
              count={cooling.length}
              note="Ventas abiertas sin contacto en 7 días, sin próximo paso o con la propuesta o la invitación esperando."
            >
              <Rows>
                {cooling.map((row) => (
                  <HomeRow
                    key={row.clientId}
                    name={
                      <ClientName clientId={row.clientId} tab="venta">
                        {row.name}
                      </ClientName>
                    }
                    product={row.product}
                    action={
                      <OpenClientButton clientId={row.clientId} tab="venta" label="Ver la venta" />
                    }
                  >
                    <Line
                      parts={[
                        row.why,
                        row.owner ? `La lleva ${row.owner.name}` : "Sin responsable",
                      ]}
                    />
                  </HomeRow>
                ))}
              </Rows>
            </HomeSection>
          ) : null}

          {atRisk.length > 0 ? (
            <HomeSection
              id="en-riesgo"
              title="En riesgo"
              count={atRisk.length}
              note="Clínicas con cuenta: cada señal dice su hecho."
            >
              <Rows>
                {atRisk.map((row) => {
                  const tab = riskTab(
                    row.signals.map((signal) => signal.code),
                    isAdmin,
                  )
                  return (
                    <HomeRow
                      key={row.clientId}
                      name={
                        <ClientName clientId={row.clientId} tab={tab}>
                          {row.name}
                        </ClientName>
                      }
                      product={row.product}
                      action={<OpenClientButton clientId={row.clientId} tab={tab} urgent />}
                    >
                      <Line
                        parts={[
                          { text: row.why, urgent: true },
                          row.owner ? `La lleva ${row.owner.name}` : null,
                        ]}
                      />
                    </HomeRow>
                  )
                })}
              </Rows>
            </HomeSection>
          ) : null}

          {prospects.length > 0 ? (
            <HomeSection
              id="prospectos"
              title="Prospectos por responder"
              count={prospects.length}
              lead={
                isAdmin
                  ? null
                  : "Invitar o descartar lo hace Administración; tú puedes anotar el contacto."
              }
              note={`Se responde en ${answerWithin}. Una sin responder se va al anotar un contacto, invitar o descartar.`}
            >
              <Rows>
                {prospects.map((row) => {
                  const deadline = prospectDeadline(row, now)
                  const urgent = row.overdue || deadline?.urgent === true
                  return (
                    <HomeRow
                      key={row.id}
                      name={
                        row.clientId ? (
                          <ClientName clientId={row.clientId} tab="venta">
                            {row.clinicName}
                          </ClientName>
                        ) : (
                          row.clinicName
                        )
                      }
                      product={row.product}
                      action={
                        row.clientId ? (
                          <OpenClientButton
                            clientId={row.clientId}
                            tab="venta"
                            label="Responder"
                            urgent={urgent}
                          />
                        ) : (
                          <OpenRequest id={row.id} urgent={urgent} />
                        )
                      }
                    >
                      <Line parts={[WAITLIST_STAGE_WORDS[row.stage] ?? null, deadline]} />
                    </HomeRow>
                  )
                })}
              </Rows>
            </HomeSection>
          ) : null}

          {cases.length > 0 ? (
            <HomeSection
              id="casos"
              title="Casos de soporte por atender"
              count={cases.length}
              more={
                <Link to="/support" className={moreLink}>
                  Ver la cola de soporte
                </Link>
              }
              note="El que más espera va arriba. Lo que escribió la clínica no sale aquí: se lee al abrir el caso."
            >
              <Rows>
                {cases.map((row) => {
                  const wait = supportWaitWords(row, now)
                  return (
                    <HomeRow
                      key={row.id}
                      name={
                        row.clientId ? (
                          <ClientName clientId={row.clientId} tab="soporte">
                            {row.organizationName}
                          </ClientName>
                        ) : (
                          row.organizationName
                        )
                      }
                      product={row.product}
                      action={
                        row.clientId ? (
                          <OpenClientButton
                            clientId={row.clientId}
                            tab="soporte"
                            label="Ver el caso"
                            urgent={wait.urgent}
                          />
                        ) : (
                          <Button
                            size="sm"
                            variant={wait.urgent ? "default" : "outline"}
                            render={<Link to="/support" search={{ caso: row.id }} />}
                          >
                            Abrir caso
                          </Button>
                        )
                      }
                    >
                      <Line
                        parts={[
                          SUPPORT_KIND_LABEL[row.kind as keyof typeof SUPPORT_KIND_LABEL] ?? null,
                          wait,
                          row.assigneeName ?? "Sin asignar",
                        ]}
                      />
                    </HomeRow>
                  )
                })}
              </Rows>
            </HomeSection>
          ) : null}

          {owners.length > 0 ? (
            <HomeSection
              id="propietarias"
              title="Clínicas con la propietaria sin aceptar"
              count={owners.length}
              note="«Reenviar» está en los contactos de la ficha: el mismo enlace vuelve a valer 7 días. Nada se reenvía solo."
            >
              <Rows>
                {owners.map((row) => {
                  const due = invitationDueWords(row.expiresAt, now)
                  return (
                    <HomeRow
                      key={row.invitationId}
                      name={
                        row.clientId ? (
                          <ClientName clientId={row.clientId} tab="contactos">
                            {row.organizationName}
                          </ClientName>
                        ) : (
                          row.organizationName
                        )
                      }
                      product={row.product}
                      action={
                        row.clientId ? (
                          <OpenClientButton
                            clientId={row.clientId}
                            tab="contactos"
                            label="Ver contactos"
                            urgent={due.urgent}
                          />
                        ) : (
                          <Button
                            size="sm"
                            variant={due.urgent ? "default" : "outline"}
                            render={
                              <Link
                                to="/organizations/$organizationId"
                                params={{ organizationId: row.organizationId }}
                                search={{ tab: "equipo" }}
                              />
                            }
                          >
                            Ver la clínica
                          </Button>
                        )
                      }
                    >
                      <Line
                        parts={[
                          `Propietaria invitada el ${supportDay(row.invitedAt)}, aún no acepta`,
                          { text: `La invitación ${due.text}`, urgent: due.urgent },
                          trialWords(row.trialStartedAt, now),
                        ]}
                      />
                    </HomeRow>
                  )
                })}
              </Rows>
            </HomeSection>
          ) : null}

          {isAdmin && expiring.length > 0 ? (
            <HomeSection
              id="vencen-pronto"
              title="Precios especiales que vencen pronto"
              count={expiring.length}
              note="Si no haces nada, vence: desde el día siguiente se cuenta al precio de lista y la clínica ya recibió su aviso."
            >
              <Rows>
                {expiring.map((row) => {
                  const days = Math.max(
                    0,
                    Math.ceil((new Date(row.endsAt).getTime() - now.getTime()) / 86_400_000),
                  )
                  return (
                    <HomeRow
                      key={`${row.kind}-${row.organizationId}`}
                      name={
                        row.clientId ? (
                          <ClientName clientId={row.clientId} tab="pagos">
                            {row.organizationName}
                          </ClientName>
                        ) : (
                          row.organizationName
                        )
                      }
                      product={products[row.organizationId] ?? null}
                      action={
                        row.clientId ? (
                          <OpenClientButton
                            clientId={row.clientId}
                            tab="pagos"
                            label={row.kind === "precio_especial" ? "Renovar…" : "Ver el plan"}
                          />
                        ) : (
                          <Button
                            size="sm"
                            render={
                              <Link
                                to="/organizations/$organizationId"
                                params={{ organizationId: row.organizationId }}
                                search={row.kind === "precio_especial" ? { tab: "precio" } : {}}
                              />
                            }
                          >
                            {row.kind === "precio_especial" ? "Renovar…" : "Ver la clínica"}
                          </Button>
                        )
                      }
                    >
                      <Line
                        parts={[
                          row.why,
                          {
                            text:
                              days === 0
                                ? "vence hoy"
                                : `faltan ${days} ${days === 1 ? "día" : "días"}`,
                            urgent: days <= 7,
                          },
                        ]}
                      />
                    </HomeRow>
                  )
                })}
              </Rows>
            </HomeSection>
          ) : null}
        </>
      )}

      {overview.isPending ? (
        <SkeletonRegion message="Consultando las otras colas…">
          <HomeCountersSkeleton />
        </SkeletonRegion>
      ) : overview.isError ? (
        <section aria-labelledby="otras-colas" className="space-y-3">
          <h2 id="otras-colas" className="text-base font-semibold">
            Otras colas
          </h2>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
        </section>
      ) : counters.length > 0 ? (
        <HomeSection
          id="otras-colas"
          title="Otras colas"
          lead={product === "todos" ? null : "Las otras colas cuentan todos los productos."}
        >
          <Rows>
            {counters.map((item) => (
              <li key={item.key}>
                <Link
                  to={QUEUE_PATHS[item.path] ?? "/"}
                  className="flex items-center gap-4 p-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{item.label}</span>
                    <span className="block text-sm text-muted-foreground">{item.description}</span>
                  </span>
                  <span className="text-lg font-semibold tabular-nums">{item.count}</span>
                  <ArrowRight className="size-4 shrink-0" aria-hidden />
                </Link>
              </li>
            ))}
          </Rows>
        </HomeSection>
      ) : null}

      {nothing ? (
        <EmptyState
          title="Nada espera al equipo por ahora"
          description="Cuando Kairós deje algo listo, venza una tarea o llegue una solicitud o un caso, sale aquí con su botón."
        />
      ) : null}

      {/* Pruebas por vencer y costo y margen: importes, solo para la administración. */}
      {isAdmin ? <TodayBilling product={product} /> : null}
    </PageShell>
  )
}

/** Una tarea de hoy o vencida: «Hecho» la cierra y «Mover» la pasa a otro día. */
function TaskItem({
  row,
  today,
  who,
  isAdmin,
}: {
  row: TaskRow
  today: string
  who: "mias" | "todas"
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const tab = taskTab(row.kind, isAdmin)
  const leave = useFocusOnLeave<HTMLLIElement>()
  const done = useMutation({
    mutationFn: async () => {
      leave.markLeaving()
      return api(`/api/admin/clients/tasks/${row.id}/done`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    },
    onSuccess: () => {
      invalidateArm(queryClient, row.clientId)
      toast.success(`Hecho: ${row.title}`)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const move = useMutation({
    mutationFn: async (dueOn: string) => {
      leave.markLeaving()
      return api(`/api/admin/clients/tasks/${row.id}/move`, {
        method: "POST",
        body: JSON.stringify({ dueOn }),
      })
    },
    onSuccess: (_data, dueOn) => {
      invalidateArm(queryClient, row.clientId)
      toast.success(`Pasó al ${limaDayWords(dueOn)}`)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const busy = done.isPending || move.isPending
  // Una presentación se cierra diciendo cómo fue, en la Venta de la ficha.
  const presentation = row.kind === "presentacion"
  return (
    <HomeRow
      rowRef={leave.ref}
      name={
        <ClientName clientId={row.clientId} tab={tab}>
          {row.clientName}
        </ClientName>
      }
      product={row.product}
      action={
        <>
          {row.report && isAdmin ? (
            // La tarea se cierra sola cuando el informe queda enviado.
            <UnknownReportActions
              organizationId={row.report.organizationId}
              number={row.report.number}
              to={row.report.to}
              canResend={row.report.canResend}
              size="sm"
            />
          ) : presentation ? (
            <OpenClientButton
              clientId={row.clientId}
              tab="venta"
              label="Cómo fue"
              urgent={row.overdue}
            />
          ) : (
            <Button
              type="button"
              size="sm"
              variant={row.overdue ? "default" : "outline"}
              disabled={busy}
              onClick={() => done.mutate()}
            >
              Hecho
            </Button>
          )}
          <DatePickerButton
            size="sm"
            value={row.dueOn}
            min={today}
            align="end"
            disabled={busy}
            aria-label={`Mover «${row.title}» a otro día`}
            onChange={(day) => {
              if (day && day !== row.dueOn) move.mutate(day)
            }}
          >
            Mover
          </DatePickerButton>
        </>
      }
    >
      <p className="flex flex-wrap items-center gap-x-1.5 text-sm [overflow-wrap:anywhere]">
        {row.byKairos ? <AgentMark size="sm" className="size-5" /> : null}
        <span>{row.title}</span>
      </p>
      <Line
        parts={[
          { text: row.why, urgent: row.overdue },
          who === "todas" ? (row.assignee ? `De ${row.assignee.name}` : "Sin asignar") : null,
        ]}
      />
    </HomeRow>
  )
}

/**
 * «Abrir solicitud» de una fila que no trae su cliente: `/waitlist?solicitud=`
 * busca el cliente de esa solicitud y abre su ficha en Venta (o Clientes, si
 * no lo encuentra).
 */
function OpenRequest({ id, urgent }: { id: string; urgent: boolean }) {
  return (
    <Button
      size="sm"
      variant={urgent ? "default" : "outline"}
      render={
        <Link to="/waitlist" search={() => ({ ...rememberedWaitlistFilters(), solicitud: id })} />
      }
    >
      Abrir solicitud
    </Button>
  )
}
