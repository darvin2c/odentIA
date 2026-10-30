import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn } from "@odentia/ui"
import { SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../../lib/api"
import type { ConnectionItem, OwnAppState } from "../../../lib/crm"
import { PageDraftGuard } from "../../../lib/page-draft-guard"
import {
  accountWords,
  type ConnectResult,
  type ConnectionSetup,
  ownAppHelpText,
  ownAppSignatureProblem,
  ownAppUnfinished,
  WHATSAPP_FIELDS,
} from "../../../lib/whatsapp"
import { openSupportRequest } from "../../help-panel"
import { CopyValue } from "../channel-panel"
import { AccountField } from "./account-field"
import { Note } from "./note"
import { OwnAppGuide } from "./own-app-guide"
import { OwnAppStatus } from "./own-app-status"
import { appWords } from "../../../lib/product-words"

/** El dato que corrige cada rechazo de las claves: el foco va a ese campo. */
const FIELD_OF_ERROR: Record<string, string> = {
  WHATSAPP_APP_SECRET_REJECTED: "appSecret",
  WHATSAPP_TEMPORARY_KEY: "accessToken",
  WHATSAPP_KEY_SCOPES: "accessToken",
}

/** Tiempo esperando el primer mensaje antes de ofrecer qué revisar. */
const FIRST_MESSAGE_HELP_MS = 3 * 60_000

type StepState = "done" | "current" | "pending"

const STATE_WORD: Record<StepState, string> = { done: "hecho", current: "paso actual", pending: "pendiente" }

function StepItem({
  number,
  title,
  state,
  summary,
  children,
}: {
  number: number
  title: string
  state: StepState
  /** Una línea: qué se hace en el paso o, ya hecho, qué se encontró. */
  summary: string
  children?: ReactNode
}) {
  return (
    <li className="flex gap-3 border-t px-4 py-4 sm:px-5" aria-current={state === "current" ? "step" : undefined}>
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold",
          state === "current" && "bg-primary text-primary-foreground",
          state === "done" && "bg-primary-soft text-primary-soft-foreground",
          state === "pending" && "bg-muted text-muted-foreground",
        )}
      >
        {state === "done" ? <Check className="size-4" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 tabIndex={-1} className={cn("text-[15px] font-semibold outline-none", state === "pending" && "text-muted-foreground")}>
            {title}
            <span className="sr-only"> ({STATE_WORD[state]})</span>
          </h3>
          <p className="text-sm text-muted-foreground">
            Paso {number} de 3{state === "done" ? ", hecho" : ""}. {summary}
          </p>
        </div>
        {state === "current" ? <div className="max-w-2xl">{children}</div> : null}
      </div>
    </li>
  )
}

