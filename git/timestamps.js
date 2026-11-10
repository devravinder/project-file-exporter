"use strict";

const MIN_GAP = 5 * 60; // seconds
const MAX_GAP = 24 * 60 * 60;

const pad = (n) => String(n).padStart(2, "0");

// "2026-11-10" → 00:00:00, "2026-11-10 11" → 11:00:00, "2026-11-10 11:12:13" as is.
// Parsed in local time. Returns ms since epoch.
function parseDateTime(input) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/.exec(String(input).trim());
  const bad = () => new Error(`Invalid date/time "${input}". Use YYYY-MM-DD hh:mm:ss (time part optional).`);
  if (!m) throw bad();
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw bad();
  }
  return date.getTime();
}

// Local "YYYY-MM-DD hh:mm:ss".
function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Git's raw date format: "<unix seconds> <+hhmm>" (local zone at that moment).
function toGitDate(ms) {
  const off = -new Date(ms).getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${Math.floor(ms / 1000)} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function formatGap(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return (d ? `${d}d ` : "") + `${pad(h)}h ${pad(m)}m`;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Strictly increasing timestamps for n commits: first = start, last = end,
// every gap random between 5 minutes and 1 day. Throws if that is impossible.
function planTimestamps(n, startMs, endMs, seed) {
  if (seed === undefined || seed === null) seed = Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const startS = Math.floor(startMs / 1000);

  if (n <= 0) return { times: [], seed };
  if (n === 1) return { times: [startS * 1000], seed };

  const endS = Math.floor(endMs / 1000);
  const span = endS - startS;
  const gaps = n - 1;
  if (span < gaps * MIN_GAP || span > gaps * MAX_GAP) {
    const minEnd = formatDate((startS + gaps * MIN_GAP) * 1000);
    const maxEnd = formatDate((startS + gaps * MAX_GAP) * 1000);
    throw new Error(
      `${n} commits cannot be spread over ${formatDate(startMs)} → ${formatDate(endMs)} with gaps of 5 min - 1 day.\n` +
        `  With this start, the end must be between ${minEnd} and ${maxEnd}.`
    );
  }

  // Every gap starts at the minimum; the remaining time is shared randomly,
  // never pushing a gap beyond the maximum.
  const extra = new Array(gaps).fill(0);
  const cap = MAX_GAP - MIN_GAP;
  let remaining = span - gaps * MIN_GAP;
  let active = extra.map((_, i) => i);
  while (remaining > 0 && active.length) {
    const w = active.map(() => rng() + 1e-9);
    const sum = w.reduce((a, b) => a + b, 0);
    let given = 0;
    active.forEach((idx, k) => {
      const add = Math.min(Math.floor((remaining * w[k]) / sum), cap - extra[idx]);
      extra[idx] += add;
      given += add;
    });
    if (given === 0) {
      // rounding stall: hand out single seconds
      const idx = active[Math.floor(rng() * active.length)];
      extra[idx] += 1;
      given = 1;
    }
    remaining -= given;
    active = active.filter((idx) => extra[idx] < cap);
  }

  const times = [startS * 1000];
  let t = startS;
  for (let i = 0; i < gaps; i++) {
    t += MIN_GAP + extra[i];
    times.push(t * 1000);
  }
  return { times, seed };
}

module.exports = { parseDateTime, formatDate, toGitDate, formatGap, planTimestamps, MIN_GAP, MAX_GAP };
