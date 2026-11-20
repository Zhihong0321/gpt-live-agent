const ZONE = 'Asia/Kuala_Lumpur';

/** Today and the next working day (Mon–Fri) in Malaysia, worded for the agent. Never throws. */
export function callDates(now: Date): { today_malaysia?: string; next_working_day?: string } {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(now).map(p => [p.type, p.value]));
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
    const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
    if (weekday < 0 || !year || !month || !day) return {};
    // Mon–Thu: tomorrow. Fri: +3, Sat: +2, Sun: +1 (all land on Monday).
    const ahead = weekday === 5 ? 3 : weekday === 6 ? 2 : 1;
    const word = (d: Date, time: boolean) => new Intl.DateTimeFormat('en-GB', { timeZone: time ? ZONE : 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) }).format(d);
    return { today_malaysia: word(now, true), next_working_day: word(new Date(Date.UTC(year, month - 1, day + ahead)), false) };
  } catch { return {}; }
}
