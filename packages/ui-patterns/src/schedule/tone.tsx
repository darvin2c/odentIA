/**
 * Identidad visual de un recurso de la agenda: sus iniciales sobre un color
 * categórico, el mismo en la cabecera de la rejilla, en las fichas del
 * teléfono y en cada fila de la lista. Así «de quién es esta cita» se reconoce
 * sin leer.
 *
 * Paleta categórica (excepción prevista en `packages/ui/AGENTS.md`): tonos que
 * no se confunden con los de estado; por eso no hay verde, ámbar ni rojo. Tampoco
 * el color de la marca ni los de fábrica (turquesa de odentIA, violeta de latidIA, verde de vistIA):
 * ese queda para actuar y lo seleccionado (ADR 0162), y un profesional en ese tono
 * parecía elegido. Los parecidos (azul e índigo, rosa y fucsia) quedan lejos en el
 * ciclo, y las iniciales los distinguen.
 */

import { cn } from "@odentia/ui"

import type { ScheduleTone } from "./types.js"

const TONE_CLASSES: Record<ScheduleTone, string> = {
  0: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  1: "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200",
  2: "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100",
  3: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
  4: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200",
}

const TONE_COUNT = Object.keys(TONE_CLASSES).length

/** Tono estable por posición: con más recursos que tonos, se repite el ciclo. */
export function scheduleToneAt(index: number): ScheduleTone {
  return (((index % TONE_COUNT) + TONE_COUNT) % TONE_COUNT) as ScheduleTone
}

export function scheduleToneClass(tone: ScheduleTone = 0): string {
  return TONE_CLASSES[tone]
}

const TITLE = /^(dra?|lic|sra?|srta)\.?$/i

/**
 * «Dra. Ana Torres» → «AT»; «Unidad dental 1» → «U1»: si el nombre acaba en
 * número, la inicial va con ese número para distinguir la unidad dental 1 de la 2.
 */
export function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean)
  const named = words.filter((word) => !TITLE.test(word))
  const last = named.at(-1)
  if (named.length > 1 && last !== undefined && /^\d+$/.test(last))
    return `${named[0]!.charAt(0)}${last}`.toLocaleUpperCase("es")
  return (named.length > 0 ? named : words)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toLocaleUpperCase("es")
}

const SIZE_CLASSES = {
  sm: "size-7 text-[11px]",
  md: "size-9 text-xs",
} as const

export interface ResourceAvatarProps {
  label: string
  tone?: ScheduleTone
  size?: keyof typeof SIZE_CLASSES
  className?: string
}

/** Iniciales del recurso; decorativas: el nombre va siempre escrito al lado. */
export function ResourceAvatar({ label, tone = 0, size = "md", className }: ResourceAvatarProps) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-bold select-none",
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        className,
      )}
    >
      {initialsOf(label)}
    </span>
  )
}
