import type { HelpMore } from "../help-guide.js"
import { INICIO_TAREAS_BANDEJA } from "./inicio-tareas-bandeja.js"
import { AGENDA_EQUIPO } from "./agenda-equipo.js"
import { PERSONAS_VENTAS } from "./personas-ventas.js"
import { CLINICA } from "./clinica.js"
import { DINERO_CATALOGO } from "./dinero-catalogo.js"
import { REPORTES_AGENTES_CANALES } from "./reportes-agentes-canales.js"

/**
 * Lo que cada zona de la app le suma a la guía de la Ayuda: una lista por zona,
 * con las preguntas frecuentes de sus temas. Una pregunta nueva va en la lista
 * de su zona; el tema (la pantalla, su ruta y su párrafo) sigue en
 * `help-guide.ts`. Lo que es solo de odentIA lleva `own`; lo de latidIA y
 * vistIA va en la guía de cada uno (`medical/help.ts`, `optical/help.ts`).
 */
export const HELP_MORE: readonly HelpMore[] = [
  ...INICIO_TAREAS_BANDEJA,
  ...AGENDA_EQUIPO,
  ...PERSONAS_VENTAS,
  ...CLINICA,
  ...DINERO_CATALOGO,
  ...REPORTES_AGENTES_CANALES,
]
