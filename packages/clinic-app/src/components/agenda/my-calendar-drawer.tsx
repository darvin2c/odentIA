import { Badge, Button, Input, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, PageNotice, SubmitButton, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check } from "lucide-react"
import * as React from "react"
import {
  acknowledgeCalendarClient,
  type CalendarClient,
  createMyCalendarFeed,
  fetchMyCalendarFeed,
  MY_CALENDAR_KEY,
  type MyCalendarFeed,
  revokeMyCalendarFeed,
  rotateMyCalendarFeed,
  usageWords,
  whenWords,
} from "../../lib/calendar-feed"
import { errorMessage as errorText } from "./shared"
import { activeOrgLocale } from "../../lib/locale"
import { appWords } from "../../lib/product-words"

/** «Hoy, 10:00 – 10:30», «Mañana, …» o «Lunes 26 de octubre, …» de la próxima cita, en la zona de su sede. */
function previewWhen(preview: NonNullable<MyCalendarFeed["preview"]>, now = new Date()): string {
  const zone = preview.timeZone
  const time = (iso: string) => new Date(iso).toLocaleTimeString(activeOrgLocale(), { hour: "2-digit", minute: "2-digit", timeZone: zone })
  const dayOf = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(date)
  const start = new Date(preview.start)
  const day =
    dayOf(start) === dayOf(now)
      ? "Hoy"
      : dayOf(start) === dayOf(new Date(now.getTime() + 86_400_000))
        ? "Mañana"
        : start.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long", timeZone: zone })
  return `${day.charAt(0).toLocaleUpperCase("es")}${day.slice(1)}, ${time(preview.start)} – ${time(preview.end)}`
}

/**
 * «Mi calendario» (issue 46, ADR 0082; tableros 2, 3, 3b y 3c del lienzo):
 * crear el enlace privado, añadirlo a Google, Apple u Outlook, ver qué
 * programas lo usan y cambiarlo o apagarlo. Lo que dice sale del servidor.
 */
