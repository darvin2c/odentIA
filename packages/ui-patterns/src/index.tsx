/**
 * Composiciones custom sobre primitivas shadcn/Base UI de @odentia/ui.
 * Consumen tokens del theme de @odentia/ui (src/styles/globals.css),
 * nunca hex hardcodeado. Primitivas vienen del registry shadcn (Button, Card,
 * Input, Label, Field, Skeleton, Spinner, Empty, Sheet/Drawer); aquí viven
 * solo las composiciones que no existen en el registry (PageShell, AppShell,
 * FormDrawer, estados, filtros, DataTable, Chip, Marker) y el catálogo de
 * copy compartido `common`.
 */
export { Chip, type ChipProps, type ChipVariant } from "./chip.js";
export { AuthCard } from "./auth-card.js";
export { fieldErrorMessages } from "./field-errors.js";
export { common } from "./common.js";
export { Marker, type MarkerProps, MarkerContent, type MarkerContentProps } from "./marker.js";
export { EmptyState, type EmptyStateProps } from "./empty-state.js";
export { ErrorState, type ErrorStateProps, type ApiErrorShape } from "./error-state.js";
export { FormDrawer, type FormDrawerProps } from "./form-drawer.js";
export { ConfirmDialog, type ConfirmDialogProps, type ConfirmVariant } from "./confirm-dialog.js";
export { RowActions, type RowActionItem, type RowActionsProps, type RowActionTone } from "./row-actions.js";
export { NewButton, type NewButtonProps } from "./new-button.js";
export { SideNav, type SideNavItem, type SideNavProps } from "./side-nav.js";
export { SubmitButton, type SubmitButtonProps } from "./submit-button.js";
export { KpiCard, type KpiCardProps } from "./kpi-card.js";
export {
 DataRefreshMarker,
 type DataRefreshMarkerProps,
 LoadingState,
 type LoadingStateProps,
} from "./loading-state.js";
export { PageShell, type PageShellProps } from "./page-shell.js";
export { AppShell, PageHeader, isNavItemActive } from "./app-shell.js";
export type { AppShellProps, AppShellNavEntry, AppShellNavItem, AppShellNavGroup, AppShellUser } from "./app-shell.js";
export * from "./list-filtering/index.js";
export {
 DataTable,
 type DataTableProps,
 DataTableSkeleton,
 type DataTableSkeletonProps,
} from "./data-table.js";
