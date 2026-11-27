import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, '../public/legacy-check.js'), 'utf8');

type El = {
  id?: string;
  style: Record<string, string>;
  textContent?: string;
  children: El[];
  parentNode?: El;
  appendChild(child: El): El;
  removeChild(child: El): void;
};

function element(): El {
  const el: El = {
    style: {},
    children: [],
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentNode = undefined;
    },
  };
  return el;
}

function text(el: El): string {
  return [el.textContent ?? '', ...el.children.map(text)].join(' ');
}

// Runs the script the way index.html does (classic script, globals from the page) against small fakes.
function run(options: { missing?: 'registerProperty'; readyState?: string; observer?: boolean } = {}) {
  const timers: { fn: () => void; delay: number }[] = [];
  const windowListeners: Record<string, () => void> = {};
  const documentListeners: Record<string, () => void> = {};
  const root = Object.assign(element(), { childNodes: [] as unknown[] });
  const inserted: El[] = [];
  const body = element();
  const originalAppend = body.appendChild;
  body.appendChild = (child) => {
    inserted.push(child);
    return originalAppend(child);
  };
  const fakeDocument = {
    readyState: options.readyState ?? 'loading',
    documentElement: { dataset: {} as Record<string, string> },
    addEventListener: (name: string, fn: () => void) => {
      documentListeners[name] = fn;
    },
    getElementById: (id: string) =>
      id === 'root' ? root : (inserted.find((e) => e.id === id && e.parentNode) ?? null),
    createElement: () => element(),
    body,
  };
  const css: Record<string, unknown> = { supports: () => true, registerProperty: () => {} };
  if (options.missing) delete css[options.missing];
  const fakeWindow: Record<string, unknown> = {
    CSS: css,
    CSSLayerBlockRule: {},
    HTMLScriptElement: { prototype: { noModule: false } },
    Object,
    Array,
    String,
    setTimeout: (fn: () => void, delay: number) => timers.push({ fn, delay }),
    addEventListener: (name: string, fn: () => void) => {
      windowListeners[name] = fn;
    },
  };
  if (options.observer === false) fakeWindow.MutationObserver = undefined;
  new Function('window', 'document', source)(fakeWindow, fakeDocument);
  return {
    root,
    inserted,
    timers,
    windowListeners,
    documentListeners,
    messages: () => inserted.filter((e) => e.id === 'pb-legacy'),
  };
}

describe('legacy-check.js', () => {
  it('shows nothing on a browser with every feature, and nothing once the app has rendered', () => {
    const page = run();
    expect(page.timers).toHaveLength(0);
    page.windowListeners.load?.();
    expect(page.timers).toHaveLength(1);
    page.root.childNodes = [{}];
    page.timers[0]?.fn();
    expect(page.messages()).toHaveLength(0);
    expect(page.root.style.display).toBeUndefined();
  });

  it('names the minimum browsers and a TV hint when a feature is missing', () => {
    const page = run({ missing: 'registerProperty', readyState: 'complete' });
    const [message] = page.messages();
    expect(message).toBeDefined();
    const words = text(message as El);
    for (const part of ['Chrome or Edge 111', 'Safari 16.4', 'Firefox 128', 'streaming stick'])
      expect(words).toContain(part);
    expect(page.root.style.display).toBe('none');
  });

  it('waits for the document when a feature is missing and the page is still loading', () => {
    const page = run({ missing: 'registerProperty' });
    expect(page.messages()).toHaveLength(0);
    page.documentListeners.DOMContentLoaded?.();
    expect(page.messages()).toHaveLength(1);
  });

  it('shows the same message when the app has not mounted long after load', () => {
    const page = run();
    page.windowListeners.load?.();
    expect(page.timers[0]?.delay).toBeGreaterThanOrEqual(10_000);
    page.timers[0]?.fn();
    expect(page.messages()).toHaveLength(1);
    expect(text(page.messages()[0] as El)).toContain('reload the page');
  });

  it('polls for the app and takes the message down when a slow device mounts it late', () => {
    const page = run({ observer: false });
    page.windowListeners.load?.();
    page.timers[0]?.fn();
    const [message] = page.messages();
    expect(message?.parentNode).toBeDefined();
    page.root.childNodes = [{}];
    page.timers[1]?.fn();
    expect(message?.parentNode).toBeUndefined();
  });

  it('is written in ES5, so an old engine can parse it', () => {
    // Comments explain why and may use these words.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/=>/);
    expect(code).not.toContain('`');
    expect(code).not.toMatch(/\blet\b/);
    expect(code).not.toMatch(/\bconst\b/);
    expect(code).not.toMatch(/\bclass\s/);
    expect(code).not.toContain('...');
  });

  it('is loaded from index.html as a classic script after theme-init.js', () => {
    const html = readFileSync(join(import.meta.dirname, '../index.html'), 'utf8');
    expect(html).toContain(
      '<script src="/theme-init.js"></script>\n    <script src="/legacy-check.js"></script>',
    );
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});
