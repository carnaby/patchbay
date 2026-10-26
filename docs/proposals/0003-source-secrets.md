# Proposal 0003: secrets for HTTP data sources

|                    |                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | **Implemented** (server, web UI and user docs). The owner decided to offer credentials on HTTP sources, behind an instance switch and with a prominent warning. See "Decisions" and "Implementation notes" at the end. |
| Area               | `packages/core` (schema, binding matcher), `apps/server` (storage, encryption, `DashboardService`, `DataService`, `safe-fetch`, `LiveHub`, REST, MCP), `apps/web` (Settings, dataset editor, share panel)              |
| Effort             | About five days including tests and docs                                                                                                                                                                               |
| New infrastructure | None. One SQLite table, one environment key.                                                                                                                                                                           |

## Problem

An HTTP dataset source is "any public HTTPS JSON endpoint (no credentials, private networks are blocked)"
(`SourceSchema` in `packages/core/src/schema.ts`). Patchbay therefore cannot read APIs that sit behind a token, which
includes most of the APIs people actually want on a dashboard: their own web apps, their shop's back office, a
self-hosted analytics tool, a SaaS API with a personal key. An AI agent working through the MCP server flagged this as
the main limit.

Today the only workaround is to paste the key into the URL (`?api_key=…`). That is strictly worse than anything in
this proposal: the URL is stored in the document, in all 50 versions, returned by `get_dashboard` to every agent, and
shown to every viewer of a public dashboard.

## Goal

A signed-in user can save a credential once, in Settings, and let an HTTP dataset use it. The credential:

- is stored encrypted at rest and can be set, replaced and deleted, but **never read back** by anyone through
  Patchbay: not the editor, not the API, not MCP, not viewers;
- is only ever sent to the exact address it was saved for (**host binding**), so whoever can edit a dashboard,
  including an agent, cannot redirect it elsewhere;
- is only usable in dashboards **owned by the user who saved it**.

Before saving, the user is told plainly that the operator of the instance can technically read it, and that sensitive
data belongs on a self-hosted instance. The operator decides whether the instance offers secrets at all.

## Non-goals

- **Protecting secrets from the operator.** A server that sends a token on the user's behalf must be able to decrypt
  it. Encryption protects backups, copies of the database and other users, not against whoever runs the process and
  holds the key. The warning says so; self-hosting is the answer for sensitive data.
- **OAuth flows to third-party APIs** (authorization code, refresh tokens). Only static secrets: API keys, bearer
  tokens, service tokens.
- **Request bodies and other methods.** HTTP sources stay `GET` returning JSON. GraphQL over `POST` is a separate
  question.
- **Secrets for built-in connectors** (a GitHub token for higher rate limits). The same `secrets` field could be added
  to connector sources later; nothing here prevents it.
- **Sharing secrets** between users or teams.
- **Private networks.** The SSRF block stays exactly as it is (see "Fetching"). Reaching databases or LAN services is
  discussed in [proposal 0004](0004-database-connector.md).
- **Fetching with credentials in the browser.** Rejected below ("Alternatives considered").

## Security model

Who can do what once this ships:

| Actor                                                     | Can                                                                                                                                       | Cannot                                                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The user who saved the secret                             | Use it in their own dashboards for its bound address; rename, replace the value, delete                                                   | Read the value back, change the bound address (create a new secret instead)                                                       |
| A viewer of a public dashboard backed by a secret         | See the data it returns, the dataset URL and the secret's id                                                                              | Learn the value, use the secret anywhere else                                                                                     |
| Another user of the instance                              | Nothing with it                                                                                                                           | List, use, reference or read it (resolution is per owner, see "Who can use which secret")                                         |
| An agent connected with the user's token (MCP or PAT)     | List names and bound addresses; reference the user's secrets in the user's dashboards, on the bound address only; read the resulting data | Read, create, replace or delete values; make a secret-backed dashboard public; change a public secret-backed dashboard in any way |
| Someone holding a copy of the data directory or a backup  | Ciphertext                                                                                                                                | Decrypt it without `SECRETS_KEY`                                                                                                  |
| The operator, or anyone with the key **and** the database | Decrypt everything                                                                                                                        | (by design; this is what the warning is about)                                                                                    |
| The API at the bound address                              | Receive the secret (it issued it)                                                                                                         | Have it reflected back to viewers: echoed values are redacted from responses                                                      |

The residual risk worth naming: an agent, possibly steered by a prompt injection in some data it read, can use a
secret against **other paths on the same address** and show the result in the user's private dashboards (and send it
to its model provider). Least-privilege keys and the optional path prefix limit this; the UI recommends both.

The token rules restrict **references and public secret-backed dashboards**, not where data an agent has read can be
copied. An agent that read rows with `get_data` or `preview_data` can write them into another dashboard as an inline
dataset, a text widget or its own answer, and nothing on the server can tell those rows apart from any other data.
The reference text tells agents not to, which is all the server can do.

## User experience

### Settings → Secrets

A new section on the Settings page, under "Personal access tokens", built from the same pieces (`Section`, `Card`,
list rows with an `IconButton` to delete, a `Modal` to create). It is hidden when the instance switch is `off` and the
user has no secrets, and explains "This instance only lets administrators store secrets" in `admins` mode.

Each row shows:

- **Name** (e.g. "Shop API, read-only"),
- **Only sent to** `https://api.example.com/v1/…`,
- **Sent as** `Authorization: Bearer ••••` · `Header X-API-Key` · `Query parameter api_key`,
- **Used by** the datasets that reference it (dashboard title → dataset name, linked),
- **Last used**, **Updated**.

Actions: rename, **Replace value**, delete. Deleting a secret in use asks for confirmation and lists the datasets that
will stop loading.

**Add a secret** opens a modal:

| Field        | Notes                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name         | 1–80 characters, unique per user (ignoring case)                                                                                                                                                                                            |
| Only send to | A URL prefix, e.g. `https://api.example.com/v1/`. Parsed and shown back as origin + path prefix. HTTPS only, no user name or password, no query or fragment                                                                                 |
| Send it as   | _Bearer token_ (default) · _Custom header_ (name) · _Query parameter_ (name). The query option carries the hint "Prefer a header if the API supports one: query parameters end up in the API's access logs."                                |
| Value        | Password input with a show toggle, `autocomplete="off"`, `spellCheck={false}`. Trimmed. 8–4096 characters, no control characters, printable ASCII when sent in a header. A pasted `Bearer …` prefix is refused with "Paste only the token." |
| Warning      | The text below, with a required checkbox. Save stays disabled until it is ticked                                                                                                                                                            |

