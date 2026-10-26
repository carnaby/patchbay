// Core targets plain ES2023 so it cannot reach for DOM or Node APIs by accident. The WHATWG URL parser is the one
// exception it needs (secret bindings must parse URLs exactly like the server's fetch does), and it exists in every
// runtime core runs in. Only the members core uses are declared; the apps type-check against their full definitions.
declare class URLSearchParams {
  keys(): IterableIterator<string>;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  readonly href: string;
  readonly origin: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly searchParams: URLSearchParams;
}
