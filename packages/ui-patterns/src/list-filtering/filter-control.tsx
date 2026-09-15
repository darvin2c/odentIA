import { common } from "../common.js";
import {
  Button,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Slider,
  cn,
} from "@odentia/ui";
import { Check, ChevronDown, Search, X } from "lucide-react";
import * as React from "react";
import { Calendar } from "./calendar.js";
import type { FilterDef, FilterOption } from "./filter-def.js";
import { paramKeys } from "./filter-def.js";
import { useListSearch } from "./list-search.js";

export interface FilterControlProps {
  filter: FilterDef;
  layout: "popover" | "inline";
}

function selectedValues(raw?: string): string[] {
  return raw?.split(",").filter(Boolean) ?? [];
}

function optionLabels(options: FilterOption[], values: string[]): string[] {
  const labels = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => labels.get(value) ?? value);
}

const LOCAL_OPTION_SEARCH_MINIMUM = 8;

function normalizeOptionSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-PE");
}

function useOptionSearch(options: FilterOption[]) {
  const [query, setQuery] = React.useState("");
  const searchable = options.length >= LOCAL_OPTION_SEARCH_MINIMUM;
  const visibleOptions = React.useMemo(() => {
    const normalizedQuery = normalizeOptionSearch(query.trim());
    if (!searchable || !normalizedQuery) return options;
    return options.filter((option) =>
      normalizeOptionSearch(option.label).includes(normalizedQuery),
    );
  }, [options, query, searchable]);

  return { query, searchable, setQuery, visibleOptions };
}

function OptionSearch({
  label,
  query,
  onQueryChange,
}: {
  label: string;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <InputGroup className="mb-1 bg-surface">
      <InputGroupAddon align="inline-start">
        <Search aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={query}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          onQueryChange(event.target.value)
        }
        placeholder={common.filters.search}
        aria-label={`${common.filters.search} ${label}`}
      />
    </InputGroup>
  );
}
const shortDateFormatter = new Intl.DateTimeFormat("es-PE", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return shortDateFormatter.format(new Date(year, month - 1, day));
}


export function hasFilterValue(
  filter: FilterDef,
  get: (key: string) => string | undefined,
): boolean {
  return paramKeys(filter).some((key) => Boolean(get(key)));
}

export function filterSummary(
  filter: FilterDef,
  get: (key: string) => string | undefined,
): string | undefined {
  if (filter.type === "select" || filter.type === "multi") {
    const labels = optionLabels(filter.options, selectedValues(get(filter.key)));
    if (labels.length === 0) return undefined;
    return labels.length > 2 ? String(labels.length) : labels.join(", ");
  }
  if (filter.type === "number-range") {
    const min = get(`${filter.key}_min`);
    const max = get(`${filter.key}_max`);
    if (!min && !max) return undefined;
    const display = (value?: string) => {
      if (!value) return undefined;
      return filter.money ? `S/ ${(Number(value) / 100).toFixed(2)}` : value;
    };
    return [display(min), display(max)].filter(Boolean).join(" – ");
  }
  if (filter.type === "date") return formatDate(get(`${filter.key}_on`));
  const from = formatDate(get(`${filter.key}_from`));
  const to = formatDate(get(`${filter.key}_to`));
  return [from, to].filter(Boolean).join(" – ") || undefined;
}

function ClearFilterButton({ filter }: { filter: FilterDef }) {
  const { get, setParams } = useListSearch();
  if (!hasFilterValue(filter, get)) return null;
  return (
    <div className="border-t border-border pt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          setParams(Object.fromEntries(paramKeys(filter).map((key) => [key, undefined])))
        }
      >
        {common.filters.clear}
      </Button>
    </div>
  );
}

