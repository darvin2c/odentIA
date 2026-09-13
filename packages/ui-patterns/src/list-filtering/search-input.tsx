import { common } from "../common.js";
import { Button, Input, cn } from "@odentia/ui";
import { Search, X } from "lucide-react";
import * as React from "react";
import { useListSearch } from "./list-search.js";

export interface SearchInputProps {
  placeholder?: string;
  expandable?: boolean;
  className?: string;
}

export function SearchInput({
  placeholder = common.filters.search,
  expandable = false,
  className,
}: SearchInputProps) {
  const { get, setParam } = useListSearch();
  const query = get("q") ?? "";
  const [value, setValue] = React.useState(query);

  React.useEffect(() => {
    setValue(query);
  }, [query]);

  React.useEffect(() => {
    if (value === query) return;
    const timeout = window.setTimeout(() => {
      setParam("q", value.trim() || undefined, { replace: true });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [query, setParam, value]);

  return (
    <div
      className={cn(
        expandable
          ? "relative w-36 shrink-0 transition-[width] duration-200 ease-out focus-within:w-64 motion-reduce:transition-none"
          : "relative w-full min-w-52",
        className,
      )}
    >
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        type="search"
        value={value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 rounded-full bg-surface pl-9 pr-9"
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1 top-1/2 -translate-y-1/2"
          aria-label={common.filters.clear}
          onClick={() => {
            setValue("");
            setParam("q", undefined, { replace: true });
          }}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}
