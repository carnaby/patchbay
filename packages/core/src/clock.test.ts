import { describe, expect, it } from 'vitest';
import {
  applyOps,
  ClockConfigSchema,
  clockModel,
  clockSvg,
  describeClock,
  emptyDashboard,
  handAngles,
  isDataWidgetType,
  SearchConfigSchema,
  SIZE_HINTS,
  searchPlaceholder,
  searchUrl,
  THEMES,
  WidgetSchema,
  zoneCity,
} from './index.ts';

const clock = (input: Record<string, unknown> = {}) => ClockConfigSchema.parse(input);
// Thursday 30 July 2026, 12:34:56 UTC: summer time in Europe and New York.
const SUMMER = Date.UTC(2026, 6, 30, 12, 34, 56);
// Friday 15 January 2027, 23:05:09 UTC: winter time.
const WINTER = Date.UTC(2027, 0, 15, 23, 5, 9);

describe('clock schema', () => {
  it('fills defaults and stays strict', () => {
    expect(clock()).toEqual({ style: 'digital', hourCycle: 'h23', showDate: true, showSeconds: false });
    expect(ClockConfigSchema.safeParse({ colour: 'red' }).success).toBe(false);
  });

  it('accepts IANA zones and rejects unknown ones', () => {
    expect(clock({ timeZone: 'Europe/Bratislava' }).timeZone).toBe('Europe/Bratislava');
    expect(clock({ timeZone: 'UTC' }).timeZone).toBe('UTC');
    expect(ClockConfigSchema.safeParse({ timeZone: 'Mars/Olympus_Mons' }).success).toBe(false);
    expect(ClockConfigSchema.safeParse({ timeZone: '' }).success).toBe(false);
  });

  it('is a data-free widget with its own size', () => {
    expect(WidgetSchema.safeParse({ id: 'c', type: 'clock', config: {} }).success).toBe(true);
    expect(WidgetSchema.safeParse({ id: 'c', type: 'clock', datasetId: 'd', config: {} }).success).toBe(
      false,
    );
    expect(
      WidgetSchema.safeParse({ id: 'c', type: 'clock', config: {}, sound: { trigger: { kind: 'newRows' } } })
        .success,
    ).toBe(false);
    expect(isDataWidgetType('clock')).toBe(false);
    expect(isDataWidgetType('search')).toBe(false);
    expect(isDataWidgetType('text')).toBe(false);
    expect(isDataWidgetType('table')).toBe(true);
    expect(SIZE_HINTS.clock).toEqual({ w: 3, h: 2 });
  });

  it('can be added by an operation without a dataset', () => {
    const doc = applyOps(emptyDashboard(), [
      { op: 'addWidget', widget: { id: 'time', type: 'clock', config: { timeZone: 'Asia/Tokyo' } } },
    ]).doc;
    expect(doc.widgets[0]).toMatchObject({
      type: 'clock',
      config: { timeZone: 'Asia/Tokyo', style: 'digital' },
    });
    expect(doc.layout[0]).toMatchObject({ w: 3, h: 2 });
  });
});

describe('clockModel', () => {
  it('formats a named zone with summer and winter time', () => {
    const bratislava = clock({ timeZone: 'Europe/Bratislava' });
    expect(clockModel(bratislava, SUMMER, { locale: 'en-GB' }).time).toBe('14:34');
    expect(clockModel(bratislava, WINTER, { locale: 'en-GB' }).time).toBe('00:05');
    const ny = clock({ timeZone: 'America/New_York' });
    expect(clockModel(ny, SUMMER, { locale: 'en-GB' }).time).toBe('08:34');
    expect(clockModel(ny, WINTER, { locale: 'en-GB' }).time).toBe('18:05');
  });

  it('uses the fallback zone only when the config names none', () => {
    expect(clockModel(clock(), SUMMER, { locale: 'en-GB', zone: 'UTC' }).time).toBe('12:34');
    expect(clockModel(clock({ timeZone: 'Asia/Tokyo' }), SUMMER, { locale: 'en-GB', zone: 'UTC' }).time).toBe(
      '21:34',
    );
  });

  it('supports 12-hour clocks and seconds', () => {
    const m = clockModel(clock({ timeZone: 'UTC', hourCycle: 'h12', showSeconds: true }), WINTER, {
      locale: 'en-US',
    });
    expect(m.time).toBe('11:05:09');
    expect(m.period).toBe('PM');
    expect(
      clockModel(clock({ timeZone: 'UTC', hourCycle: 'h12' }), Date.UTC(2026, 0, 1, 0, 7), {
        locale: 'en-US',
      }),
    ).toMatchObject({ time: '12:07', period: 'AM' });
    expect(clockModel(clock({ timeZone: 'UTC' }), WINTER, { locale: 'en-GB' }).period).toBeNull();
  });

  it('writes the date in the viewer language and labels the city', () => {
    const m = clockModel(clock({ timeZone: 'Europe/Bratislava' }), SUMMER, { locale: 'en-GB' });
    expect(m.date).toBe('Thursday 30 July');
    expect(m.label).toBe('Bratislava');
    const sk = clockModel(clock({ timeZone: 'Europe/Bratislava' }), SUMMER, { locale: 'sk-SK' });
    expect(sk.date?.toLowerCase()).toContain('štvrtok');
    expect(clockModel(clock({ showDate: false }), SUMMER, { locale: 'en-GB' }).date).toBeNull();
    // An explicit label wins; a local clock without a zone has none.
    expect(clockModel(clock({ timeZone: 'UTC', label: 'Office' }), SUMMER, { locale: 'en-GB' }).label).toBe(
      'Office',
    );
    expect(clockModel(clock(), SUMMER, { locale: 'en-GB' }).label).toBeNull();
  });

  it('falls back to a working locale for a broken one', () => {
    expect(clockModel(clock({ timeZone: 'UTC' }), SUMMER, { locale: 'not a locale!!' }).date).toBe(
      'Thursday 30 July',
    );
  });

  it('names cities from zones', () => {
    expect(zoneCity('America/New_York')).toBe('New York');
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCity('UTC')).toBe('UTC');
  });

  it('describes the clock without seconds', () => {
    const m = clockModel(clock({ timeZone: 'Europe/Bratislava', showSeconds: true }), SUMMER, {
      locale: 'en-GB',
    });
    expect(describeClock(m)).toBe('14:34, Thursday 30 July, Bratislava');
    const pm = clockModel(clock({ timeZone: 'UTC', hourCycle: 'h12', showSeconds: true }), WINTER, {
      locale: 'en-US',
    });
    expect(describeClock(pm)).toBe('11:05 PM, Friday, January 15, UTC');
  });
});

