/**
 * What day and hour it is where somebody is.
 *
 * Through Intl rather than arithmetic on a stored offset, which is only true until the clocks
 * move.
 */

export interface LocalMoment {
  /** `YYYY-MM-DD` in the zone. */
  day: string;
  hour: number;
}

/** Constructing one loads zone data, and the sweep asks for the same few zones all day. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export function isTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  try {
    formatterFor(value);

    return true;
  } catch {
    return false;
  }
}

export function localMomentIn(timezone: string, at: Date): LocalMoment {
  const parts = formatterFor(timezone).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return {
    day: `${read('year')}-${read('month')}-${read('day')}`,
    hour: Number(read('hour')),
  };
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const existing = FORMATTERS.get(timezone);

  if (existing) {
    return existing;
  }

  // Throws RangeError on an unknown zone, which is what isTimezone reads.
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    // `hourCycle` rather than `hour12: false`, which renders midnight as 24 on some runtimes.
    hourCycle: 'h23',
  });

  FORMATTERS.set(timezone, formatter);

  return formatter;
}
