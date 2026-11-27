import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@odentia/ui/components/dropdown-menu"
import { type KeyboardEvent, useRef, useState } from "react"
import type { District } from "./lib/zonas"
import { MAP_COLUMNS, MAP_PLACES, MAP_ROWS, zoneTone } from "./lib/zonas"

/**
 * El mapa esquemático de Lima y Callao (tablero 7): un dibujo propio, no un mapa de calles. Cada
 * distrito es un botón con su nombre y su zona, en su lugar aproximado; tocarlo deja elegir su
 * zona o «No entrego ahí». Con el teclado: Tab entra al mapa, las flechas pasan al distrito de al
 * lado y Enter abre la lista de zonas. La lista de cada zona (con buscador y casillas) hace lo
 * mismo sin mapa y va siempre al lado.
 */

const CELL_W = 80
const CELL_H = 46
const TILE_W = 76
const TILE_H = 42
const WIDTH = MAP_COLUMNS * CELL_W
const HEIGHT = MAP_ROWS * CELL_H

/** La costa, aproximada a la rejilla: el mar al oeste. */
const SEA = [
  [0, 0],
  [3.95, 0],
  [3.95, 0.95],
  [2.95, 0.95],
  [1.95, 1.95],
  [1.95, 3.95],
  [-0.05, 3.95],
  [-0.05, 4.95],
  [1.95, 4.95],
  [1.95, 5.95],
  [2.95, 5.95],
  [2.95, 6.95],
  [3.95, 6.95],
  [3.95, 8.95],
  [5.95, 8.95],
  [5.95, 9.95],
  [6.95, 9.95],
  [6.95, 10.95],
  [7.95, 10.95],
  [7.95, 11.95],
  [8.95, 11.95],
  [8.95, 13],
  [0, 13],
]

export interface MapZone {
  name: string
}

export function LimaMap({
  districts,
  zoneOf,
  zones,
  home,
  canEdit,
  onMove,
}: {
  districts: District[]
  /** La zona de cada distrito (su posición en `zones`); sin zona, no se entrega ahí. */
  zoneOf: Map<string, number>
  zones: MapZone[]
  /** El distrito desde el que despacha la tienda. */
  home: string | null
  canEdit: boolean
  onMove: (code: string, to: number | null) => void
}) {
  const placed = districts.filter((d) => MAP_PLACES[d.code])
  const [focused, setFocused] = useState(home && MAP_PLACES[home] ? home : (placed[0]?.code ?? ""))
  const refs = useRef(new Map<string, HTMLButtonElement>())

  /** El distrito más cercano en esa dirección: primero el de la misma fila o columna. */
  const next = (from: string, dx: number, dy: number): string | null => {
    const [x, y] = MAP_PLACES[from] ?? [0, 0]
    let best: string | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const d of placed) {
      const [cx, cy] = MAP_PLACES[d.code] ?? [0, 0]
      const along = (cx - x) * dx + (cy - y) * dy
      if (along <= 0) continue
      const across = Math.abs((cx - x) * dy) + Math.abs((cy - y) * dx)
      const score = along + across * 3
      if (score < bestScore) {
        bestScore = score
        best = d.code
      }
    }
    return best
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, code: string) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    const to = next(code, move[0], move[1])
    if (to) {
      setFocused(to)
      refs.current.get(to)?.focus()
    }
  }

  return (
    <div className="@container w-full">
      <fieldset
        className="relative m-0 w-full min-w-0 border-0 p-0"
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
      >
        <legend className="sr-only">
          Mapa esquemático de Lima y Callao, por zona. Flechas para moverse entre distritos; Enter
          para cambiar su zona.
        </legend>
        <svg
          aria-hidden
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="absolute inset-0 size-full"
          preserveAspectRatio="none"
        >
          <polygon
            points={SEA.map(([x, y]) => `${(x ?? 0) * CELL_W},${(y ?? 0) * CELL_H}`).join(" ")}
            className="fill-sky-50 dark:fill-sky-950/40"
          />
          <text
            x={CELL_W * 0.4}
            y={CELL_H * 7.2}
            className="fill-sky-700 text-[13px] font-semibold tracking-[0.2em] dark:fill-sky-300"
          >
            MAR
          </text>
        </svg>
        {placed.map((district) => {
          const [x, y] = MAP_PLACES[district.code] ?? [0, 0]
          const zone = zoneOf.get(district.code)
          const isHome = district.code === home
          const label = `${district.name}: ${
            zone === undefined ? "no entregas ahí" : `zona ${zone + 1}, ${zones[zone]?.name ?? ""}`
          }${isHome ? ". Despachas desde aquí" : ""}`
          const tile = (
            <button
              type="button"
              ref={(node) => {
                if (node) refs.current.set(district.code, node)
                else refs.current.delete(district.code)
              }}
              tabIndex={district.code === focused ? 0 : -1}
              aria-label={label}
              title={label}
              onFocus={() => setFocused(district.code)}
              onKeyDown={(event) => onKeyDown(event, district.code)}
              className={cn(
                "absolute flex flex-col items-center justify-center overflow-hidden rounded-md border-[1.5px] px-0.5 text-center leading-tight font-semibold text-foreground transition-colors",
                "focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none",
                zone === undefined
                  ? "border-dashed border-border bg-card text-muted-foreground"
                  : zoneTone(zone),
                isHome && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                canEdit ? "cursor-pointer hover:brightness-95" : "cursor-default",
              )}
              style={{
                left: `${((x * CELL_W) / WIDTH) * 100}%`,
                top: `${((y * CELL_H) / HEIGHT) * 100}%`,
                width: `${(TILE_W / WIDTH) * 100}%`,
                height: `${(TILE_H / HEIGHT) * 100}%`,
                fontSize: "clamp(7px, 1.2cqw, 11px)",
              }}
            >
              <span aria-hidden className="line-clamp-2">
                {district.short}
              </span>
              <span aria-hidden className="font-bold text-muted-foreground">
                {isHome ? "tu tienda" : zone === undefined ? "—" : zone + 1}
              </span>
            </button>
          )
          if (!canEdit) return <span key={district.code}>{tile}</span>
          return (
            <DropdownMenu key={district.code}>
              <DropdownMenuTrigger render={tile} />
              <DropdownMenuContent className="min-w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{district.name}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={zone === undefined ? "ninguna" : String(zone)}
                    onValueChange={(value: string) =>
                      onMove(district.code, value === "ninguna" ? null : Number(value))
                    }
                  >
                    {zones.map((z, index) => (
                      <DropdownMenuRadioItem key={z.name} value={String(index)} closeOnClick>
                        <span
                          aria-hidden
                          className={cn("size-3 shrink-0 rounded-sm border", zoneTone(index))}
                        />
                        Zona {index + 1} · {z.name}
                      </DropdownMenuRadioItem>
                    ))}
                    <DropdownMenuRadioItem value="ninguna" closeOnClick>
                      No entrego ahí
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}
      </fieldset>
    </div>
  )
}
