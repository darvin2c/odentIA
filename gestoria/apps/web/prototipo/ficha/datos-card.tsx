import { Button, cn, Input, Textarea } from "@odentia/ui"
import { FormDrawer, RadioChips } from "@odentia/ui-patterns"
import { MessageCircleQuestion, Plus, Settings2, Sparkles, Trash2 } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { type Dato, type Producto, RUBROS, type Rubro } from "../datos"
import { cambiar, estado, plantilla } from "../tienda"
import { Propuesto, Seccion, Sub } from "./piezas"

function setDato(p: Producto, d: Dato, v: unknown, group?: string) {
  cambiar(
    p.id,
    `${d.label}: ${typeof v === "string" ? v || "vacío" : "cambió"}`,
    (x) => {
      x.datos[d.id] = v
      if (x.ai.datos) delete x.ai.datos[d.id]
    },
    { group, toast: !group },
  )
}

function Campo({ p, d, edit, R }: { p: Producto; d: Dato; edit: boolean; R: Rubro }) {
  const id = useId()
  const v = p.datos[d.id]
  const ai = p.ai.datos?.[d.id]
  const empty =
    v == null || v === "" || (typeof v === "object" && Object.keys(v as object).length === 0)
  const showAi = ai != null && empty && edit
  const labelRow = (
    <div className="flex min-h-5 items-center gap-2">
      <label htmlFor={id} id={`${id}-l`} className="text-sm font-medium">
        {d.label}
      </label>
      {showAi ? (
        <Propuesto
          porque={`Visto en las fotos o la etiqueta: «${String(ai)}». Elige otra opción si no es así.`}
          onAccept={() => setDato(p, d, ai)}
          onDiscard={() =>
            cambiar(
              p.id,
              "Descartaste la propuesta",
              (x) => {
                if (x.ai.datos) delete x.ai.datos[d.id]
              },
              { toast: true },
            )
          }
        />
      ) : null}
      {empty && d.need && !showAi ? (
        <span className="text-xs font-medium text-warning">Sofi lo necesita</span>
      ) : null}
    </div>
  )

  let control: React.ReactNode = null
  if (d.type === "chips")
    control = (
      <div className={cn("w-fit rounded-full", showAi && "propuesta border p-0.5")}>
        <RadioChips
          id={id}
          aria-labelledby={`${id}-l`}
          value={(empty ? (showAi ? String(ai) : null) : String(v)) as string | null}
          options={(d.opts ?? []).map((o) => ({ value: o, label: o }))}
          disabled={!edit}
          onChange={(o) => setDato(p, d, o)}
        />
      </div>
    )
  else if (d.type === "text")
    control = (
      <>
        <Input
          id={id}
          value={empty && showAi ? String(ai) : String(v ?? "")}
          disabled={!edit}
          className={cn(showAi && "propuesta")}
          placeholder={d.ai ? "O responde la pregunta de abajo" : ""}
          onChange={(e) => setDato(p, d, e.target.value, `dato-${d.id}`)}
        />
        {d.ai && empty && edit ? (
          <div className="entra flex flex-wrap items-center gap-2 text-sm">
            <Sparkles className="size-3.5 text-primary" aria-hidden />
            <span className="text-muted-foreground">{d.ai.q}</span>
            {Object.entries(d.ai.a).map(([opt, text]) => (
              <Button key={opt} size="xs" variant="outline" onClick={() => setDato(p, d, text)}>
                {opt}
              </Button>
            ))}
          </div>
        ) : null}
      </>
    )
  else if (d.type === "date") {
    const [y, m] = String(v ?? "").split("-")
    control = (
      <Input
        id={id}
        className="w-36"
        placeholder="MM/AAAA"
        disabled={!edit}
        defaultValue={v ? `${m}/${y}` : ""}
        onBlur={(e) => {
          const mm = /^(\d{1,2})\/(\d{4})$/.exec(e.target.value.trim())
          if (mm) setDato(p, d, `${mm[2]}-${mm[1]!.padStart(2, "0")}`)
        }}
      />
    )
  } else if (d.type === "percol") {
    const m = (v ?? {}) as Record<string, string>
    control = (
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2"
        role="group"
        aria-labelledby={`${id}-l`}
      >
        {p.sizes.map((z) => (
          <label key={z} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {R.col} {z}
            <Input
              id={`dato-${d.id}-${z}`}
              inputMode="decimal"
              disabled={!edit}
              value={m[z] ?? ""}
              placeholder="cm"
              className="h-8 text-center"
              onChange={(e) => setDato(p, d, { ...m, [z]: e.target.value }, `dato-${d.id}`)}
            />
          </label>
        ))}
      </div>
    )
  } else if (d.type === "table") {
    const m = (v ?? {}) as Record<string, string[]>
    control = (
      <div className="overflow-x-auto rounded-xl border" role="group" aria-labelledby={`${id}-l`}>
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">{R.col}</th>
              {(d.cols ?? []).map((c) => (
                <th key={c} className="px-3 py-2 text-left font-semibold">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.sizes.map((z) => (
              <tr key={z} className="border-t">
                <th className="px-3 py-1.5 text-left font-medium">{z}</th>
                {(d.cols ?? []).map((c, ci) => (
                  <td key={c} className="px-2 py-1.5">
                    <Input
                      inputMode="decimal"
                      disabled={!edit}
                      value={m[z]?.[ci] ?? ""}
                      placeholder="cm"
                      className="h-8 w-20"
                      aria-label={`${c} de la ${z}`}
                      onChange={(e) => {
                        const row = [...(m[z] ?? [])]
                        row[ci] = e.target.value
                        setDato(p, d, { ...m, [z]: row }, `dato-${d.id}`)
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div id={`dato-${d.id}`} className="flex scroll-mt-24 flex-col gap-2 rounded-xl">
      {labelRow}
      {control}
    </div>
  )
}

/** La plantilla del rubro: qué pide cada producto y qué necesita Sofi. Vale para toda la tienda. */
function TemplateDrawer({ R, onClose }: { R: Rubro; onClose: () => void }) {
  const [draft, setDraft] = useState(() =>
    estado().db[estado().rubro]!.tpl.map((d) => ({ ...d, quitar: false })),
  )
  const [nuevo, setNuevo] = useState("")
  const dirty =
    JSON.stringify(draft) !==
      JSON.stringify(estado().db[estado().rubro]!.tpl.map((d) => ({ ...d, quitar: false }))) ||
    !!nuevo
  return (
    <FormDrawer
      open
      onClose={onClose}
      title={`Plantilla de ${R.label.toLowerCase()}`}
      description={`Lo que pide cada producto de ${R.store.name}. Sofi lo usa al responder.`}
      isDirty={dirty}
      submitLabel="Guardar plantilla"
      onSubmit={(e) => {
        e.preventDefault()
        const extra = nuevo.trim()
          ? [
              {
                id: `x${Date.now()}`,
                label: nuevo.trim(),
                type: "text" as const,
                keys: nuevo
                  .toLowerCase()
                  .split(/\s+/)
                  .filter((w) => w.length > 3),
              },
            ]
          : []
        plantilla(() => [
          ...draft.filter((d) => !d.quitar).map(({ quitar: _q, ...d }) => d),
          ...extra,
        ])
        onClose()
      }}
    >
      <div className="flex flex-col divide-y">
        {draft.map((d, i) => (
          <div
            key={d.id}
            className={cn("flex flex-col gap-2 py-3 first:pt-0", d.quitar && "opacity-50")}
          >
            <span className="text-sm font-medium" id={`tpl-${d.id}`}>
              {d.label}
            </span>
            <RadioChips
              aria-labelledby={`tpl-${d.id}`}
              value={d.quitar ? "quitar" : d.need ? "need" : "suma"}
              options={[
                { value: "need", label: "Sofi lo necesita" },
                { value: "suma", label: "Suma" },
                { value: "quitar", label: "Quitar" },
              ]}
              onChange={(v) =>
                setDraft(
                  draft.map((x, j) =>
                    j === i ? { ...x, need: v === "need", quitar: v === "quitar" } : x,
                  ),
                )
              }
            />
          </div>
        ))}
        <label className="flex flex-col gap-1.5 pt-3 text-sm font-medium">
          Agregar un dato
          <Input
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            placeholder="Ej.: ¿Es vegano?"
          />
        </label>
      </div>
    </FormDrawer>
  )
}

function Preguntas({ p, edit }: { p: Producto; edit: boolean }) {
  const [nueva, setNueva] = useState<{ q: string; a: string } | null>(null)
  const ans = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const onAsk = (e: Event) => {
      setNueva({ q: (e as CustomEvent<string>).detail, a: "" })
      setTimeout(() => ans.current?.focus(), 420)
    }
    window.addEventListener("ficha:pregunta", onAsk)
    return () => window.removeEventListener("ficha:pregunta", onAsk)
  }, [])
  const R = RUBROS[estado().rubro]
  return (
    <>
      <Sub
        id="preguntas"
        action={
          edit && !nueva ? (
            <Button size="sm" variant="ghost" onClick={() => setNueva({ q: "", a: "" })}>
              <Plus aria-hidden />
              Pregunta
            </Button>
          ) : null
        }
      >
        Preguntas respondidas
      </Sub>
      {p.preguntas.length === 0 && !nueva ? (
        <p className="text-sm text-muted-foreground">
          Cuando Sofi no sepa algo, te lo pregunta en «Te toca» y tu respuesta queda aquí.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {p.preguntas.map((x, i) => (
          <li
            key={`${x.q}${i}`}
            className="group flex items-start gap-3 rounded-xl bg-surface-muted px-3 py-2.5 text-sm"
          >
            <MessageCircleQuestion
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">{x.q}</span>
              <span>{x.a}</span>
              <span className="text-xs text-muted-foreground">{x.who}</span>
            </span>
            {edit ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Quitar la pregunta"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() =>
                  cambiar(p.id, "Quitaste una pregunta", (y) => y.preguntas.splice(i, 1), {
                    toast: true,
                  })
                }
              >
                <Trash2 aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {nueva ? (
        <form
          className="entra flex flex-col gap-2 rounded-xl border p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!nueva.q.trim() || !nueva.a.trim()) return
            cambiar(
              p.id,
              "Guardaste una respuesta",
              (y) =>
                y.preguntas.unshift({
                  q: nueva.q.trim(),
                  a: nueva.a.trim(),
                  who: `${R.store.owner.split(" ")[0]} · hoy`,
                }),
              { toast: true },
            )
            setNueva(null)
          }}
        >
          <Input
            aria-label="La pregunta"
            placeholder="La pregunta de la clienta"
            value={nueva.q}
            onChange={(e) => setNueva({ ...nueva, q: e.target.value })}
          />
          <Textarea
            ref={ans}
            aria-label="Tu respuesta"
            placeholder="Tu respuesta. Sofi la usará la próxima vez."
            rows={2}
            value={nueva.a}
            onChange={(e) => setNueva({ ...nueva, a: e.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setNueva(null)}>
              Cancelar
            </Button>
            <Button type="submit" size="sm">
              Guardar respuesta
            </Button>
          </div>
        </form>
      ) : null}
    </>
  )
}

export function DataCard({
  p,
  edit,
  R,
  tpl,
}: {
  p: Producto
  edit: boolean
  R: Rubro
  tpl: Dato[]
}) {
  const [tplOpen, setTplOpen] = useState(false)
  const filled = tpl.filter((d) => {
    const v = p.datos[d.id]
    return (
      v != null && v !== "" && !(typeof v === "object" && Object.keys(v as object).length === 0)
    )
  }).length
  return (
    <Seccion
      id="datos"
      title={`Datos de ${R.label.toLowerCase()}`}
      summary={`${filled} de ${tpl.length} · ${p.preguntas.length} preguntas respondidas`}
      contains={["dato-", "preguntas"]}
      action={
        edit ? (
          <Button size="sm" variant="ghost" onClick={() => setTplOpen(true)}>
            <Settings2 aria-hidden />
            Plantilla
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-5">
        {tpl.map((d) => (
          <Campo key={d.id} p={p} d={d} edit={edit} R={R} />
        ))}
      </div>
      <Preguntas p={p} edit={edit} />
      {tplOpen ? <TemplateDrawer R={R} onClose={() => setTplOpen(false)} /> : null}
    </Seccion>
  )
}
