/**
 * Composiciones custom sobre primitivas shadcn/Base UI de @odentia/ui.
 * Consumen tokens del theme de @odentia/ui (src/styles/globals.css),
 * nunca hex hardcodeado. Primitivas vienen del registry shadcn (Button, Card,
 * Input, Label, Field, Skeleton, Spinner, Empty, Sheet/Drawer); aquí viven
 * solo las composiciones que no existen en el registry (PageShell, AppShell,
 * SectionNav, FormDrawer, estados, filtros, DataTable) y el catálogo de
 * copy compartido `common`.
 */

export type {
  AppShellNavEntry,
  AppShellNavGroup,
  AppShellNavItem,
  AppShellProps,
  AppShellUser,
  AppShellUserMenuItem,
  NavIcon,
  ShellLinkComponent,
} from "./app-shell.js"
export {
  AgentMark,
  type AgentMarkProps,
  AgentSurface,
  type AgentSurfaceProps,
} from "./agent-mark.js"
export { AppShell, isNavItemActive } from "./app-shell.js"
export {
  FlowDiagram,
  type FlowDiagramActor,
  type FlowDiagramProps,
  type FlowDiagramStep,
} from "./flow-diagram.js"
export { AuthCard } from "./auth-card.js"
export { AuthAside, AuthSplit } from "./auth-split.js"
export { AccessLinkPasswordGate, type AuthFetch } from "./access-link-gate.js"
export { type ClinicAgreementStatus, LegalGate, type LegalLinks } from "./legal-gate.js"
export { NewPasswordDialog } from "./new-password-dialog.js"
export { PasswordInput, type PasswordRequirement } from "./password-input.js"
export { isPasswordBreachedOnline, PASSWORD_MIN_LENGTH, usePasswordRequirements } from "./password-requirements.js"
export { Brand } from "./brand.js"
export {
  BarChart,
  BarList,
  type BarListProps,
  type BarListRow,
  type ChartCategory,
  type ChartPoint,
  ColumnChart,
  type ColumnChartProps,
  type ColumnSeries,
  DonutChart,
  FunnelChart,
  type HeatmapAxis,
  HeatmapGrid,
  type HeatmapGridProps,
  niceTicks,
  scaleLevel,
  type SeriesTone,
  ShareBar,
  type SharePart,
  Sparkline,
  TrendChart,
  WaterfallChart,
  type WaterfallChartProps,
  type WaterfallStep,
} from "./charts/index.js"
export { common } from "./common.js"
export { ConfirmDialog, type ConfirmDialogProps, type ConfirmVariant } from "./confirm-dialog.js"
export {
  DataTable,
  type DataTableProps,
  DataTableSkeleton,
  type DataTableSkeletonProps,
} from "./data-table.js"
export type { ColumnViewMeta, DataTableView } from "./data-table-view.js"
export * from "./detail/index.js"
export { EmptyState, type EmptyStateProps } from "./empty-state.js"
export { type ApiErrorShape, ErrorState, type ErrorStateProps } from "./error-state.js"
export * from "./form/index.js"
export {
  HeaderUtilitiesProvider,
  useHeaderUtilities,
} from "./header-utilities.js"
export { KpiCard, type KpiCardProps } from "./kpi-card.js"
export { UsageMeter, type UsageMeterProps, usageMeterLevel } from "./usage-meter.js"
export { PageNotice, type PageNoticeProps } from "./page-notice.js"
export * from "./list-filtering/index.js"
export {
  DataRefreshMarker,
  type DataRefreshMarkerProps,
  LoadingState,
  type LoadingStateProps,
} from "./loading-state.js"
export {
  type DetailMode,
  type DetailPanelSize,
  MasterDetail,
  type MasterDetailProps,
  useDetailMode,
} from "./master-detail.js"
export { DockedSurface, type DockedSurfaceProps, useDockDecision } from "./docked-surface.js"
export { PageHeader, type PageHeaderProps } from "./page-header.js"
export {
  type DraftGuardComponent,
  SideColumn,
  type SideColumnProps,
  type SideColumnWidth,
  SideDockPortal,
  SideDockProvider,
  type SideDockScope,
  SideDockScopeProvider,
  SideDockSlot,
  useSideColumnWidth,
  useSideDock,
  useSideDockScope,
  useSidebarWidth,
} from "./side-dock.js"
export { PageShell, type PageShellProps } from "./page-shell.js"
export * from "./phone/index.js"
export {
  type RowActionItem,
  RowActions,
  type RowActionsProps,
  type RowActionTone,
} from "./row-actions.js"
export { DatePickerButton, type DatePickerButtonProps } from "./date-picker-button.js"
export * from "./dates/index.js"
export * from "./schedule/index.js"
export {
  SectionNav,
  type SectionNavGroup,
  type SectionNavItem,
  type SectionNavMobilePosition,
  type SectionNavProps,
  type SectionNavSide,
} from "./section-nav/index.js"
export {
  type FormatRegion,
  formatCountry,
  formatLocale,
  formatTimeZone,
  setFormatRegion,
} from "./locale.js"
export { normalizeSearchText } from "./text.js"
export {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
  ThemeTabs,
  useTheme,
} from "./theme.js"
export * from "./time-zone/index.js"
