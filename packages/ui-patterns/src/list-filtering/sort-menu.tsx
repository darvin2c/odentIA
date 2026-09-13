import { common } from "../common.js";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@odentia/ui";
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from "lucide-react";
import type { SortOption } from "./filter-def.js";
import { useListSearch } from "./list-search.js";

export interface SortMenuProps {
  options: SortOption[];
  compact?: boolean;
}

export function SortMenu({ options, compact = false }: SortMenuProps) {
  const { get, setParam } = useListSearch();
  const sort = get("sort");
  const field = sort?.replace(/^-/, "");
  const active = options.find((option) => option.value === field);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            aria-label={active?.label ?? common.filters.sort}
          >
            <ArrowUpDown />
            <span className={compact ? "hidden sm:inline" : undefined}>
              {active?.label ?? common.filters.sort}
            </span>
            {sort ? (
              <span className="flex min-w-5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-xs text-accent-foreground">
                1
              </span>
            ) : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={() => setParam("sort", undefined)}>
          <Check className={sort ? "opacity-0" : "opacity-100"} />
          {common.filters.sortDefault}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((option) => {
          const isActive = field === option.value;
          const descending = isActive && sort?.startsWith("-");
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => {
                if (!isActive) {
                  setParam("sort", option.value);
                  return;
                }
                setParam("sort", descending ? option.value : `-${option.value}`);
              }}
            >
              <Check className={isActive ? "opacity-100" : "opacity-0"} />
              <span className="flex-1">{option.label}</span>
              {isActive ? descending ? <ArrowDown /> : <ArrowUp /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
