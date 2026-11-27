import { Badge, Button, cn, Input, Textarea, useIsMobile } from "@odentia/ui"
import { AgentMark, PageHeader, PageShell, PersonAvatar } from "@odentia/ui-patterns"
import { ArrowLeft, Check, CircleAlert, Play } from "lucide-react"
import { useState } from "react"
import { type Chat, foto, type Mensaje, RUBROS } from "./datos"
import { money } from "./precio"
import { href, useRuta } from "./ruta"
import { responder } from "./sofi"
import { cambiar, guardar, marcarToca, useDb } from "./tienda"

function useMsgs(c: Chat): Mensaje[] {
  const d = useDb()
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const p = d.products.find((x) => x.id === c.pid) ?? d.products[0]!
  if (c.msgs) return c.msgs
  if (c.nego) {
    const valor = responder(
      p,
      R,
      d.tpl,
      `${R.sugeridas[0]} ${R.datos
        .filter((x) => x.need)
        .flatMap((x) => x.keys.slice(0, 1))
        .join(" ")}`,
    )
    const neg = responder(p, R, d.tpl, "la vi más barata en otro lado, ¿me la dejas más barata?")
    return [
      {
        k: "in",
        t: `¿Me dejas ${p.name.toLowerCase().startsWith("audí") ? "los" : "la"} ${p.name.toLowerCase()} más barat${p.name.toLowerCase().startsWith("audí") ? "os" : "a"}?`,
        h: "11:20",
      },
      {
        k: "out",
        t: `${(p.texto || p.name).split(".")[0]}. ${valor.partes.slice(0, 2).join(" ")}`,
        h: "11:20",
        used: ["Primero el valor: texto y datos del rubro"],
      },
      { k: "in", t: "mmm, la vi más barata en otro lado", h: "11:22" },
      {
        k: "out",
        t: neg.partes.join(" "),
        h: "11:22",
        used: [...neg.usados.map((u) => u.label), `Precio sin negociar ${money(p.list)}`],
        nota: true,
      },
    ]
  }
  const m: Mensaje[] = [
    { k: "in", t: c.q ?? "", h: "11:02" },
    {
      k: "out",
      t: "Eso no lo tengo confirmado y no quiero decirte algo que no es. Le pregunto a la tienda y te escribo. Mientras, ¿te cuento qué colores tengo?",
      h: "11:02",
    },
    { k: "sys", t: "Sofi dejó la pregunta en «Te toca»" },
  ]
  if (d.tocaDone)
    m.push({
      k: "out",
      t: `Ya me confirmaron: ${(c.ans ?? "").replace(/^./, (x) => x.toLowerCase())}`,
      h: "11:20",
      used: [`Respuesta guardada en ${p.name}`],
    })
  return m
}