The dialog never receives a value from the server, so "Replace value" opens the same modal with an empty value field,
the binding read-only, and the same warning and checkbox.

The value is sent once, with `POST /api/secrets`, and dropped from client state right after: the request is made with
`api()` directly and the mutation is reset on success, so the value does not linger in TanStack Query's mutation
cache (where `useMutation` keeps `variables`) or in devtools.

### The warning (draft)

Shown in an amber callout at the top of the create and replace dialogs. `{instance}` is the host of `PUBLIC_URL`,
`{address}` is the parsed "Only send to" value.

> **Before you save this secret**
>
> Patchbay will store this value on **{instance}** and send it with every request your datasets make to
> **{address}**. After saving, nobody can view it in Patchbay: not you, not AI agents, not people who view your
> dashboards.
>
> **The operator of {instance} can technically read it.** The value is encrypted, but the server has to decrypt it to
> use it, so whoever runs this server can get to it. Only continue if you trust them with this credential.
>
> - Use a key with as little access as possible: read-only, limited to the data you want to show, with an expiry if
>   the API offers one.
> - If a dashboard that uses this secret is public, anyone with the link sees the data it returns (never the secret
>   itself).
> - For sensitive data, run your own Patchbay. It is open source and runs as a single container:
>   https://github.com/carnaby/patchbay

Required checkbox below the callout: **☐ I understand that the operator of {instance} can access this secret.**

For a signed-in admin of the instance, one more line: "You administer this instance. The encryption key
(`SECRETS_KEY`) must not be stored in the same backup as the data directory, or the backup holds readable secrets."

### Using a secret in a dataset

In `DatasetsPanel` (`source.kind === 'http'`), a **Credentials** field below the URL:

- `None (public endpoint)`, the default.
- The user's secrets whose binding matches the URL, by name, with "Sent as …".
- Secrets bound elsewhere are listed disabled, with their address ("only sent to https://other.example.com/").
- **Add a secret…** opens the Settings modal in place, with "Only send to" prefilled from the URL's origin.

Up to three secrets per source, for APIs that need two values (a Cloudflare Access service token is
`CF-Access-Client-Id` plus `CF-Access-Client-Secret`; some APIs want `app_id` plus `app_key`).

The hint under the URL changes from "A public JSON endpoint without credentials" to "Don't put keys into the URL;
use Credentials instead." If the URL's query has a parameter that looks like a credential (`key`, `api_key`,
`apikey`, `token`, `access_token`, `secret`, `password`, `auth`, `signature`, case-insensitive), the editor shows a
warning with a one-click "Move it into a secret" that opens the modal with the name and value prefilled and removes it
from the URL. This is a warning, not a rejection: existing dashboards keep working.

The dataset list shows a lock icon next to the host (`sourceSummary`) for secret-backed datasets.

### Public dashboards

Data fetched with a secret is shown to whoever may view the dashboard. That is the point of the feature, and also the
easiest way to publish something by accident, so both ways of creating the combination ask first:

- **Making a dashboard public** (`SharePanel`) that has secret-backed datasets: "This dashboard uses your secrets
  _Shop API_ and _Stats key_. Anyone with the link will see the data they return (never the secrets themselves).
  Make it public?"
- **Adding a secret to a dataset of a public dashboard** in the editor: the same confirmation before the change is
  applied.

The share panel shows a persistent line while both are true: "Public · shows data fetched with 2 secrets".

### When something is wrong

A secret-backed dataset can fail for reasons the editor can explain better than a widget can. Widget errors (the
`DatasetResult.error` every viewer sees) stay generic; the dataset editor, which only the owner opens, adds detail
from the secret list it already has and the shared binding matcher in core:

| Situation                                       | Widget (everyone)                                           | Dataset editor (owner)                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secret deleted, or belongs to someone else      | "Credentials for this source are not available."            | "The secret this dataset used no longer exists. Pick one of your secrets for api.example.com."                                                         |
| URL no longer matches the secret's binding      | "Credentials for this source are bound to another address." | "_Shop API_ is only sent to https://api.example.com/v1/. Change the URL back or pick another secret." Checked while typing, before any preview request |
| Instance switch turned off or owner not allowed | "Credentials are turned off on this server."                | Same, plus "Your secrets are kept; ask the operator, or remove the credential to load the URL without it."                                             |
| Anonymous dashboard                             | n/a (cannot be saved)                                       | Field disabled: "Sign in and claim this dashboard to use secrets."                                                                                     |
| Server key changed, value cannot be decrypted   | "Credentials could not be decrypted on this server."        | Same, plus "Replace the value to store it again."                                                                                                      |
| Upstream answered 401/403                       | "Upstream responded 401" (as today)                         | "The API rejected the credential. Check it is still valid, then replace the value."                                                                    |

A dataset whose secret cannot be resolved is **never fetched without it**: the request does not happen at all.

### Agents (MCP)

- New read-only tool **`list_secrets`**: `[{ id, name, origin, pathPrefix, sentAs, updatedAt, lastUsedAt }]`, plus a
  line: "Values are never readable. To add one, ask the user to open {PUBLIC_URL}/settings#secrets."
- Agents reference secrets in operations like any other field:
  `{ "op": "updateDataset", "id": "orders", "set": { "source": { "kind": "http", "url": "https://shop.example.com/api/orders", "secrets": ["sec_…"] } } }`.
- **Agents cannot create, replace or delete secrets.** The value would pass through the model, the provider's logs and
  the chat transcript, and the user would have to paste it into a chat anyway, which is the habit this feature should
  break. There is no write tool, and the secret write endpoints refuse every bearer token, OAuth and
  personal access tokens alike (the same rule as "Tokens cannot create tokens" in `routes/api.ts`).
- `get_reference` gets a short section (see "Reference text").
- The OAuth consent screen (`pages/OAuthConsent.tsx`) adds a line under write access: "use secrets you saved in your
  own dashboards (never read them)".

## Design

### Document schema (`packages/core/src/schema.ts`)

```ts
export const SecretIdSchema = z
  .string()
  .regex(/^sec_[A-Za-z0-9]{16}$/, 'Secret ids look like "sec_…"; see list_secrets');

// The http member of SourceSchema:
z.strictObject({
  kind: z.literal('http'),
  url: z.url({ protocol: /^https$/ }).max(2000),
  path: z.string().max(200).optional().describe('…'),
  secrets: z
    .array(SecretIdSchema)
    .min(1)
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length, 'Each secret once')
    .optional()
    .describe('Ids of saved secrets (list_secrets) sent with the request, only to the address each is bound to'),
}).describe('An HTTPS JSON endpoint. Private networks are blocked. Credentials only via "secrets", never in the URL'),
```

