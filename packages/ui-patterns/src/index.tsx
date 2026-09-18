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
export { AppShell, isNavItemActive, PageHeader } from "./app-shell.js"
export { AuthCard } from "./auth-card.js"
export { AuthSplit } from "./auth-split.js"
export { common } from "./common.js"
export { ConfirmDialog, type ConfirmDialogProps, type ConfirmVariant } from "./confirm-dialog.js"
export {
  DataTable,
  type DataTableProps,
  DataTableSkeleton,
  type DataTableSkeletonProps,
} from "./data-table.js"
export type { ColumnViewMeta, DataTableView } from "./data-table-view.js"
export { EmptyState, type EmptyStateProps } from "./empty-state.js"
export { type ApiErrorShape, ErrorState, type ErrorStateProps } from "./error-state.js"
export * from "./form/index.js"
export { KpiCard, type KpiCardProps } from "./kpi-card.js"
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
export { PageShell, type PageShellProps } from "./page-shell.js"
export * from "./phone/index.js"
export {
  type RowActionItem,
  RowActions,
  type RowActionsProps,
  type RowActionTone,
} from "./row-actions.js"
export {
  SectionNav,
  type SectionNavItem,
  type SectionNavMobilePosition,
  type SectionNavProps,
  type SectionNavSide,
} from "./section-nav/index.js"
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
