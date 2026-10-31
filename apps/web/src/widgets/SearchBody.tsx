import { type SearchConfig, searchPlaceholder, searchUrl } from '@patchbay/core';
import { Search } from 'lucide-react';
import { useState } from 'react';

/**
 * Navigates straight to the engine: the query never reaches our server, and a `<form action>` to another origin
 * would be blocked by the CSP's `form-action 'self'`, which should stay.
 */
export function SearchBody({ config }: { config: SearchConfig }) {
  const [query, setQuery] = useState('');
  const placeholder = searchPlaceholder(config);
  const go = () => {
    const url = searchUrl(config, query);
    if (!url) return;
    if (config.newTab) window.open(url, '_blank', 'noopener,noreferrer');
    else window.location.assign(url);
  };
  return (
    // An unknown element in old TV browsers still lays out as a box through the classes.
    <search className="flex h-full items-center">
      <label className="flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 focus-within:border-ink-2">
        <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          // biome-ignore lint/a11y/noAutofocus: opt-in per widget, for start pages; off by default
          autoFocus={config.autofocus}
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // The dashboard's single-key shortcuts (F, undo) must not fire while typing a query.
            e.stopPropagation();
            if (e.key === 'Enter') go();
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
        />
      </label>
    </search>
  );
}