Datasets reference secrets **by id, not by name**. Names are labels the user can rename and that collide across
users; an id is stable and, more importantly, is looked up **only among the dashboard owner's secrets**, so the same id
in someone else's dashboard resolves to nothing. Ids are not secret (they appear in public documents) and do not need
to be: knowing one gives no access.

A new pure module `packages/core/src/secrets.ts` holds what both the editor and the server need:

- `SecretInfo` (public metadata: id, name, origin, pathPrefix, placement, paramName, timestamps) and
  `SecretPlacement = 'bearer' | 'header' | 'query'`;
- `parseBinding(input: string): { origin, pathPrefix }` for the "Only send to" field;
- `bindingMatches(binding, url): { ok: true } | { ok: false; reason: 'origin' | 'path' | 'encoding' }`;
- `secretRefChanges(prev: DashboardDoc, next: DashboardDoc): string[]`, the ids of datasets that **introduce or
  retarget** a secret reference: new datasets with `secrets`, datasets that gained a secret id, or datasets with
  `secrets` whose `url` changed. Removing an id or reordering them is not a change (nothing new is sent anywhere);
- `credentialLikeParams(url): string[]` for the editor warning.

The editor's preview keys and the query cache key (`JSON.stringify(dataset)` in `state/sync.ts`) need no change: the
document only ever holds ids.

### Host binding

Every secret is bound to an **origin** (`URL.origin`: scheme, host, port) and a **path prefix** (default `/`). A
request carries the secret only if, for that exact request URL:

1. `new URL(url).origin === secret.origin`. Comparing parsed origins handles case and IDN (punycode) normalisation. A
   trailing-dot host (`api.example.com.`) is a different string and therefore a mismatch, which fails safe. The SSRF
   rules currently allow only port 443, so in practice this is scheme + host, but the comparison stays correct if that
   ever changes.
2. `pathname.startsWith(pathPrefix)`. The stored prefix always ends with `/`, so `/v1/` does not match `/v10/`. The
   exact path the prefix was made from (`/v1/orders` for `/v1/orders/`) also matches: it is the address the user
   typed. `URL` already resolves `.`, `..` and their percent-encoded forms. Because servers may decode `%2F` and `%5C`
   into separators after we compared (and `%25` when they decode twice), and many Java servers treat `..;` as `..`, a
   secret with a non-root prefix refuses URLs whose path contains any of these (reason `encoding`). The path is read
   strictly: every `%` must start a two-digit escape (`%u002e` is refused), `%3B` is refused (`..%3b`), the decoded
   bytes must be shortest-form UTF-8 (overlong `%C0%AE`, `%E0%80%AE` and surrogates are refused), and control
   characters and look-alike dots and slashes (fullwidth `．` `／` `＼`, halfwidth `｡`, `∕`, `⁄`, small and ideographic
   full stops), encoded or raw, are refused. Ordinary escaped UTF-8 (`/mestá/Žilina`) passes.
3. For query placement, the URL must not already contain a parameter with the secret's name, compared without case
   because servers differ, so a document cannot shadow or duplicate it (reason `param`).

`parseBinding` applies the same rules to the "Only send to" field and also refuses a non-default port, since data
sources may only use port 443.

The binding is **immutable**. Changing where a value may be sent is the one operation that could leak it, so it is
not an operation: the user creates a new secret. Rename and replace-value keep the binding.

The binding is also part of the encryption's associated data (below), so even someone with write access to the database
but not the key cannot re-point a sealed value at another host: decryption would fail.

### Placement

The secret decides how it is sent, not the dataset. Otherwise an editor or an agent could switch a header secret to
a query parameter and push it into URL logs.

