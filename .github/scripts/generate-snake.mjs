#!/usr/bin/env node
// Generates an animated "contribution snake" SVG from the GitHub contribution
// calendar. Fetches the calendar in 2-month chunks because a single full-year
// query exceeds GitHub's GraphQL resource limits for high-volume accounts.
// No dependencies. Requires: GITHUB_TOKEN, optionally GH_LOGIN, OUT_DIR.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOGIN = process.env.GH_LOGIN ?? "sumiredc";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR ?? "dist";
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_DAYS = 61;

const utcMidnight = (d) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function fetchChunk(from, to) {
  const query = `query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { login: LOGIN, from: from.toISOString(), to: to.toISOString() },
    }),
  });
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays);
}

async function fetchCalendar() {
  const end = utcMidnight(new Date());
  let start = new Date(end.getTime() - 364 * DAY_MS);
  start = new Date(start.getTime() - start.getUTCDay() * DAY_MS); // back to Sunday

  const counts = new Map();
  for (let t = start.getTime(); t <= end.getTime(); t += CHUNK_DAYS * DAY_MS) {
    const from = new Date(t);
    const to = new Date(Math.min(t + (CHUNK_DAYS - 1) * DAY_MS, end.getTime()));
    for (const day of await fetchChunk(from, to)) {
      counts.set(day.date, day.contributionCount);
    }
  }

  const days = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.push({ date, count: counts.get(date) ?? 0 });
  }
  return { start, days };
}

function assignLevels(days) {
  const nonzero = days.filter((d) => d.count > 0).map((d) => d.count).sort((a, b) => a - b);
  const q = (p) => nonzero[Math.min(nonzero.length - 1, Math.floor(nonzero.length * p))] ?? 1;
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  for (const d of days) {
    d.level = d.count === 0 ? 0 : d.count <= q1 ? 1 : d.count <= q2 ? 2 : d.count <= q3 ? 3 : 4;
  }
}

const PALETTES = {
  light: {
    cells: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: ["#7135e0", "#8b5cf6", "#a78bfa", "#c4b5fd"],
    text: "#57606a",
  },
  dark: {
    cells: ["#2d2f3f", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: ["#bd93f9", "#a884e3", "#9375cd", "#7e66b7"],
    text: "#8b949e",
  },
};

const CELL = 12;
const PITCH = 16;
const MARGIN_X = 8;
const MARGIN_TOP = 24;
const MARGIN_BOTTOM = 28;
const ROWS = 7;

function buildSvg(days, palette) {
  const cols = Math.ceil(days.length / ROWS);
  const width = MARGIN_X * 2 + cols * PITCH - (PITCH - CELL);
  const height = MARGIN_TOP + ROWS * PITCH - (PITCH - CELL) + MARGIN_BOTTOM;
  const x = (col) => MARGIN_X + col * PITCH;
  const y = (row) => MARGIN_TOP + row * PITCH;

  // Serpentine order: even columns top->bottom, odd columns bottom->top.
  const order = [];
  for (let col = 0; col < cols; col++) {
    for (let r = 0; r < ROWS; r++) {
      const row = col % 2 === 0 ? r : ROWS - 1 - r;
      order.push({ col, row });
    }
  }
  const orderIndex = new Map(order.map((p, i) => [`${p.col},${p.row}`, i]));
  const steps = order.length - 1;
  const dur = Math.round(steps / 9); // ~9 cells per second

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${LOGIN}'s contribution snake</title>`,
  );

  // Month labels
  let lastMonth = -1;
  for (let col = 0; col < cols; col++) {
    const first = days[col * ROWS];
    if (!first) break;
    const d = new Date(first.date);
    const month = d.getUTCMonth();
    if (month !== lastMonth) {
      if (lastMonth !== -1 || col === 0) {
        const label = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
        parts.push(
          `<text x="${x(col)}" y="14" font-family="ui-monospace,monospace" font-size="10" fill="${palette.text}">${label}</text>`,
        );
      }
      lastMonth = month;
    }
  }

  // Cells
  for (let i = 0; i < days.length; i++) {
    const col = Math.floor(i / ROWS);
    const row = i % ROWS;
    const day = days[i];
    const cx = x(col);
    const cy = y(row);
    const color = palette.cells[day.level];
    if (day.level === 0) {
      parts.push(`<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2" fill="${color}"/>`);
      continue;
    }
    const k = orderIndex.get(`${col},${row}`);
    const t = Math.min(0.985, 0.01 + (k / steps) * 0.965).toFixed(4);
    parts.push(
      `<rect x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2" fill="${color}">` +
        `<animate attributeName="fill" values="${color};${palette.cells[0]};${color}" keyTimes="0;${t};0.99" ` +
        `calcMode="discrete" dur="${dur}s" repeatCount="indefinite"/></rect>`,
    );
  }

  // Snake path (serpentine), constant speed via paced animateMotion.
  const path = [`M${x(0)},${y(0)}`];
  for (let col = 0; col < cols; col++) {
    const [top, bottom] = [y(0), y(ROWS - 1)];
    path.push(col % 2 === 0 ? `V${bottom}` : `V${top}`);
    if (col < cols - 1) path.push(`H${x(col + 1)}`);
  }
  const d = path.join("");
  const lag = 1 / 9; // one cell behind per segment
  palette.snake.forEach((color, i) => {
    const size = i === 0 ? CELL + 2 : CELL - 1;
    const off = (CELL - size) / 2;
    const begin = (i * lag).toFixed(3);
    parts.push(
      `<rect x="${off}" y="${off}" width="${size}" height="${size}" rx="4" fill="${color}" opacity="${i === 0 ? 1 : 0}">` +
        (i > 0 ? `<set attributeName="opacity" to="1" begin="${begin}s"/>` : "") +
        `<animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite" calcMode="paced" path="${d}"/></rect>`,
    );
  });

  // Caption
  const total = days.reduce((sum, day) => sum + day.count, 0);
  parts.push(
    `<text x="${MARGIN_X}" y="${height - 8}" font-family="ui-monospace,monospace" font-size="11" fill="${palette.text}">` +
      `$ ${total.toLocaleString("en")} contributions in the last year</text>`,
    `</svg>`,
  );
  return parts.join("\n");
}

const { days } = await fetchCalendar();
assignLevels(days);
await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "snake.svg"), buildSvg(days, PALETTES.light));
await writeFile(join(OUT_DIR, "snake-dark.svg"), buildSvg(days, PALETTES.dark));
console.log(`Generated ${OUT_DIR}/snake.svg and ${OUT_DIR}/snake-dark.svg (${days.length} days)`);
