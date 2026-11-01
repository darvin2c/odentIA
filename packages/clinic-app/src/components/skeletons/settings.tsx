/**
 * Los esqueletos de Configuración. Cada `XSkeleton` es la zona de datos de su
 * pantalla, con sus mismas tarjetas y clases responsive; `XPageSkeleton` añade
 * el encabezado de la pantalla para el `pendingComponent` de su ruta.
 *
 * Las pantallas de Configuración siempre se montan dentro del layout, que ya
 * pone el `PageShell` y la lista de apartados, y cada una aporta su propio
 * `PageHeader`: por eso aquí el marco es `SettingsPage` y no `PageLoading`, que
 * dentro de un shell omite el título.
 */
import { cn, Skeleton } from "@odentia/ui"
import { DataTableSkeleton, PageHeader, type PageHeaderProps, SkeletonRegion } from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import type { ReactNode } from "react"
import { PLAN_PATH } from "../../lib/billing"
import { useCan, usePermission } from "../../lib/crm"
import { settingsPrimary } from "../../lib/screen-rules"

/** Una línea de `text-sm`: la barra más su aire mide lo mismo que el renglón. */
function Line({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-4", className)} />
}

/** Una línea de texto base (24 px de renglón). */
function BaseLine({ className }: { className?: string }) {
  return <Skeleton className={cn("my-1 h-4", className)} />
}

function slots(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

/** El encabezado real de la pantalla y su zona de datos, con el mismo envoltorio. */
function SettingsPage({
  title,
  subtitle,
  primary,
  message,
  className = "flex flex-col gap-6",
  children,
}: {
  title: string
  subtitle?: ReactNode
  primary?: PageHeaderProps["primary"]
  message: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={className}>
      <PageHeader title={title} subtitle={subtitle} primary={primary} />
      <SkeletonRegion message={message} className={className}>
        {children}
      </SkeletonRegion>
    </div>
  )
}

/**
 * `FilterBar` sin datos: el buscador plegado y los filtros en la web; en el
 * teléfono, el buscador a lo ancho y la fila de filtros debajo.
 */
function FilterBarLoading({ filters = 1 }: { filters?: number }) {
  const chips = slots(filters)
  return (
    <div aria-hidden className="flex rounded-md bg-card p-3">
      <div className="hidden w-full min-w-0 items-center gap-2 md:flex">
        <Skeleton className="h-9 w-40 rounded-full" />
        {chips.map((chip) => (
          <Skeleton key={chip} className="h-9 w-24 shrink-0 rounded-full" />
        ))}
        <Skeleton className="ml-auto h-9 w-24 shrink-0 rounded-full" />
      </div>
      <div className="flex w-full min-w-0 flex-col gap-2 md:hidden">
        <Skeleton className="h-9 w-full rounded-full" />
        <div className="flex min-w-0 items-center gap-2 overflow-hidden pb-0.5">
          {chips.map((chip) => (
            <Skeleton key={chip} className="h-9 w-24 shrink-0 rounded-full" />
          ))}
          <Skeleton className="h-9 w-24 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Datos de la clínica
// ---------------------------------------------------------------------------

const PROFILE_CARD = "elevated flex flex-col gap-4 rounded-xl border bg-card p-5"

const PROFILE_FORM = [
  { title: "Identidad", fields: ["Razón social", "Nombre comercial", "Documento fiscal", "Número", "Dirección fiscal", "Teléfono para urgencias"] },
  { title: "País y formato", fields: ["País", "Zona horaria", "Moneda"] },
]

/** El formulario con sus tarjetas y rótulos: solo el valor de cada campo es barra. */
export function ClinicProfileSkeleton() {
  return (
    <div aria-hidden className="flex max-w-3xl flex-col gap-4">
      {PROFILE_FORM.map((card) => (
        <div key={card.title} className={PROFILE_CARD}>
          <h2 className="font-heading text-base font-medium">{card.title}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {card.fields.map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <span className="text-sm font-medium">{field}</span>
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="flex justify-end gap-3">
        <Skeleton className="h-11 w-24 rounded-md" />
        <Skeleton className="h-11 w-24 rounded-md" />
      </div>
      <section className={PROFILE_CARD}>
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium">Logo</h2>
          <p className="text-sm text-muted-foreground">Lo ven tus pacientes al abrir el registro y su enlace.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Skeleton className="size-16 rounded-lg" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </section>
      <section className={PROFILE_CARD}>
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium">Lista de diagnósticos</h2>
          <p className="text-sm text-muted-foreground">En ella se eligen los diagnósticos de las atenciones. Cada diagnóstico guarda su lista.</p>
        </div>
        <Skeleton className="h-9 w-full" />
      </section>
    </div>
  )
}

export function ClinicProfilePageSkeleton() {
  return (
    <SettingsPage
      title="Datos de la clínica"
      subtitle="Con estos datos se leen las fechas, los importes y los documentos de toda la clínica."
      message="Cargando los datos de la clínica…"
      className="flex flex-col gap-4"
    >
      <ClinicProfileSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Sedes, Equipo, Actividad, Campos, Etapas: tablas
// ---------------------------------------------------------------------------

export function BranchesSkeleton() {
  return <DataTableSkeleton columnCount={5} rowCount={3} label="Cargando las sedes…" />
}

export function BranchesPageSkeleton() {
  const can = useCan()
  return (
    <SettingsPage title="Sedes" subtitle="Los locales de la clínica, con su dirección, su teléfono y su zona horaria." primary={settingsPrimary("branches", can)} message="Cargando las sedes…">
      <FilterBarLoading />
      <BranchesSkeleton />
    </SettingsPage>
  )
}

export function TeamSkeleton() {
  return <DataTableSkeleton columnCount={6} rowCount={4} label="Cargando el equipo…" />
}

export function TeamPageSkeleton() {
  const can = useCan()
  return (
    <SettingsPage title="Equipo" subtitle="Quién forma parte de la clínica y qué puede hacer cada persona." primary={settingsPrimary("team", can)} message="Cargando el equipo…">
      {/* La tarjeta de verificación en dos pasos, con el mismo hueco que deja al cargar. */}
      <Skeleton aria-hidden className="h-20 w-full rounded-xl" />
      <FilterBarLoading />
      <TeamSkeleton />
    </SettingsPage>
  )
}

export function TeamActivitySkeleton() {
  return <DataTableSkeleton columnCount={4} rowCount={8} label="Cargando la actividad del equipo…" />
}

export function TeamActivityPageSkeleton() {
  return (
    <SettingsPage
      title="Actividad del equipo"
      subtitle="Quién hizo qué y cuándo. Es una consulta: desde aquí no se cambia nada."
      message="Cargando la actividad del equipo…"
    >
      <TeamActivitySkeleton />
    </SettingsPage>
  )
}

export function PipelinesSkeleton() {
  return <DataTableSkeleton columnCount={3} rowCount={4} label="Cargando las etapas de venta…" />
}

export function PipelinesPageSkeleton() {
  return (
    <SettingsPage
      title="Etapas de venta"
      subtitle="Los cuatro pasos por los que avanza sola cada oportunidad. Puedes cambiarles el nombre."
      message="Cargando las etapas de venta…"
    >
      <PipelinesSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Horarios y ausencias
// ---------------------------------------------------------------------------

const AVAILABILITY_CARD = "grid content-start gap-3 rounded-xl border bg-background p-3 sm:p-4"

function AvailabilityGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 grid gap-0.5">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  )
}

function AvailabilityCardHead({ title }: { title?: string }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2">
      {title ? <h3 className="min-w-0 flex-1 font-semibold">{title}</h3> : <BaseLine className="w-60 max-w-full" />}
    </div>
  )
}

/** Los dos grupos y sus tarjetas: lo que no depende de la sede se escribe. */
export function AvailabilitySkeleton() {
  return (
    <div aria-hidden className="grid gap-4">
      <AvailabilityGroup title="De cada profesional">Su horario de la semana y los días que no viene.</AvailabilityGroup>
      <Skeleton className="h-10 w-64 max-w-full rounded-full" />
      <div className={AVAILABILITY_CARD}>
        <AvailabilityCardHead />
        {slots(7).map((day) => (
          <Skeleton key={day} className="h-10 w-full" />
        ))}
      </div>
      <div className={AVAILABILITY_CARD}>
        <AvailabilityCardHead />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="mt-2 grid gap-0.5">
        <h2 className="text-lg font-bold">De la sede</h2>
        <Line className="w-72 max-w-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={AVAILABILITY_CARD}>
          <AvailabilityCardHead />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className={AVAILABILITY_CARD}>
          <AvailabilityCardHead title="Duración de una cita regular" />
          <div className="flex flex-wrap gap-2">
            {slots(4).map((option) => (
              <Skeleton key={option} className="h-10 w-20 rounded-xl" />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Lo que dura una cita sin servicio. Con servicio manda su duración, y al reservar se puede cambiar estirando el bloque. Se guarda al elegirla.
          </p>
        </div>
      </div>
      <div className={AVAILABILITY_CARD}>
        <AvailabilityCardHead title="Feriados y cierres" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  )
}

export function AvailabilityPageSkeleton() {
  return (
    <SettingsPage
      title="Horarios y ausencias"
      subtitle="El horario y las ausencias de cada profesional, y lo que vale para toda la sede."
      message="Cargando horarios y ausencias…"
      className="grid gap-4"
    >
      <AvailabilitySkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Protección de datos
// ---------------------------------------------------------------------------

export function DataProtectionSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-5">
      <section className="grid gap-4 rounded-2xl border bg-muted/40 p-5 text-sm sm:grid-cols-2">
        {["Responsable de los datos", "Encargado"].map((title) => (
          <div key={title} className="flex flex-col gap-1">
            <h2 className="mb-1 text-base font-semibold">{title}</h2>
            <Line className="w-4/5" />
            <Line className="w-3/5" />
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border p-5">
        <h2 className="text-base font-semibold">Qué datos guarda y para qué</h2>
        <ul className="flex flex-col divide-y text-sm sm:hidden">
          {slots(4).map((row) => (
            <li key={row} className="flex flex-col gap-0.5 py-2.5">
              <Line className="w-3/5" />
              <Line className="w-full" />
              <Line className="w-4/5" />
            </li>
          ))}
        </ul>
        <div className="hidden overflow-hidden sm:block">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                {["Para qué", "Qué datos", "Con qué permiso", "Cuánto tiempo"].map((label) => (
                  <th key={label} scope="col" className="border-b px-2 py-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slots(4).map((row) => (
                <tr key={row} className="align-top">
                  {slots(4).map((cell) => (
                    <td key={cell} className="border-b px-2 py-2.5">
                      <Line className="w-4/5" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border p-5">
        <div>
          <h2 className="text-base font-semibold">Quién más los toca</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Empresas que procesan los datos por cuenta de la clínica. Las que están fuera del país son una transferencia
            internacional: la autorizaste en el contrato de encargo.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-48" />
          <ul className="flex flex-col divide-y rounded-xl border">
            {slots(3).map((row) => (
              <li key={row} className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[minmax(150px,1fr)_minmax(220px,2fr)_140px] sm:gap-3">
                <Line className="w-3/4" />
                <Line className="w-4/5" />
                <Line className="w-16" />
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-5">
        <div className="min-w-0 flex-1">
          <BaseLine className="w-60 max-w-full" />
          <Line className="mt-1 w-4/5" />
        </div>
      </section>
    </div>
  )
}

export function DataProtectionPageSkeleton() {
  return (
    <SettingsPage
      title="Protección de datos"
      subtitle="Qué datos guarda la clínica, para qué y quién más los toca. Es lo que pide la ley de datos personales y lo que te pide la autoridad si lo revisa. Se arma solo, con lo que la clínica usa hoy."
      message="Armando el registro…"
      className="flex flex-col gap-5"
    >
      <DataProtectionSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Especialidades
// ---------------------------------------------------------------------------

export function SpecialtiesSkeleton() {
  const canAdmin = usePermission("settings.write")
  return (
    <ul aria-hidden className="elevated flex flex-col divide-y rounded-xl border bg-card">
      {["w-40", "w-32", "w-44", "w-36"].map((width) => (
        <li key={width} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <BaseLine className={width} />
            <Line className="w-64 max-w-full" />
          </div>
          {canAdmin ? <Skeleton className="h-11 w-16 rounded-md sm:h-8" /> : null}
        </li>
      ))}
    </ul>
  )
}

export function SpecialtiesPageSkeleton() {
  const can = useCan()
  return (
    <SettingsPage
      title="Especialidades"
      primary={settingsPrimary("specialties", can)}
      subtitle="Las especialidades de tu clínica y quién atiende cada una. La agenda ofrece cada servicio a quien atiende su especialidad."
      message="Cargando las especialidades…"
    >
      <SpecialtiesSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Consentimientos
// ---------------------------------------------------------------------------

/** Las plantillas: su nombre, su estado y sus versiones, luego sus acciones. */
export function TemplatesSkeleton() {
  // «Nueva plantilla» es de quien administra; las demás acciones de cada fila también dependen de su estado.
  const canAdmin = usePermission("settings.write")
  return (
    <div aria-hidden className="flex flex-col gap-4">
      {canAdmin ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Skeleton className="h-11 w-40 rounded-md" />
        </div>
      ) : null}
      <ul className="flex flex-col gap-3">
        {["w-56", "w-44", "w-64"].map((width) => (
          <li key={width} className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <BaseLine className={cn("max-w-full", width)} />
                <Line className="w-40" />
              </div>
              <Skeleton className="h-5.5 w-32 rounded-full" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Skeleton className="h-11 w-48 rounded-md sm:h-8" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function FormTemplatesPageSkeleton() {
  return (
    <SettingsPage
      title="Consentimientos"
      subtitle="Lo que firma el paciente antes de un tratamiento. La atención lo prepara solo cuando registras uno de estos servicios."
      message="Cargando los consentimientos…"
    >
      <TemplatesSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Integraciones
// ---------------------------------------------------------------------------

/** Las filas de un bloque: la marca solo desde `@xl`, como en la fila real. */
function IntegrationRowsLoading({ rows }: { rows: number }) {
  return (
    <>
      {slots(rows).map((row) => (
        <li key={row} className="flex items-center gap-3 border-t px-4 py-3">
          <Skeleton className="hidden size-9 shrink-0 rounded-[10px] @xl:block" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-3/5" />
          </div>
          <Skeleton className="h-9 w-24 shrink-0 rounded-full" />
        </li>
      ))}
    </>
  )
}

function IntegrationBlockLoading({ title, rows, note }: { title: string; rows: number; note?: string }) {
  return (
    <section className="@container elevated flex min-w-0 flex-col rounded-xl border bg-card">
      <h2 className="px-4 pt-3.5 pb-2.5 text-xs font-bold tracking-wider text-muted-foreground uppercase">{title}</h2>
      <ul className="flex flex-col">
        <IntegrationRowsLoading rows={rows} />
      </ul>
      {note ? <p className="border-t px-4 pt-2.5 pb-3.5 text-sm text-muted-foreground">{note}</p> : null}
    </section>
  )
}

export function IntegrationsPageSkeleton() {
  return (
    <SettingsPage
      title="Integraciones"
      subtitle={
        <>
          <span className="sm:hidden">Lo que se conecta una vez: para qué sirve y cómo está.</span>
          <span className="max-sm:hidden">Lo que se conecta una vez. Cada fila dice para qué sirve, con qué cuenta y cómo está.</span>
        </>
      }
      message="Cargando las integraciones…"
      className="flex flex-col gap-4"
    >
      <div aria-hidden className="flex flex-col gap-4">
        <IntegrationBlockLoading
          title="Mensajería"
          rows={4}
          note="Lo automático sale por WhatsApp y, si no se puede, por correo. Instagram, Messenger y Telegram solo responden a quien escribió primero."
        />
        <IntegrationBlockLoading title="Tu sitio web" rows={1} />
        <IntegrationBlockLoading title="Correo de la clínica" rows={2} />
      </div>
    </SettingsPage>
  )
}

/** El camino de vuelta y el texto: el mismo `IntegrationsCrumbWithText`, sin enlace. */
function IntegrationsCrumbLoading({ current, text }: { current: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="flex flex-wrap items-center gap-1.5 text-sm">
        <span>Integraciones</span>
        <span aria-hidden>›</span>
        <span className="text-foreground">{current}</span>
      </p>
      <p className="min-w-0">{text}</p>
    </div>
  )
}

export function WhatsAppSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <div className="elevated flex items-center gap-3.5 rounded-xl border bg-card p-4">
        <Skeleton className="hidden size-11 shrink-0 rounded-xl sm:block" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-56 max-w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
        <Skeleton className="h-9 w-28 shrink-0 rounded-full" />
      </div>
      <div className="elevated flex flex-col rounded-xl border bg-card">
        <div className="flex flex-col gap-2 px-4 py-4 sm:px-5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
        {slots(5).map((row) => (
          <div key={row} className="flex items-center gap-3 border-t px-4 py-3 sm:px-5">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-44 max-w-full" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            <Skeleton className="h-5 w-24 shrink-0 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function WhatsAppPageSkeleton() {
  return (
    <SettingsPage
      title="WhatsApp"
      subtitle={<IntegrationsCrumbLoading current="WhatsApp" text="El número de la clínica y los mensajes que WhatsApp deja enviar." />}
      message="Cargando WhatsApp…"
      className="flex flex-col gap-4"
    >
      <WhatsAppSkeleton />
    </SettingsPage>
  )
}

/** Chat web: las dos columnas que se apilan solas (`flex-wrap`) cuando no caben. */
export function WebchatSkeleton() {
  return (
    <div aria-hidden className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[3_1_26rem] flex-col gap-6">
        <section className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="font-semibold">Chat de tu sitio</h2>
            <Line className="w-64 max-w-full" />
          </div>
          <Skeleton className="h-9 w-28 rounded-md" />
        </section>
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold">Instalar en tu sitio</h2>
            <p className="text-sm text-muted-foreground">
              Copia esta línea y pégala en tu sitio, antes de &lt;/body&gt;. Cambiar el color o el saludo no obliga a volver a pegarla.
            </p>
          </div>
          <Skeleton className="h-20 w-full rounded-xl" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-9 w-36 rounded-md" />
            <Skeleton className="h-9 w-52 max-w-full rounded-md" />
          </div>
          <Line className="w-56" />
        </section>
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold">Dónde responde</h2>
            <p className="text-sm text-muted-foreground">
              El primer sitio donde pegas la línea se registra solo. Si aparece en otro, decides tú; mientras tanto, ahí dice «No disponible».
            </p>
          </div>
          <ul className="flex flex-col divide-y rounded-xl border bg-card">
            {slots(2).map((row) => (
              <li key={row} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <BaseLine className="my-0.5 w-40" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                </div>
                <Skeleton className="h-11 w-20 rounded-md sm:h-8" />
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="flex min-w-0 flex-[2_1_20rem] flex-col gap-3 lg:sticky lg:top-4">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex-1 font-semibold">Vista previa</h2>
            <Skeleton className="h-9 w-44 rounded-lg" />
          </div>
          <Skeleton className="mx-auto h-[600px] w-full max-w-[400px] rounded-2xl" />
        </section>
      </div>
    </div>
  )
}

export function WebchatPageSkeleton() {
  return (
    <SettingsPage
      title="Chat web"
      subtitle={<IntegrationsCrumbLoading current="Chat web" text="El chat de tu sitio web: lo que escriben llega a la misma Bandeja." />}
      message="Cargando el chat web…"
    >
      <WebchatSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Portal y registro de pacientes
// ---------------------------------------------------------------------------

const PORTAL_CARD = "elevated flex flex-col gap-4 rounded-xl border bg-card p-5 sm:p-6"

/** Una casilla y su texto, con el alto del real en el teléfono. */
function PortalOption({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex min-h-11 items-start gap-3 sm:min-h-0">
      <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="font-medium">{label}</span>
        {hint ? <span className="text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  )
}

/** Es texto fijo con casillas: lo que se espera es solo si cada una está marcada. */
export function PatientPortalSkeleton() {
  const canWrite = usePermission("settings.write")
  return (
    <div aria-hidden className="flex flex-col gap-6">
      <section className={PORTAL_CARD}>
        <h2 className="font-heading text-base font-medium">El portal</h2>
        <PortalOption label="Portal del paciente encendido" hint="Apagado por defecto. Apagado, nadie entra y no se dan accesos." />
      </section>
      <section className={PORTAL_CARD}>
        <div className="flex flex-col gap-1.5">
          <h2 className="font-heading text-base font-medium">Lo que el paciente puede ver</h2>
          <p className="text-sm text-muted-foreground">
            Es el máximo para toda la clínica. A cada persona se le da acceso en la ficha del paciente, y nunca a más
            de lo marcado aquí.
          </p>
        </div>
        {["Citas", "Presupuestos", "Cuenta y saldo", "Documentos"].map((label) => (
          <PortalOption key={label} label={label} />
        ))}
      </section>
      <section className={PORTAL_CARD}>
        <h2 className="font-heading text-base font-medium">Cómo se entra</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>El acceso se da en la página de cada persona, en persona y con su documento.</li>
          <li>La primera vez entra con el enlace de recepción, que vale 3 días, y un código de 6 dígitos que se le dice aparte.</li>
          <li>Después entra con su huella o su cara. Si su teléfono no puede guardarlo, lo recordamos 30 días.</li>
          <li>El acceso no vence: dura hasta que alguien del equipo pulse «Quitar acceso».</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Para la cita, los datos, el presupuesto y el consentimiento no hace falta el portal: cada persona tiene «Su enlace».
        </p>
      </section>
      {canWrite ? (
        <div>
          <Skeleton className="h-11 w-24 rounded-md" />
        </div>
      ) : null}
    </div>
  )
}

export function PatientPortalPageSkeleton() {
  return (
    <SettingsPage
      title="Portal del paciente"
      subtitle="Si tus pacientes pueden entrar a su portal y qué ven ahí. El acceso de cada persona se da en la ficha del paciente."
      message="Cargando el portal del paciente…"
      className="flex max-w-3xl flex-col gap-6"
    >
      <PatientPortalSkeleton />
    </SettingsPage>
  )
}

const REGISTRATION_CARD = "elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"

function RegistrationCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={REGISTRATION_CARD}>
      <div className="flex flex-col gap-1.5">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : <Line className="w-3/5" />}
      </div>
      {children}
    </section>
  )
}

/** La columna de la configuración y, desde `lg`, la de cómo lo ve el paciente. */
export function PatientRegistrationSkeleton() {
  return (
    <div aria-hidden className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        <RegistrationCard
          title="Qué le pedimos"
          hint="Elige, dato por dato, si es obligatorio, opcional o no se pregunta. Vale para recepción y para lo que llena el paciente en su celular; en «Así lo ve el paciente» ves cómo le queda."
        >
          <div className="flex flex-col gap-3">
            {slots(6).map((row) => (
              <div key={row} className="flex flex-wrap items-center justify-between gap-2">
                <BaseLine className="w-40" />
                <Skeleton className="h-9 w-56 max-w-full rounded-lg" />
              </div>
            ))}
          </div>
        </RegistrationCard>
        <RegistrationCard
          title="Mensajes de la clínica"
          hint="Lo que el registro pregunta, además de la atención. Lo que la persona acepte vale de inmediato para lo que Argos le escribe por su cuenta; sin preguntarlo, casi nadie podrá recibirlo."
        >
          <ul className="flex flex-col divide-y rounded-xl border">
            {slots(2).map((row) => (
              <li key={row} className="flex min-h-11 items-center gap-3 p-3">
                <div className="flex-1">
                  <Line className="w-32" />
                  <Line className="w-4/5" />
                </div>
                <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
              </li>
            ))}
          </ul>
        </RegistrationCard>
        <RegistrationCard title="Aviso de privacidad y publicación" hint="El aviso lo escribe tu clínica y se muestra antes de pedir el consentimiento.">
          <Skeleton className="h-28 w-full rounded-lg" />
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border p-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Que se registren solos</span>
              <Line className="w-56 max-w-full" />
            </span>
            <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
          </div>
        </RegistrationCard>
        <RegistrationCard title="Enlace público y código QR">
          <Skeleton className="h-11 w-40 rounded-md" />
        </RegistrationCard>
      </div>
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-heading text-base font-medium">Así lo ve el paciente</h2>
          <p className="text-sm text-muted-foreground">Con lo que marcaste, una pregunta a la vez, en su celular. Es una vista previa: no guarda nada.</p>
        </div>
        {/* El marco de teléfono de la vista previa, con su mismo alto mínimo. */}
        <div className="flex min-h-[32rem] flex-col gap-3 rounded-[2rem] border-8 border-foreground/85 bg-background p-5">
          <BaseLine className="w-3/4" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    </div>
  )
}

export function PatientRegistrationPageSkeleton() {
  return (
    <SettingsPage
      title="Registro de pacientes"
      subtitle="Qué le pedimos a cada paciente, lo registre recepción o se registre solo, y el aviso de privacidad."
      message="Cargando el registro de pacientes…"
      className="flex max-w-6xl flex-col gap-6"
    >
      <PatientRegistrationSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Medios de pago y ticket
// ---------------------------------------------------------------------------

const PAYMENT_CARD = "elevated flex min-w-0 flex-col rounded-xl border bg-card"

/** Filas con la forma de las reales: `flex-wrap` deja los controles debajo en el teléfono. */
export function PaymentMethodRowsSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col">
      {slots(4).map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-3">
          <div className="flex min-w-48 flex-1 flex-col gap-0.5">
            <BaseLine className="w-32" />
            <Line className="w-56 max-w-full" />
          </div>
          <div className="flex items-center gap-1">
            <Skeleton className="size-11 rounded-md" />
            <Skeleton className="size-11 rounded-md" />
            <Skeleton className="mx-2 h-5 w-9 rounded-full" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Sus tres filas, con el rótulo escrito: en el teléfono, el valor debajo. */
export function TicketRowsSkeleton() {
  return (
    <dl aria-hidden className="flex flex-col">
      {["Ancho del ticket", "Tamaño de hoja", "Frase al pie del ticket"].map((label) => (
        <div key={label} className="flex flex-col gap-0.5 border-t px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
          <dt className="text-sm text-muted-foreground sm:w-56 sm:shrink-0">{label}</dt>
          <dd className="min-w-0 flex-1">
            <Line className="w-48 max-w-full" />
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function PaymentMethodsPageSkeleton() {
  const can = useCan()
  return (
    <SettingsPage
      title="Medios de pago y ticket"
      primary={settingsPrimary("paymentMethods", can)}
      subtitle="Con qué se cobra en caja y cómo salen el ticket y el presupuesto."
      message="Cargando los medios de pago…"
      className="flex flex-col gap-4"
    >
      <section className={PAYMENT_CARD}>
        <div className="flex flex-col gap-0.5 px-4 pt-4 pb-3">
          <h2 className="font-heading text-base font-medium">Medios de pago</h2>
          <Line className="w-3/4" />
        </div>
        <PaymentMethodRowsSkeleton />
      </section>
      <section className={PAYMENT_CARD}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-3">
          <div className="flex min-w-48 flex-1 flex-col gap-0.5">
            <h2 className="font-heading text-base font-medium">Ticket e impresión</h2>
            <p className="text-sm text-muted-foreground">El ticket y la hoja de cierre salen en térmica; el presupuesto, en hoja.</p>
          </div>
        </div>
        <TicketRowsSkeleton />
      </section>
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Plan y pagos
// ---------------------------------------------------------------------------

/** Lo que hicieron los agentes: la tarjeta del consumo, con sus filas. */
export function PlanConsumptionSkeleton() {
  return (
    <section aria-hidden className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <BaseLine className="w-64 max-w-full" />
        <Line className="w-4/5" />
        <Line className="w-3/5" />
      </div>
      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border">
        {slots(5).map((row) => (
          <li key={row} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2">
            <Line className="w-48 max-w-full" />
            <Line className="w-16" />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Los planes: el de lista va completo, con sus tres columnas desde `sm`. */
export function PlanOffersSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <section className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <BaseLine className="w-32" />
            <Line className="w-48 max-w-full" />
          </div>
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {slots(3).map((column) => (
            <div key={column} className="flex flex-col gap-1.5 rounded-lg border p-3">
              <Line className="w-20" />
              <Line className="w-full" />
              <Line className="w-full" />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

/** Los cargos, con la misma fila de la lista real. */
export function PlanChargesSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col gap-3">
      {slots(2).map((row) => (
        <li key={row} className="rounded-lg border">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0">
              <Line className="w-40" />
              <Skeleton className="h-3 w-28" />
            </div>
            <BaseLine className="w-20" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** El formulario del comprobante: tres campos, dos de ellos lado a lado. */
export function PlanReceiptSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Line className="w-16" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {slots(2).map((field) => (
          <div key={field} className="flex flex-col gap-1">
            <Line className="w-16" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <Line className="w-20" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  )
}

/** El historial de pagos: la misma lista de filas. */
export function PlanPaymentsSkeleton() {
  return (
    <ul aria-hidden className="flex flex-col gap-2">
      {slots(2).map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-4">
          <div className="min-w-0 flex-1 basis-56">
            <Line className="w-40" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Line className="w-20" />
        </li>
      ))}
    </ul>
  )
}

/** Todo lo que sigue al encabezado mientras llega la suscripción. */
export function PlanSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <section aria-hidden className="rounded-lg border p-4">
        <BaseLine className="w-40" />
        <Line className="mt-1 w-4/5" />
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {slots(4).map((cell) => (
            <div key={cell}>
              <Skeleton className="my-0.5 h-3 w-16" />
              <Line className="w-20" />
            </div>
          ))}
        </div>
      </section>
      <PlanConsumptionSkeleton />
      {[
        { title: "Planes", body: <PlanOffersSkeleton /> },
        { title: "Tus cargos", body: <PlanChargesSkeleton /> },
        { title: "Registrar comprobante", body: <PlanReceiptSkeleton /> },
        { title: "Historial de pagos", body: <PlanPaymentsSkeleton /> },
      ].map((block) => (
        <section key={block.title} className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">{block.title}</h2>
          {block.body}
        </section>
      ))}
    </div>
  )
}

export function PlanPageSkeleton() {
  return (
    <SettingsPage title="Plan y pagos" subtitle={<Line className="w-48" />} message="Cargando tu plan…">
      <PlanSkeleton />
    </SettingsPage>
  )
}

/** Las filas de «Cada acción»: esa tabla es tabla en todos los anchos, y desliza en la suya. */
export function PlanActionsSkeleton() {
  return <DataTableSkeleton view="table" columnCount={6} rowCount={8} label="Cargando las acciones…" />
}

export function PlanActionsPageSkeleton() {
  return (
    <SettingsPage
      title="Cada acción de tus agentes"
      subtitle={<Line className="w-72 max-w-full" />}
      primary={{ label: "Volver a Plan y pagos", icon: <ArrowLeft aria-hidden />, render: <Link to={PLAN_PATH} /> }}
      message="Cargando las acciones…"
      className="flex flex-col gap-4"
    >
      <div aria-hidden className="flex flex-wrap items-center justify-between gap-2">
        <Skeleton className="h-9 w-[34rem] max-w-full rounded-lg" />
        <Skeleton className="h-9 w-56 max-w-full rounded-lg" />
      </div>
      <PlanActionsSkeleton />
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// El contenido del layout mientras llega su código
// ---------------------------------------------------------------------------

const PAGE_BY_PATH: Record<string, () => ReactNode> = {
  "/settings": ClinicProfilePageSkeleton,
  "/settings/branches": BranchesPageSkeleton,
  "/settings/team": TeamPageSkeleton,
  "/settings/availability": AvailabilityPageSkeleton,
  "/settings/data-protection": DataProtectionPageSkeleton,
  "/settings/specialties": SpecialtiesPageSkeleton,
  "/settings/forms": FormTemplatesPageSkeleton,
  "/settings/patient-registration": PatientRegistrationPageSkeleton,
  "/settings/patient-access": PatientPortalPageSkeleton,
  "/settings/payment-methods": PaymentMethodsPageSkeleton,
  "/settings/pipelines": PipelinesPageSkeleton,
  "/settings/integrations": IntegrationsPageSkeleton,
  "/settings/integrations/whatsapp": WhatsAppPageSkeleton,
  "/settings/integrations/webchat": WebchatPageSkeleton,
  "/settings/audit": TeamActivityPageSkeleton,
  "/settings/plan": PlanPageSkeleton,
  "/settings/plan/acciones": PlanActionsPageSkeleton,
}

/**
 * Lo que va al lado de la lista de apartados cuando se entra a Configuración
 * desde fuera: la pantalla que se abre, según la dirección. Sin una conocida,
 * la primera.
 */
export function SettingsContentSkeleton({ pathname }: { pathname: string }) {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  const Page = PAGE_BY_PATH[clean] ?? ClinicProfilePageSkeleton
  return <Page />
}