| Placement | Sent as                                                         | Validation                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bearer`  | `Authorization: Bearer <value>`                                 | Value without a `Bearer ` prefix                                                                                                                                                                                      |
| `header`  | `<name>: <value>`                                               | Name is an RFC 9110 token, at most 64 characters, not one of `host`, `connection`, `content-length`, `content-type`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `keep-alive`, `proxy-*`, `accept`, `user-agent` |
| `query`   | `?<name>=<value>` appended to a copy of the URL at request time | Name matches `^[A-Za-z0-9_.~-]{1,64}$`                                                                                                                                                                                |

**Query parameters are supported, deliberately.** Many APIs accept nothing else (a large share of public weather,
mapping and government APIs, and plenty of self-hosted apps). The value is added only to the in-memory request URL;
it never enters the document, Patchbay's logs or error messages (which always quote the document's URL). What remains
is the upstream's own access logs, which belong to the party that issued the key. The UI steers towards headers when
both work. Refusing query placement would push those users back to pasting the key into the URL, which is the worst
option.

Two secrets on one source must not collide (two `bearer` secrets, the same header name, or the same query name); the
save is rejected otherwise.

### Storage (`apps/server/src/db.ts`, `apps/server/src/auth/secrets.ts`)

Secrets are per user, like tokens, so they live in SQLite next to `users` and `tokens`, not in dashboard folders.
Folders are copied when dashboards are duplicated, inspected by hand and deleted by hand; none of that should touch
credentials. Migration 3:

```sql
CREATE TABLE secrets (
  id           TEXT PRIMARY KEY,                         -- sec_ + 16 chars (newId)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  origin       TEXT NOT NULL,                            -- https://api.example.com
  path_prefix  TEXT NOT NULL DEFAULT '/',
  placement    TEXT NOT NULL CHECK (placement IN ('bearer', 'header', 'query')),
  param_name   TEXT,                                     -- header or query parameter name
  key_id       TEXT NOT NULL,                            -- which SECRETS_KEY sealed it
  sealed       BLOB NOT NULL,                            -- version ‖ nonce ‖ ciphertext ‖ tag
  revision     INTEGER NOT NULL DEFAULT 1,               -- +1 on every value change; part of cache keys
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (user_id, name)
);
CREATE INDEX secrets_user ON secrets(user_id);
```

`class Secrets` in `apps/server/src/auth/secrets.ts` mirrors `Tokens`: storage and crypto only, every method scoped by
`userId`. `list`, `create`, `rename`, `replaceValue` (re-seal, `revision + 1`), `remove`, `rotate` (startup), and
`unseal(userId, id)`, whose only caller is `DashboardService.credentialsFor`. `markUsed` writes `last_used_at` at most
once a minute per secret, so a one-second live refresh does not turn into a write storm. At most 20 secrets per user.

Deleting a user deletes their secrets (`ON DELETE CASCADE`).

### Encryption and the key (`apps/server/src/util/crypto.ts`, `apps/server/src/config.ts`)

- **AES-256-GCM** from `node:crypto`, a fresh 12-byte random nonce per seal. `seal(key, plaintext, aad)` returns
  `0x01 ‖ nonce ‖ ciphertext ‖ tag`; `unseal` checks the version byte and the tag.
- **Associated data** binds a ciphertext to its row and its binding:
  `pb-secret-v1 \n id \n user_id \n origin \n path_prefix \n placement \n param_name`. A sealed value copied into
  another row, another user or another binding does not decrypt.
- **`SECRETS_KEY`**: 32 random bytes, base64 (`openssl rand -base64 32`, or
  `node -e "console.log(crypto.randomBytes(32).toString('base64'))"` on Windows). `loadConfig` rejects anything that
  does not decode to exactly 32 bytes.
- **`key_id`** is the first 16 hex characters of `SHA-256("patchbay-secrets-key-id" ‖ key)`. It identifies which key
  sealed a row without revealing anything useful about the key.
- Values are decrypted per request, kept only in the scope of that request, and never passed to pipeline workers
  (pipelines see rows, not requests). JavaScript cannot zero strings, so a heap dump of the process can contain values;
  that is operator-level access, which the warning already covers.

**Rotation.** Set the new key as `SECRETS_KEY` and the old one as `SECRETS_KEY_PREVIOUS` (comma-separated if
several), restart. At startup `Secrets.rotate()` re-seals every row whose `key_id` belongs to a previous key, in one
transaction, and logs `[patchbay] re-encrypted N secrets with the current SECRETS_KEY`. Then remove
`SECRETS_KEY_PREVIOUS`. Rows that no configured key can open are left untouched and counted in the log
(`N secrets cannot be decrypted with the configured keys`); their datasets show "could not be decrypted" and the
owner can replace the value.

**Key loss** makes every value unrecoverable, by design. Users re-enter them; nothing else breaks.

**Key compromise together with a database copy** cannot be fixed by rotation: the old copy plus the old key still
decrypt. The only remedy is revoking the credentials at their source. The admin page shows the number of secrets per
user (never values or names) so the operator knows whom to tell.

**Backups** of `DATA_DIR` contain only ciphertext. `docs/deployment.md` gets a paragraph: keep `SECRETS_KEY` in a
password manager or secret store, not in the same backup set as `data/`; in the NAS setup that means not backing up
`patchbay.env` together with `data/`.

### Instance switch

```
SECRETS=off | admins | users     (default off)
SECRETS_KEY=<base64, 32 bytes>   (required unless SECRETS=off)
SECRETS_KEY_PREVIOUS=            (optional, for rotation)
```

- **`off` is the default.** An operator who updates a public instance should not start holding other people's
  credentials, with the liability and attention that brings, because of an upgrade. Turning it on is a deliberate act,
  done together with creating a key. Patchbay's promise "free, no API keys" also stays true for every instance that
  does nothing.
- **`admins`**: only users in `ADMIN_EMAILS` can store and use secrets. The right setting for a personal instance that
  others can also sign in to, which is the owner's case for his own data.
- **`users`**: every signed-in user. For a team instance, or a public instance whose operator accepts the
  responsibility. This is the intended setting for such public instances: whoever stores a secret on someone else's
  instance does so at their own risk, and the warning and the self-hosting recommendation exist for exactly that.
- `SECRETS` other than `off` without a valid `SECRETS_KEY` **refuses to start**: the operator clearly meant to enable
  it, and a half-working feature is worse than a clear error. With `off`, the key is not needed.
- A `SECRETS_KEY` that is set but malformed refuses to start even with `off`, and so does `SECRETS_KEY_PREVIOUS`
  without a current key. Keys are accepted in standard or URL-safe base64. Error messages never repeat the key.
- Switching back to `off` (or an owner losing admin rights in `admins` mode) keeps the rows. Listing and **deleting
  stay allowed**, so users can always clean up; creating, replacing, renaming and using are refused. The check
  happens at use time, so it applies immediately.
- `GET /api/me` gains `secrets: 'off' | 'admins' | 'users'` and `canUseSecrets: boolean`, so the web app shows or hides
  the UI.

### Who can use which secret

One rule decides: **a dataset's secrets are resolved against the secrets of the dashboard's owner** (`meta.ownerId`),
never against the viewer, the editor or the agent making the request. Everything else follows from that rule plus one
invariant: **anonymous dashboards never contain secret references.**

All of it lives in `DashboardService` (`apps/server/src/services/dashboards.ts`), per the rule that permission checks
live only there. Routes and MCP tools just call it.

**At use time** (authoritative), `DashboardService.credentialsFor(target: { id, ownerId }, dataset)` returns the
decrypted credentials or throws an `HttpError` with one of the generic messages from "When something is wrong":

1. no `secrets` → `[]`;
2. switch `off`, or `admins` and the owner is not an admin → refuse;
3. `ownerId === null` → refuse;
4. each id: `Secrets.unseal(ownerId, id)`; `null` → "not available";
5. `bindingMatches(secret, url)` → else "bound to another address";
6. decryption failure → "could not be decrypted" (logged once per secret per process, id only).

`DataService` cannot reach `DashboardService` today (it is constructed first in `createDeps`), so it receives the
function at construction: `new DataService(connectors, store, pipeline, (t, d) => dashboards.credentialsFor(t, d))`,
wired late in `createDeps` (`apps/server/src/app.ts`).

**At save time** (for clear, early errors to editors and agents), `DashboardService.commit` checks the documents it is
about to write, using `secretRefChanges(current, next)`:

- `meta.ownerId === null` and the new document contains any `secrets` → reject: "Sign in and claim this dashboard to use
  secrets." The same check runs in `create`. This is what makes **claiming safe**: someone could otherwise prepare an
  anonymous dashboard that references a victim's secret id (ids are visible in the victim's public documents) on the
  right host but a revealing path, hand over the edit key, and read the data once the victim claims it. Since anonymous
  documents and therefore all their versions never contain references, `claim` has nothing to check.
- For every dataset that introduces or retargets a reference: the secret exists for the owner, the owner may use
  secrets, the binding matches, no placement collides. Otherwise reject with a message that may name the secret's
  address (only the owner and their tokens can edit an owned dashboard).
- If the principal arrived **via a token** (MCP or PAT) and the dashboard is **public** and has any secret reference
  (before or after the change) → reject **every** write: ops (dry runs included), full saves and restores. "This
  dashboard is public and shows data fetched with secrets, so agents and tokens cannot change it: a person has to make
  this change in the Patchbay web app. Ask the user to do it there, or to make the dashboard private first." Refusing
  only new or re-pointed references was not enough: removing a pipeline step, changing the JSON path or `accumulate`,
  adding a widget or restoring an older version can each widen what the public sees, so an injected agent could
  publish full upstream rows without touching a reference. A token may still make such a dashboard **private**, which
  only narrows access; after that it can edit again. Public dashboards without secrets stay editable by tokens.
- If the principal is a **session** and the dashboard is **public**, the confirmation is enforced by the server, not
  only by the dialog: without `confirmPublicSecrets: true` in the request the answer is `428` with
  `{ error, code: "confirm_public_secrets", secrets: [{ id, name }] }`, which the web app turns into the dialog and
  then repeats the request with the flag. Tokens are refused whether or not they send the flag. Dry runs answer like
  the save would.
- Datasets whose references did not change are not re-checked, so deleting a secret never blocks unrelated edits or
  autosave.

`Principal` gains `viaToken: boolean`, set in `identify()` (`apps/server/src/context.ts`) when a bearer token
authenticated the request and in the MCP `principal()` factory.

**The other paths:**

| Path                                     | Behaviour                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate by the owner                   | References kept; the copy has the same owner. The copy is private (the existing default for signed-in users)                                                                                                                                                                                                                                                                  |
| Duplicate by anyone else                 | `secrets` removed from every copied dataset, with a change-log entry "Removed secret references (secrets belong to their owner)". Anonymous copies would be rejected otherwise; signed-in copies would hold dead references. The copy then fetches without credentials and typically shows the upstream's 401, which the editor turns into "This API probably needs a secret" |
| Claim                                    | Nothing to do (invariant above)                                                                                                                                                                                                                                                                                                                                               |
| Restore a version                        | Same owner, so resolution is unchanged. Restore skips the existence and binding checks (a restored reference to a deleted secret shows "not available" at use time instead of blocking the restore), but applies the anonymous invariant, the token rule for public dashboards and the session confirmation                                                                   |
| Visibility → public                      | Through the web UI: allowed with `confirmPublicSecrets: true` after the `428` described above. Via a token (`set_visibility`, `PATCH /settings` with a PAT) on a dashboard with secret-backed datasets: rejected, "Make it public in the web app; it would show data fetched with your secrets to anyone."                                                                    |
| Visibility → private                     | As today: `LiveHub.revalidate` disconnects viewers who lost access                                                                                                                                                                                                                                                                                                            |
| Edit keys                                | Only anonymous dashboards have edit keys, and they cannot hold references                                                                                                                                                                                                                                                                                                     |
| Admins                                   | Can view and delete every dashboard, as today, and therefore see the data of secret-backed datasets in private dashboards. They cannot edit, so they cannot retarget anything. This is consistent with the warning: the operator can access secrets anyway                                                                                                                    |
| PNG snapshots                            | `snapshot.png` and `render_snapshot` resolve with the dashboard's owner like every other path, so they show what viewers see: data, never secrets                                                                                                                                                                                                                             |
| Preview (`POST /dashboards/:id/preview`) | Requires `canEdit`, so for an owned dashboard the caller is the owner; resolves with that dashboard as target                                                                                                                                                                                                                                                                 |
| `preview_data` (MCP)                     | A source with `secrets` needs the `dashboards:write` scope: a preview sends the credentials to a URL the agent chooses, so it is a use, not a read. With `dashboardId`: also requires `canEdit` (like uploads today) and resolves with that dashboard's owner. Without: resolves against the calling user's own secrets                                                       |
| `/api/showcase`                          | Fixed definitions, no secrets                                                                                                                                                                                                                                                                                                                                                 |

### Fetching (`apps/server/src/util/safe-fetch.ts`)

`safeFetchJson(raw, { credentials })`, where a `Credential` is `{ id, revision, origin, pathPrefix, placement,
paramName, value }`.

- **SSRF rules are unchanged** and apply first, on every hop: HTTPS only, no userinfo, port 443, every resolved
  address public, checked inside the socket's DNS lookup. A secret never relaxes any of them. TLS certificate
  verification is never disabled; it is what keeps a DNS hijack of the bound host from receiving the secret.
- Per hop, `bindingMatches` must hold for **every** credential before the request is built. The headers and the
  query parameter are added to that hop's request only.
- **Redirects** are already followed manually (`redirect: 'manual'`), which matters here: `fetch` strips
  `Authorization` on cross-origin redirects but forwards custom headers like `X-API-Key`. With credentials, a redirect
  is followed only if the target still matches every binding; the secrets are re-attached for that hop. Any other
  redirect stops the request: "The API redirected to another address. Credentials are only sent to
  https://api.example.com/v1/, so the request was stopped." It is not retried without credentials either; a silent
  anonymous request to wherever the API pointed is not what the user configured. A redirect that keeps the query
  string (Django's `APPEND_SLASH`, nginx adding a trailing slash) brings back the query secret we sent: that
  parameter is removed from the target before the binding check and attached again, but only when its value is
  exactly the secret's. Any other value for that name still fails the check.
- **Errors** carry the document's URL and the status code, never the request URL with a query secret, never upstream
  headers or bodies. Every message from a credentialed fetch goes through `redact(message, values)` as a last guard,
  and errors are created as `HttpError` without a `cause`, so the 500 logger in `app.ts` never prints an undici error
  object that might hold request options. Client failures of a credentialed request say only "Request failed" or
  "Request timed out" (the undici message is dropped).
- **Echo redaction.** Some APIs echo the credential (`/whoami`, error payloads, debug fields). After `JSON.parse`, the
  parsed value is walked and every string (keys included) is checked after normalisation: as is, with JSON escapes
  (`\/`, `\uXXXX`) undone, and percent-decoded repeatedly (double encoding, any hex case, Python-style raw `/`) with
  and without `+` as a space, all compared without case. Besides the value itself it looks for base64 and base64url
  of the value at each byte alignment (so `Basic base64(user:value)` is caught) and, for digits-only values, the
  digits without leading zeros. The plain spellings are replaced in place (`Bearer [redacted]`); if any other
  spelling remains, the whole string becomes `[redacted]`. A number that contains the value becomes `[redacted]`. The
  minimum length of 8 keeps this from mangling ordinary data. **Not caught:** partial echoes (the last four
  characters), other transformations (hashing, hex, reversing, splitting a value across fields), and encodings beyond
  the ones listed. The data still only reaches viewers of a dashboard the owner chose to show it on.

### Caching and live updates (`apps/server/src/services/data.ts`, `apps/server/src/live/hub.ts`)

`DataService.resolve(dashboardId, dataset)` becomes `resolve(target: { id: string; ownerId: string | null },
dataset, options)`. All callers already have the meta: the REST data, preview, suggest and snapshot routes, the MCP
tools, and the hub, whose `loadDoc` becomes `loadDashboard(id) → { doc, ownerId }` (`store.readMeta` +
`store.readDoc` in `createDeps`).

- **HTTP TTL cache.** The key is `${url}#${path}` today, so two datasets with the same URL share a response. With
  secrets the key becomes `${credentialKey}|${url}#${path}`, where `credentialKey` is
  `${ownerId}/${id}@${revision}` for each credential, sorted and joined, and empty for public requests. A public
  dataset can therefore never receive a secret-backed response for the same URL, two users with the same URL never
  share, and replacing a value (`revision + 1`) invalidates at once. The 30-second TTL stays: it also protects the
  owner's API when many viewers open a public dashboard.
