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

async function fetchRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/users/${LOGIN}/repos?per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => !r.fork);
}

async function fetchLanguageBytes(repos) {
  const totals = new Map();
  await Promise.all(
    repos.map(async (r) => {
      const langs = await api(`/repos/${r.full_name}/languages`);
      for (const [lang, bytes] of Object.entries(langs)) {
        totals.set(lang, (totals.get(lang) ?? 0) + bytes);
      }
    }),
  );
  return totals;
}

function countPrimaryLanguages(repos) {
  const totals = new Map();
  for (const r of repos) {
    if (!r.language) continue;
    totals.set(r.language, (totals.get(r.language) ?? 0) + 1);
  }
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

function buildSvg(entries, theme, title) {
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
    `<text x="${pad}" y="32" font-family="ui-monospace,monospace" font-size="15" font-weight="600" fill="${theme.title}">${title}</text>`,
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
      `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${e.color}" stroke="${theme.muted}" stroke-width="0.75"/>`,
      `<text x="${lx + 16}" y="${ly}" font-family="ui-monospace,monospace" font-size="11" fill="${theme.text}">${e.lang}</text>`,
      `<text x="${lx + innerW / 2 - 12}" y="${ly}" text-anchor="end" font-family="ui-monospace,monospace" font-size="11" fill="${theme.muted}">${e.value}</text>`,
    );
  });

  parts.push(`</svg>`);
  return parts.join("\n");
}

function toEntries(totals, fmtValue) {
  const grand = [...totals.values()].reduce((a, b) => a + b, 0);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const entries = sorted.slice(0, TOP_N).map(([lang, n]) => ({
    lang,
    share: (n / grand) * 100,
    value: fmtValue(n, grand),
    color: LANG_COLORS[lang] ?? "#8b949e",
  }));
  const rest = sorted.slice(TOP_N).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) {
    entries.push({
      lang: "Other",
      share: (rest / grand) * 100,
      value: fmtValue(rest, grand),
      color: "#8b949e",
    });
  }
  return entries;
}

const percent = (n, grand) => `${((n / grand) * 100).toFixed(1)}%`;
const count = (n) => `${n}`;

const repos = await fetchRepos();
const byBytes = toEntries(await fetchLanguageBytes(repos), percent);
const byRepos = toEntries(countPrimaryLanguages(repos), count);

await mkdir(OUT_DIR, { recursive: true });
for (const [file, entries, title] of [
  ["langs", byBytes, "$ tokei --sort code"],
  ["repolangs", byRepos, "$ gh repo list --json language"],
]) {
  await writeFile(join(OUT_DIR, `${file}.svg`), buildSvg(entries, THEMES.light, title));
  await writeFile(join(OUT_DIR, `${file}-dark.svg`), buildSvg(entries, THEMES.dark, title));
  console.log(`Generated ${file}: ` + entries.map((e) => `${e.lang} ${e.value}`).join(", "));
}
