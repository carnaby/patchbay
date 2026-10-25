import { inferTable } from '@patchbay/core';
import { type Connector, DAY, floorTo, rng, seedOf } from './types.ts';

interface HnItem {
  id: number;
  title?: string;
  score?: number;
  by?: string;
  descendants?: number;
  url?: string;
  time?: number;
}

export const hackerNews: Connector = {
  info: {
    id: 'hackernews.stories',
    name: 'Hacker News',
    category: 'Tech',
    description: 'Top, new or best Hacker News stories with score and comment counts.',
    params: [
      {
        name: 'list',
        label: 'List',
        type: 'enum',
        required: false,
        default: 'top',
        options: [
          { value: 'top', label: 'Top' },
          { value: 'new', label: 'New' },
          { value: 'best', label: 'Best' },
        ],
      },
      { name: 'limit', label: 'Stories', type: 'number', required: false, default: 20, description: '1-50' },
    ],
    minRefreshSec: 180,
    docsUrl: 'https://github.com/HackerNews/API',
    attribution: 'Hacker News (Y Combinator)',
  },
  async fetch(params, ctx) {
    const limit = Math.min(Math.max(Number(params.limit ?? 20), 1), 50);
    const ids = await ctx.fetchJson<number[]>(
      `https://hacker-news.firebaseio.com/v0/${params.list ?? 'top'}stories.json`,
    );
    const items = await Promise.all(
      ids
        .slice(0, limit)
        .map((id) => ctx.fetchJson<HnItem>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
    );
    return inferTable(
      items.map((it, i) => ({
        rank: i + 1,
        title: it.title ?? '',
        score: it.score ?? 0,
        comments: it.descendants ?? 0,
        by: it.by ?? '',
        time: (it.time ?? 0) * 1000,
        url: it.url ?? `https://news.ycombinator.com/item?id=${it.id}`,
      })),
      { types: { time: 'time' } },
    );
  },
  sample(params) {
    const limit = Math.min(Number(params.limit ?? 20), 50);
    const r = rng(seedOf('hn', floorTo(Date.now(), 600_000)));
    const topics = [
      'Show HN: A dashboard you wire up with an AI agent',
      'The case for boring technology in 2026',
      'SQLite is all you need (for most things)',
      'Model Context Protocol, one year later',
      'Why we moved back to a monolith',
      'A visual guide to OAuth 2.1',
      'Writing a Pratt parser in 200 lines',
      'Apache ECharts 6 released',
      'How Open-Meteo serves billions of forecasts',
      'The hidden cost of microfrontends',
    ];
    const rows = Array.from({ length: limit }, (_, i) => ({
      rank: i + 1,
      title: topics[i % topics.length]!,
      score: Math.round(600 / (i + 1) + r() * 50),
      comments: Math.round(300 / (i + 1) + r() * 30),
      by: ['pg', 'dang', 'tptacek', 'patio11', 'simonw'][Math.floor(r() * 5)]!,
      time: Date.now() - Math.floor(r() * DAY),
      url: 'https://news.ycombinator.com/',
    }));
    return inferTable(rows, { types: { time: 'time' } });
  },
};

export const githubRepo: Connector = {
  info: {
    id: 'github.repo',
    name: 'GitHub repository',
    category: 'Tech',
    description: 'Stars, forks, open issues and watchers of one or more public repositories.',
    params: [
      {
        name: 'repos',
        label: 'Repositories',
        type: 'string',
        required: true,
        default: 'facebook/react,vuejs/core,sveltejs/svelte',
        description: 'Comma separated owner/name',
      },
    ],
    minRefreshSec: 900,
    docsUrl: 'https://docs.github.com/en/rest/repos/repos#get-a-repository',
    attribution: 'GitHub REST API',
  },
  async fetch(params, ctx) {
    const repos = String(params.repos)
      .split(',')
      .map((r) => r.trim())
      .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r))
      .slice(0, 10);
    const rows = await Promise.all(
      repos.map(async (repo) => {
        const j = await ctx.fetchJson<Record<string, unknown>>(`https://api.github.com/repos/${repo}`, {
          accept: 'application/vnd.github+json',
        });
        return {
          repo,
          stars: j.stargazers_count,
          forks: j.forks_count,
          open_issues: j.open_issues_count,
          watchers: j.subscribers_count,
          language: j.language,
          pushed_at: j.pushed_at,
        };
      }),
    );
    return inferTable(rows);
  },
  sample(params) {
    const repos = String(params.repos ?? 'facebook/react')
      .split(',')
      .map((r) => r.trim())
      .slice(0, 10);
    return inferTable(
      repos.map((repo) => {
        const r = rng(seedOf(repo));
        return {
          repo,
          stars: Math.round(20_000 + r() * 200_000),
          forks: Math.round(2_000 + r() * 40_000),
          open_issues: Math.round(100 + r() * 1500),
          watchers: Math.round(500 + r() * 6000),
          language: ['TypeScript', 'JavaScript', 'Rust', 'Go'][Math.floor(r() * 4)]!,
          pushed_at: new Date(Date.now() - Math.floor(r() * DAY)).toISOString(),
        };
      }),
    );
  },
};

export const npmDownloads: Connector = {
  info: {
    id: 'npm.downloads',
    name: 'npm downloads',
    category: 'Tech',
    description: 'Daily download counts of npm packages (long table: day, package, downloads).',
    params: [
      {
        name: 'packages',
        label: 'Packages',
        type: 'string',
        required: true,
        default: 'react,vue,svelte',
        description: 'Comma separated, max 8',
      },
      {
        name: 'period',
        label: 'Period',
        type: 'enum',
        required: false,
        default: 'last-month',
        options: [
          { value: 'last-week', label: 'Last week' },
          { value: 'last-month', label: 'Last month' },
          { value: 'last-year', label: 'Last year' },
        ],
      },
    ],
    minRefreshSec: 6 * 3600,
    docsUrl: 'https://github.com/npm/registry/blob/main/docs/download-counts.md',
    attribution: 'npm, Inc.',
  },
  async fetch(params, ctx) {
    const pkgs = String(params.packages)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 8);
    const results = await Promise.all(
      pkgs.map((p) =>
        ctx
          .fetchJson<{ downloads: { day: string; downloads: number }[] }>(
            `https://api.npmjs.org/downloads/range/${params.period ?? 'last-month'}/${encodeURIComponent(p)}`,
          )
          .then((j) => j.downloads.map((d) => ({ day: d.day, package: p, downloads: d.downloads }))),
      ),
    );
    return inferTable(results.flat());
  },
  sample(params) {
    const pkgs = String(params.packages ?? 'react')
      .split(',')
      .map((p) => p.trim())
      .slice(0, 8);
    const days =
      { 'last-week': 7, 'last-month': 30, 'last-year': 365 }[String(params.period ?? 'last-month')] ?? 30;
    const end = floorTo(Date.now(), DAY) - DAY;
    const rows = pkgs.flatMap((p, k) => {
      const r = rng(seedOf('npm', p));
      const base = [3_500_000, 900_000, 300_000, 150_000][k] ?? 80_000;
      return Array.from({ length: days }, (_, i) => {
        const t = end - (days - 1 - i) * DAY;
        const weekend = [0, 6].includes(new Date(t).getUTCDay());
        return { day: t, package: p, downloads: Math.round(base * (weekend ? 0.55 : 1) * (0.9 + r() * 0.2)) };
      });
    });
    return inferTable(rows, { types: { day: 'time' } });
  },
};
