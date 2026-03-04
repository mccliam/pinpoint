/**
 * daily.js — Pure game logic (no network calls).
 * Handles deterministic daily city selection and hint generation.
 */

export const IS_SPEED_ROUND = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('speed');


// ─────────────────────────────────────────────────
// Seeded PRNG (Mulberry32) — same seed → same shuffle, every time
// ─────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────

const RESET_OFFSET_HRS = 15; // 7:00 AM PST (15:00 UTC)

/** Returns the game date (date at 7:00 AM PST) */
function getShiftedDate() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - RESET_OFFSET_HRS);
  return d;
}

/** Returns today's date as "YYYY-MM-DD" based on the 7AM PST reset. */
export function getDateString() {
  if (IS_SPEED_ROUND) {
    const d = new Date();
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`;
  }
  const d = getShiftedDate();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Returns an integer seed from the game date. */
export function getDateSeed() {
  return parseInt(getDateString().replace(/-/g, ''), 10);
}

// ─────────────────────────────────────────────────
// Daily city selection
// ─────────────────────────────────────────────────

/**
 * Returns the single city for today.
 * Uses days since a fixed epoch so every player on earth gets the same city
 * regardless of timezone (epoch is UTC midnight 2024-01-01).
 */
export function getDailyCity(locations) {
  if (IS_SPEED_ROUND) {
    const minIndex = Math.floor(Date.now() / 60000);
    return locations[minIndex % locations.length];
  }
  const epoch = Date.UTC(2024, 0, 1);
  const d = getShiftedDate();
  const gameUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayIndex = Math.floor((gameUtc - epoch) / 86_400_000);
  return locations[Math.abs(dayIndex) % locations.length];
}

// ─────────────────────────────────────────────────
// Hint template filling
// ─────────────────────────────────────────────────

/** Map of hint ID → placeholder tokens → city field names */
const HINT_FIELD_MAP = {
  hard_1: { '[value]': 'elevation' },
  hard_2: { '[value]': 'rainfall' },
  hard_3: { '[value]': 'vegetation' },
  hard_4: { '[value]': 'languages' },
  hard_5: { '[value]': 'founding' },
  hard_6: { '[value]': 'transit' },
  hard_7: { '[value]': 'nickname' },
  medium_1: { '[population]': 'population', '[rank]': 'rank' },
  medium_2: { '[average]': 'average', '[high]': 'high', '[low]': 'low' },
  medium_3: { '[invention]': 'invention', '[inventor]': 'inventor' },
  medium_4: { '[value]': 'major_event' },
  medium_5: { '[value]': 'national_sport' },
  medium_6: { '[value]': 'border_distance' },
  medium_7: { '[value]': 'geography' },
  medium_8: { '[value]': 'economy' },
  easy_1: { '[value]': 'famous_for' },
  easy_2: { '[value]': 'food' },
  easy_3: { '[person]': 'person' },
  easy_4: { '[value]': 'flag_colors' },
  easy_5: { '[value]': 'wordplay' },
  easy_6: { '[value]': 'currency' },
  easy_7: { '[value]': 'continent' },
};

function fillTemplate(hint, city) {
  const tokenMap = HINT_FIELD_MAP[hint.id] || {};
  let text = hint.template;
  for (const [token, field] of Object.entries(tokenMap)) {
    text = text.replaceAll(token, city[field] ?? '???');
  }
  return { ...hint, text };
}

// ─────────────────────────────────────────────────
// Seeded shuffle
// ─────────────────────────────────────────────────

function seededShuffle(array, rng) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─────────────────────────────────────────────────
// Hint selection — 3 Hard, 3 Medium, 2 Easy (ordered hardest first)
// ─────────────────────────────────────────────────

/**
 * Returns an ordered array of 8 filled hint objects for today.
 * The same date always produces the same 8 hints in the same order.
 * Ordering: Hard → Hard → Hard → Medium → Medium → Medium → Easy → Easy
 */
export function buildHints(city, allHints) {
  const seed = getDateSeed();
  const rng = mulberry32(seed);

  const hard = allHints.filter((h) => h.difficulty === 'Hard');
  const medium = allHints.filter((h) => h.difficulty === 'Medium');
  const easy = allHints.filter((h) => h.difficulty === 'Easy');

  const picked = [
    ...seededShuffle(hard, rng).slice(0, 3),
    ...seededShuffle(medium, rng).slice(0, 3),
    ...seededShuffle(easy, rng).slice(0, 2),
  ];

  return picked.map((hint) => fillTemplate(hint, city));
}

const HINT_START_HRS_OFFSET = 1; // 1 hour after reset (8:00 AM PST)

/** How many hints are currently visible based on game time (0–8). */
export function getHintsRevealedCount() {
  if (IS_SPEED_ROUND) {
    // Reveal 1 hint every minute, max 8.
    const minutesSinceHour = new Date().getMinutes();
    return Math.min((minutesSinceHour % 10) + 1, 8);
  }
  const hrsSinceReset = getShiftedDate().getUTCHours();
  if (hrsSinceReset < HINT_START_HRS_OFFSET) return 0;
  return Math.min(hrsSinceReset - HINT_START_HRS_OFFSET + 1, 8);
}

/** Milliseconds until the next hint unlocks. */
export function getNextHintMs() {
  if (IS_SPEED_ROUND) {
    return 60000 - (Date.now() % 60000);
  }
  const sinceReset = getShiftedDate().getUTCHours();
  const nextTarget = sinceReset < HINT_START_HRS_OFFSET ? HINT_START_HRS_OFFSET : sinceReset + 1;

  const target = getShiftedDate();
  target.setUTCHours(nextTarget, 0, 0, 0);

  const nowShifted = getShiftedDate();
  return target - nowShifted;
}

/** Format milliseconds as "HH:MM:SS". */
export function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}
