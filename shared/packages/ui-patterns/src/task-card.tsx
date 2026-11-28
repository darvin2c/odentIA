import { Button, cn } from "@odentia/ui"
import { Check, UserRound } from "lucide-react"
import type * as React from "react"

/** Quién hace lo que toca: alguien del equipo (`person`) o nadie, porque avanza solo (`auto`). */
export type TaskCardOwner = "person" | "auto"

export interface TaskCardProps extends Omit<React.HTMLAttributes<HTMLLIElement>, "title" | "children"> {
  /** El nombre: «Carla Mendoza». */
  title: string
  /** Al lado del nombre, en gris: el número del pedido o de la historia («0164»). */
  reference?: string
  /**
   * La foto de lo que lleva (URL), en un cuadro de 48 px. `null` deja el cuadro vacío: la
   * tarjeta no cambia de forma porque a un producto le falte la foto.
   */
  image?: string | null
  /** Otra cosa en lugar de la foto (`PersonAvatar`, el número de la parada…). Gana sobre `image`. */
  media?: React.ReactNode
  /** La etapa (un `Badge`) y lo que va con ella («Falta S/ 101»), en una línea que se parte si no cabe. */
  status?: React.ReactNode
  /** Datos cortos, uno por línea y recortados: el primero en tinta (lo que lleva), los demás en gris. */
  details?: React.ReactNode[]
  /** Abajo, lo que toca: una frase entera («Empácalo y dáselo a Jhon. Sale de 2 a 6 p. m.»). */
  task: React.ReactNode
  /** `person` (predeterminado): ámbar, con su botón. `auto`: avanza solo, en gris con un visto. */
  owner?: TaskCardOwner
  /** El texto del botón de abajo («Empacar»). Sin él no hay botón. Abre lo mismo que la tarjeta. */
  actionLabel?: string
  /** Lo que abre tocar la tarjeta o su botón (el cajón con lo que toca). Nada se hace en un toque. */
  onOpen: () => void
  /**
   * Nombre accesible de la tarjeta, con lo que hace falta para decidir sin verla: «Carla Mendoza,
   * pedido 0164: Pago por confirmar». Por defecto, el nombre y la referencia. Lleva delante «Abrir:».
   */
  label?: string
  /** Su cajón está abierto al lado. */
  selected?: boolean
}

/**
 * La tarjeta de dos filas: arriba lo que es (la foto, el nombre, la etapa y sus datos), abajo lo
 * que toca (una frase y, si toca a una persona, su único botón). Es la misma en Despachos, en
 * «Te toca» de Inicio y de Pedidos y en la Agenda.
 *
 * Tocar cualquier parte abre lo mismo, y el botón de abajo también: nunca actúa solo, porque
 * todo lo que cambia algo se confirma donde se abre, con el registro a la vista. Con el teclado
 * son dos paradas (la tarjeta y su botón) que abren lo mismo; el resto de la tarjeta se toca por
 * el botón de arriba, estirado sobre toda ella.
 *
 * Arrastrable si recibe las props de `useScheduleDraggable`: `data-dragging` la atenúa y
 * `data-lifting` la achica un punto mientras se mantiene el dedo.
 */
export function TaskCard({
  title,
  reference,
  image,
  media,
  status,
  details = [],
  task,
  owner = "person",
  actionLabel,
  onOpen,
  label,
  selected = false,
  className,
  ...rest
}: TaskCardProps) {
  const person = owner === "person"
  const name = label ?? (reference ? `${title}, ${reference}` : title)
  const picture =
    media ??
    (image === undefined ? null : image ? (
      <img src={image} alt="" className="size-12 shrink-0 rounded-lg bg-muted object-cover" />
    ) : (
      <span aria-hidden className="size-12 shrink-0 rounded-lg bg-muted" />
    ))
  return (
    // Va en una lista (`ul`): Despachos, «Te toca», la Agenda.
    <li
      {...rest}
      data-task-card=""
      data-selected={selected ? "true" : undefined}
      className={cn(
        "relative flex list-none flex-col overflow-hidden rounded-xl border bg-card elevated touch-manipulation select-none [-webkit-touch-callout:none]",
        "transition-[border-color,transform,opacity] duration-200 motion-reduce:transition-none",
        "hover:border-primary has-[[data-task-card-open]:focus-visible]:ring-2 has-[[data-task-card-open]:focus-visible]:ring-ring",
        "data-[dragging=true]:opacity-30 motion-safe:data-[lifting=true]:scale-[0.98]",
        selected && "border-primary ring-1 ring-primary",
        className,
      )}
    >
      {/* El botón de arriba se estira sobre toda la tarjeta (`after:inset-0`): tocar cualquier
          parte lo toca a él; el botón de abajo queda encima y abre lo mismo. */}
      <button
        type="button"
        data-task-card-open=""
        aria-label={`Abrir: ${name}`}
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        className="flex w-full items-start gap-3 p-2.5 text-left outline-none after:absolute after:inset-0 after:content-['']"
      >
        {picture}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-semibold">{title}</span>
            {reference ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{reference}</span>
            ) : null}
          </span>
          {status ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">{status}</span>
          ) : null}
          {details.map((detail, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: las líneas son fijas y no se reordenan: su lugar es lo que son.
              key={index}
              className={cn("truncate text-[13px]", index > 0 && "text-muted-foreground")}
            >
              {detail}
            </span>
          ))}
        </span>
      </button>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-2.5 py-2",
          person ? "bg-warning-soft/60" : "bg-muted/40",
        )}
      >
        <p className="flex min-w-[11rem] flex-1 items-start gap-1.5 text-[13px] leading-snug">
          {person ? (
            <UserRound aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          ) : (
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
          )}
          <span className={person ? undefined : "text-muted-foreground"}>{task}</span>
        </p>
        {actionLabel ? (
          <Button
            type="button"
            className="relative z-10 ml-auto h-11 shrink-0 px-4 whitespace-nowrap"
            aria-label={`${actionLabel}: ${title}`}
            onClick={onOpen}
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
