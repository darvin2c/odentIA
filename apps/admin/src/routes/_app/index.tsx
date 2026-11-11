import { CLINICAL_PRODUCTS, type ClinicalProduct } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import { EmptyState, ErrorState, PageHeader, PageShell, SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { api } from "../../lib/api"
import { invitationDueWords, limaDayWords } from "../../lib/invitation-words"
import { SUPPORT_KIND_LABEL, supportDay, supportWaitWords } from "../../lib/support-words"
import { matchesProduct, type ProductChoice, ProductFilter, ProductMark, useOrgProducts } from "../../components/product"
import { HomeCountersSkeleton, HomePageSkeleton, HomeSkeleton } from "../../components/skeletons/home"
import { TodayBilling } from "../../components/today-billing"

export const Route = createFileRoute("/_app/")({ pendingComponent: HomePageSkeleton, component: AdminHome })
const appRoute = getRouteApi("/_app")

const overviewSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int().nonnegative(),
      description: z.string(),
      path: z.enum(["/support", "/billing", "/commissions", "/organizations", "/users", "/complaints", "/waitlist"]),
    }),
  ),
  expiring: z
    .array(
      z.object({
        organizationId: z.string(),
        organizationName: z.string(),
        kind: z.enum(["precio_especial", "condiciones"]),
        endsAt: z.string(),
        discountBps: z.number().nullable(),
      }),
    )
    .default([]),
})

/** Lo que Inicio nombra fila por fila (`GET /api/admin/overview/today`): el orden es el del servidor. */
const productShape = z.enum(CLINICAL_PRODUCTS)
const todaySchema = z.object({
  prospects: z.array(
    z.object({
      id: z.string(),
      clinicName: z.string(),
      product: productShape,
      stage: z.string(),
      reason: z.enum(["por_responder", "invitacion"]).nullable(),
      answer: z.object({ due: z.enum(["vencida", "hoy", "hasta"]), day: z.string() }).nullable(),
      inviteExpiresAt: z.string().nullable(),
      followUp: z
        .object({ on: z.string(), overdue: z.boolean(), body: z.string(), authorName: z.string().nullable(), createdAt: z.string() })
        .nullable(),
      overdue: z.boolean(),
    }),
  ),
  support: z.array(
    z.object({
      id: z.string(),
      organizationName: z.string(),
      product: productShape.nullable(),
      kind: z.enum(["pregunta", "problema", "acceso", "cobro"]),
      assigneeName: z.string().nullable(),
      waitingSince: z.string(),
      answerBy: z.string().nullable(),
      accessUntil: z.string().nullable(),
    }),
  ),
  owners: z.array(
    z.object({
      organizationId: z.string(),
      organizationName: z.string(),
      product: productShape,
      invitationId: z.string(),
      invitedAt: z.string(),
      expiresAt: z.string(),
      trialStartedAt: z.string().nullable(),
    }),
  ),
  answerWithin: z.string(),
})
type Today = z.infer<typeof todaySchema>
type Prospect = Today["prospects"][number]

/** Las colas que ya son listas arriba: su número va en el menú, no entre «Otras colas». */
const LISTED_QUEUES = new Set(["waitlist", "support-open"])

/** La etapa de una solicitud, con las palabras de la lista de espera. */
const STAGE_WORDS: Record<string, string> = {
  por_revisar: "Por revisar",
  invitada: "Invitada",
  invitacion_vencida: "Invitación vencida",
  entro: "Entró",
  paga: "Paga",
  descartada: "Descartada",
}

const endFormat = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" })

/** «10 % negociado vence el sáb 24 oct · faltan 6 días». */
function expiringText(item: z.infer<typeof overviewSchema>["expiring"][number], now: Date): { title: string; tail: string; soon: boolean } {
  const end = new Date(item.endsAt)
  const days = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000))
  const day = endFormat.format(end).replaceAll(".", "").replace(",", "")
  const tail = days === 0 ? "vence hoy" : `faltan ${days} ${days === 1 ? "día" : "días"}`
  return item.kind === "precio_especial"
    ? { title: `Su precio negociado (${(item.discountBps ?? 0) / 100} % menos) vence el ${day}`, tail, soon: days <= 7 }
    : { title: `Sus condiciones de Fundador terminan el ${day}; después pasa al plan de lista`, tail, soon: days <= 7 }
}

