/**
 * Agenda: la rejilla vertical por recurso (Día), por día (Semana) y de un solo
 * carril (teléfono), la lista del día, los huecos y sus piezas. Contrato en
 * `types.ts`; la aritmética de tiempo en `time.ts`; el núcleo de arrastre en
 * `drag.ts` (puntero, pulsación larga táctil y teclado con Alt+Intro).
 */

export {
  type ScheduleAgendaAction,
  type ScheduleAgendaItem,
  ScheduleAgendaList,
  type ScheduleAgendaListProps,
} from "./agenda-list.js"
export { conflictLabel, findScheduleConflicts, type ScheduleConflict } from "./conflicts.js"
export { type AxisTarget, type UseAxisDragConfig, useAxisDrag } from "./axis-drag.js"
export { entryAccessibleName } from "./block.js"
export { ScheduleCard, type ScheduleCardProps } from "./card.js"
export { ScheduleDayStrip, type ScheduleDayStripProps } from "./day-strip.js"
export {
  type DragGeometry,
  DragLiveRegion,
  type DragSessionInfo,
  type EntryDragBlockProps,
  type EntryDragResizeProps,
  type ResizeEdge,
  type UseEntryDragResult,
  useEntryDrag,
} from "./drag.js"
export { ScheduleGrid, type ScheduleGridProps } from "./grid.js"
export { type LanePlacement, layoutOverlaps } from "./layout.js"
export { SCHEDULE_SMALL_QUERY, useMediaQuery } from "./media.js"
export { useScheduleNow } from "./now.js"
export {
  clipRanges,
  type DaySegment,
  type DaySegmentKind,
  dayRangeOf,
  daySegments,
  formatSpan,
  freeMinutesOf,
  isCovered,
  type MinuteRange,
  mergeRanges,
  overlapsAny,
  subtractRanges,
  windowCovering,
} from "./occupancy.js"
export {
  type ScheduleRangeMarker,
  ScheduleRangePicker,
  type ScheduleRangePickerProps,
  type ScheduleRangeState,
  type ScheduleRangeValue,
  scheduleRangeState,
} from "./range-picker.js"
export { ScheduleResourceChips, type ScheduleResourceChipsProps } from "./resource-chips.js"
export { ResourceSelect, type ResourceSelectOption } from "./resource-select.js"
export {
  entryState,
  entryStateLabel,
  SCHEDULE_AGENDA_LABELS,
  SCHEDULE_STATE_LABELS,
  SCHEDULE_STATUS_LABELS,
  SCHEDULE_STATUS_ORDER,
  StatusDot,
  StatusIcon,
  statusSurfaceClass,
  statusTextClass,
} from "./status.js"
export { ScheduleStatusSummary, type ScheduleStatusSummaryProps } from "./status-summary.js"
export * from "./time.js"
export { ScheduleToolbar, type ScheduleToolbarProps, type ScheduleViewOption } from "./toolbar.js"
export {
  initialsOf,
  ResourceAvatar,
  type ResourceAvatarProps,
  scheduleToneAt,
  scheduleToneClass,
} from "./tone.js"
export type {
  ScheduleAvailability,
  ScheduleBlocked,
  ScheduleColumn,
  ScheduleCreateTarget,
  ScheduleEntry,
  ScheduleEntryHandler,
  ScheduleLane,
  ScheduleMove,
  ScheduleMoveHandler,
  SchedulePreview,
  ScheduleResize,
  ScheduleResizeHandler,
  ScheduleStage,
  ScheduleState,
  ScheduleStatus,
  ScheduleTone,
  ScheduleWindow,
} from "./types.js"
export { SCHEDULE_DEFAULT_WINDOW } from "./types.js"
export {
  ScheduleOccupancyLegend,
  type ScheduleWeekDay,
  ScheduleWeekOverview,
  type ScheduleWeekOverviewProps,
} from "./week-overview.js"