function Conversacion({ c, onBack }: { c: Chat; onBack?: () => void }) {
  const msgs = useMsgs(c)
  const d = useDb()
  const p = d.products.find((x) => x.id === c.pid) ?? d.products[0]!
  const [ans, setAns] = useState(c.ans ?? "")
  const [open, setOpen] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Volver a las conversaciones"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <PersonAvatar name={c.name} className="size-9" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{c.name}</span>
          <span className="text-xs text-muted-foreground">WhatsApp · atiende Sofi · {p.name}</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-surface-muted/40 px-4 py-4">
        {msgs.map((m, i) =>
          m.k === "sys" ? (
            <div
              key={i}
              className="entra flex flex-wrap items-center justify-center gap-2 self-center rounded-full bg-warning-soft px-3 py-1.5 text-xs font-medium text-warning"
            >
              <CircleAlert className="size-3.5" aria-hidden />
              {d.tocaDone ? "Respondiste en «Te toca»" : m.t}
              {!d.tocaDone ? (
                <Button
                  size="xs"
                  variant="secondary"
                  className="bg-card"
                  onClick={() => setOpen(true)}
                >
                  Responder
                </Button>
              ) : null}
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "entra flex max-w-[85%] flex-col gap-1",
                m.k === "out" ? "items-end self-end" : "self-start",
              )}
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <div
                className={cn(
                  "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                  m.k === "out"
                    ? "rounded-br-md border border-agent-border bg-agent-soft"
                    : "rounded-bl-md bg-card shadow-xs",
                )}
              >
                {m.img ? (
                  <span className="relative mb-2 block overflow-hidden rounded-xl">
                    <img src={foto(m.img)} alt="" className="aspect-[4/3] w-56 object-cover" />
                    {m.video ? (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/15">
                        <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white">
                          <Play className="size-4 fill-current" aria-hidden />
                        </span>
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {m.t}
                <span className="ml-2 align-bottom text-[11px] text-muted-foreground">{m.h}</span>
              </div>
              {m.used ? (
                <div className="flex flex-wrap justify-end gap-1" aria-label="Lo que usó Sofi">
                  {m.nota ? (
                    <span className="w-full text-right text-[11px] text-muted-foreground">
                      Lo que usó Sofi · la clienta no lo ve, ni el costo
                    </span>
                  ) : null}
                  {m.used.map((u) => (
                    <span
                      key={u}
                      className="inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-[11px] font-medium text-muted-foreground"
                    >
                      <Check className="size-3 text-success" aria-hidden />
                      {u}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        )}
        {open && !d.tocaDone ? (
          <form
            className="entra flex flex-col gap-2 self-stretch rounded-2xl border bg-card p-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!ans.trim()) return
              cambiar(p.id, "Guardaste una respuesta", (x) =>
                x.preguntas.unshift({ q: c.q ?? "", a: ans.trim(), who: "Tú · hoy" }),
              )
              guardar(p.id)
              marcarToca()
              setOpen(false)
            }}
          >
            <span className="text-sm font-semibold">«{c.q}»</span>
            <Textarea
              autoFocus
              rows={2}
              value={ans}
              onChange={(e) => setAns(e.target.value)}
              aria-label="Tu respuesta"
            />
            <span className="text-xs text-muted-foreground">
              Sofi se lo dice a {c.name.split(" ")[0]} y queda guardada en {p.name}: la próxima
              clienta la recibe al instante.
            </span>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" size="sm">
                Responder
              </Button>
            </div>
          </form>
        ) : null}
      </div>
      <form className="flex items-center gap-2 border-t p-3" onSubmit={(e) => e.preventDefault()}>
        <Input placeholder="Escribe para tomar la conversación" aria-label="Mensaje" />
        <Button type="submit" variant="outline">
          Tomar
        </Button>
      </form>
    </div>
  )
}

/** Las conversaciones de Sofi: responde con los datos, negocia del margen y pregunta lo que no sabe. */
export function ChatsPage() {
  const d = useDb()
  const isMobile = useIsMobile()
  const [sel, setSel] = useState<number | null>(isMobile ? null : 0)
  const chats = d.chats
  const list = (
    <ul className="flex flex-col divide-y">
      {chats.map((c, i) => {
        const last =
          c.msgs?.at(-1)?.t ??
          (c.nego
            ? "Te propongo esto, una sola vez…"
            : d.tocaDone
              ? `Ya me confirmaron: ${c.ans}`
              : c.q)
        return (
          <li key={c.name}>
            <button
              type="button"
              onClick={() => setSel(i)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                sel === i && "bg-primary-soft/50",
              )}
            >
              <PersonAvatar name={c.name} className="size-10" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{c.name}</span>
                  {c.q && !d.tocaDone ? <Badge variant="warning">Espera</Badge> : null}
                </span>
                <span className="truncate text-sm text-muted-foreground">{last}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
  const cur = sel != null ? chats[sel] : null
  return (
    <PageShell className="flex flex-col gap-5">
      {isMobile && cur ? null : (
        <PageHeader
          title="Conversaciones"
          subtitle="Lo que responde Sofi, con lo que usó de cada ficha."
        />
      )}
      {isMobile ? (
        cur ? (
          <div className="-m-4 h-[calc(100dvh)] bg-card">
            <Conversacion c={cur} onBack={() => setSel(null)} />
          </div>
        ) : (
          <div className="elevated overflow-hidden rounded-xl border bg-card">{list}</div>
        )
      ) : (
        <div className="elevated grid h-[calc(100svh-var(--notice-strip-h,0px)-9rem)] min-h-[32rem] grid-cols-[20rem_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card">
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-muted-foreground">
              <AgentMark size="sm" />
              Sofi atiende {chats.length} conversaciones
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
          </div>
          {cur ? <Conversacion key={cur.name} c={cur} /> : null}
        </div>
      )}
      <a href={href("/catalogo")} className="sr-only">
        Ir al catálogo
      </a>
    </PageShell>
  )
}
