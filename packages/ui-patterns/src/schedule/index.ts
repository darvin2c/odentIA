/**
 * Agenda: el timeline — eje de tiempo por recurso (escritorio) y stream
 * vertical por día (móvil) — con arrastrar y soltar, scroll infinito por
 * ambos bordes y franja de semana. Contrato en `types.ts`; la aritmética de
 * tiempo en `time.ts`; el núcleo de arrastre en `drag.ts` (puntero,
 * pulsación larga táctil y teclado con Alt+Intro).
 */

export { conflictLabel, findScheduleConflicts, type ScheduleConflict } from "./conflicts.js"
export { type AxisTarget, type UseAxisDragConfig, useAxisDrag } from "./axis-drag.js"
export { ScheduleBlock } from "./block.js"
export {
  type DragGeometry,
  DragLiveRegion,
  type DragSessionInfo,
  type EntryDragBlockProps,
  type EntryDragResizeProps,
  type UseEntryDragResult,
  useEntryDrag,
} from "./drag.js"
export { type LanePlacement, layoutOverlaps } from "./layout.js"
export { SCHEDULE_SMALL_QUERY, useMediaQuery } from "./media.js"
export { useScheduleNow } from "./now.js"
export { ResourceSelect, type ResourceSelectOption } from "./resource-select.js"
export { useInfiniteSentinel } from "./sentinel.js"
export { SCHEDULE_STATUS_LABELS, StatusDot, statusBlockClasses } from "./status.js"
export * from "./time.js"
export {
  ScheduleTimeline,
  type ScheduleTimelineApi,
  type ScheduleTimelineProps,
} from "./timeline.js"
export { ScheduleToolbar, type ScheduleToolbarProps, type ScheduleViewOption } from "./toolbar.js"
export type {
  ScheduleBlocked,
  ScheduleColumn,
  ScheduleEntry,
  ScheduleEntryHandler,
  ScheduleExtendHandler,
  ScheduleMove,
  ScheduleMoveHandler,
  ScheduleResizeHandler,
  ScheduleSlot,
  ScheduleStatus,
  ScheduleWindow,
} from "./types.js"
export { SCHEDULE_DEFAULT_WINDOW } from "./types.js"
export { ScheduleWeekStrip, type ScheduleWeekStripProps } from "./week-strip.js"