- **In-flight de-duplication** does not exist for HTTP sources yet (only `ConnectorService` has it). Adding it here is
  worthwhile for the same reason, keyed identically.
- **Stale fallback.** HTTP sources have none today; if one is added, it must use the same key.
- **Accumulate buffers** are keyed by `dashboardId:datasetId` and reset when `JSON.stringify(dataset.source)` changes.
  A dashboard has one owner for its lifetime once it can hold references, so buffers cannot cross users. The fingerprint
  additionally includes the credentials' revisions, so replacing a value (perhaps with another account's token) starts
  a fresh history instead of mixing two series.
- **LiveHub** rooms are per dashboard, `lastHash` is per room, and every subscriber passed `canView` (re-checked by
  `revalidate`). Results never cross rooms. This must stay true for any future optimisation: if
  [proposal 0001](0001-sse-deltas.md) or a later change shares refreshes across dashboards by URL, the sharing key
  must include `credentialKey`.

### Leak paths and redaction

| Path                                                                      | Rule                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document, versions, change logs                                           | Hold ids only. Change logs say `Updated dataset "Orders" (source)` as today                                                                                   |
| `get_dashboard`, REST `GET /dashboards/:id`, duplicate, any future export | Documents only, therefore ids only                                                                                                                            |
| `GET /api/secrets`, `list_secrets`                                        | Metadata only. No value, no prefix or suffix of it, no hash of it                                                                                             |
| `POST`/`PUT /api/secrets` responses                                       | Metadata only; the value is never echoed                                                                                                                      |
| Dataset errors (`DatasetResult.error`, `hash: error:…`)                   | Generic messages, document URL, status code; `redact` as last guard                                                                                           |
| Upstream bodies and headers                                               | Never in errors. Echoed values redacted from data                                                                                                             |
| Server logs                                                               | Fetch errors are `HttpError`s without `cause`; nothing logs request URLs or headers. Decrypt failures log the secret id only                                  |
| SSE events, PNG snapshots, `preview_data`, `get_data`, `render_snapshot`  | Carry data, which is already redacted                                                                                                                         |
| `get_reference`                                                           | Static text                                                                                                                                                   |
| Browser                                                                   | The value crosses the network once, in the create or replace request over HTTPS. Not kept in query or mutation caches. The service worker never caches `/api` |
| Pipeline workers                                                          | Receive tables only                                                                                                                                           |