/** Una frase con su parte en rojo: el rojo es solo para lo vencido y lo de hoy. */
interface Said {
  text: string
  urgent: boolean
}

/** El plazo de una solicitud en Inicio: el mismo de la columna Plazo y la cabecera del cajón. */
function prospectDeadline(row: Prospect, now: Date): Said | null {
  if (row.reason === "invitacion" && row.inviteExpiresAt) {
    const due = invitationDueWords(row.inviteExpiresAt, now)
    return { text: `La invitación ${due.text}`, urgent: due.urgent }
  }
  if (row.answer?.due === "vencida") return { text: `Respuesta vencida el ${limaDayWords(row.answer.day)}`, urgent: true }
  if (row.answer?.due === "hoy") return { text: "Responder hoy", urgent: true }
  if (row.answer) return { text: `Responder hasta el ${limaDayWords(row.answer.day)}`, urgent: false }
  return null
}

/** «Toca hoy · «No contestó» · anotó Sofía el lun 9 nov». */
function FollowUpLine({ followUp }: { followUp: NonNullable<Prospect["followUp"]> }) {
  return (
    <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
      <span className="font-medium text-destructive">{followUp.overdue ? `Tocaba el ${limaDayWords(followUp.on)}` : "Toca hoy"}</span>
      {` · «${followUp.body}» · `}
      {followUp.authorName ? `anotó ${followUp.authorName} el ${supportDay(followUp.createdAt)}` : "Nota anterior, sin autor registrado"}
    </p>
  )
}

/** Partes de una línea, separadas por «·», con su rojo donde toca. */
function Line({ parts }: { parts: (string | Said | null)[] }) {
  const shown = parts.filter((part): part is string | Said => part !== null && part !== "")
  return (
    <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
      {shown.map((part, index) => {
        const said = typeof part === "string" ? { text: part, urgent: false } : part
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: las partes de una frase no cambian de lugar.
          <span key={index}>
            {index > 0 ? " · " : null}
            <span className={said.urgent ? "font-medium text-destructive" : undefined}>{said.text}</span>
          </span>
        )
      })}
    </p>
  )
}

/** Una fila con nombre, el molde de «Precios especiales»: quién, una línea (dos con seguimiento) y un botón. */
function HomeRow({ name, product, children, action }: { name: string; product: ClinicalProduct | null; children: ReactNode; action: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1 basis-60">
        <p className="flex flex-wrap items-center gap-2 font-medium [overflow-wrap:anywhere]">
          {name}
          {product ? <ProductMark product={product} /> : null}
        </p>
        {children}
      </div>
      {action}
    </li>
  )
}

function HomeSection({
  id,
  title,
  count,
  more,
  lead,
  note,
  children,
}: {
  id: string
  title: string
  count?: number
  more?: ReactNode
  lead?: ReactNode
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {count !== undefined ? (
          <Badge variant="secondary" className="tabular-nums">
            {count}
          </Badge>
        ) : null}
        {more ? <span className="ml-auto text-sm">{more}</span> : null}
      </div>
      {lead ? <p className="text-sm text-muted-foreground">{lead}</p> : null}
      {children}
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </section>
  )
}

const moreLink = "text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"

/** Días desde que empezó la prueba: «la prueba ya corre hace 7 días». */
function trialWords(startedAt: string | null, now: Date): string | null {
  if (!startedAt) return null
  const days = Math.floor((now.getTime() - new Date(startedAt).getTime()) / 86_400_000)
  if (days < 0) return null
  if (days === 0) return "la prueba empezó hoy"
  return `la prueba ya corre hace ${days} ${days === 1 ? "día" : "días"}`
}

