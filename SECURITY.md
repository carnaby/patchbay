# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/carnaby/patchbay/security/advisories/new) (the repository's
**Security** tab → **Report a vulnerability**). Do not open a public issue, pull request or discussion for a
vulnerability, and do not post details anywhere public before a fix is released.

A useful report includes:

- what an attacker can do, and what they need first (an account, an edit key, a token, network position);
- the affected version: a release tag, an image tag or digest, or a commit SHA;
- steps to reproduce, ideally a minimal request sequence or script;
- the configuration that matters (`SECRETS`, `URL_SOURCES`, `TRUST_PROXY`, reverse proxy, container limits);
- your name or handle as you would like to be credited, or that you prefer to stay anonymous.

## What to expect

- An acknowledgement within **72 hours**.
- An assessment and a plan (fix, mitigation or a reasoned "not a vulnerability") within **14 days**.
- Updates as the fix progresses, and a heads-up before the advisory is published.
- Credit in the release notes and the advisory, unless you ask not to be named.

Patchbay is maintained by one person in their spare time; these are targets, not a contract, but a report is never
left unanswered.

## Scope

In scope: the code in this repository, self-hosted or as the published container image, and the hosted instance at
[patchbay.me.uk](https://patchbay.me.uk). For example:

- authentication and sessions, Google sign-in, the dev login's production guard;
- the OAuth 2.1 authorization server and the MCP endpoint (token binding, PKCE, redirect handling, scopes);
- access to other people's dashboards, uploads, versions or live streams, edit keys, claiming;
- stored secrets for HTTP sources: reading them back, sending them to another address, leaking them into data;
- server-side request forgery through HTTP, feed or client metadata URLs;
- cross-site scripting, CSP bypasses, markup injected through data, feeds or snapshots;
- availability problems that a few requests can cause: crashing the process, exhausting its memory or disk, or
  blocking it for everyone.

Out of scope:

- volumetric denial of service (floods that need many machines or a lot of bandwidth);
- findings that need a compromised server, a malicious operator or physical access (the operator can, by design,
  decrypt stored secrets; see [guide/deployment.md](guide/deployment.md#secrets-for-http-sources));
- missing hardening headers or best practices without a demonstrated impact;
- vulnerabilities in third-party APIs that connectors read, or in dependencies without a way to reach them through
  Patchbay (report those upstream);
- social engineering of the maintainer or of users.

## Safe harbour

Research done in good faith under this policy is welcome. We will not pursue or support legal action against you for
it. Please:

- test against your own instance where you can; on patchbay.me.uk use only accounts and dashboards you created, and
  keep automated testing gentle;
- never access, change or delete other people's data, and stop as soon as you reach any;
- do not degrade the service for others (no load testing of the hosted instance);
- give us a reasonable time to fix the problem before disclosing it.

## Supported versions

Fixes go into `main` and the next release. The `latest` image follows `main`; run it or the newest release tag.

## For operators

- Keep `SECRETS_KEY` out of the backups of `DATA_DIR`. `DATA_DIR` holds only ciphertext; a backup that holds both can
  decrypt every stored secret. See [guide/deployment.md](guide/deployment.md#secrets-for-http-sources).
- Set `PUBLIC_URL` to the exact public origin and never enable `DEV_LOGIN` on a reachable server (the server refuses
  to start with it on a non-localhost address).
- On a public instance, read "Limits for a small public instance" in the deployment guide, and consider
  `URL_SOURCES=signed-in`.