describe('clockSvg', () => {
  it('puts the hands where a clock has them', () => {
    expect(handAngles({ hours: 3, minutes: 0, seconds: 0 })).toEqual({
      hourAngle: 90,
      minuteAngle: 0,
      secondAngle: 0,
    });
    expect(handAngles({ hours: 15, minutes: 30, seconds: 15 })).toMatchObject({
      hourAngle: 105,
      minuteAngle: 181.5,
      secondAngle: 90,
    });
  });

  it('escapes the label and draws both styles', () => {
    const config = clock({ timeZone: 'UTC', label: '<b>"HQ" & co</b>' });
    const m = clockModel(config, SUMMER, { locale: 'en-GB' });
    const digital = clockSvg(m, config, THEMES.light);
    expect(digital).toContain('&lt;b&gt;&quot;HQ&quot; &amp; co&lt;/b&gt;');
    expect(digital).not.toContain('<b>');
    expect(digital).toContain('>12:34<');
    const analogConfig = clock({ timeZone: 'UTC', style: 'analog', showSeconds: true });
    const analog = clockSvg(clockModel(analogConfig, SUMMER, { locale: 'en-GB' }), analogConfig, THEMES.dark);
    expect(analog.match(/<line /g)?.length).toBe(60 + 3);
    expect(analog).toContain(THEMES.dark.status.critical);
    // A font name cannot break out of its attribute either.
    expect(clockSvg(m, config, THEMES.light, 'Inter" onload="x')).not.toContain('" onload="');
  });
});

describe('search widget', () => {
  const search = (input: Record<string, unknown> = {}) => SearchConfigSchema.parse(input);

  it('defaults to Google and builds encoded URLs', () => {
    const config = search();
    expect(config).toEqual({ engine: 'google', newTab: false, autofocus: false });
    expect(searchUrl(config, '  rock & roll #1 ')).toBe(
      'https://www.google.com/search?q=rock%20%26%20roll%20%231',
    );
    expect(searchUrl(search({ engine: 'duckduckgo' }), 'počasie')).toBe(
      'https://duckduckgo.com/?q=po%C4%8Dasie',
    );
    expect(searchUrl(config, '   ')).toBeNull();
    expect(searchPlaceholder(config)).toBe('Search Google');
  });

  it('accepts only https custom templates with {q}', () => {
    expect(
      SearchConfigSchema.safeParse({ engine: 'custom', template: 'http://x.example/?q={q}' }).success,
    ).toBe(false);
    expect(SearchConfigSchema.safeParse({ engine: 'custom', template: 'https://x.example/' }).success).toBe(
      false,
    );
    const wiki = search({ engine: 'custom', template: 'https://en.wikipedia.org/w/index.php?search={q}' });
    expect(searchUrl(wiki, 'a/b?c')).toBe('https://en.wikipedia.org/w/index.php?search=a%2Fb%3Fc');
    expect(searchPlaceholder(wiki)).toBe('Search en.wikipedia.org');
  });

  it('cannot move the query out of its slot', () => {
    const tricky = search({ engine: 'custom', template: 'https://{q}.example.com/?q={q}' });
    // Encoded, the query is not a valid host label, and the scheme cannot change.
    expect(searchUrl(tricky, 'evil.com/') ?? '').not.toMatch(/^https:\/\/evil\.com/);
  });

  it('needs a template exactly for the custom engine', () => {
    const add = (config: Record<string, unknown>) => () =>
      applyOps(emptyDashboard(), [{ op: 'addWidget', widget: { id: 's', type: 'search', config } }]);
    expect(add({ engine: 'custom' })).toThrow(/custom search engine needs a template/);
    expect(add({ engine: 'google', template: 'https://x.example/?q={q}' })).toThrow(/only used with engine/);
    expect(add({ engine: 'custom', template: 'https://x.example/?q={q}' })).not.toThrow();
  });
});
