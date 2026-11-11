/** Wording of the URL field of an HTTP source; a plain module so it can be tested without a DOM. */

export interface UrlHintContext {
  /** Owner of a dashboard that may use secrets right now. */
  canUseSecrets: boolean;
  /** The dashboard's owner may reach the hosts the operator lists in ALLOW_PRIVATE_HOSTS. */
  privateHosts: boolean;
}

/** The hint under the URL field. Matches what the server's guard answers for an address that is not listed. */
export function urlHint(context: UrlHintContext): string {
  const lead = context.canUseSecrets
    ? 'Don’t put keys into the URL; use Credentials instead.'
    : 'A public JSON endpoint without credentials.';
  return context.privateHosts
    ? `${lead} Hosts this server lists in ALLOW_PRIVATE_HOSTS are allowed, also over http:// and other ports.`
    : `${lead} Private network addresses are blocked.`;
}

/** Plain http:// is possible only for listed private hosts, so the label must not promise https then. */
export function urlFieldLabel(privateHosts: boolean): string {
  return privateHosts ? 'URL' : 'HTTPS URL';
}
