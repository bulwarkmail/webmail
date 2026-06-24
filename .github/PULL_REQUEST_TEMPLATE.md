## Description

This PR adds **Jalali (Persian/Shamsi) calendar support** and **Saturday as first day of week** to Bulwark Webmail.

## Changes

### New Files
- `lib/jalali-utils.ts` — Gregorian ↔ Jalali conversion utilities using `jalaali-js`
- `hooks/use-calendar-locale.ts` — Unified calendar locale hook that abstracts Gregorian/Jalali differences
- `locales/fa/common.json` — Full Persian (Farsi) locale translations

### Modified Files
- **`stores/settings-store.ts`** — Expanded `FirstDayOfWeek` type from `0 | 1` to `0 | 1 | 6` (Saturday)
- **`components/settings/language-settings.tsx`** — Added Saturday option to first-day-of-week picker
- **`components/calendar/calendar-month-view.tsx`** — Uses `useCalendarLocale` hook for Jalali day numbers, month checks, today detection
- **`components/calendar/calendar-week-view.tsx`** — Supports `weekStartsOn: 6` (Saturday)
- **`components/calendar/calendar-day-view.tsx`** — No direct changes needed
- **`components/calendar/mini-calendar.tsx`** — Uses `useCalendarLocale` for Jalali month grid, header labels, month picker
- **`components/calendar/calendar-toolbar.tsx`** — Uses `useCalendarLocale` for Jalali month/year/week labels
- **`hooks/use-format-event-date.ts`** — Shows Jalali dates when locale is `fa`
- **`package.json`** — Added `jalaali-js` dependency
- **All 20 locale files** — Added Jalali month name translations (`far`, `ord`, `kho`, `tir`, `mor`, `sha`, `meh`, `aba`, `aza`, `dey`, `bah`, `esf`)

### How It Works

1. **Calendar detection**: When the locale is set to `fa` (Persian), `shouldUseJalaliCalendar()` returns `true`
2. **Display layer only**: All internal date handling stays Gregorian (ISO 8601) for JMAP protocol compatibility. Jalali conversion happens only at the UI rendering level.
3. **Week start**: Saturday (6) is supported as a first-day-of-week option alongside Sunday (0) and Monday (1)
4. **Month grid**: Jalali months (Farvardin … Esfand) with correct day counts and leap year handling
5. **Date formatting**: Event dates, toolbar labels, and accessibility labels all show Jalali dates when appropriate

## Screenshots

| Feature | Gregorian (en) | Jalali (fa) |
|---------|---------------|-------------|
| Month view | Standard Gregorian | Jalali months with Saturday-first |
| Mini calendar | Gregorian months | Jalali months |
| Settings | Mon/Sun options | Mon/Sat/Sun options |

## Testing

- [x] TypeScript compilation passes (no new errors)
- [x] All calendar views render correctly with Saturday as first day
- [x] Jalali month grid shows correct day counts
- [x] Today detection works for both Gregorian and Jalali
- [x] Month/year navigation works correctly in both calendars
- [x] Week numbers display correctly for all week-start options
- [x] Event date formatting works in both calendars

## Notes

- The `fa` locale file is included as a new addition. It was developed separately and contains full Persian translations for the entire UI.
- The translation completeness test has pre-existing failures on other branches (missing RTL-related keys from a separate feature).
