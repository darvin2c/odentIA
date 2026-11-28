import {
  Badge,
  Button,
  cn,
  FieldGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  AgentMark,
  ConfirmDialog,
  DetailField,
  DetailList,
  EmptyState,
  ErrorState,
  FormDrawer,
  FormFieldGroup,
  LoadingState,
  PageNotice,
  RadioChips,
  submitErrorMessage,
  TimeSelect,
  useAppForm,
  useFieldContext,
  useFormSurface,
  useIconSidebarWhileMounted,
  useSideDock,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Check, Lightbulb, MessageCircle, Minus, Pause, Play, Plus, Trash2 } from "lucide-react"
import { createContext, type ReactNode, useContext, useEffect, useId, useState } from "react"
import { z } from "zod"
import { MoneyInput, ToggleField } from "./campos"
import { ClientTestPiece } from "./ficha/probar"
import { api } from "./lib/api"
import { anchorOf } from "./lib/ficha"
import { AGENT_STOP_WORDS } from "./lib/plan"
import { type AgentSettings, DAYS, type KnowledgeView, type SofiOverview, TONES } from "./lib/sofi"
import type { CatalogItem } from "./lib/tienda"
import { money, moneyInput, readMoney } from "./lib/tienda"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Sofi» (tablero 8 de «gestorIA · Configuración, de nuevo»; ADR 0234). La tienda elige, no
 * escribe instrucciones: cómo habla (con un ejemplo de cada tono), qué puede ofrecer para cerrar,
 * cuándo le pasa el chat y el horario de su equipo. «Lo que sabe» son preguntas y respuestas;
 * «Lo que aprendió» propone lo que Sofi no supo responder en conversaciones de verdad, y nada se
 * agrega solo. Al lado, «Probar a Sofi», con el «Por qué» de cada respuesta: solo lo que de
 * verdad le llegó (lo anota el servidor en cada respuesta).
 *
 * Cada parte se ve resumida y se cambia con «Cambiar», en el formulario común de la columna
 * lateral. El mínimo y la oferta única no se eligen: los pone el servidor.
 */

const SOFI_KEY = (storeId: string) => ["sofi", storeId]
const KNOWS_KEY = (storeId: string) => ["sofi-sabe", storeId]
const CONFIG_KEY = (storeId: string) => ["configuracion", storeId]

type Part = "habla" | "ofrece" | "persona" | "sabe" | "aprendio"

/**
 * Si hay un formulario de esta página abierto. En una ventana ancha va en la columna lateral, y
 * entonces el resumen de al lado repite lo mismo: se deja a la vista la prueba, para elegir y
 * probar a la vez (tablero 8: la prueba siempre a la vista).
 */
const EditingContext = createContext<(editing: boolean) => void>(() => {})

function useMarkEditing() {
  const mark = useContext(EditingContext)
  useEffect(() => {
    mark(true)
    return () => mark(false)
  }, [mark])
}

