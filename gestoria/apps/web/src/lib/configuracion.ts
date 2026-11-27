import type { MyStore } from "./api"

/**
 * Configuración, al pie del menú (lienzo «gestorIA como odentIA», tableros 4 y 10): lo que se
 * ajusta una vez, en grupos, como en las clínicas. Cada apartado lo ve quien puede cambiarlo
 * (`needs`, de `apps/api/src/permisos.ts`): Ventas no ve lo que no puede tocar. Soporte de
 * gestorIA, que solo mira, ve lo que su permiso deja leer (`support`), sin cambiar nada.
 *
 * Los nombres son los títulos de cada página y los de la guía de la Ayuda (`HELP_SCREENS`).
 */
export interface ConfigSection {
  label: string
  /** Dentro de la tienda: `/configuracion…`. */
  path: string
  needs: string
  /** Soporte lo mira (lo lee con `tienda.ver` o `equipo.ver`). */
  support: boolean
}

export interface ConfigGroup {
  label: string
  items: ConfigSection[]
}

export const CONFIG_PATH = "/configuracion"

export const CONFIG_GROUPS: readonly ConfigGroup[] = [
  {
    label: "La tienda",
    items: [
      { label: "Datos de la tienda", path: CONFIG_PATH, needs: "configuracion", support: true },
      { label: "Tu marca", path: `${CONFIG_PATH}/marca`, needs: "configuracion", support: true },
      {
        label: "Equipo",
        path: `${CONFIG_PATH}/equipo`,
        needs: "equipo.gestionar",
        support: true,
      },
    ],
  },
  {
    label: "Ventas",
    items: [
      // «Probar a Sofi» sirve al ajustarla: es de quien cambia la configuración.
      { label: "Sofi", path: `${CONFIG_PATH}/sofi`, needs: "configuracion", support: false },
      {
        label: "Medios de pago",
        path: `${CONFIG_PATH}/medios-de-pago`,
        needs: "configuracion",
        support: true,
      },
    ],
  },
  {
    label: "Entregas",
    items: [
      {
        label: "Formas de entrega y zonas",
        path: `${CONFIG_PATH}/entregas`,
        needs: "configuracion",
        support: true,
      },
    ],
  },
  {
    label: "Tu cuenta gestorIA",
    items: [{ label: "Plan y pagos", path: `${CONFIG_PATH}/plan`, needs: "plan", support: false }],
  },
]

type Seat = Pick<MyStore, "role" | "permissions">

export function seesSection(store: Seat, section: ConfigSection): boolean {
  return store.permissions.includes(section.needs) || (store.role === "support" && section.support)
}

/** Los grupos con lo que ve quien está; sin los que quedan vacíos. */
export function configGroupsFor(store: Seat): ConfigGroup[] {
  return CONFIG_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => seesSection(store, item)),
  })).filter((group) => group.items.length > 0)
}

/** El apartado de una ruta de la tienda (`/configuracion/marca`), o null si no es uno. */
export function configSectionOf(path: string): ConfigSection | null {
  return CONFIG_GROUPS.flatMap((group) => group.items).find((item) => item.path === path) ?? null
}
