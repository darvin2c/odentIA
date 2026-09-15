import { common } from "../common.js";
import { Button, Calendar as DatePicker, cn } from "@odentia/ui";
import { es } from "date-fns/locale";
import { format, subDays } from "date-fns";

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

/** Día local a medianoche desde una fecha-sola `yyyy-MM-dd` (sin desfase UTC). */
function parseDateOnly(value?: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function toDateOnly(value: Date | undefined): string | undefined {
  return value ? format(value, "yyyy-MM-dd") : undefined;
}

/** "Hoy" en America/Lima, no en el huso del navegador: los presets de rango
 * se anclan a la fecha de Lima igual que antes de la migración. */
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

const RANGE_PRESETS = [
  { label: common.filters.today, days: 1 },
  { label: common.filters.last3Days, days: 3 },
  { label: common.filters.last7Days, days: 7 },
  { label: common.filters.last30Days, days: 30 },
];

/**
 * Envoltorio del `Calendar` estándar (react-day-picker) que conserva la API
 * pública fecha-sola (`yyyy-MM-dd`), los modos single/range y los accesos
 * rápidos de rango anclados a Lima.
 */
export function Calendar(props: CalendarProps) {
  if (props.mode === "single") {
    return (
      <DatePicker
        mode="single"
        locale={es}
        selected={parseDateOnly(props.selected)}
        onSelect={(day) => props.onSelect(toDateOnly(day))}
      />
    );
  }

  const selected = {
    from: parseDateOnly(props.selected?.from),
    to: parseDateOnly(props.selected?.to),
  };
  const today = todayInLima();

  return (
    <div className="w-full space-y-3">
      <DatePicker
        mode="range"
        locale={es}
        numberOfMonths={props.compact ? 1 : 2}
        selected={selected}
        onSelect={(range) =>
          props.onSelect({ from: toDateOnly(range?.from), to: toDateOnly(range?.to) })
        }
      />
      <div
        className={cn(
          "grid grid-cols-2 content-start gap-2 border-t border-border pt-3",
          props.compact && "grid-cols-2",
        )}
      >
        {RANGE_PRESETS.map((preset) => {
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
    </div>
  );
}