export function MyCalendarDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: MY_CALENDAR_KEY, queryFn: fetchMyCalendarFeed, enabled: open })
  const [asking, setAsking] = React.useState<"rotate" | "revoke" | null>(null)
  const [copied, setCopied] = React.useState(false)
  const save = (data: MyCalendarFeed) => queryClient.setQueryData(MY_CALENDAR_KEY, { data })
  const create = useMutation({ mutationFn: createMyCalendarFeed, onSuccess: (result) => save(result.data) })
  const rotate = useMutation({
    mutationFn: rotateMyCalendarFeed,
    onSuccess: (result) => {
      save(result.data)
      setAsking(null)
      toast.success("Listo: el enlace anterior ya no sirve. Añade el nuevo a tu calendario.")
    },
  })
  const revoke = useMutation({
    mutationFn: revokeMyCalendarFeed,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MY_CALENDAR_KEY })
      setAsking(null)
      toast.success("Dejaste de compartir tu agenda.")
    },
  })
  const known = useMutation({
    mutationFn: (client: CalendarClient) => acknowledgeCalendarClient(client),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: MY_CALENDAR_KEY }),
  })
  const data = query.data?.data
  const feed = data?.feed ?? null
  // Cambiar o apagar el enlace fallan dentro de su diálogo, que tapa el cajón: se dicen allí.
  const failure = create.error ?? known.error
  const closeAsking = () => {
    setAsking(null)
    rotate.reset()
    revoke.reset()
  }

  const copy = async () => {
    if (!feed?.url) return
    try {
      await navigator.clipboard.writeText(feed.url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("No se pudo copiar. Selecciona el enlace y cópialo a mano.")
    }
  }

  const actions = feed ? (
    <>
      <Button type="button" variant="ghost" onClick={() => setAsking("rotate")}>
        Cambiar enlace
      </Button>
      <Button type="button" variant="ghost" className="text-destructive" onClick={() => setAsking("revoke")}>
        Dejar de compartir
      </Button>
    </>
  ) : undefined

  return (
    <>
      <DetailDrawer
        open={open}
        onClose={onClose}
        title="Mi calendario"
        description="Tus citas de esta clínica en Google Calendar, Apple u Outlook, junto a lo demás de tu día."
        isLoading={query.isPending}
        error={query.isError ? errorText(query.error) : failure ? submitErrorMessage(failure) : null}
        actions={actions}
      >
        {data && !data.allowed ? (
          <p className="text-sm text-muted-foreground">«Mi calendario» es para quien atiende pacientes en esta clínica.</p>
        ) : data && !feed ? (
          <div className="grid gap-5">
            <section className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Así se verá tu próxima cita</h3>
              {data.preview ? (
                <div className="flex gap-3 rounded-xl border bg-muted/40 p-3.5 text-sm">
                  <span aria-hidden className="w-1 shrink-0 rounded-full bg-primary" />
                  <div className="grid gap-0.5">
                    <p className="font-semibold">{data.preview.summary}</p>
                    <p>{previewWhen(data.preview)}</p>
                    {data.preview.location ? <p className="text-muted-foreground">{data.preview.location}</p> : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Aún no tienes citas por venir. Cada una saldrá como «Paciente · R. P.», con la hora y la sede.
                </p>
              )}
            </section>
            <section className="grid gap-2 text-sm leading-relaxed">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lo que hay que saber</h3>
              <p>
                <strong>Solo las iniciales.</strong> Tu calendario lo guarda Google, Apple o Microsoft, fuera de la clínica: por eso
                no va el nombre, el motivo ni nada de su historia.
              </p>
              <p>
                <strong>Solo tus citas,</strong> de hoy a tres meses adelante. Desde tu calendario no se mueve ni se reserva nada: si
                mueves o borras una cita ahí, en {appWords().name} no cambia.
              </p>
              <p>
                <strong>Puede tardar.</strong> Tu calendario decide cuándo busca los cambios; {appWords().name} no controla cuánto tarda. Para lo
                de hoy, mira la Agenda.
              </p>
              <p>
                <strong>El enlace es solo tuyo.</strong> Quien lo tenga ve tus citas así. Si lo compartiste por error, lo cambias en un
                toque.
              </p>
            </section>
            <div className="grid gap-2">
              <SubmitButton className="min-h-11" pending={create.isPending} onClick={() => create.mutate()}>
                Crear mi enlace
              </SubmitButton>
              <p className="text-center text-xs text-muted-foreground">Queda registrado cada vez que tu calendario lo consulta.</p>
            </div>
          </div>
        ) : feed ? (
          <div className="grid gap-5">
            {feed.alert ? (
              <PageNotice
                tone="alarma"
                label="Uso nuevo"
                action={
                  <span className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => setAsking("rotate")}>
                      Cambiar enlace
                    </Button>
                    <SubmitButton
                      size="sm"
                      variant="outline"
                      pending={known.isPending}
                      onClick={() => feed.alert && known.mutate(feed.alert.client)}
                    >
                      Fui yo
                    </SubmitButton>
                  </span>
                }
              >
                Un programa nuevo usó tu enlace: {feed.alert.label.toLocaleLowerCase("es")}, {whenWords(feed.alert.at)}. Si no fuiste
                tú, cámbialo: así nadie más ve tus citas.
              </PageNotice>
            ) : null}
            <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
              <Check aria-hidden className="size-4" />
              {feed.lastUsedAt ? `Conectado · tu calendario lo consultó ${whenWords(feed.lastUsedAt)}` : "Listo · añádelo a tu calendario"}
            </p>
            <section className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Añádelo a tu calendario</h3>
              {feed.googleUrl ? (
                <Button className="min-h-11" render={<a href={feed.googleUrl} target="_blank" rel="noopener noreferrer" />}>
                  Añadir a Google Calendar
                </Button>
              ) : null}
              {feed.webcalUrl ? (
                <Button variant="secondary" className="min-h-11" render={<a href={feed.webcalUrl} />}>
                  Añadir a Apple o Outlook
                </Button>
              ) : null}
              <p className="text-xs leading-relaxed text-muted-foreground">
                Cada botón abre tu calendario con el enlace ya puesto: solo confirmas. Hazlo en el celular o la computadora donde lo
                usas.
              </p>
            </section>
            {feed.url ? (
              <section className="grid gap-2">
                <label htmlFor="mi-calendario-enlace" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  O copia el enlace
                </label>
                <div className="flex gap-2">
                  <Input id="mi-calendario-enlace" readOnly value={feed.url} onFocus={(event) => event.currentTarget.select()} />
                  <Button type="button" variant="secondary" onClick={() => void copy()}>
                    {copied ? "Copiado" : "Copiar"}
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Para otro programa: «Añadir calendario desde una dirección» y pega este enlace. No lo compartas: quien lo tenga ve
                  tus citas.
                </p>
              </section>
            ) : null}
            <section className="grid gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quién usa tu enlace · últimos 7 días</h3>
              {feed.clients.length > 0 ? (
                <ul className="divide-y rounded-xl border text-sm">
                  {feed.clients.map((use) => (
                    <li key={use.client} className={use.isNew ? "flex justify-between gap-3 bg-warning-soft p-3" : "flex justify-between gap-3 p-3"}>
                      <span>
                        <span className="font-semibold">{use.label}</span>
                        {use.isNew ? (
                          <Badge variant="secondary" className="ml-2">
                            Nuevo
                          </Badge>
                        ) : null}
                        <span className="block text-xs text-muted-foreground">{usageWords(use)}</span>
                      </span>
                      <span className="text-right text-xs text-muted-foreground">
                        Última vez
                        <br />
                        {whenWords(use.lastAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Todavía ningún calendario lo consultó. Añádelo con uno de los botones.</p>
              )}
              <p className="text-xs leading-relaxed text-muted-foreground">
                Tus citas de hoy a tres meses, como «Paciente · R. P.». Los cambios pueden tardar: depende de tu calendario, no de
                {appWords().name}.
              </p>
            </section>
          </div>
        ) : null}
      </DetailDrawer>
      <ConfirmDialog
        open={asking === "rotate"}
        title="¿Cambiar tu enlace?"
        description="El enlace de ahora deja de funcionar al momento: si alguien más lo tenía, ya no verá tus citas. Tu calendario también lo pierde y tendrás que añadir el nuevo."
        confirmLabel="Sí, cambiarlo"
        cancelLabel="No, dejarlo así"
        pending={rotate.isPending}
        error={rotate.error ? submitErrorMessage(rotate.error) : null}
        onClose={closeAsking}
        onConfirm={() => rotate.mutate()}
      />
      <ConfirmDialog
        open={asking === "revoke"}
        title="¿Dejar de compartir tu agenda?"
        description="Tu enlace deja de funcionar y tus citas desaparecen de tu calendario. Puede tardar: depende de tu calendario. Cuando quieras, creas uno nuevo."
        confirmLabel="Sí, dejar de compartir"
        cancelLabel="No, seguir compartiendo"
        variant="destructive"
        pending={revoke.isPending}
        error={revoke.error ? submitErrorMessage(revoke.error) : null}
        onClose={closeAsking}
        onConfirm={() => revoke.mutate()}
      />
    </>
  )
}
