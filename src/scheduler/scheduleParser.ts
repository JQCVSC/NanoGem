export type ParsedSchedule =
  | { kind: "interval"; raw: string; intervalMs: number }
  | {
      kind: "cron";
      raw: string;
      minutes: Set<number>;
      hours: Set<number>;
      daysOfMonth: Set<number>;
      months: Set<number>;
      daysOfWeek: Set<number>;
    };

const MIN_INTERVAL_MS = 30_000; // 30 seconds minimum
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days maximum

function parseCronField(
  field: string,
  min: number,
  max: number,
  allowSundaySeven = false
): Set<number> {
  const values = new Set<number>();
  const parts = field.split(",");
  if (parts.length === 0) {
    throw new Error(`Empty cron field "${field}"`);
  }

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Invalid empty cron segment in "${field}"`);

    const [rangePart, stepPart] = trimmed.split("/");
    if (trimmed.split("/").length > 2) {
      throw new Error(`Invalid cron step syntax "${trimmed}"`);
    }

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new Error(`Invalid cron step "${stepPart}"`);
      }
      step = Number.parseInt(stepPart, 10);
      if (step < 1 || step > max) {
        throw new Error(`Cron step out of range "${stepPart}"`);
      }
    }

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const bounds = rangePart.split("-");
        if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) {
          throw new Error(`Invalid cron range "${rangePart}"`);
        }
        start = Number.parseInt(bounds[0], 10);
        end = Number.parseInt(bounds[1], 10);
      } else {
        if (!/^\d+$/.test(rangePart)) {
          throw new Error(`Invalid cron value "${rangePart}"`);
        }
        start = Number.parseInt(rangePart, 10);
        end = stepPart !== undefined ? max : start;
      }
    }

    if (start < min || end > (allowSundaySeven ? 7 : max) || start > end) {
      throw new Error(`Cron range out of bounds "${trimmed}"`);
    }

    for (let v = start; v <= end; v += step) {
      values.add(allowSundaySeven && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) {
    throw new Error(`Cron field "${field}" matched no values`);
  }
  return values;
}

/**
 * Validates and parses an interval string (e.g. "30s", "15m", "1h", "7d")
 * or a 5-field cron expression (e.g. "0,15,30,45 * * * *").
 */
export function parseScheduleExpression(rawExpr: string): ParsedSchedule {
  const expr = rawExpr?.trim();
  if (!expr) {
    throw new Error("Schedule expression is required.");
  }

  const intervalMatch = /^(\d+)\s*(s|m|h|d)$/i.exec(expr);
  if (intervalMatch) {
    const qty = Number.parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const multiplier =
      unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
    const intervalMs = qty * multiplier;
    if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      throw new Error(
        `Interval "${expr}" must be between 30s and 30d.`
      );
    }
    return { kind: "interval", raw: `${qty}${unit}`, intervalMs };
  }

  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid schedule "${expr}". Use an interval (e.g. "15m", "1h") or 5-field cron (e.g. "*/15 * * * *").`
    );
  }

  return {
    kind: "cron",
    raw: fields.join(" "),
    minutes: parseCronField(fields[0], 0, 59),
    hours: parseCronField(fields[1], 0, 23),
    daysOfMonth: parseCronField(fields[2], 1, 31),
    months: parseCronField(fields[3], 1, 12),
    daysOfWeek: parseCronField(fields[4], 0, 6, true),
  };
}

export function computeNextRunAt(
  rawExpr: string,
  fromDate: Date = new Date()
): string {
  const parsed = parseScheduleExpression(rawExpr);
  if (parsed.kind === "interval") {
    return new Date(fromDate.getTime() + parsed.intervalMs).toISOString();
  }

  // Advance minute by minute (up to 366 days) to find next matching UTC minute.
  const probe = new Date(fromDate.getTime());
  probe.setUTCSeconds(0, 0);
  probe.setUTCMinutes(probe.getUTCMinutes() + 1);

  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i++) {
    if (
      parsed.minutes.has(probe.getUTCMinutes()) &&
      parsed.hours.has(probe.getUTCHours()) &&
      parsed.daysOfMonth.has(probe.getUTCDate()) &&
      parsed.months.has(probe.getUTCMonth() + 1) &&
      parsed.daysOfWeek.has(probe.getUTCDay())
    ) {
      return probe.toISOString();
    }
    probe.setUTCMinutes(probe.getUTCMinutes() + 1);
  }

  throw new Error(`Could not compute next run time for cron "${rawExpr}".`);
}