export function SofiPage() {
  const { store } = useStoreContext()
  const overview = useQuery({
    queryKey: SOFI_KEY(store.id),
    queryFn: () => api<SofiOverview>(`/api/tiendas/${store.id}/sofi`),
  })
  const knows = useQuery({
    queryKey: KNOWS_KEY(store.id),
    queryFn: () => api<KnowledgeView>(`/api/tiendas/${store.id}/sofi/sabe`),
  })
  const [part, setPart] = useState<Part>("habla")
  const toAnswer = knows.data?.gaps.length ?? 0
  // El menú de la app en íconos mientras se ajusta a Sofi: la prueba cabe al lado en la laptop.
  useIconSidebarWhileMounted()
  const [editing, setEditing] = useState(false)
  const dock = useSideDock()
  // El formulario está en la columna lateral: el resumen se esconde (no se desmonta) y la prueba
  // queda donde estaba, arriba y al lado del formulario.
  const testOnly = editing && dock.occupied
  return (
    <EditingContext.Provider value={setEditing}>
      <StoreHeader
        title="Sofi"
        subtitle="Tu vendedora: tú eliges cómo habla, qué ofrece y cuándo te pasa el chat."
      />
      {overview.isPending ? <LoadingState message="Cargando a Sofi" /> : null}
      {overview.isError ? (
        <ErrorState
          error={overview.error instanceof Error ? overview.error : "No se pudo cargar"}
          onRetry={() => void overview.refetch()}
        />
      ) : null}
      {overview.data ? (
        <div className="@container flex flex-col gap-4">
          {overview.data.agentStop ? (
            <PageNotice
              tone="limite"
              label="En pausa"
              action={
                store.permissions.includes("plan") ? (
                  <Link
                    to="/tiendas/$id/configuracion/plan"
                    params={{ id: store.id }}
                    className="underline"
                  >
                    Ver tu plan
                  </Link>
                ) : undefined
              }
            >
              {AGENT_STOP_WORDS[overview.data.agentStop]} La prueba de aquí sigue funcionando.
            </PageNotice>
          ) : null}
          <StatusCard overview={overview.data} />
          {/* En el teléfono la prueba queda debajo: «Probar a Sofi» lleva a ella de un toque. Con
              un formulario al lado, la prueba ya está arriba y el botón sobra. */}
          {testOnly ? null : (
            <Button variant="outline" className="w-full @3xl:hidden" onClick={goToTest}>
              <MessageCircle aria-hidden />
              Probar a Sofi
            </Button>
          )}
          <ViewTabs
            label="Qué ajustar de Sofi"
            value={part}
            onValueChange={setPart}
            options={[
              { value: "habla", label: "Cómo habla" },
              { value: "ofrece", label: "Qué ofrece" },
              { value: "persona", label: "Cuándo te pasa el chat" },
              { value: "sabe", label: "Lo que sabe" },
              {
                value: "aprendio",
                label: "Lo que aprendió",
                ...(toAnswer > 0 ? { count: toAnswer } : {}),
              },
            ]}
          />
          {/* En el teléfono las pestañas se deslizan y «Lo que aprendió» queda al final, fuera de
              la vista: lo que tiene por responder se dice aquí, a la vista, con su botón. */}
          {toAnswer > 0 && part !== "aprendio" ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 w-full justify-between whitespace-normal text-left @3xl:hidden"
              onClick={() => setPart("aprendio")}
            >
              <span>
                {toAnswer === 1
                  ? "1 pregunta que Sofi no supo responder"
                  : `${toAnswer} preguntas que Sofi no supo responder`}
              </span>
              <span className="shrink-0 font-semibold">Responder</span>
            </Button>
          ) : null}
          <div
            className={cn(
              "grid items-start gap-4",
              !testOnly && "@3xl:grid-cols-[minmax(0,1fr)_minmax(19rem,23rem)]",
            )}
          >
            <section
              aria-label="Cómo trabaja Sofi"
              className={cn("flex min-w-0 flex-col gap-4", testOnly && "hidden")}
            >
              {part === "habla" ? <HowSheTalks overview={overview.data} /> : null}
              {part === "ofrece" ? <WhatSheOffers overview={overview.data} /> : null}
              {part === "persona" ? <WhenToPerson overview={overview.data} /> : null}
              {part === "sabe" || part === "aprendio" ? (
                knows.isError ? (
                  <ErrorState
                    error={knows.error instanceof Error ? knows.error : "No se pudo cargar"}
                    onRetry={() => void knows.refetch()}
                  />
                ) : !knows.data ? (
                  <LoadingState message="Cargando lo que sabe" />
                ) : part === "sabe" ? (
                  <WhatSheKnows view={knows.data} />
                ) : (
                  <WhatSheLearned view={knows.data} />
                )
              ) : null}
            </section>
            <TestAsClient />
          </div>
        </div>
      ) : null}
    </EditingContext.Provider>
  )
}

/** Lleva a la prueba y deja el cursor donde se escribe. */
function goToTest() {
  const test = document.getElementById("probar-a-sofi")
  if (!test) return
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  test.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })
  test
    .querySelector<HTMLInputElement>('input[aria-label^="Mensaje de la clienta"]')
    ?.focus({ preventScroll: true })
}

/* ------------------------------------------------------------------ guardar */

/**
 * Guarda lo que cambió este formulario, nada más, con la versión que se vio al abrirlo: si otra
 * persona (u otra pestaña) cambió a Sofi después, el servidor lo rechaza y el formulario lo dice,
 * en vez de pisar lo suyo. Lo de antes se fija al abrir: aunque la página se ponga al día, este
 * formulario sigue comparando con lo que la persona vio. Encender o pausar va aparte.
 */
function useSaveSettings(overview: SofiOverview) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [seen] = useState(() => ({ settings: overview.settings, version: overview.version }))
  return useMutation({
    mutationFn: async (change: Partial<Omit<AgentSettings, "enabled">>) => {
      const changed = Object.fromEntries(
        Object.entries(change).filter(
          ([key, value]) => !sameValue(value, seen.settings[key as keyof AgentSettings]),
        ),
      )
      if (Object.keys(changed).length === 0) return null
      return api(`/api/tiendas/${store.id}/sofi`, {
        method: "PATCH",
        body: { ...changed, version: seen.version },
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SOFI_KEY(store.id) })
      await queryClient.invalidateQueries({ queryKey: CONFIG_KEY(store.id) })
    },
    // Lo nuevo de la otra persona queda a la vista al cerrar el formulario.
    onError: () => void queryClient.invalidateQueries({ queryKey: SOFI_KEY(store.id) }),
  })
}

/**
 * Lo mismo, con «Se presenta como» vacío igual a sin nombre y el horario por su contenido (la base
 * devuelve sus llaves en otro orden).
 */
function sameValue(next: unknown, before: unknown): boolean {
  const plain = (value: unknown): unknown => {
    if (typeof value === "string") return value.trim() || null
    if (Array.isArray(value)) return value.map(plain)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, plain(inner)]),
      )
    return value ?? null
  }
  return JSON.stringify(plain(next)) === JSON.stringify(plain(before))
}