/** Dónde está cada dato en la página de Meta: ayuda a mano, no una regla del sistema. */
function WhereToFind() {
  return (
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger
        render={
          <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
            ¿Dónde encuentro estos datos?
            <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
          </Button>
        }
      />
      <CollapsibleContent>
        <ul className="flex flex-col gap-1.5 rounded-xl bg-muted px-3.5 py-3 text-sm text-muted-foreground">
          <li>
            <strong className="font-semibold text-foreground">Los dos identificadores:</strong> en la app de Meta de la clínica,
            en «Paso 2: Configuración de producción» › «Registra tu número de teléfono de WhatsApp».
          </li>
          <li>
            <strong className="font-semibold text-foreground">La clave de acceso permanente:</strong> en la configuración del
            negocio en Meta, en Usuarios › «System users». El usuario del sistema debe poder administrar la cuenta de WhatsApp.
          </li>
          <li>
            <strong className="font-semibold text-foreground">La clave secreta de la app:</strong> en la app de Meta, en
            Configuración › «Basic».
          </li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Paso 1 sin conexión: los cuatro datos y «Comprobar», que dice qué número encontró. */
function AccountForm({ idPrefix, onCreated }: { idPrefix: string; onCreated: (created: ConnectResult) => void }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [missing, setMissing] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const isDirty = Object.values(values).some((value) => value.trim() !== "")

  const connect = useMutation({
    mutationFn: (config: Record<string, string>) =>
      apiFetch<{ data: ConnectResult }>("/api/channels/connections", {
        method: "POST",
        // Sin nombre: la conexión toma el que WhatsApp le da a la cuenta.
        body: JSON.stringify({ channel: "whatsapp", provider: "whatsapp_cloud_api", config }),
      }),
    onSuccess: async ({ data }) => {
      // Primero lo que se encontró, después la lista: así la página ya sabe qué decir cuando la conexión aparece.
      onCreated(data)
      await queryClient.invalidateQueries({ queryKey: ["connections"] })
    },
    // El servidor ya dice qué pasó y cómo arreglarlo; si es de una clave, el foco va a esa clave.
    onError: (failure) => {
      setError(
        failure instanceof ApiError && failure.shape.message
          ? failure.shape.message
          : "No pudimos conectar WhatsApp. Revisa los datos y vuelve a intentarlo.",
      )
      const field = failure instanceof ApiError && failure.shape.code ? FIELD_OF_ERROR[failure.shape.code] : undefined
      if (field) document.getElementById(`${idPrefix}-${field}`)?.focus()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const config = Object.fromEntries(WHATSAPP_FIELDS.map((field) => [field.key, (values[field.key] ?? "").trim()] as const))
    const empty = WHATSAPP_FIELDS.filter((field) => !config[field.key]).map((field) => field.key)
    setMissing(empty)
    if (empty.length === 0) connect.mutate(config)
    // Lo que falta se dice en cada campo y el foco va al primero.
    else document.getElementById(`${idPrefix}-${empty[0]}`)?.focus()
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      {/* Lo escrito se conserva: salir de la página pregunta antes. */}
      <PageDraftGuard dirty={isDirty && !connect.isPending && !connect.isSuccess} />
      {WHATSAPP_FIELDS.map((field) => (
        <AccountField
          key={field.key}
          id={`${idPrefix}-${field.key}`}
          field={field}
          value={values[field.key] ?? ""}
          shown={Boolean(shown[field.key])}
          error={missing.includes(field.key) ? "Escribe este dato." : null}
          onChange={(value) => {
            setValues((current) => ({ ...current, [field.key]: value }))
            setMissing((current) => current.filter((key) => key !== field.key))
          }}
          onToggleShown={() => setShown((current) => ({ ...current, [field.key]: !current[field.key] }))}
        />
      ))}
      <WhereToFind />
      {error ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <SubmitButton type="submit" pending={connect.isPending} className="h-11 self-start px-5">
          Comprobar
        </SubmitButton>
        <p className="text-sm text-muted-foreground">
          {appWords().name} le pregunta a WhatsApp con estos datos y te dice qué número encontró antes de seguir.
        </p>
      </div>
    </form>
  )
}

/** Paso 1 recién hecho: qué número encontró, qué se comprobó e hizo en Meta y si la clave puede pedir mensajes. */
function AccountFound({
  created,
  onContinue,
  onChangeKey,
}: {
  created: ConnectResult
  onContinue: () => void
  onChangeKey: () => void
}) {
  const next = useRef<HTMLButtonElement>(null)
  const describedBy = useId()
  const [ownApp, setOwnApp] = useState<OwnAppState | null>(created.ownApp ?? null)
  // Sin registrar el número no se sigue: no podría enviar ni recibir.
  const blocked = ownAppUnfinished(ownApp)
  // «Comprobar» ya no está: el foco sigue en el siguiente paso, que lee lo que se encontró.
  useEffect(() => {
    next.current?.focus()
  }, [])
  const account = accountWords(created.account)
  const report = created.templates
  return (
    <div className="flex flex-col gap-3">
      <div id={describedBy} className="flex flex-col gap-3">
        {ownApp ? (
          <>
            <Note tone={blocked ? "waiting" : "ok"} title={blocked ? "Falta un paso en Meta" : "Todo en orden"}>
              {account ? <span>{account}</span> : null}
            </Note>
            <OwnAppStatus connectionId={created.id} state={ownApp} found={null} step={1} onUpdated={setOwnApp} />
          </>
        ) : (
          // Solo se dice lo que WhatsApp confirmó: sin su respuesta, que la conexión quedó guardada.
          <Note tone="ok" title={account ? "Encontramos tu número" : "La conexión quedó guardada"}>
            {account ? <span>{account}</span> : null}
            {account && report?.canManage ? <span>La clave puede leer y pedir mensajes.</span> : null}
          </Note>
        )}
        {report?.error ? (
          <Note tone="waiting" title="La conexión sigue; faltan los mensajes">
            <span>{report.error}</span>
          </Note>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {blocked ? null : (
          <Button ref={next} type="button" className="h-11 px-5" aria-describedby={describedBy} onClick={onContinue}>
            Continuar
          </Button>
        )}
        {report?.error ? (
          <Button type="button" variant="outline" className="h-11" onClick={onChangeKey}>
            Cambiar la clave
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** Paso 2: los dos valores que se copian en Meta; la pantalla detecta sola cuándo Meta verifica. */
function AddressStep({
  idPrefix,
  webhookUrl,
  verifyToken,
  loading,
  failed,
  onRetry,
}: {
  idPrefix: string
  webhookUrl: string | null
  verifyToken: string | null
  loading: boolean
  failed: boolean
  onRetry: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {webhookUrl ? (
        <CopyValue id={`${idPrefix}-direccion`} label={`Dirección de ${appWords().name}`} hint="En Meta se llama «Callback URL»." value={webhookUrl} />
      ) : null}
      {verifyToken ? (
        <CopyValue
          id={`${idPrefix}-verificacion`}
          label="Clave de verificación"
          hint="En Meta se llama «Verify token». Se puede volver a ver aquí cuando haga falta."
          value={verifyToken}
        />
      ) : loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Cargando la clave de verificación…
        </p>
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">No pudimos cargar la clave de verificación.</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onRetry}>
            Reintentar
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-sm">
        <strong className="font-semibold">Después marca tres avisos</strong>
        <span className="text-muted-foreground">Meta no los marca solo: en «Campos del webhook», activa «Suscribirse» en cada fila.</span>
        <span className="text-muted-foreground">«messages», para recibir lo que escriben.</span>
        <span className="text-muted-foreground">«message_template_status_update», para saber cuándo WhatsApp aprueba un mensaje.</span>
        <span className="text-muted-foreground">«template_category_update», para saber si WhatsApp cuenta un aviso como promoción.</span>
      </div>
      <Note tone="waiting" icon live title="Esperando a Meta.">
        <span>Esta pantalla lo detecta sola cuando verifique la dirección. Puedes cerrarla y volver: seguirá en este paso.</span>
      </Note>
      <p className="text-sm text-muted-foreground">
        Si Meta no verifica la dirección, revisa que copiaste los dos valores completos y sin espacios.
      </p>
    </div>
  )
}

/**
 * Paso 3: escribir «hola» al número; la pantalla detecta sola el primer
 * mensaje. Si a los 3 minutos no llegó, dice qué revisar; si llegó uno firmado
 * con otra clave secreta, lo dice en vez de seguir esperando.
 */
function FirstMessageStep({
  requested,
  connection,
  onOpenGuide,
  onChangeKey,
}: {
  requested: number | null
  connection: ConnectionItem | null
  onOpenGuide: () => void
  onChangeKey: () => void
}) {
  const [waitedLong, setWaitedLong] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setWaitedLong(true), FIRST_MESSAGE_HELP_MS)
    return () => window.clearTimeout(timer)
  }, [])
  const [ownApp, setOwnApp] = useState<OwnAppState | null>(connection?.ownApp ?? null)
  useEffect(() => {
    setOwnApp(connection?.ownApp ?? null)
  }, [connection?.ownApp])
  if (ownAppSignatureProblem(ownApp, connection?.lastInboundAt)) {
    return (
      <div className="flex flex-col gap-3">
        <div role="alert" className="flex flex-col gap-2 rounded-xl bg-danger-soft px-3.5 py-3 text-sm text-destructive">
          <strong className="font-semibold">Llegó un mensaje, pero no pudimos leerlo</strong>
          <span>
            Meta lo firmó con una clave secreta distinta de la que pegaste. Suele pasar si la copiaste de otra app o si la cambiaste en
            Meta («Restablecer»). Copia la «Clave secreta de la app» de la misma app y pégala aquí.
          </span>
          <Button type="button" className="h-11 self-start px-5" onClick={onChangeKey}>
            Cambiar la clave secreta
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">Meta lo reintenta durante 7 días: al corregir la clave, los mensajes pendientes llegan solos.</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <Note tone="ok" icon live title="Meta verificó la dirección.">
        <span>Falta comprobar que llega un mensaje.</span>
      </Note>
      <Note tone="waiting" icon live title="Esperando el primer mensaje.">
        <span>Esta pantalla lo detecta sola en cuanto llegue.</span>
      </Note>
      {waitedLong ? (
        <div className="flex flex-col gap-2 rounded-xl border px-3.5 py-3 text-sm">
          <strong className="font-semibold">¿Escribiste y no llega? Revisa en este orden</strong>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
            <li>
              <strong className="font-semibold text-foreground">¿Publicaste la app?</strong> En Meta, junto al nombre de tu app, debe
              decir «Publicada» y no «En desarrollo». Sin publicar, Meta no avisa de los mensajes reales.{" "}
              <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-0" onClick={onOpenGuide}>
                Cómo publicarla
              </Button>
            </li>
            <li>
              <strong className="font-semibold text-foreground">¿Marcaste «messages»?</strong> En «Paso 2: Configuración de
              producción» › «Configurar webhooks», la fila «messages» debe decir «Suscritos».
            </li>
            <li>
              <strong className="font-semibold text-foreground">¿Escribiste al número correcto?</strong> Desde otro teléfono, al número
              de la clínica.
            </li>
          </ol>
          {connection && ownApp ? (
            <OwnAppStatus connectionId={connection.id} state={ownApp} found={null} step={3} onUpdated={setOwnApp} />
          ) : (
            <Button type="button" variant="ghost" className="h-11 self-start sm:h-9" onClick={() => openSupportRequest(ownAppHelpText(3))}>
              Pedir ayuda a {appWords().name}
            </Button>
          )}
        </div>
      ) : null}
      <div className="flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-sm">
        <strong className="font-semibold">
          {requested && requested > 0
            ? `Ya pedimos a WhatsApp ${requested === 1 ? "tu mensaje" : `tus ${requested} mensajes`}`
            : "Tus mensajes ya se le pidieron a WhatsApp"}
        </strong>
        <span className="text-muted-foreground">
          Se piden al conectar, no al prender cada línea, para que ya estén aprobados cuando los necesites. WhatsApp puede
          tardar hasta un día; te avisamos de cada uno.
        </span>
      </div>
    </div>
  )
}

/**
 * Conectar WhatsApp con los datos de la app de Meta, en tres pasos que se
 * comprueban solos: (1) los cuatro datos y qué número encontró, (2) la dirección
 * de odentIA y su clave copiadas en Meta, (3) el primer mensaje recibido. El
 * paso en curso sale de lo que dice el servidor, así que se puede cerrar y
 * volver: una conexión a medias se retoma donde quedó.
 */
export function WhatsAppConnectSteps({
  title,
  connection,
  account = null,
  created,
  step,
  setup,
  setupPending = false,
  setupFailed = false,
  requested = null,
  onCreated,
  onContinue,
  onChangeKey,
  onRetrySetup,
}: {
  title: string
  /** La conexión, si ya existe: los pasos siguen con ella. */
  connection: ConnectionItem | null
  /** Con qué cuenta quedó, para decirlo en el paso 1 ya hecho. */
  account?: string | null
  /** Recién creada y con su resultado aún sin leer: el paso 1 dice qué encontró. */
  created: ConnectResult | null
  /** Paso en curso. */
  step: 1 | 2 | 3
  setup?: ConnectionSetup
  setupPending?: boolean
  setupFailed?: boolean
  /** Cuántos mensajes se pidieron al conectar, si se sabe. */
  requested?: number | null
  /** Solo sin conexión: se creó con los cuatro datos. */
  onCreated?: (created: ConnectResult) => void
  /** Solo recién creada: la persona leyó qué se encontró y sigue. */
  onContinue?: () => void
  onChangeKey?: () => void
  onRetrySetup?: () => void
}) {
  const headingId = useId()
  const fieldId = useId()
  const [guideOpen, setGuideOpen] = useState(false)
  const stateOf = (number: number): StepState => (number < step ? "done" : number === step ? "current" : "pending")
  const section = useRef<HTMLElement>(null)

  // Al avanzar de paso, el control que se tenía delante desaparece: el foco pasa al paso que
  // sigue. Si la persona está en otra parte de la página, no se le mueve.
  const shown = useRef(`${step}:${created ? "encontrado" : ""}`)
  useEffect(() => {
    const next = `${step}:${created ? "encontrado" : ""}`
    if (shown.current === next) return
    shown.current = next
    const active = document.activeElement
    if (active === document.body || section.current?.contains(active)) {
      // Sin desplazar la página: el paso se detecta solo y la persona puede estar leyendo más abajo.
      section.current?.querySelector<HTMLElement>("[aria-current='step'] h3")?.focus({ preventScroll: true })
    }
  }, [step, created])

  return (
    <section ref={section} aria-labelledby={headingId} className="elevated flex min-w-0 flex-col rounded-xl border bg-card">
      <div className="flex flex-col gap-1 px-4 pt-4 pb-3.5 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 id={headingId} tabIndex={-1} className="font-heading text-base font-semibold outline-none">
            {title}
          </h2>
          <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={() => setGuideOpen(true)}>
            Ver la guía
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Tres pasos. Cada uno se comprueba solo y dice qué encontró; puedes cerrar y volver cuando quieras.
        </p>
      </div>
      <ol className="flex flex-col">
        <StepItem
          number={1}
          title="Tu cuenta de WhatsApp Business"
          state={stateOf(1)}
          summary={
            stateOf(1) === "done"
              ? account
                ? `La cuenta es ${account}.`
                : "La cuenta quedó conectada."
              : "Los cuatro datos están en la app de Meta de la clínica."
          }
        >
          {connection && created ? (
            <AccountFound created={created} onContinue={() => onContinue?.()} onChangeKey={() => onChangeKey?.()} />
          ) : (
            <AccountForm idPrefix={fieldId} onCreated={(result) => onCreated?.(result)} />
          )}
        </StepItem>
        <StepItem
          number={2}
          title="Que WhatsApp nos avise"
          state={stateOf(2)}
          summary={
            stateOf(2) === "done"
              ? "Meta verificó la dirección."
              : "Copia estos dos valores en tu app de Meta, en «Paso 2: Configuración de producción» › «Configurar webhooks»."
          }
        >
          <AddressStep
            idPrefix={fieldId}
            webhookUrl={setup?.webhookUrl ?? connection?.webhookUrl ?? null}
            verifyToken={setup?.verifyToken ?? created?.webhookSecret ?? null}
            loading={setupPending}
            failed={setupFailed}
            onRetry={() => onRetrySetup?.()}
          />
        </StepItem>
        <StepItem
          number={3}
          title="Prueba y listo"
          state={stateOf(3)}
          summary="Escribe «hola» al número de la clínica desde cualquier teléfono."
        >
          <FirstMessageStep
            requested={requested}
            connection={connection}
            onOpenGuide={() => setGuideOpen(true)}
            onChangeKey={() => onChangeKey?.()}
          />
        </StepItem>
      </ol>
      <OwnAppGuide open={guideOpen} onClose={() => setGuideOpen(false)} />
    </section>
  )
}
