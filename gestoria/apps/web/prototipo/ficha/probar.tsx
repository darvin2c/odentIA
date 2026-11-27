import { Button, cn, Collapsible, CollapsibleContent, CollapsibleTrigger, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { Check, ChevronUp, CircleAlert, Info, RotateCcw, Store, X } from "lucide-react"
import type { Dispatch, SetStateAction } from "react"
import type { Dato, Producto, Rubro } from "../datos"
import { resumen, saber } from "../sofi"
import { ChatCelular } from "../vitrina/chat"
import { type Compra, nueva } from "../vitrina/compra"
import { PhoneFrame } from "../vitrina/marcos"
import { TiendaCelular } from "../vitrina/tienda"
import { irA, SofiDot } from "./piezas"

/*
 * PARA PROGRAMAR — «Probar como clienta».
 * En la app real, la prueba pasa por la MISMA tubería de Sofi que una conversación real: las mismas
 * herramientas (`apps/api/src/sofi/herramientas.ts`), las mismas reglas de precio (`precio.ts`: mínimo,
 * una sola oferta del margen, plazo real), la misma vitrina y el mismo carrito. Lo único distinto es
 * que la conversación va con el canal «prueba» (`CONVERSATION_CHANNELS` de `packages/db/src/schema.ts`):
 * sus pedidos llevan `test`, no mueven stock, no crean un link de pago real (no cobran) y no cuentan
 * en Reportes ni en Argos. Este prototipo imita esas reglas en el navegador (`vitrina/sofi-chat.ts`).
 */

export function ProbarPanel({
  p,
  R,
  tpl,
  all,
  c,
  set,
  dirty,
  edit,
  onClose,
  onGo,
  className,
}: {
  p: Producto
  R: Rubro
  tpl: Dato[]
  all: Producto[]
  c: Compra
  set: Dispatch<SetStateAction<Compra>>
  dirty: boolean
  edit: boolean
  onClose?: () => void
  /** Antes de ir a un campo (en el celular, cierra el cajón). */
  onGo?: () => void
  className?: string
}) {
  const x = { p, R, tpl, all }
  const L = saber(p, R, tpl)
  const s = resumen(L)
  const go = (target: string) => {
    onGo?.()
    setTimeout(() => irA(target), onGo ? 280 : 0)
  }
  const tab = c.tab
  const faltan = c.uso?.faltan ?? []
  const usados = c.uso?.usados ?? []
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-[15px] font-semibold">Probar como clienta</h2>
          <p className="truncate text-xs text-muted-foreground">{dirty ? "Con la ficha de ahora, con tus cambios sin guardar" : "Lo mismo que vive la clienta, con la ficha de ahora"}</p>
        </div>
        <Popover>
          <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Cómo funciona en la app" />}>
            <Info aria-hidden />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-2 rounded-2xl p-4 text-sm">
            <p className="font-semibold">En la app, es la conversación real</p>
            <p className="text-muted-foreground">
              Pasa por la misma Sofi de un chat de verdad: mismas herramientas, mismas reglas de precio, la misma vitrina y el mismo carrito. Va marcada «prueba»: no mueve
              stock, no cobra y no cuenta en Reportes.
            </p>
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon-sm" aria-label="Empezar la prueba de nuevo" onClick={() => set(nueva(p))}>
          <RotateCcw aria-hidden />
        </Button>
        {onClose ? (
          <Button variant="ghost" size="icon-sm" aria-label="Cerrar la prueba" onClick={onClose}>
            <X aria-hidden />
          </Button>
        ) : null}
      </div>
      <div className="flex justify-center border-b px-4 py-2">
        <ToggleGroup value={[tab]} onValueChange={(v) => v[0] && set((cc) => ({ ...cc, tab: v[0] as Compra["tab"] }))} className="w-full rounded-full bg-muted p-1" aria-label="Cómo llega la clienta">
          {(
            [
              ["chat", "WhatsApp"],
              ["vitrina", "Vitrina"],
            ] as const
          ).map(([v, l]) => (
            <ToggleGroupItem key={v} value={v} className="h-8 flex-1 rounded-full text-[13px] font-medium data-pressed:bg-background data-pressed:shadow-xs">
              {v === "vitrina" ? <Store className="size-3.5" aria-hidden /> : null}
              {l}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex min-h-0 flex-1 bg-muted/40 p-2">
        <PhoneFrame bare height={760} className="h-full">
          {tab === "chat" ? (
            <ChatCelular x={x} c={c} set={set} onVitrina={() => set((cc) => ({ ...cc, tab: "vitrina" }))} />
          ) : (
            <TiendaCelular x={x} c={c} set={set} onChat={() => set((cc) => ({ ...cc, tab: "chat", sheet: null }))} />
          )}
        </PhoneFrame>
      </div>
      <Collapsible defaultOpen className="border-t">
        <CollapsibleTrigger className="group flex w-full items-center gap-2.5 px-4 py-2.5 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/60">
          <SofiDot done={s.done} total={s.total} vendeSola={s.vendeSola} size={20} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            Qué usó Sofi
            {faltan.length ? <span className="text-warning"> · le faltó {faltan.length}</span> : null}
          </span>
          <span className="text-xs text-muted-foreground">
            sabe {s.done} de {s.total}
          </span>
          <ChevronUp className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-250 ease-out data-ending-style:h-0 data-starting-style:h-0">
          <div className="flex max-h-44 flex-col gap-2 overflow-y-auto px-4 pb-3">
            {!usados.length && !faltan.length ? <p className="text-xs text-muted-foreground">Pregunta algo como clienta y aquí ves de qué dato salió cada respuesta.</p> : null}
            {usados.length ? (
              <div className="flex flex-wrap gap-1" aria-label="Lo que usó Sofi">
                {usados.map((u) => (
                  <button key={u.label} type="button" onClick={() => go(u.target)} className="entra inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground">
                    <Check className="size-3 text-success" aria-hidden />
                    {u.label}
                  </button>
                ))}
              </div>
            ) : null}
            {faltan.map((f) => (
              <div key={f.label} className="entra flex items-center gap-2 text-sm">
                <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 flex-1">Le faltó: {f.label.toLowerCase()}</span>
                {edit ? (
                  <Button size="xs" variant="outline" onClick={() => go(f.target)}>
                    Completar
                  </Button>
                ) : null}
              </div>
            ))}
            {s.needMiss.length || s.plusMiss.length ? (
              <p className="text-xs text-muted-foreground">
                Aún no sabe: {[...s.needMiss, ...s.plusMiss].map((x2) => x2.label.toLowerCase()).join(", ")}.
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
