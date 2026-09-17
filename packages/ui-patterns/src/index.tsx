/**
 * Composiciones custom sobre primitivas shadcn/Base UI de @odentia/ui.
 * Consumen tokens del theme de @odentia/ui (src/styles/globals.css),
 * nunca hex hardcodeado. Primitivas vienen del registry shadcn (Button, Card,
 * Input, Label, Field, Skeleton, Spinner, Empty, Sheet/Drawer); aquí viven
 * solo las composiciones que no existen en el registry (PageShell, AppShell,
 * FormDrawer, estados, filtros, DataTable) y el catálogo de
 * copy compartido `common`.
 */

export type {
  AppShellNavEntry,
  AppShellNavGroup,
  AppShellNavItem,
  AppShellProps,
  AppShellUser,
  AppShellUserMenuItem,
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
export { fieldErrorMessages } from "./field-errors.js"
export { FormDrawer, type FormDrawerProps } from "./form-drawer.js"
export { KpiCard, type KpiCardProps } from "./kpi-card.js"
export * from "./list-filtering/index.js"
export {
  DataRefreshMarker,
  type DataRefreshMarkerProps,
  LoadingState,
  type LoadingStateProps,
} from "./loading-state.js"
export { PageShell, type PageShellProps } from "./page-shell.js"
export {
  type RowActionItem,
  RowActions,
  type RowActionsProps,
  type RowActionTone,
} from "./row-actions.js"
export { SubmitButton, type SubmitButtonProps } from "./submit-button.js"
export {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
  ThemeTabs,
  useTheme,
} from "./theme.js"
export { type WizardStep, WizardSteps, type WizardStepsProps } from "./wizard-steps.js"
