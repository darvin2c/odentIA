import { toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  FormPanel,
  PageHeader,
  PageShell,
  RadioChips,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { ArrowLeft, Banknote, Check, Sparkles, X } from "lucide-react"
import { useState } from "react"
import { RUBROS } from "../datos"
import { href, ir, useRuta } from "../ruta"
import {
  ADELANTO,
  alRecibirPara,
  type CasoCobro,
  COBRO_TIENDA,
  guardarCobro,
  type PoliticaCobro,
  useCobro,
  VIAJE,
  ZONAS_LIMA,
} from "./cobros"
import { money } from "./modelo"

function Linea({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3 py-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
}

/** Cuatro casos de la semana: lo que respondería Sofi con esta política. Cambia al tocar el formulario. */
const CASOS: (CasoCobro & { quien: string })[] = [
  { quien: "Lorena · Ate", nombre: "Lorena", zona: "Ate", monto: 139, envio: 10, compras: 2 },
  { quien: "Pilar · Carabayllo", nombre: "Pilar", zona: "Carabayllo", monto: 189, envio: 10, compras: 0 },
  { quien: "Una clienta nueva · Surco, S/ 450", nombre: "Andrea", zona: "Surco", monto: 450, envio: 10, compras: 0 },
  { quien: "Sofía · Trujillo, por agencia", nombre: "Sofía", zona: "Trujillo, por agencia", monto: 167, envio: 18, compras: 1 },
]

function AsiLoDice({ pol }: { pol: PoliticaCobro }) {
  return (
    <section aria-labelledby="asi-cobro" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 id="asi-cobro" className="flex items-center gap-2 text-base font-semibold">
        <Sparkles className="size-4 text-primary" aria-hidden />
        Así lo dice Sofi con esta política
      </h2>
      <ul className="flex flex-col gap-3">
        {CASOS.map((c) => {
          const r = alRecibirPara(pol, c)
          return (
            <li key={c.quien} className="flex flex-col gap-1.5 rounded-xl border p-3 text-sm">
              <span className="flex items-center gap-2">
                {r.ok ? (
                  <Check className="size-4 shrink-0 text-success" aria-hidden />
                ) : (
                  <X className="size-4 shrink-0 text-destructive" aria-hidden />
                )}
                <b className="min-w-0 flex-1">{c.quien}</b>
                <span className="text-xs text-muted-foreground">{r.ok ? "Al recibir" : "Con su link"}</span>
              </span>
              <span className="text-xs text-muted-foreground">La regla: {r.regla}</span>
              <span className="rounded-lg bg-muted px-2.5 py-1.5">«{r.sofi}»</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Configuración › Cobros: la política del pago contra entrega. La decide la tienda; Sofi la sigue,
 * la explica con su regla y, si no se puede, ofrece el link. No inventa excepciones.
 */
export function CobrosPage() {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const guardada = useCobro(rubro)
  const [vista, setVista] = useState<PoliticaCobro>(guardada)
  const form = useAppForm({
    defaultValues: guardada,
    listeners: { onChange: ({ formApi }) => setVista({ ...(formApi.state.values as PoliticaCobro) }) },
    onSubmit: async ({ value }) => {
      guardarCobro(rubro, value)
      toast.success("Guardada. Sofi ya la usa al ofrecer el pago al recibir.")
      form.reset(value)
    },
  })
  const surface = useFormSurface(form)
  const sw = (k: "alRecibir" | "soloConCompras", label: string) => (
    <form.AppField name={k}>
      {(f) => (
        <Linea label={label}>
          <Switch checked={!!f.state.value} onCheckedChange={(v) => f.handleChange(!!v)} />
        </Linea>
      )}
    </form.AppField>
  )
  const chips = <K extends "adelanto" | "viaje">(k: K, label: string, opts: Record<string, string>, help?: string) => (
    <form.AppField name={k}>
      {(f) => (
        <f.Control label={label} description={help}>
          {(c) => (
            <RadioChips
              id={c.id}
              aria-label={label}
              aria-describedby={c.describedBy}
              value={String(f.state.value)}
              options={Object.entries(opts).map(([value, l]) => ({ value, label: l }))}
              onChange={(v) => f.handleChange(v as never)}
            />
          )}
        </f.Control>
      )}
    </form.AppField>
  )
  const grupo = (t: string, children: React.ReactNode) => (
    <fieldset className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <legend className="mb-1 text-sm font-semibold">{t}</legend>
      {children}
    </fieldset>
  )
  return (
    <PageShell className="flex min-w-0 flex-col gap-4">
      <a
        href={href("/pedidos")}
        className="inline-flex min-h-11 items-center gap-1 self-start rounded-md text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Volver a Pedidos
      </a>
      <PageHeader
        title="Cobros: pago al recibir"
        subtitle={`Configuración › Cobros · ${R.store.name}. Sofi lo ofrece o no según esta política, y lo explica con tu regla.`}
      />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <FormPanel
          {...surface}
          title="Tu política de pago al recibir"
          description="El repartidor cobra en la puerta en efectivo, con POS o con Yape o Plin a la tienda."
          onClose={() => ir("/pedidos")}
          submitLabel="Guardar la política"
          className="elevated h-auto rounded-xl border"
          secondaryAction={{
            label: "Volver a la de la tienda",
            onClick: () => {
              form.reset(COBRO_TIENDA, { keepDefaultValues: true })
              setVista(COBRO_TIENDA)
            },
          }}
        >
          {/* Con el dedo, cada opción y el selector a 44 px. */}
          <div className="flex flex-col gap-4 max-sm:[&_[role=combobox]]:min-h-11 max-sm:[&_button]:min-h-11 max-sm:[&_label]:min-h-11 pointer-coarse:[&_label]:min-h-11">
            {grupo(
              "Qué aceptas",
              <>
                {sw("alRecibir", "Acepta pago al recibir")}
                <form.AppField name="montoMax">
                  {(f) => (
                    <f.SelectField
                      label="Monto máximo de un pedido al recibir"
                      description="Más que eso, Sofi ofrece el link."
                      options={[0, 200, 300, 400, 600].map((m) => ({
                        value: String(m),
                        label: m ? `Hasta ${money(m)}` : "Sin tope",
                      }))}
                    />
                  )}
                </form.AppField>
                {chips("adelanto", "Lo que pide adelantar antes de salir", ADELANTO, "Con el link de siempre; el resto, en la puerta.")}
                {sw("soloConCompras", "Solo para clientas con compras anteriores")}
              </>,
            )}
            {grupo(
              "En qué zonas",
              <form.AppField name="sinZonas">
                {(f) => (
                  <f.Control label="Distritos donde acepta" description="Por agencia, nunca: la agencia no cobra por la tienda.">
                    {() => (
                      <div className="grid gap-x-6 sm:grid-cols-2">
                        {ZONAS_LIMA.map((z) => (
                          <Linea key={z} label={z}>
                            <Switch
                              checked={!f.state.value.includes(z)}
                              onCheckedChange={(on) =>
                                f.handleChange(on ? f.state.value.filter((y) => y !== z) : [...f.state.value, z])
                              }
                            />
                          </Linea>
                        ))}
                      </div>
                    )}
                  </f.Control>
                )}
              </form.AppField>,
            )}
            {grupo(
              "Si no lo recibe o no paga",
              chips(
                "viaje",
                "Quién paga el viaje",
                VIAJE,
                "Si lo paga la clienta, queda como cargo en el saldo del pedido y se cobra si lo quiere otro día.",
              ),
            )}
          </div>
        </FormPanel>
        <div className="flex min-w-0 flex-col gap-4">
          <AsiLoDice pol={vista} />
          <div className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
            <b className="flex items-center gap-2">
              <Banknote className="size-4 text-primary" aria-hidden />
              Lo que hace sola, sin que lo pidas
            </b>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
              <li>Al cerrar un pedido al recibir en efectivo, pregunta «¿con cuánto vas a pagar?». El repartidor ve el vuelto que lleva.</li>
              <li>El día de la entrega, le recuerda el monto y le ofrece pagar ya con su link, para no esperar el vuelto.</li>
              <li>Si no lo recibe, le pregunta si lo quiere otro día, con el viaje según esta política.</li>
            </ul>
          </div>
        </div>
      </div>
    </PageShell>
  )
}
