export interface PHHoliday {
  key: string         // unique ID — used as signal ID in the store
  name: string        // display name
  date: Date          // the holiday date
  lookAheadDays: number
  toneTag: string     // ToneTag value
  topicTag: string    // TopicTag value
  generationTag: string // GenerationTag value
  signal: string      // short headline for display (~80 chars)
  copyHint: string    // full angle guidance passed to Claude
}

// ── Date helpers ──────────────────────────────────────────────────────────

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

// n > 0: nth weekday (1=first), n < 0: nth from end (-1=last)
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const d = new Date(year, month - 1, 1)
    const diff = (weekday - d.getDay() + 7) % 7
    d.setDate(1 + diff + (n - 1) * 7)
    return d
  }
  const d = new Date(year, month, 0) // last day of month
  const diff = (d.getDay() - weekday + 7) % 7
  d.setDate(d.getDate() - diff)
  return d
}

// Easter Sunday via Meeus/Jones/Butcher algorithm
function getEaster(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

// ── Holiday definitions ───────────────────────────────────────────────────

function buildHolidays(year: number): PHHoliday[] {
  const easter      = getEaster(year)
  const goodFriday  = addDays(easter, -2)
  const holySat     = addDays(easter, -1)
  const mothersDay  = nthWeekday(year, 5, 0, 2)  // 2nd Sunday of May
  const fathersDay  = nthWeekday(year, 6, 0, 3)  // 3rd Sunday of June
  const heroesDay   = nthWeekday(year, 8, 1, -1) // last Monday of August

  return [
    // ── Undas (peak season) ──────────────────────────────────────────────
    {
      key: `undas_${year}_nov01`,
      name: "All Saints' Day (Undas)",
      date: new Date(year, 10, 1),
      lookAheadDays: 21,
      toneTag: 'quiet_grief',
      topicTag: 'grief_loss',
      generationTag: 'all',
      signal: `All Saints' Day (Undas) ${year} — families visit cemeteries to honor the departed`,
      copyHint: "Undas is approaching — Filipino families will visit loved ones at the cemetery. Write about the comfort and peace of having a beautiful, dignified resting place to return to year after year. Tone: tender, reflective, family-centered. Not morbid — focus on the visit, the memory, the togetherness.",
    },
    {
      key: `undas_${year}_nov02`,
      name: "All Souls' Day (Undas)",
      date: new Date(year, 10, 2),
      lookAheadDays: 21,
      toneTag: 'quiet_grief',
      topicTag: 'grief_loss',
      generationTag: 'all',
      signal: `All Souls' Day (Undas) ${year} — lighting candles and praying for departed souls`,
      copyHint: "All Souls' Day — the day Filipinos light candles and pray for departed souls. Write about remembrance, the peace of a dignified resting place, and the love that outlasts death. Angle: no matter how far you are, you can always come back to them here.",
    },
    // ── Holy Week ────────────────────────────────────────────────────────
    {
      key: `good_friday_${year}`,
      name: 'Good Friday',
      date: goodFriday,
      lookAheadDays: 14,
      toneTag: 'quiet_grief',
      topicTag: 'grief_loss',
      generationTag: 'boomer',
      signal: `Good Friday ${year} — a solemn day of Filipino Catholic reflection and remembrance`,
      copyHint: "Good Friday — a solemn day of reflection for Filipino Catholics. Angle: the peace of knowing your loved one rests in a dignified, sacred place. Understated, reverent tone. No hard sell — let the silence speak.",
    },
    {
      key: `holy_saturday_${year}`,
      name: 'Holy Saturday',
      date: holySat,
      lookAheadDays: 14,
      toneTag: 'hopeful_legacy',
      topicTag: 'legacy_planning',
      generationTag: 'millennial',
      signal: `Holy Saturday ${year} — the quiet between loss and hope, a time for family reflection`,
      copyHint: "Holy Saturday — the quiet between grief and hope. Angle: use this moment of stillness to think about the future, give your family the gift of being prepared. Pre-planning as an act of love, not fear. Hopeful but grounded.",
    },
    // ── Family occasions ─────────────────────────────────────────────────
    {
      key: `mothers_day_${year}`,
      name: "Mother's Day",
      date: mothersDay,
      lookAheadDays: 14,
      toneTag: 'parental_sacrifice',
      topicTag: 'family_sacrifice',
      generationTag: 'millennial',
      signal: `Mother's Day ${year} — honoring the nanay who gave everything`,
      copyHint: "Mother's Day is coming. Write about honoring the nanay who gave everything — preserving her memory, having a place to always return to, saying thank you even after she's gone. Warm, loving, not morbid. The focus is on the love, not the loss.",
    },
    {
      key: `fathers_day_${year}`,
      name: "Father's Day",
      date: fathersDay,
      lookAheadDays: 14,
      toneTag: 'generational_pride',
      topicTag: 'family_sacrifice',
      generationTag: 'millennial',
      signal: `Father's Day ${year} — honoring the tatay whose quiet sacrifice shaped the family`,
      copyHint: "Father's Day is coming. Write about the tatay whose quiet, unspoken sacrifice shaped his family. Angle: his legacy deserves to be preserved with dignity — a resting place worthy of everything he gave. Dignified, proud, not sentimental.",
    },
    // ── Christmas / New Year ─────────────────────────────────────────────
    {
      key: `christmas_${year}`,
      name: 'Christmas',
      date: new Date(year, 11, 25),
      lookAheadDays: 21,
      toneTag: 'hopeful_legacy',
      topicTag: 'holiday_occasion',
      generationTag: 'all',
      signal: `Christmas ${year} — first Christmas without a loved one, or planning ahead for family peace`,
      copyHint: "Christmas season — the seat that's empty this year, or the peace of knowing your family will never face hardship unprepared. Two angles: (1) remembering the departed during the holidays, (2) giving your family the gift of pre-planning. Warm, gentle, not heavy.",
    },
    {
      key: `new_year_${year}`,
      name: "New Year's Day",
      date: new Date(year, 0, 1),
      lookAheadDays: 14,
      toneTag: 'hopeful_legacy',
      topicTag: 'legacy_planning',
      generationTag: 'millennial',
      signal: `New Year ${year} — a time to plan for the family's future and protect what matters most`,
      copyHint: "New Year — as Filipino families begin a fresh chapter, many reflect on what they'd leave behind. Angle: give your family the gift of peace of mind in the new year. Pre-planning as a New Year's resolution — responsible, loving, practical.",
    },
    // ── National occasions ───────────────────────────────────────────────
    {
      key: `independence_day_${year}`,
      name: 'Philippine Independence Day',
      date: new Date(year, 5, 12),
      lookAheadDays: 7,
      toneTag: 'generational_pride',
      topicTag: 'legacy_planning',
      generationTag: 'boomer',
      signal: `Philippine Independence Day ${year} — honoring sacrifice, resilience, and Filipino legacy`,
      copyHint: "Independence Day — honoring Filipino sacrifice and resilience. Angle: every life is a legacy worth preserving. From national heroes to the everyday tatay and nanay who gave everything for their family. Tie the spirit of sacrifice to family legacy.",
    },
    {
      key: `heroes_day_${year}`,
      name: 'National Heroes Day',
      date: heroesDay,
      lookAheadDays: 7,
      toneTag: 'generational_pride',
      topicTag: 'family_sacrifice',
      generationTag: 'all',
      signal: `National Heroes Day ${year} — every Filipino who sacrificed for their family is a hero`,
      copyHint: "National Heroes Day — every Filipino who sacrificed for their family is a hero. Angle: the OFW who missed birthdays, the tatay who worked double shifts, the lola who raised the whole family. Their story deserves to be honored with dignity.",
    },
  ]
}

// ── Public API ────────────────────────────────────────────────────────────

export function getUpcomingHolidays(referenceDate = new Date()): PHHoliday[] {
  const year = referenceDate.getFullYear()
  // Include next year to catch year-boundary holidays (e.g. New Year in December)
  const all = [...buildHolidays(year), ...buildHolidays(year + 1)]

  const refMs = referenceDate.getTime()
  return all.filter(h => {
    const diffDays = (h.date.getTime() - refMs) / (24 * 3600 * 1000)
    return diffDays >= 0 && diffDays <= h.lookAheadDays
  })
}

export function daysUntil(holiday: PHHoliday, referenceDate = new Date()): number {
  return Math.ceil((holiday.date.getTime() - referenceDate.getTime()) / (24 * 3600 * 1000))
}