/** Encender o pausar: su propia operación, que no toca lo elegido. */
function useSetEnabled() {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/api/tiendas/${store.id}/sofi/estado`, { method: "PATCH", body: { enabled } }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: SOFI_KEY(store.id) })
      await queryClient.invalidateQueries({ queryKey: CONFIG_KEY(store.id) })
    },
  })
}

/** Una tarjeta de la página con su título y «Cambiar». */
function Panel({
  title,
  description,
  onChange,
  changeLabel = "Cambiar",
  children,
}: {
  title: string
  description?: ReactNode
  onChange?: () => void
  changeLabel?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {onChange ? (
          <Button variant="outline" size="sm" onClick={onChange} className="shrink-0">
            {changeLabel}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** Una línea con su marca: ✓ lo que hace, — lo que no. */
function Line({ on, title, detail }: { on: boolean; title: string; detail?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
          on ? "bg-primary text-primary-foreground" : "bg-surface-muted text-muted-foreground",
        )}
      >
        {on ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={cn("text-sm font-medium", !on && "text-muted-foreground")}>
          {title}
          <span className="sr-only">{on ? ": sí" : ": no"}</span>
        </span>
        {detail ? <span className="text-sm text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  )
}

/* ------------------------------------------------------------------ estado */

function StatusCard({ overview }: { overview: SofiOverview }) {
  const { store } = useStoreContext()
  const { settings } = overview
  const toggle = useSetEnabled()
  const name = settings.displayName ?? `Sofi, de ${store.name}`
  return (
    <section
      aria-label="Si Sofi atiende"
      className="elevated flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4"
    >
      <AgentMark size="md" />
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        <p className="flex flex-wrap items-center gap-2 font-semibold">
          {name}
          <Badge variant={settings.enabled ? "success" : "outline"}>
            {settings.enabled ? "Encendida" : "Apagada"}
          </Badge>
        </p>
        <p className="text-sm text-muted-foreground">
          {settings.enabled
            ? "Atenderá tus chats cuando conectes WhatsApp o Instagram. Mientras, pruébala aquí."
            : "Tus chats esperan a una persona. La prueba de aquí funciona igual."}
        </p>
      </div>
      <Button
        variant="outline"
        disabled={toggle.isPending}
        onClick={() =>
          toggle.mutate(!settings.enabled, {
            onSuccess: () => toast.success(settings.enabled ? "Sofi en pausa" : "Sofi encendida"),
            onError: (error) => toast.error(submitErrorMessage(error)),
          })
        }
      >
        {settings.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
        {settings.enabled ? "Pausar" : "Encender"}
      </Button>
    </section>
  )
}

/* --------------------------------------------------------------- cómo habla */

function HowSheTalks({ overview }: { overview: SofiOverview }) {
  const { store } = useStoreContext()
  const { settings } = overview
  const [editing, setEditing] = useState(false)
  const tone = TONES.find((t) => t.value === settings.tone)!
  return (
    <Panel
      title="Cómo habla"
      description="Elige su tono viendo cómo respondería. Nunca le escribes instrucciones."
      onChange={() => setEditing(true)}
    >
      <div className="flex flex-col gap-2 rounded-lg border bg-surface-muted p-3">
        <p className="text-xs font-medium text-muted-foreground">Su tono: {tone.label}</p>
        <p className="w-fit max-w-full rounded-2xl border bg-card px-3 py-2 text-sm">
          {tone.example}
        </p>
      </div>
      <DetailList className="@lg:grid-cols-3">
        <DetailField label="Trata a la clienta de">
          {settings.address === "tu" ? "Tú" : "Usted"}
        </DetailField>
        <DetailField label="Emojis">
          {settings.emojis === "ninguno" ? "Ninguno" : "Pocos"}
        </DetailField>
        <DetailField label="Se presenta como">
          {settings.displayName ?? `Sofi, de ${store.name}`}
        </DetailField>
      </DetailList>
      {editing ? <TalkForm overview={overview} onClose={() => setEditing(false)} /> : null}
    </Panel>
  )
}

const talkSchema = z.object({
  tone: z.enum(["cercana", "formal", "directa"]),
  address: z.enum(["tu", "usted"]),
  emojis: z.enum(["ninguno", "pocos"]),
  displayName: z.string().trim().max(60, "Máximo 60 caracteres"),
})

function TalkForm({ overview, onClose }: { overview: SofiOverview; onClose: () => void }) {
  const { settings } = overview
  const { store } = useStoreContext()
  const save = useSaveSettings(overview)
  useMarkEditing()
  const form = useAppForm({
    defaultValues: {
      tone: settings.tone,
      address: settings.address,
      emojis: settings.emojis,
      displayName: settings.displayName ?? "",
    },
    validators: { onSubmit: talkSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      toast.success("Guardado: pruébala al lado")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Cambiar cómo habla"
      description="Lo que elijas lo usa en todas sus respuestas, desde la siguiente."
      submitLabel="Guardar"
      onClose={onClose}
    >
      <FieldGroup className="gap-5">
        <form.AppField name="tone">{() => <ToneField />}</form.AppField>
        <form.AppField name="address">
          {(field) => (
            <FormFieldGroup legend="Trata a la clienta de">
              {(control) => (
                <RadioChips
                  aria-label="Trata a la clienta de"
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={(next) => field.handleChange(next as "tu" | "usted")}
                  options={[
                    { value: "tu", label: "Tú" },
                    { value: "usted", label: "Usted" },
                  ]}
                />
              )}
            </FormFieldGroup>
          )}
        </form.AppField>
        <form.AppField name="emojis">
          {(field) => (
            <FormFieldGroup legend="Emojis">
              {(control) => (
                <RadioChips
                  aria-label="Emojis"
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  onChange={(next) => field.handleChange(next as "ninguno" | "pocos")}
                  options={[
                    { value: "ninguno", label: "Ninguno" },
                    { value: "pocos", label: "Pocos" },
                  ]}
                />
              )}
            </FormFieldGroup>
          )}
        </form.AppField>
        <form.AppField name="displayName">
          {(field) => (
            <field.TextField
              label="Se presenta como"
              placeholder={`Sofi, de ${store.name}`}
              maxLength={60}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/** El tono: tres tarjetas, cada una con cómo respondería. Un grupo de radios accesible. */
function ToneField() {
  const field = useFieldContext<AgentSettings["tone"]>()
  return (
    <FormFieldGroup legend="Su tono">
      {(control) => (
        <div aria-describedby={control.describedBy} className="flex flex-col gap-2">
          {TONES.map((tone) => {
            const chosen = field.state.value === tone.value
            return (
              <label
                key={tone.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/30",
                  chosen ? "border-primary bg-primary/5" : "hover:bg-surface-muted",
                )}
              >
                <input
                  type="radio"
                  name="tone"
                  value={tone.value}
                  checked={chosen}
                  onChange={() => field.handleChange(tone.value)}
                  onBlur={control.onBlur}
                  className="mt-1 size-4 accent-[var(--primary)]"
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{tone.label}</span>
                  <span className="text-sm text-muted-foreground">{tone.example}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}
    </FormFieldGroup>
  )
}

/* --------------------------------------------------------------- qué ofrece */

function WhatSheOffers({ overview }: { overview: SofiOverview }) {
  const { settings } = overview
  const [editing, setEditing] = useState<"ofertas" | "seguimientos" | null>(null)
  return (
    <>
      <Panel
        title="Qué puede ofrecer para cerrar una venta"
        description="Solo cuando ve que puede perder la venta, y solo lo que marques."
        onChange={() => setEditing("ofertas")}
      >
        <ul className="divide-y">
          <Line
            on={settings.offerShipping}
            title="Envío gratis o más barato"
            detail="Cuando ve que la clienta lo duda."
          />
          <Line
            on={settings.offerDiscount}
            title="Un descuento"
            detail="Hasta lo que queda sobre tu precio mínimo."
          />
          <Line
            on={settings.offerGift}
            title="Un regalo"
            detail="Algo que combina con su compra."
          />
          <Line
            on={settings.offerDiscount || settings.offerSecond}
            title="Una rebaja si lleva dos o más"
            detail={
              settings.offerDiscount
                ? "Va incluida en «Un descuento»."
                : "Para quien duda entre dos."
            }
          />
        </ul>
        <div className="flex gap-3 rounded-lg bg-surface-muted p-3 text-sm">
          <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p>
            <span className="font-medium">Siempre igual, no se cambia: </span>
            primero dice el precio completo, y ofrece solo si la clienta duda después de oírlo. Una
            sola vez, con como mucho la mitad de lo que hay sobre tu mínimo, a cambio de pagar
            dentro de 24 horas, con la hora exacta. Nunca baja del mínimo de cada producto (lo pones
            en Catálogo). Con pago al recibir, no hay oferta.
          </p>
        </div>
      </Panel>
      <Panel
        title="Después de la venta"
        description="Los mensajes que Argos le encarga a Sofi, una vez cada uno."
        onChange={() => setEditing("seguimientos")}
      >
        <ul className="divide-y">
          <Line on={settings.followPayment} title="Recordar el pago a quien no pagó" />
          <Line
            on={settings.followThanks}
            title="Agradecer y preguntar si llegó bien, al día siguiente"
          />
          <Line
            on={settings.followRestock}
            title="Avisar que volvió lo que alguien pidió agotado"
          />
          <Line on={settings.followReturn} title="Invitar a volver a quien compró hace dos meses" />
        </ul>
      </Panel>
      {editing === "ofertas" ? (
        <OffersForm overview={overview} onClose={() => setEditing(null)} />
      ) : null}
      {editing === "seguimientos" ? (
        <FollowForm overview={overview} onClose={() => setEditing(null)} />
      ) : null}
    </>
  )
}

function OffersForm({ overview, onClose }: { overview: SofiOverview; onClose: () => void }) {
  const { settings } = overview
  const save = useSaveSettings(overview)
  useMarkEditing()
  const form = useAppForm({
    defaultValues: {
      offerShipping: settings.offerShipping,
      offerDiscount: settings.offerDiscount,
      offerGift: settings.offerGift,
      offerSecond: settings.offerSecond,
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      toast.success("Guardado: pruébala al lado")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const discount = useStore(form.store, (s) => s.values.offerDiscount)
  return (
    <FormDrawer
      {...surface}
      open
      title="Qué puede ofrecer"
      description="Todo sale del mismo margen sobre tu precio mínimo: nunca baja de él."
      submitLabel="Guardar"
      onClose={onClose}
    >
      <FieldGroup className="gap-4">
        <form.AppField name="offerShipping">
          {() => (
            <ToggleField
              label="Envío gratis o más barato"
              description="Hasta lo que dejaste rebajar en cada forma de entrega."
            />
          )}
        </form.AppField>
        <form.AppField name="offerDiscount">
          {() => <ToggleField label="Un descuento" description="Sobre el precio del producto." />}
        </form.AppField>
        <form.AppField name="offerGift">
          {() => <ToggleField label="Un regalo" description="Algo que combina, a su mínimo." />}
        </form.AppField>
        {discount ? null : (
          <form.AppField name="offerSecond">
            {() => (
              <ToggleField
                label="Una rebaja solo si lleva dos o más"
                description="Para quien duda entre dos."
              />
            )}
          </form.AppField>
        )}
      </FieldGroup>
    </FormDrawer>
  )
}

function FollowForm({ overview, onClose }: { overview: SofiOverview; onClose: () => void }) {
  const { settings } = overview
  const save = useSaveSettings(overview)
  useMarkEditing()
  const form = useAppForm({
    defaultValues: {
      followPayment: settings.followPayment,
      followThanks: settings.followThanks,
      followRestock: settings.followRestock,
      followReturn: settings.followReturn,
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      toast.success("Guardado")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Después de la venta"
      description="Cada mensaje sale una vez, con un texto fijo."
      submitLabel="Guardar"
      onClose={onClose}
    >
      <FieldGroup className="gap-4">
        <form.AppField name="followPayment">
          {() => <ToggleField label="Recordar el pago a quien no pagó" />}
        </form.AppField>
        <form.AppField name="followThanks">
          {() => <ToggleField label="Agradecer y preguntar si llegó bien, al día siguiente" />}
        </form.AppField>
        <form.AppField name="followRestock">
          {() => <ToggleField label="Avisar que volvió lo que alguien pidió agotado" />}
        </form.AppField>
        <form.AppField name="followReturn">
          {() => <ToggleField label="Invitar a volver a quien compró hace dos meses" />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/* ------------------------------------------------------ cuándo te pasa el chat */

function WhenToPerson({ overview }: { overview: SofiOverview }) {
  const { store } = useStoreContext()
  const { settings, words } = overview
  const [editing, setEditing] = useState(false)
  return (
    <>
      <Panel
        title="Sofi te pasa el chat cuando…"
        description="Te llega el aviso al celular y el chat espera a una persona."
        onChange={() => setEditing(true)}
      >
        <ul className="divide-y">
          <Line on title="La clienta pide hablar con una persona" detail="Siempre." />
          <Line on title="Es un reclamo, un cambio o una devolución" detail="Siempre." />
          <Line
            on
            title="Sofi no sabe la respuesta"
            detail="Siempre. Nunca inventa: avisa y te lo pasa. Lo verás en «Lo que aprendió»."
          />
          <Line on={settings.handoffUpset} title="La clienta está molesta" />
          <Line
            on={settings.handoffOverCents !== null}
            title={
              settings.handoffOverCents !== null
                ? `El pedido pasa de ${money(settings.handoffOverCents, store.currency)}`
                : "El pedido pasa de un monto"
            }
            detail="Para atender tú las compras grandes."
          />
        </ul>
      </Panel>
      <Panel title="Horario de tu equipo" onChange={() => setEditing(true)}>
        <DetailList>
          <DetailField label="Atienden">
            {words ? capitalize(words.hours) : "Sin horario: Sofi no dice cuándo responden"}
          </DetailField>
          <DetailField label="Fuera de ese horario">
            {settings.afterHoursSells
              ? "Sofi sigue vendiendo: cobra con link y arma pedidos"
              : "Sofi solo avisa cuándo le responden y te pasa el chat"}
          </DetailField>
        </DetailList>
        {words ? (
          <p className="rounded-lg bg-surface-muted p-3 text-sm">
            <span className="text-muted-foreground">Lo que es para una persona, avisa así: </span>«
            {words.afterHours}»
          </p>
        ) : null}
      </Panel>
      {editing ? <HandoffForm overview={overview} onClose={() => setEditing(false)} /> : null}
    </>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function HandoffForm({ overview, onClose }: { overview: SofiOverview; onClose: () => void }) {
  const { settings } = overview
  const { store } = useStoreContext()
  const save = useSaveSettings(overview)
  const hours = settings.teamHours
  useMarkEditing()
  const form = useAppForm({
    defaultValues: {
      handoffUpset: settings.handoffUpset,
      overOn: settings.handoffOverCents !== null,
      over: moneyInput(settings.handoffOverCents, store.currency),
      hoursOn: hours !== null,
      days: hours?.days ?? [1, 2, 3, 4, 5, 6],
      from: hours?.from ?? "09:00",
      to: hours?.to ?? "19:00",
      afterHours: settings.afterHoursSells ? "vende" : "espera",
    },
    validators: {
      onSubmit: z
        .object({
          handoffUpset: z.boolean(),
          overOn: z.boolean(),
          over: z.string(),
          hoursOn: z.boolean(),
          days: z.array(z.number()),
          from: z.string(),
          to: z.string(),
          afterHours: z.string(),
        })
        .superRefine((value, ctx) => {
          if (value.overOn && !readMoney(value.over, store.currency))
            ctx.addIssue({ code: "custom", path: ["over"], message: "Escribe el monto" })
          if (value.hoursOn && value.days.length === 0)
            ctx.addIssue({ code: "custom", path: ["days"], message: "Elige al menos un día" })
          if (value.hoursOn && value.from >= value.to)
            ctx.addIssue({
              code: "custom",
              path: ["to"],
              message: "La hora de cierre va después de la de apertura",
            })
        }),
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        handoffUpset: value.handoffUpset,
        handoffOverCents: value.overOn ? readMoney(value.over, store.currency) : null,
        teamHours: value.hoursOn ? { days: value.days, from: value.from, to: value.to } : null,
        afterHoursSells: value.afterHours === "vende",
      })
      toast.success("Guardado")
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) =>
      key === "handoffOverCents"
        ? "over"
        : key.startsWith("teamHours.days")
          ? "days"
          : key === "teamHours.to"
            ? "to"
            : key === "teamHours.from"
              ? "from"
              : undefined,
  })
  const overOn = useStore(form.store, (s) => s.values.overOn)
  const hoursOn = useStore(form.store, (s) => s.values.hoursOn)
  return (
    <FormDrawer
      {...surface}
      open
      title="Cuándo te pasa el chat"
      description="Pedir una persona, un reclamo, un cambio o algo que no sabe: siempre te lo pasa."
      submitLabel="Guardar"
      onClose={onClose}
    >
      <FieldGroup className="gap-5">
        <form.AppField name="handoffUpset">
          {() => <ToggleField label="Si la clienta está molesta" />}
        </form.AppField>
        <form.AppField name="overOn">
          {() => (
            <ToggleField
              label="Si el pedido pasa de un monto"
              description="Para atender tú las compras grandes."
            />
          )}
        </form.AppField>
        {overOn ? (
          <form.AppField name="over">
            {(field) => (
              <field.Control label="El pedido pasa de" className="max-w-48">
                {(control) => (
                  <MoneyInput
                    control={control}
                    currency={store.currency}
                    value={field.state.value}
                    onChange={field.handleChange}
                    inputMode="decimal"
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="hoursOn">
          {() => (
            <ToggleField
              label="Tu equipo tiene horario"
              description="Fuera de él, Sofi dice cuándo le responden."
            />
          )}
        </form.AppField>
        {hoursOn ? (
          <>
            <form.AppField name="days">{() => <DaysField />}</form.AppField>
            <div className="grid grid-cols-2 gap-3">
              <form.AppField name="from">
                {(field) => (
                  <field.Control label="Desde">
                    {(control) => (
                      <TimeSelect
                        id={control.id}
                        aria-describedby={control.describedBy}
                        invalid={control.invalid}
                        value={field.state.value}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
              <form.AppField name="to">
                {(field) => (
                  <field.Control label="Hasta">
                    {(control) => (
                      <TimeSelect
                        id={control.id}
                        aria-describedby={control.describedBy}
                        invalid={control.invalid}
                        value={field.state.value}
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </div>
            <form.AppField name="afterHours">
              {(field) => (
                <FormFieldGroup legend="Fuera de ese horario">
                  {(control) => (
                    <RadioChips
                      aria-label="Fuera de ese horario"
                      aria-describedby={control.describedBy}
                      invalid={control.invalid}
                      onBlur={control.onBlur}
                      value={field.state.value}
                      onChange={(next) => field.handleChange(next)}
                      options={[
                        { value: "vende", label: "Sofi sigue vendiendo" },
                        { value: "espera", label: "Espera a una persona" },
                      ]}
                    />
                  )}
                </FormFieldGroup>
              )}
            </form.AppField>
          </>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/** Los días del equipo, con el grupo de botones común: una parada de Tab y flechas. */
function DaysField() {
  const field = useFieldContext<number[]>()
  return (
    <FormFieldGroup legend="Días">
      {(control) => (
        <ToggleGroup
          aria-label="Días"
          aria-describedby={control.describedBy}
          multiple
          spacing={1}
          className="flex-wrap"
          value={field.state.value.map(String)}
          onValueChange={(next: unknown[]) =>
            field.handleChange(
              next
                .map(Number)
                .filter((d) => d >= 1 && d <= 7)
                .sort((a, b) => a - b),
            )
          }
        >
          {DAYS.map((day) => (
            <ToggleGroupItem
              key={day.value}
              value={String(day.value)}
              aria-label={day.label}
              variant="outline"
              className="min-h-11 min-w-12 rounded-full aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground sm:min-h-9"
            >
              {day.short}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </FormFieldGroup>
  )
}

/* --------------------------------------------------------------- lo que sabe */

type AnswerTarget = { id: string; question: string; answer: string } | "nueva"

function WhatSheKnows({ view }: { view: KnowledgeView }) {
  const { store } = useStoreContext()
  const [editing, setEditing] = useState<AnswerTarget | null>(null)
  return (
    <>
      <Panel
        title="De tu tienda"
        description="Lo que una clienta pregunta y tú respondes una vez. Sofi lo cuenta así; lo que no está aquí no lo inventa."
        onChange={() => setEditing("nueva")}
        changeLabel="Agregar"
      >
        {view.answers.length === 0 ? (
          <EmptyState
            title="Todavía no le enseñaste nada"
            description="Por ejemplo: «¿Hacen cambios?» o «¿Dónde están?». Lo que Sofi no sepa lo verás en «Lo que aprendió»."
            actionLabel="Agregar una pregunta"
            onAction={() => setEditing("nueva")}
          />
        ) : (
          <ul className="divide-y">
            {view.answers.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-sm font-medium break-words">{a.question}</p>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground break-words">
                    {a.answer}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  aria-label={`Editar «${a.question}»`}
                  onClick={() => setEditing(a)}
                >
                  Editar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title="De tus productos"
        description="Sofi lee la ficha de cada producto en Catálogo: precio, opciones, stock y descripción."
      >
        {view.productsWithoutDescription.length === 0 ? (
          <p className="flex items-center gap-2 text-sm">
            <Check aria-hidden className="size-4 text-primary" />
            Todos tus productos tienen descripción.
          </p>
        ) : (
          <ul className="divide-y">
            {view.productsWithoutDescription.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="text-sm text-muted-foreground">
                    Le falta la descripción: el material, la horma, cómo se cuida.
                  </span>
                </div>
                <Link
                  to="/tiendas/$id/catalogo"
                  params={{ id: store.id }}
                  search={{ producto: p.id }}
                  className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Completar
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {editing ? <AnswerForm target={editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

const answerSchema = z.object({
  question: z.string().trim().min(3, "Escribe la pregunta como la haría una clienta").max(200),
  answer: z.string().trim().min(1, "Escribe la respuesta").max(1000),
})

function AnswerForm({ target, onClose }: { target: AnswerTarget; onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const existing = target === "nueva" ? null : target
  const [asking, setAsking] = useState(false)
  const save = useMutation({
    mutationFn: (body: z.infer<typeof answerSchema>) =>
      existing
        ? api(`/api/tiendas/${store.id}/sofi/sabe/${existing.id}`, { method: "PATCH", body })
        : api(`/api/tiendas/${store.id}/sofi/sabe`, { method: "POST", body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KNOWS_KEY(store.id) }),
  })
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/sofi/sabe/${existing!.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KNOWS_KEY(store.id) })
      toast.success("Pregunta quitada")
      setAsking(false)
      onClose()
    },
  })
  useMarkEditing()
  const form = useAppForm({
    defaultValues: { question: existing?.question ?? "", answer: existing?.answer ?? "" },
    validators: { onSubmit: answerSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      toast.success("Guardado: Sofi ya lo sabe")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <>
      <FormDrawer
        {...surface}
        open
        title={existing ? "Editar lo que sabe" : "Agregar a lo que sabe"}
        description="Una pregunta y su respuesta. Sofi la lee cuando una clienta pregunta eso."
        submitLabel="Guardar"
        onClose={onClose}
        {...(existing
          ? { secondaryAction: { label: "Quitar", onClick: () => setAsking(true) } }
          : {})}
      >
        <FieldGroup className="gap-4">
          <form.AppField name="question">
            {(field) => (
              <field.TextField label="Pregunta" placeholder="¿Hacen cambios?" maxLength={200} />
            )}
          </form.AppField>
          <form.AppField name="answer">
            {(field) => (
              <field.TextareaField
                label="Respuesta"
                rows={4}
                maxLength={1000}
                placeholder="Sí, de talla dentro de 7 días, con la caja y sin usar."
              />
            )}
          </form.AppField>
        </FieldGroup>
      </FormDrawer>
      {existing ? (
        <ConfirmDialog
          open={asking}
          title={`¿Quitar «${existing.question}»?`}
          description="Sofi deja de saberlo. Si una clienta lo pregunta, te pasará el chat."
          confirmLabel="Quitar"
          pending={remove.isPending}
          error={remove.isError ? submitErrorMessage(remove.error) : null}
          onConfirm={() => remove.mutate()}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </>
  )
}

/* ----------------------------------------------------------- lo que aprendió */

type Gap = KnowledgeView["gaps"][number]

function WhatSheLearned({ view }: { view: KnowledgeView }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [answering, setAnswering] = useState<Gap | null>(null)
  const dismiss = useMutation({
    mutationFn: (key: string) =>
      api(`/api/tiendas/${store.id}/sofi/aprendio/quitar`, { method: "POST", body: { key } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KNOWS_KEY(store.id) })
      await queryClient.invalidateQueries({ queryKey: CONFIG_KEY(store.id) })
      toast.success("Quitada de la lista")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  return (
    <Panel
      title="Lo que aprendió"
      description="Lo que clientas preguntaron en tus chats y Sofi no supo responder. Respondes una vez y Sofi ya lo sabe."
    >
      {view.gaps.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="Nada por responder"
          description="Cuando Sofi no sepa algo en un chat, no lo inventa: te pasa el chat y la pregunta aparece aquí."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {view.gaps.map((gap) => (
            <li
              key={gap.key}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-sm font-medium break-words">«{gap.question}»</p>
                <p className="text-sm text-muted-foreground">
                  {gap.conversations === 1
                    ? "1 clienta lo preguntó."
                    : `${gap.conversations} clientas lo preguntaron.`}{" "}
                  Sofi no sabía y te pasó el chat.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => setAnswering(gap)}>
                  Responder
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Quitar «${gap.question}»`}
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(gap.key)}
                >
                  <Trash2 aria-hidden />
                  <span className="max-sm:sr-only">Quitar</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">
        Nada se agrega solo: lo que respondes se guarda en «Lo que sabe», y lo puedes cambiar.
      </p>
      {answering ? <GapForm gap={answering} onClose={() => setAnswering(null)} /> : null}
    </Panel>
  )
}

