#!/usr/bin/env node
// Generates a "Top Languages" card SVG from repository language bytes via the
// GitHub REST API (immune to the GraphQL resource limits that break hosted
// stats cards for high-volume accounts). Forks are excluded.
// No dependencies. Requires: GITHUB_TOKEN, optionally GH_LOGIN, OUT_DIR.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOGIN = process.env.GH_LOGIN ?? "sumiredc";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR ?? "dist";
const TOP_N = 8;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const HEADERS = {
  authorization: `bearer ${TOKEN}`,
  accept: "application/vnd.github+json",
};

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function fetchLanguageBytes() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/users/${LOGIN}/repos?per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  const totals = new Map();
  await Promise.all(
    repos
      .filter((r) => !r.fork)
      .map(async (r) => {
        const langs = await api(`/repos/${r.full_name}/languages`);
        for (const [lang, bytes] of Object.entries(langs)) {
          totals.set(lang, (totals.get(lang) ?? 0) + bytes);
        }
      }),
  );
  return totals;
}

// GitHub linguist colors for languages likely to appear; gray fallback.
const LANG_COLORS = {
  Rust: "#dea584",
  PHP: "#4F5D95",
  Go: "#00ADD8",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  C: "#555555",
  "C++": "#f34b7d",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Shell: "#89e051",
  Dockerfile: "#384d54",
  PureScript: "#1D222D",
  Makefile: "#427819",
  Blade: "#f7523f",
  Vue: "#41b883",
  Python: "#3572A5",
};

const THEMES = {
  light: {
    bg: "#ffffff",
    border: "#d0d7de",
    title: "#7135e0",
    text: "#24292f",
    muted: "#57606a",
    track: "#eaeef2",
  },
  dark: {
    bg: "#282a36",
    border: "#44475a",
    title: "#bd93f9",
    text: "#f8f8f2",
    muted: "#6272a4",
    track: "#44475a",
  },
};

function buildSvg(entries, theme) {
  const width = 320;
  const pad = 20;
  const barY = 52;
  const legendY = barY + 24;
  const rowH = 22;
  const rows = Math.ceil(entries.length / 2);
  const height = legendY + rows * rowH + pad - 6;
  const innerW = width - pad * 2;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>Top languages by bytes of code</title>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="${theme.bg}" stroke="${theme.border}"/>`,
    `<text x="${pad}" y="32" font-family="ui-monospace,monospace" font-size="15" font-weight="600" fill="${theme.title}">$ tokei --sort code</text>`,
  );

  // Stacked percentage bar
  parts.push(`<rect x="${pad}" y="${barY}" width="${innerW}" height="8" rx="4" fill="${theme.track}"/>`);
  parts.push(`<clipPath id="bar"><rect x="${pad}" y="${barY}" width="${innerW}" height="8" rx="4"/></clipPath>`);
  let bx = pad;
  for (const e of entries) {
    const w = (e.share / 100) * innerW;
    parts.push(
      `<rect x="${bx.toFixed(2)}" y="${barY}" width="${(w + 1).toFixed(2)}" height="8" fill="${e.color}" clip-path="url(#bar)"/>`,
    );
    bx += w;
  }

  // Legend, two columns
  entries.forEach((e, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const lx = pad + col * (innerW / 2);
    const ly = legendY + row * rowH + 10;
    parts.push(
      `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${e.color}"/>`,
      `<text x="${lx + 16}" y="${ly}" font-family="ui-monospace,monospace" font-size="11" fill="${theme.text}">${e.lang}</text>`,
      `<text x="${lx + innerW / 2 - 12}" y="${ly}" text-anchor="end" font-family="ui-monospace,monospace" font-size="11" fill="${theme.muted}">${e.share.toFixed(1)}%</text>`,
    );
  });

  parts.push(`</svg>`);
  return parts.join("\n");
}

const totals = await fetchLanguageBytes();
const grand = [...totals.values()].reduce((a, b) => a + b, 0);
const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
const top = sorted.slice(0, TOP_N);
const otherBytes = sorted.slice(TOP_N).reduce((sum, [, b]) => sum + b, 0);

const entries = top.map(([lang, bytes]) => ({
  lang,
  share: (bytes / grand) * 100,
  color: LANG_COLORS[lang] ?? "#8b949e",
}));
if (otherBytes > 0) {
  entries.push({ lang: "Other", share: (otherBytes / grand) * 100, color: "#8b949e" });
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, "langs.svg"), buildSvg(entries, THEMES.light));
await writeFile(join(OUT_DIR, "langs-dark.svg"), buildSvg(entries, THEMES.dark));
console.log(
  `Generated ${OUT_DIR}/langs.svg and ${OUT_DIR}/langs-dark.svg: ` +
    entries.map((e) => `${e.lang} ${e.share.toFixed(1)}%`).join(", "),
);