function MultiOptions({ filter }: { filter: Extract<FilterDef, { type: "multi" }> }) {
  const { get, setParam } = useListSearch();
  const selected = selectedValues(get(filter.key));
  const { query, searchable, setQuery, visibleOptions } = useOptionSearch(filter.options);
  const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const firstSelected = visibleOptions.findIndex((option) => selected.includes(option.value));
  const [focusIndex, setFocusIndex] = React.useState(Math.max(firstSelected, 0));

  React.useEffect(() => {
    setFocusIndex(0);
  }, [query]);

  function toggle(value: string) {
    const next = selected.includes(value)
      ? selected.filter((current) => current !== value)
      : [...selected, value];
    setParam(filter.key, next.length > 0 ? next.join(",") : undefined);
  }

  function focusOption(index: number) {
    if (visibleOptions.length === 0) return;
    const nextIndex = (index + visibleOptions.length) % visibleOptions.length;
    setFocusIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOption(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusOption(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOption(0);
        break;
      case "End":
        event.preventDefault();
        focusOption(visibleOptions.length - 1);
        break;
    }
  }

  return (
    <div>
      {searchable ? (
        <OptionSearch label={filter.label} query={query} onQueryChange={setQuery} />
      ) : null}
      {visibleOptions.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {common.filters.noResults}
        </p>
      ) : (
        <ScrollArea className="max-h-72">
          <div
            role="listbox"
            aria-label={filter.label}
            aria-multiselectable="true"
            className="space-y-0.5 p-1"
          >
            {visibleOptions.map((option, index) => {
              const isSelected = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={focusIndex === index ? 0 : -1}
                  className={cn(
                    "flex min-h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50",
                    isSelected && "font-medium",
                  )}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                  onClick={() => toggle(option.value)}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.count !== undefined ? (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {option.count}
                    </span>
                  ) : null}
                  <Check
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 text-accent-foreground transition-opacity",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function SelectOptions({
  filter,
  close,
}: {
  filter: Extract<FilterDef, { type: "select" }>;
  close?: () => void;
}) {
  const { get, setParam } = useListSearch();
  const selected = get(filter.key);
  const { query, searchable, setQuery, visibleOptions } = useOptionSearch(filter.options);

  return (
    <div>
      {searchable ? (
        <OptionSearch label={filter.label} query={query} onQueryChange={setQuery} />
      ) : null}
      {visibleOptions.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {common.filters.noResults}
        </p>
      ) : (
        <ScrollArea className="max-h-72">
          <div role="listbox" aria-label={filter.label} className="space-y-1">
            {visibleOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected === option.value}
                className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-muted"
                onClick={() => {
                  setParam(filter.key, option.value);
                  close?.();
                }}
              >
                <Check
                  className={cn(
                    "size-4",
                    selected === option.value ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="flex-1">{option.label}</span>
                {option.count !== undefined ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {option.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function NumberRangeControl({
  filter,
}: {
  filter: Extract<FilterDef, { type: "number-range" }>;
}) {
  const { get, setParams } = useListSearch();
  const minKey = `${filter.key}_min`;
  const maxKey = `${filter.key}_max`;
  const fromParam = (value?: string) =>
    value === undefined ? "" : String(filter.money ? Number(value) / 100 : Number(value));
  const [minimum, setMinimum] = React.useState(() => fromParam(get(minKey)));
  const [maximum, setMaximum] = React.useState(() => fromParam(get(maxKey)));
  const minimumParam = get(minKey);
  const maximumParam = get(maxKey);

  React.useEffect(() => setMinimum(fromParam(minimumParam)), [filter.money, minimumParam]);
  React.useEffect(() => setMaximum(fromParam(maximumParam)), [filter.money, maximumParam]);

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      const toParam = (value: string) => {
        if (!value) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return undefined;
        return String(filter.money ? Math.round(parsed * 100) : Math.round(parsed));
      };
      const nextMinimum = toParam(minimum);
      const nextMaximum = toParam(maximum);
      if (nextMinimum === minimumParam && nextMaximum === maximumParam) return;
      setParams({ [minKey]: nextMinimum, [maxKey]: nextMaximum }, { replace: true });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [filter.money, maxKey, maximum, maximumParam, minKey, minimum, minimumParam, setParams]);

  const sliderMaximum = Math.max(
    filter.money ? 1_000 : 100_000,
    Number(minimum) || 0,
    Number(maximum) || 0,
  );
  const sliderValues = [Number(minimum) || 0, Number(maximum) || sliderMaximum];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step={filter.money ? "0.5" : "1"}
          value={minimum}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setMinimum(event.target.value)}
          placeholder={common.filters.min}
          aria-label={`${filter.label} ${common.filters.min}`}
        />
        <Input
          type="number"
          inputMode="decimal"
          min="0"
          step={filter.money ? "0.5" : "1"}
          value={maximum}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setMaximum(event.target.value)}
          placeholder={common.filters.max}
          aria-label={`${filter.label} ${common.filters.max}`}
        />
      </div>
      <Slider
        min={0}
        max={sliderMaximum}
        step={filter.money ? 0.5 : 1}
        value={sliderValues}
        className="mx-auto w-full max-w-xs h-2"
        onValueChange={(values) => {
          const next = Array.isArray(values) ? values : [values];
          setMinimum(String(next[0] ?? 0));
          setMaximum(String(next[1] ?? sliderMaximum));
        }}
      />
    </div>
  );
}

function DateControl({
  filter,
  compact,
}: {
  filter: Extract<FilterDef, { type: "date" | "date-range" }>;
  compact: boolean;
}) {
  const { get, setParam, setParams } = useListSearch();
  if (filter.type === "date") {
    const key = `${filter.key}_on`;
    return (
      <Calendar
        mode="single"
        compact={compact}
        selected={get(key)}
        onSelect={(value) => setParam(key, value)}
      />
    );
  }

  const fromKey = `${filter.key}_from`;
  const toKey = `${filter.key}_to`;
  return (
    <Calendar
      mode="range"
      compact={compact}
      selected={{ from: get(fromKey), to: get(toKey) }}
      onSelect={(value) => setParams({ [fromKey]: value.from, [toKey]: value.to })}
    />
  );
}

function ControlBody({
  filter,
  layout,
  close,
}: FilterControlProps & { close?: () => void }) {
  switch (filter.type) {
    case "multi":
      return <MultiOptions filter={filter} />;
    case "select":
      return <SelectOptions filter={filter} close={close} />;
    case "number-range":
      return <NumberRangeControl filter={filter} />;
    case "date":
    case "date-range":
      return <DateControl filter={filter} compact={layout === "inline"} />;
  }
}

export function FilterControl({ filter, layout }: FilterControlProps) {
  const { get, setParams } = useListSearch();
  const [open, setOpen] = React.useState(false);
  const summary = filterSummary(filter, get);
  const Icon = filter.icon;

  if (layout === "inline") {
    return (
      <section className="space-y-3 border-b border-border pb-4 last:border-0">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          {Icon ? <Icon className="size-4" /> : null}
          <span>{filter.label}</span>
        </div>
        <ControlBody filter={filter} layout={layout} />
        <ClearFilterButton filter={filter} />
      </section>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "inline-flex h-9 max-w-64 shrink-0 items-center rounded-full border bg-surface text-foreground transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
          summary ? "border-accent" : "border-border hover:bg-surface-muted",
        )}
      >
        {summary ? (
          <button
            type="button"
            className="ml-1 flex size-7 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`${common.filters.clear}: ${filter.label}`}
            onClick={() => {
              setOpen(false);
              setParams(Object.fromEntries(paramKeys(filter).map((key) => [key, undefined])));
            }}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <PopoverTrigger
          render={
            <button
              type="button"
              className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium outline-none"
              aria-label={summary ? `${filter.label}: ${summary}` : filter.label}
              title={summary ? `${filter.label}: ${summary}` : filter.label}
            >
              {!summary && Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
              <span className="truncate">
                {summary ? `${filter.label}: ${summary}` : filter.label}
              </span>
              <ChevronDown
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </button>
          }
        />
      </div>
      <PopoverContent
        align="start"
        className={cn(
          filter.type === "date-range"
            ? "w-[46rem] max-w-[calc(100vw-2rem)] p-4"
            : filter.type === "date" || filter.type === "number-range"
              ? "w-80 p-4"
              : "w-72 p-2",
        )}
      >
        <ControlBody filter={filter} layout={layout} close={() => setOpen(false)} />
        <ClearFilterButton filter={filter} />
      </PopoverContent>
    </Popover>
  );
}