function AdminHome() {
  const { adminSession } = appRoute.useRouteContext()
  // Soporte no ve cobros: ni sus colas ni sus importes (ADR 0094). Así tampoco pide lo que la API le niega.
  const isAdmin = adminSession.actor.role === "admin"
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: async () => overviewSchema.parse(await api<unknown>("/api/admin/overview")),
  })
  const today = useQuery({
    queryKey: ["admin", "overview", "today"],
    queryFn: async () => todaySchema.parse(await api<unknown>("/api/admin/overview/today")),
  })
  // El filtro alcanza a todo lo que es de una clínica (las filas, los vencimientos, las pruebas,
  // el costo y el margen); las otras colas son números de todos los productos.
  const [product, setProduct] = useState<ProductChoice>("todos")
  const products = useOrgProducts().data ?? {}
  const now = new Date()

  const prospects = (today.data?.prospects ?? []).filter((row) => matchesProduct(product, row.product))
  const toAnswer = prospects.filter((row) => row.reason !== null)
  const followUps = prospects.filter((row) => row.reason === null && row.followUp)
  const cases = (today.data?.support ?? []).filter((row) => matchesProduct(product, row.product ?? undefined))
  const owners = (today.data?.owners ?? []).filter((row) => matchesProduct(product, row.product))
  const counters = (overview.data?.items ?? []).filter((item) => item.count > 0 && !LISTED_QUEUES.has(item.key))
  const expiring = (overview.data?.expiring ?? []).filter((item) => matchesProduct(product, products[item.organizationId]))
  const nothing =
    today.isSuccess &&
    overview.isSuccess &&
    toAnswer.length + followUps.length + cases.length + owners.length + counters.length + expiring.length === 0

  return (
    <PageShell className="space-y-6">
      <PageHeader title="Hoy" subtitle="Lo que necesita atención del equipo." />
      <ProductFilter value={product} onChange={setProduct} />
      {nothing ? (
        <EmptyState
          title="Nada espera al equipo por ahora"
          description="Cuando llegue una solicitud o un caso, o esté por vencer una invitación, sale aquí con su botón."
        />
      ) : (
        <>
          {today.isPending ? (
            <SkeletonRegion message="Consultando lo de hoy…">
              <HomeSkeleton />
            </SkeletonRegion>
          ) : today.isError ? (
            <section aria-labelledby="hoy-filas" className="space-y-3">
              <h2 id="hoy-filas" className="text-base font-semibold">
                Prospectos, casos y seguimientos
              </h2>
              <ErrorState error={today.error} onRetry={() => void today.refetch()} />
            </section>
          ) : (
            <>
              {toAnswer.length > 0 ? (
                <HomeSection
                  id="prospectos"
                  title="Prospectos por responder"
                  count={toAnswer.length}
                  more={
                    <Link to="/waitlist" className={moreLink}>
                      Ver la lista de espera
                    </Link>
                  }
                  lead={isAdmin ? null : "Invitar o descartar lo hace Administración; tú puedes anotar el seguimiento."}
                  note={`Se responde en ${today.data.answerWithin}. La fila se va sola al anotar un contacto, invitar, reenviar o descartar.`}
                >
                  <ul className="divide-y rounded-xl border bg-card">
                    {toAnswer.map((row) => (
                      <HomeRow
                        key={row.id}
                        name={row.clinicName}
                        product={row.product}
                        action={<OpenRequest id={row.id} urgent={row.overdue || prospectDeadline(row, now)?.urgent === true} />}
                      >
                        <Line parts={[STAGE_WORDS[row.stage] ?? null, prospectDeadline(row, now)]} />
                        {row.followUp ? <FollowUpLine followUp={row.followUp} /> : null}
                      </HomeRow>
                    ))}
                  </ul>
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
                  note="El que más espera va arriba. Lo que escribió la clínica no sale aquí: se lee al abrir el caso. La fila se va al responderle o cuando el caso queda esperando a la clínica."
                >
                  <ul className="divide-y rounded-xl border bg-card">
                    {cases.map((row) => {
                      const wait = supportWaitWords(row, now)
                      return (
                        <HomeRow
                          key={row.id}
                          name={row.organizationName}
                          product={row.product}
                          action={
                            <Button size="sm" variant={wait.urgent ? "default" : "outline"} render={<Link to="/support" search={{ caso: row.id }} />}>
                              Abrir caso
                            </Button>
                          }
                        >
                          <Line parts={[SUPPORT_KIND_LABEL[row.kind], wait, row.assigneeName ?? "Sin asignar"]} />
                        </HomeRow>
                      )
                    })}
                  </ul>
                </HomeSection>
              ) : null}
              {followUps.length > 0 ? (
                <HomeSection
                  id="seguimientos"
                  title="Seguimientos de hoy"
                  count={followUps.length}
                  note="Sale lo anotado para hoy o para un día que ya pasó. Anotar otra vez sin fecha, o con una fecha más adelante, la saca de aquí."
                >
                  <ul className="divide-y rounded-xl border bg-card">
                    {followUps.map((row) => (
                      <HomeRow key={row.id} name={row.clinicName} product={row.product} action={<OpenRequest id={row.id} urgent />}>
                        <Line parts={[STAGE_WORDS[row.stage] ?? null]} />
                        {row.followUp ? <FollowUpLine followUp={row.followUp} /> : null}
                      </HomeRow>
                    ))}
                  </ul>
                </HomeSection>
              ) : null}
              {owners.length > 0 ? (
                <HomeSection
                  id="propietarias"
                  title="Clínicas con la propietaria sin aceptar"
                  count={owners.length}
                  note="La clínica se abre en Equipo, donde está «Reenviar». Nada se reenvía solo."
                >
                  <ul className="divide-y rounded-xl border bg-card">
                    {owners.map((row) => {
                      const due = invitationDueWords(row.expiresAt, now)
                      return (
                        <HomeRow
                          key={row.invitationId}
                          name={row.organizationName}
                          product={row.product}
                          action={
                            <Button
                              size="sm"
                              variant={due.urgent ? "default" : "outline"}
                              render={<Link to="/organizations/$organizationId" params={{ organizationId: row.organizationId }} search={{ tab: "equipo" }} />}
                            >
                              Ver la clínica
                            </Button>
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
                  </ul>
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
              <ul className="divide-y rounded-xl border bg-card">
                {counters.map((item) => (
                  <li key={item.key}>
                    <Link
                      to={item.path}
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
              </ul>
            </HomeSection>
          ) : null}
          {expiring.length > 0 ? (
            <HomeSection
              id="vencen-pronto"
              title="Precios especiales que vencen pronto"
              note="Si no haces nada, vence: desde el día siguiente se cuenta al precio de lista y la clínica ya recibió su aviso."
            >
              <ul className="divide-y rounded-xl border bg-card">
                {expiring.map((item) => {
                  const text = expiringText(item, now)
                  return (
                    <HomeRow
                      key={`${item.kind}-${item.organizationId}`}
                      name={item.organizationName}
                      product={products[item.organizationId] ?? null}
                      action={
                        <Button
                          size="sm"
                          render={
                            <Link
                              to="/organizations/$organizationId"
                              params={{ organizationId: item.organizationId }}
                              search={item.kind === "precio_especial" ? { tab: "precio" } : {}}
                            />
                          }
                        >
                          {item.kind === "precio_especial" ? "Renovar…" : "Ver la clínica"}
                        </Button>
                      }
                    >
                      <Line parts={[text.title, { text: text.tail, urgent: text.soon }]} />
                    </HomeRow>
                  )
                })}
              </ul>
            </HomeSection>
          ) : null}
        </>
      )}
      {/* Pruebas por vencer y costo y margen: importes, solo para la administración. */}
      {isAdmin ? <TodayBilling product={product} /> : null}
    </PageShell>
  )
}

/** «Abrir solicitud»: el cajón de esa solicitud en la lista de espera, no la lista. */
function OpenRequest({ id, urgent }: { id: string; urgent: boolean }) {
  return (
    <Button size="sm" variant={urgent ? "default" : "outline"} render={<Link to="/waitlist" search={{ solicitud: id }} />}>
      Abrir solicitud
    </Button>
  )
}
