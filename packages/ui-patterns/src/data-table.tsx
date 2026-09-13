import { common } from "./common.js";
import type { Table as TanStackTable } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import {
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@odentia/ui";

export interface DataTableProps<TData> {
  table: TanStackTable<TData>;
  onRowClick?: (row: TData) => void;
}

export interface DataTableSkeletonProps {
  columnCount?: number;
  rowCount?: number;
  showPagination?: boolean;
  label?: string;
}

const skeletonWidths = ["w-40", "w-20", "w-24", "w-16", "w-8"] as const;

function skeletonWidth(index: number): string {
  return skeletonWidths[index % skeletonWidths.length] ?? "w-20";
}

export function DataTable<TData>({ table, onRowClick }: DataTableProps<TData>) {
  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            className={onRowClick ? "cursor-pointer" : undefined}
            onClick={(event) => {
              if (!onRowClick) return;
              const target = event.target as HTMLElement;
              if (target.closest("button, a, input, select, textarea, [role='menuitem']")) return;
              onRowClick(row.original);
            }}
          >
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function DataTableSkeleton({
  columnCount = 5,
  rowCount = 6,
  showPagination = false,
  label = common.states.loading,
}: DataTableSkeletonProps) {
  const columns = Array.from({ length: columnCount });
  const rows = Array.from({ length: rowCount });

  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      <Table aria-hidden="true">
        <TableHeader>
          <TableRow>
            {columns.map((_, columnIndex) => (
              <TableHead key={columnIndex}>
                <Skeleton className={cn("h-3", skeletonWidth(columnIndex))} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((_, rowIndex) => (
            <TableRow key={rowIndex}>
              {columns.map((_, columnIndex) => (
                <TableCell key={columnIndex}>
                  <Skeleton
                    className={cn(
                      "h-4",
                      skeletonWidth((columnIndex + rowIndex + 1) % skeletonWidths.length),
                    )}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {showPagination ? (
        <div
          aria-hidden="true"
          className="flex items-center justify-between gap-2 border-t border-border p-3"
        >
          <Skeleton className="h-9 w-24 rounded-full" />
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
      ) : null}
    </div>
  );
}