### REST API (`apps/server/src/routes/api.ts`)

| Route                        | Who                                                            | Notes                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/secrets`           | Signed-in user, session or token                               | `{ mode, canUseSecrets, secrets: (SecretInfo & { sentAs, usedBy: [{ dashboardId, dashboardTitle, datasetId, datasetName }] })[] }`. "Used by" scans the user's own dashboards (`index.listByOwner` + `store.readDoc`) |
| `POST /api/secrets`          | Session only, `sameOrigin` CSRF check as for all cookie writes | Strict body `{ name, sendTo, placement, paramName?, value }` → `201 SecretInfo`                                                                                                                                       |
| `PUT /api/secrets/:id/value` | Session only                                                   | `{ value }` → `SecretInfo` with new `updatedAt`; the binding and placement stay                                                                                                                                       |
| `PATCH /api/secrets/:id`     | Session only                                                   | `{ name }` → `SecretInfo`. There is no field for the binding                                                                                                                                                          |
| `DELETE /api/secrets/:id`    | Session only, allowed even when the switch is `off`            | `{ ok: true }`                                                                                                                                                                                                        |
| `GET /api/admin/secrets`     | Admins (session)                                               | `{ mode, users: [{ userId, email, secrets }] }`: counts only, for "whom to tell" after a key and database leak                                                                                                        |

Every handler is one call into `DashboardService` (`listSecrets`, `createSecret`, `replaceSecretValue`,
`renameSecret`, `deleteSecret`), which checks the principal, the switch and `viaToken`, then delegates to `Secrets`.
Writes go through the existing `writes` rate limiter. Request bodies are already capped at 1 MB. Bodies of these
routes are parsed without ever letting a JSON syntax error (whose message quotes the input) reach the response or the
error logger.

Errors: `400` for validation (messages never repeat the value), `401` signed out, `403` for tokens ("Secrets can only
be added or changed in the web app, never with a token."), for cross-site requests and when the switch refuses the
user ("Secrets are turned off on this server." / "This instance only lets administrators store and use secrets."),
`404` for another user's or a missing id.

The dashboard routes that can create the "public + secrets" combination accept `confirmPublicSecrets: true` in their
body: `PUT /api/dashboards/:id`, `POST /api/dashboards/:id/ops`, `PATCH /api/dashboards/:id/settings` and
`POST /api/dashboards/:id/versions/:v/restore`. Without it a session gets the `428` described under "Who can use which
secret"; `GET /api/me` adds `secrets` (the mode) and `canUseSecrets`.

### MCP (`apps/server/src/mcp/server.ts`)

One read tool, `list_secrets` (scope `dashboards:read`), calling `dashboards.listSecrets(p)`. It takes no arguments,
so it adds little to the size of the tool list (32.8 KB in total after this change, within the existing 33 KB
budget). It returns `{ secrets: [{ id, name, origin, pathPrefix, sentAs, updatedAt, lastUsedAt }], note }`, where the
note is the "never readable" line, or says that secrets are off or for administrators only. Existing tools change in what they pass to
`DataService.resolve`; the save-time rules surface as ordinary tool errors from `DashboardService`.
`apply_operations` adds a `warnings` array to its result when a touched URL has credential-like query parameters.

### Reference text (`apps/server/src/mcp/reference.ts`)

```
- source.kind "http": { url: "https://...", path?: "data.items", secrets?: ["sec_..."] }

## Secrets (http sources)
Some APIs need a key. The user saves keys under Settings → Secrets; you can list them (list_secrets) but never read,
create or change them.
- Add secrets: ["<id>"] to an http source. The URL must start with the secret's origin and pathPrefix, or the save
  fails. At most 3 per source.
