import { common } from "../common.js";
import { Button, cn } from "@odentia/ui";
import {
  addDays,
  addMonths,
  endOfMonth,
  format,
  isAfter,
  isBefore,
  isSameDay,
  startOfMonth,
  startOfWeek,
  subDays,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";

export type CalendarRange = { from?: string; to?: string };

export type CalendarProps =
  | {
      mode: "single";
      selected?: string;
      compact?: boolean;
      onSelect: (value?: string) => void;
    }
  | {
      mode: "range";
      selected?: CalendarRange;
      compact?: boolean;
      onSelect: (value: CalendarRange) => void;
    };

const monthFormatter = new Intl.DateTimeFormat("es-PE", {
  month: "long",
  year: "numeric",
});
const dayFormatter = new Intl.DateTimeFormat("es-PE", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const weekdayFormatter = new Intl.DateTimeFormat("es-PE", { weekday: "short" });

function parseDateOnly(value?: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function todayInLima(): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return new Date(part("year"), part("month") - 1, part("day"));
}

function isInRange(day: Date, from?: Date, to?: Date): boolean {
  return Boolean(from && to && isAfter(day, from) && isBefore(day, to));
}

interface MonthGridProps {
  month: Date;
  selectedFrom?: Date;
  selectedTo?: Date;
  onSelectDay: (day: Date) => void;
}

function MonthGrid({ month, selectedFrom, selectedTo, onSelectDay }: MonthGridProps) {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    weekdayFormatter.format(addDays(gridStart, index)).replace(".", ""),
  );

  return (
    <div className="min-w-0" aria-label={monthFormatter.format(month)}>
      <div className="grid grid-cols-7 text-center">
        {weekdays.map((weekday) => (
          <span key={weekday} className="py-2 text-xs font-medium text-muted-foreground">
            {weekday}
          </span>
        ))}
        {days.map((day) => {
          const isSelected = Boolean(
            (selectedFrom && isSameDay(day, selectedFrom)) ||
              (selectedTo && isSameDay(day, selectedTo)),
          );
          const inRange = isInRange(day, selectedFrom, selectedTo);
          const outsideMonth = isBefore(day, monthStart) || isAfter(day, monthEnd);
          return (
            <button
              key={format(day, "yyyy-MM-dd")}
              type="button"
              aria-label={dayFormatter.format(day)}
              aria-pressed={isSelected}
              onClick={() => onSelectDay(day)}
              className={cn(
                "flex size-9 items-center justify-center justify-self-center rounded-full text-sm outline-none transition-colors hover:bg-surface-muted focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-accent",
                outsideMonth && "text-muted-foreground/50",
                inRange && "w-full rounded-none bg-surface-muted text-foreground",
                isSelected && "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Calendar(props: CalendarProps) {
  const selectedValue =
    props.mode === "single" ? props.selected : (props.selected?.from ?? props.selected?.to);
  const initialSelected = parseDateOnly(selectedValue);
  const [month, setMonth] = React.useState(() => startOfMonth(initialSelected ?? todayInLima()));
  const selectedFrom =
    props.mode === "single" ? parseDateOnly(props.selected) : parseDateOnly(props.selected?.from);
  const selectedTo = props.mode === "range" ? parseDateOnly(props.selected?.to) : undefined;

  React.useEffect(() => {
    const selected = parseDateOnly(selectedValue);
    if (selected) setMonth(startOfMonth(selected));
  }, [selectedValue]);

  function selectDay(day: Date) {
    const value = format(day, "yyyy-MM-dd");
    if (props.mode === "single") {
      props.onSelect(value);
      return;
    }
    if (!selectedFrom || selectedTo) {
      props.onSelect({ from: value });
      return;
    }
    if (isBefore(day, selectedFrom)) {
      props.onSelect({ from: value, to: format(selectedFrom, "yyyy-MM-dd") });
      return;
    }
    props.onSelect({ from: format(selectedFrom, "yyyy-MM-dd"), to: value });
  }

  const nextMonth = addMonths(month, 1);
  const today = todayInLima();
  const showTwoMonths = props.mode === "range" && !props.compact;
  const presets =
    props.mode === "range"
      ? [
          { label: common.filters.today, days: 1 },
          { label: common.filters.last3Days, days: 3 },
          { label: common.filters.last7Days, days: 7 },
          { label: common.filters.last30Days, days: 30 },
        ]
      : [];

  return (
    <div className="w-full space-y-3">
      <div className="grid grid-cols-[2rem_1fr_2rem] items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={common.filters.previous}
          onClick={() => setMonth((current) => addMonths(current, -1))}
        >
          <ChevronLeft />
        </Button>
        <div className={cn("grid text-center", showTwoMonths && "grid-cols-2 gap-6")}>
          <p className="text-sm font-medium capitalize text-foreground">
            {monthFormatter.format(month)}
          </p>
          {showTwoMonths ? (
            <p className="text-sm font-medium capitalize text-foreground">
              {monthFormatter.format(nextMonth)}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={common.filters.next}
          onClick={() => setMonth((current) => addMonths(current, 1))}
        >
          <ChevronRight />
        </Button>
      </div>

      <div className={cn("grid gap-4", showTwoMonths && "grid-cols-[1fr_1fr_auto]")}>
        <MonthGrid
          month={month}
          selectedFrom={selectedFrom}
          selectedTo={selectedTo}
          onSelectDay={selectDay}
        />
        {showTwoMonths ? (
          <MonthGrid
            month={nextMonth}
            selectedFrom={selectedFrom}
            selectedTo={selectedTo}
            onSelectDay={selectDay}
          />
        ) : null}
        {props.mode === "range" ? (
          <div
            className={cn(
              "grid grid-cols-2 content-start gap-2 border-t border-border pt-4",
              showTwoMonths && "w-36 grid-cols-1 border-l border-t-0 pl-4 pt-0",
            )}
          >
            {presets.map((preset) => {
              const from = format(subDays(today, preset.days - 1), "yyyy-MM-dd");
              const to = format(today, "yyyy-MM-dd");
              const active = props.selected?.from === from && props.selected?.to === to;
              return (
                <Button
                  key={preset.days}
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={active}
                  className={cn("w-full justify-center", active && "border-accent bg-surface-muted")}
                  onClick={() => props.onSelect({ from, to })}
                >
                  {preset.label}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
