export function nextRun(schedule: string, from = new Date()): Date {
  const every = schedule.match(/^every:(\d+)(m|h)$/);
  if (every) {
    const amount = Number(every[1]);
    const ms = every[2] === "h" ? amount * 3600_000 : amount * 60_000;
    return new Date(from.getTime() + ms);
  }
  const daily = schedule.match(/^daily:(\d{2}):(\d{2})$/);
  if (daily) {
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(Number(daily[1]), Number(daily[2]), 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  const cron = schedule.match(/^cron:(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
  if (cron) return nextCron(cron.slice(1) as string[], from);
  throw new Error(`unsupported schedule: ${schedule}`);
}

export function isValidSchedule(schedule: string): boolean {
  try {
    nextRun(schedule);
    return true;
  } catch {
    return false;
  }
}

function nextCron(fields: string[], from: Date): Date {
  const cursor = new Date(from.getTime() + 60_000);
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (matchField(fields[0] ?? "*", cursor.getMinutes())
      && matchField(fields[1] ?? "*", cursor.getHours())
      && matchField(fields[2] ?? "*", cursor.getDate())
      && matchField(fields[3] ?? "*", cursor.getMonth() + 1)
      && matchField(fields[4] ?? "*", cursor.getDay())) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error("cron did not match within a year");
}

function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  return field.split(",").some((part) => Number(part) === value);
}