- Never put keys or tokens into a URL, a dataset name or a text widget. If an API needs a key the user has not saved,
  ask them to add it at <PUBLIC_URL>/settings#secrets, then continue.
- A public dashboard that uses secrets is read-only for you: every change to it (datasets, steps, widgets, restoring
  a version) must be made by the user in the web app, or after they make it private. You also cannot make a
  dashboard with secrets public. Ask the user to do it in the web app.
- These rules limit where secrets are used, not where data you have read can go. Never copy data fetched with a
  secret anywhere else (another dashboard, inline rows, a text widget, your answer) unless the user asked for it.
- Data fetched with a secret is shown to everyone who can view the dashboard. Keep such dashboards private unless the
  user says otherwise.
```

The `list_connectors` description ("no API keys needed") stays true. `SERVER_INSTRUCTIONS` gains one sentence:
"Private APIs: see list_secrets."

### Docs to update with the implementation

`README.md` (the security model currently says "All secrets are stored as SHA-256 hashes", which becomes "Tokens are
stored as SHA-256 hashes; data source secrets are encrypted with AES-256-GCM and never readable", plus the three
variables in the configuration table), `.env.example`, `docs/deployment.md` (key handling and backups),
`docs/mcp.md` (tool table), `docs/architecture.md` §4 and §7, and an "Implementation notes" section here.

## Testing

**Core** (`packages/core/src/core.test.ts` or a new `secrets.test.ts`):

- Schema: `secrets` accepts 1–3 unique ids, rejects other shapes; strictness unchanged.
- `bindingMatches`: exact origin; other host, subdomain, port, scheme; IDN and case; trailing dot; prefix with and
  without trailing slash (`/v1/` vs `/v10`); `..`, `%2e%2e`, `%2f`, `%5c`, backslashes; query and fragment ignored.
- `secretRefChanges`: new dataset, changed URL, changed ids, unchanged, removed.

**Server** (`apps/server/src/server.test.ts`, new "secrets" block, plus a unit file for crypto):

- Crypto: round trip; tampered ciphertext, tag or nonce fails; a sealed value moved to another row, user or binding
  fails (AAD); wrong key; rotation re-seals and the old key is no longer needed; unknown key rows are counted, not
  destroyed.
- Config: `SECRETS=users` without a key refuses to start; a key that is not 32 bytes refuses; `off` needs no key.
- Fetching, against a local HTTP server that a test-only dispatcher (passed to `createDeps`, never read from the
  environment) routes every request to, so the URL-level SSRF checks still run: headers and query placement arrive; a
  same-origin redirect re-attaches; a cross-origin redirect stops and the second host receives nothing (assert on the
  server's request log); an upstream echo is redacted; 401 bodies do not appear in errors.
- Resolution: owner's secret works; another user's id is "not available"; anonymous save with `secrets` is rejected;
  claim of a dashboard prepared with a victim's id is impossible; duplicate by a stranger strips references; duplicate
  by the owner keeps them; token on a public dashboard cannot add or retarget; token cannot make a secret-backed
  dashboard public, the session can; restore of a version with a deleted secret succeeds and shows "not available";
  switch `off` refuses use and allows delete.
- Caches: a public dataset and a secret-backed dataset with the same URL get different responses; two users with the
  same URL get their own; replacing a value invalidates; accumulate restarts after a replace.
- Management: `POST /api/secrets` refuses PATs and OAuth tokens and cross-site requests; no response ever contains the
  value; per-user limit.
- **Canary test.** Store a secret whose value is a unique random canary, then exercise every path: REST data,
  preview, suggest, snapshot, SSE stream, every MCP tool, versions, list endpoints, and failures (401, cross-origin
  redirect, timeout, invalid JSON, oversized body, binding mismatch). Capture all response bodies and everything
  written to stdout and stderr, and assert the canary never appears. The only thing allowed to contain it is the
  request the mock upstream received.

**Web:** a Playwright run (like the other browser checks, during development and not in CI) through creating a secret
with the warning, picking it in a dataset, the "bound to another host" state while editing the URL, the public
confirmation, and checking that the value is absent from the page, the query cache and `localStorage` afterwards.

## Effort

About five days:

| Part                                                                                               | Estimate |
| -------------------------------------------------------------------------------------------------- | -------- |
| Core: schema, `secrets.ts`, tests                                                                  | ½ day    |
| Storage, crypto, rotation, config, migration                                                       | ¾ day    |
| Fetch path: binding, placement, redirects, redaction, cache keys, `resolve` signature, hub         | 1 day    |
| `DashboardService` rules, REST, MCP tool, reference text                                           | ¾ day    |
| Web: Settings section and modal with the warning, credentials picker, states, public confirmations | 1¼ days  |
| Canary test, remaining server tests, docs                                                          | ¾ day    |

## Risks

- **Publishing private data by accident** through a public dashboard. Mitigated by the confirmations, the share panel
  line, private-by-default for duplicates, and tokens being unable to create the combination.
- **An agent misusing a secret on its bound host.** Mitigated by binding (with path prefixes), least-privilege advice
  in the warning, and the public-dashboard rules for tokens. Not eliminated; the security model names it.
- **Operator trust on shared instances.** Not a technical risk to mitigate but a fact to state, which the warning
  does, and the reason the default is `off`.
- **Key handling mistakes** (key in the same backup, key lost). Documented in `docs/deployment.md`; loss only costs
  re-entering values.
- **Complexity in the save path.** The rules are pure functions in core (`secretRefChanges`, `bindingMatches`) plus
  a short block in `DashboardService.commit`, all covered by tests.

## Alternatives considered

- **Keep the secret in the browser and fetch from there.** No operator trust needed, but it breaks everything that
  makes Patchbay work: server-side pipelines, the live hub, PNG snapshots, MCP, public dashboards, and most APIs do not
  allow CORS. Rejected.
- **Hash secrets like tokens.** Impossible: the plaintext has to be sent.
- **Encrypt with a per-user key derived from a password.** Users sign in with Google and have no password, and secrets
  must be usable while the user is away (live dashboards, public viewers, snapshots). Rejected.
- **Store secrets in the dashboard folder.** Duplicates, hand inspection, folder deletion and version history would
  all have to know about them. Per-user rows in SQLite keep them away from all of that.
- **External KMS or Vault.** Stronger key custody, but an extra service, against the single-container design. The
  `Secrets` class is the seam if an operator ever needs it.
- **Reference by name.** Names change and collide; resolving by id against the owner is simpler to reason about.
- **Placement on the dataset.** Would let editors and agents move a header secret into a URL. Placement belongs to the
  secret.
- **Let agents create secrets.** Values would pass through the model and its logs. Rejected (see "Agents").
- **Default `SECRETS=users`.** Would make every existing public instance a credential store on upgrade. Rejected.

## Decisions

Decided by the owner on 2026-10-26:

1. **Agents and public dashboards.** Tokens (MCP and PATs) may not make a secret-backed dashboard public, and may not
   add or re-point secrets on a public dashboard. Only a person in the web UI can, after the confirmation described in
   "Public dashboards". Agents can still do everything on private dashboards. Extended after the security review:
   a public dashboard with any secret reference is read-only for tokens altogether (see "Who can use which secret").
2. **Public instances.** The repository default stays `SECRETS=off`. A public instance whose operator accepts the
   responsibility runs `SECRETS=users`, and the owner's own public instance will: users of someone else's instance
   store secrets at their own risk, which is what the warning and the self-hosting recommendation are for.
3. **No `secrets:write` scope.** Values are set and replaced only through the web UI. A scope for scripted rotation can
   be added later if there is a concrete need.

## Implementation notes

Everything is implemented: the server side (core, storage, encryption, `DashboardService`, fetching, caches, REST,
MCP), the web UI (Settings → Secrets with the warning, the credentials picker, the public confirmations, owner hints,
the OAuth consent line, admin counts) and the user-facing docs (`README.md`, `docs/deployment.md`, `docs/mcp.md`,
`docs/architecture.md`).

Where the implementation differs from the text above, it chose the safer option; the sections above were updated:

- **Server-enforced confirmation.** The public-dashboard confirmation is not only a dialog: sessions get `428
  confirm_public_secrets` (with the secret ids and names for the dialog) until they repeat the request with
  `confirmPublicSecrets: true`. This also covers restoring a version that brings references back onto a public
  dashboard, and dry runs answer like saves.
- **Public secret-backed dashboards are read-only for tokens** (security review): every token write is refused, not
  only new or re-pointed references, because pipeline, path, widget and restore changes can widen what the public
  sees. Tokens may still make such a dashboard private.
- **Previews with secrets need the write scope** (security review), checked in `DashboardService.previewTarget` from
  `Principal.readOnly`. The REST preview already needed it (it is a `POST`).
- **Binding.** Also refuses `%25` and `..;` segments under a non-root prefix, and (security review) reads the path
  strictly: malformed escapes, `%3B`, invalid or overlong UTF-8, control characters and look-alike dots and slashes
  are refused. It compares the query parameter name
  without case, and `parseBinding` refuses non-default ports. The exact path a prefix was made from matches too.
- **`secretRefChanges`** treats only new ids and URL changes as changes; removing or reordering ids is not.
- **Switch off** also refuses renaming; a malformed key refuses to start even with `off`.
- **Values** sent in a header must be printable ASCII; redaction normalises strings (URL decoding, JSON escapes,
  case) and also looks for base64 forms and JSON numbers (hardened after the security review); failed credentialed
  requests never carry the HTTP client's message.
- **Use time** also refuses two secrets writing the same header or parameter ("Credentials for this source conflict
  with each other."), and `claim` refuses a document with references (impossible unless edited by hand).
- **Admin counts** are served by `GET /api/admin/secrets`; the admin page shows them in the web phase.
- **Tests** use a local HTTP server and a dispatcher seam on `createDeps` instead of undici's `MockAgent`.

Residual risks worth knowing: a numeric secret longer than 15 digits echoed as a JSON number loses precision on parse
and is then not recognised by the redaction (the echo is a near-copy of the value); partial or transformed echoes are
not recognised either (see "Echo redaction"); a heap dump of the process can contain values (operator-level access, as
stated in the warning).

### Web phase

Built as described above, with these choices:

- **Shared strings.** `CREDENTIAL_ERRORS` and `CONFIRM_PUBLIC_SECRETS` moved from `services/dashboards.ts` to
  `packages/core/src/secrets.ts` (the service re-exports them), so the web app matches on exactly the server's strings.
- **Confirmations.** Saving a dataset edit that adds or re-points a secret on a public dashboard asks before the change
  is applied. Everything else (undo/redo, rebases, "keep mine") relies on the server's `428`: autosave keeps the
  refused document in the editor store and does not resend it until the user confirms, edits further or discards the
  unsaved changes; after "Not now" a banner stays instead of the dialog popping up on every edit. A confirmation covers
  exactly the references the user saw (dataset id, URL and secret ids), so the flag is never sent for something the
  user was not shown. Visibility changes and version restores go through the same dialog.
- **`{instance}`** in the warning is the browser's host, which equals the host of `PUBLIC_URL` in production.
- **Settings** shows the section to clean up (list and delete) when the switch is `off` and the user still has
  secrets, explains `admins` mode to everyone else, and hides it only when `off` with nothing stored.
  `/settings#secrets` scrolls to it.