function GapForm({ gap, onClose }: { gap: Gap; onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (body: z.infer<typeof answerSchema>) =>
      api(`/api/tiendas/${store.id}/sofi/aprendio/responder`, {
        method: "POST",
        body: { ...body, key: gap.key },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KNOWS_KEY(store.id) })
      await queryClient.invalidateQueries({ queryKey: CONFIG_KEY(store.id) })
    },
  })
  useMarkEditing()
  const form = useAppForm({
    defaultValues: { question: gap.question, answer: "" },
    validators: { onSubmit: answerSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync(value)
      toast.success("Guardado en «Lo que sabe»")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Responder"
      description="Se guarda en «Lo que sabe» y Sofi lo usa desde el siguiente chat."
      submitLabel="Guardar"
      onClose={onClose}
    >
      <FieldGroup className="gap-4">
        <form.AppField name="question">
          {(field) => <field.TextField label="Pregunta" maxLength={200} />}
        </form.AppField>
        <form.AppField name="answer">
          {(field) => <field.TextareaField label="Respuesta" rows={4} maxLength={1000} />}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/* ------------------------------------------------------------------- probar a Sofi */

/**
 * «Probar a Sofi»: lo mismo que vive la clienta, siempre con el flujo de verdad (el chat de
 * WhatsApp, la vitrina por link, el mismo carrito, la oferta con plazo y «Pagar ahora» de
 * prueba), con el producto que se elige. Es la pieza de «Probar como clienta» de la ficha
 * (`ClientTestPiece`): nunca un chat suelto de preguntas y respuestas.
 */
function TestAsClient() {
  const { store } = useStoreContext()
  const navigate = useNavigate()
  const catalog = useQuery({
    queryKey: ["catalogo", store.id],
    queryFn: () => api<{ products: CatalogItem[] }>(`/api/tiendas/${store.id}/catalogo`),
  })
  // Solo lo que se vende: lo que ya no se vende no lo ofrece Sofi.
  const products = (catalog.data?.products ?? []).filter((p) => p.state !== "no_se_vende")
  const [picked, setPicked] = useState<string | null>(null)
  const product =
    products.find((p) => p.id === picked) ??
    products.find((p) => p.readiness.sellsAlone && p.stock > 0) ??
    products[0] ??
    null
  const selectId = useId()

  const title = (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h2 id="sofi-prueba" className="text-base font-semibold">
          Probar a Sofi
        </h2>
        <p className="text-xs text-muted-foreground">
          Como clienta, con un producto: el chat, la vitrina y el pago de prueba. No es una venta:
          no se envía, no se cobra ni mueve stock.
        </p>
      </div>
      {products.length > 1 && product ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-xs font-medium text-muted-foreground">
            Producto
          </label>
          <Select
            items={Object.fromEntries(products.map((p) => [p.id, p.name]))}
            value={product.id}
            onValueChange={(next) => next && setPicked(String(next))}
          >
            <SelectTrigger id={selectId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  )

  return (
    <section
      id="probar-a-sofi"
      aria-labelledby="sofi-prueba"
      className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4 @3xl:sticky @3xl:top-4"
    >
      {catalog.isError ? (
        <>
          {title}
          <ErrorState
            error={catalog.error instanceof Error ? catalog.error : "No se pudo cargar"}
            onRetry={() => void catalog.refetch()}
          />
        </>
      ) : catalog.isPending ? (
        <>
          {title}
          <LoadingState message="Cargando tus productos" />
        </>
      ) : !product ? (
        <>
          {title}
          <EmptyState
            title="Agrega un producto para probar"
            description="La prueba es la de la clienta: pregunta por un producto, lo ve en la vitrina y lo paga de prueba."
            actionLabel="Ir al catálogo"
            onAction={() =>
              void navigate({ to: "/tiendas/$id/catalogo", params: { id: store.id } })
            }
          />
        </>
      ) : (
        <ClientTestPiece
          key={product.id}
          storeId={store.id}
          productId={product.id}
          readiness={product.readiness}
          edit={store.permissions.includes("configuracion")}
          extraQuick={["¿Hacen cambios de talla?", "Quiero hablar con una persona"]}
          // A la ficha, en el dato del que salió (`#dato-<clave>`, `#precio`, `#variantes`…).
          onGo={(target) =>
            void navigate({
              to: "/tiendas/$id/catalogo/$productId",
              params: { id: store.id, productId: product.id },
              hash: anchorOf(target),
            })
          }
          title={title}
        />
      )}
    </section>
  )
}
