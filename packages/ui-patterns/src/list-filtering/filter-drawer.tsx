import { common } from "../common.js";
import {
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ScrollArea,
  useIsMobile,
} from "@odentia/ui";
import { X } from "lucide-react";
import { FilterControl, hasFilterValue } from "./filter-control.js";
import type { FilterDef } from "./filter-def.js";
import { paramKeys } from "./filter-def.js";
import { useListSearch } from "./list-search.js";

export interface FilterDrawerProps {
  filters: FilterDef[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
}

export function FilterDrawer({
  filters,
  open,
  onOpenChange,
  title = common.filters.label,
}: FilterDrawerProps) {
  const isMobile = useIsMobile();
  const { get, setParams } = useListSearch();
  const hasActiveFilters = filters.some((filter) => hasFilterValue(filter, get));

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      swipeDirection={isMobile ? "down" : "right"}
      showSwipeHandle={isMobile}
    >
      <DrawerContent>
        <div className="flex h-full flex-col overflow-hidden">
          <DrawerHeader className="gap-1 border-b border-border px-6 py-4 pb-4 text-left group-data-[swipe-axis=y]/drawer-popup:text-left">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="sr-only">{title}</DrawerDescription>
          </DrawerHeader>
          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="space-y-5 px-6 py-4">
                {filters.map((filter) => (
                  <FilterControl key={`${filter.type}:${filter.key}`} filter={filter} layout="inline" />
                ))}
              </div>
            </ScrollArea>
          </div>
          <DrawerFooter className="flex-row items-center justify-end gap-2 border-t border-border bg-surface px-6 py-4 pt-4">
            <Button
              type="button"
              variant="secondary"
              disabled={!hasActiveFilters}
              onClick={() =>
                setParams(
                  Object.fromEntries(
                    filters.flatMap((filter) =>
                      paramKeys(filter).map((key) => [key, undefined]),
                    ),
                  ),
                )
              }
            >
              <X />
              {common.filters.clear}
            </Button>
            <Button type="button" onClick={() => onOpenChange(false)}>
              {common.actions.close}
            </Button>
          </DrawerFooter>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