- **Owner hints.** Widgets keep the generic credential errors for viewers; the owner also sees what to do, from the
  same function the dataset editor uses (`credentialErrorHint` in `apps/web/src/lib/secrets.ts`).
- **The OAuth consent line** appears only when the user may use secrets on the instance.
- **Tests.** The web app gained a vitest project for its pure logic and the editor store (the 428 flow, the
  fingerprints, the explanations). The Playwright run in "Testing" was done by hand in a browser against a local
  instance with `SECRETS=users`, `admins` and `off`, a real upstream (`httpbin.org/bearer`, whose echo is redacted) and a
  canary value that was absent from the DOM, `localStorage` and every API response afterwards.

### For the web phase (as handed over by the server phase)

- `GET /api/me` → `{ user, secrets: 'off' | 'admins' | 'users', canUseSecrets }`.
- Settings uses the REST table above; send the value once with `api()` and reset the mutation (see "Settings →
  Secrets"). Validation helpers for the form live in core: `parseBinding`, `secretParamIssue`, `secretValueIssue`,
  `describePlacement`, `MAX_SECRETS_PER_USER`.
- Dataset editor: `bindingMatches` + `bindingMismatchMessage`, `placementConflict` and `credentialLikeParams` (core)
  explain problems while typing; `sourceSecretIds` reads references. Widget errors are the strings in
  `CREDENTIAL_ERRORS` (`apps/server/src/services/dashboards.ts`).
- Saves: handle `428` with `code: "confirm_public_secrets"` on autosave (`PUT`), op batches, visibility changes and
  restores: show the dialog with `secrets[].name` and repeat with `confirmPublicSecrets: true`. The editor's 409
  conflict handling is unaffected.
