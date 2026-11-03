/**
 * ALLOW_PRIVATE_HOSTS: the hosts on the operator's own network that http and feed sources may reach, also over plain
 * http:// and on any port. Empty (the default) means none, and safe-fetch behaves exactly as on a public instance.
 *
 * Entries are host names (exact, or "*.lan" for every name below lan), IP addresses and CIDR ranges. A name entry
 * trusts that name's DNS answers only into the ordinary LAN ranges below: loopback, link-local and every other special
 * range opens only through an address entry that covers it, and a cloud metadata address only through an entry naming
 * exactly that address. safe-fetch asks `allowsAddress` inside the socket's DNS lookup, so the address that is checked
 * is the one connected to, and a DNS answer that changes cannot lead anywhere the list does not allow.
 */
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/** PRIVATE_HOSTS_FOR: whose dashboards may use the list, by the dashboard's owner. */
export type PrivateHostsFor = 'admins' | 'signed-in' | 'everyone';

export interface PrivateHosts {
  /** The entries in their canonical spelling, for the startup log and the MCP reference. */
  readonly entries: readonly string[];
  /** Whether a URL's host is listed itself: a name entry, or an IP literal that an address entry covers. */
  listsHost(host: string): boolean;
  /** Whether a connection to `ip`, which `host` resolved to (or is), is allowed. */
  allowsAddress(host: string, ip: string): boolean;
}

/** What a user's dashboards may reach, as the MCP reference tells agents. */
export type NetworkAccess =
  | { kind: 'public' }
  | { kind: 'not-yours' }
  | { kind: 'private'; entries: readonly string[] };

/** An entry the server refuses to start with; the message names the entry and what to write instead. */
export class PrivateHostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateHostsError';
  }
}

// NEVER and LAN below are deliberately independent of safe-fetch's BLOCKED list: they say what an operator's list may
// open, not what is blocked by default, and this module stays pure.

/** Never a host: "this network" (0.0.0.0 reaches the machine itself on Linux), multicast, reserved and broadcast. */
const NEVER = new BlockList();
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('224.0.0.0', 3, 'ipv4');
NEVER.addAddress('::', 'ipv6');
NEVER.addSubnet('ff00::', 8, 'ipv6');

/** Cloud and container metadata services, which hand out credentials. */
export const METADATA_ADDRESSES: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS, GCP, Azure, OpenStack, DigitalOcean, ...
  '169.254.170.2', // AWS ECS task metadata
  '169.254.170.23', // AWS EKS Pod Identity
  'fd00:ec2::254', // AWS instance metadata over IPv6
  'fd00:ec2::23', // AWS EKS Pod Identity over IPv6
  '100.100.100.200', // Alibaba Cloud
]);

/** Where a name entry's DNS answers may lead: home, office and VPN ranges. */
const LAN = new BlockList();
LAN.addSubnet('10.0.0.0', 8, 'ipv4');
LAN.addSubnet('172.16.0.0', 12, 'ipv4');
LAN.addSubnet('192.168.0.0', 16, 'ipv4');
LAN.addSubnet('100.64.0.0', 10, 'ipv4'); // carrier-grade NAT, also Tailscale
LAN.addSubnet('fc00::', 7, 'ipv6'); // unique local

/** A range broader than this would make the guard pointless; fc00::/7 (all unique-local) is the broadest sensible one. */
const MIN_PREFIX = { 4: 8, 6: 7 } as const;
const NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;
const USAGE =
  'write host names (homeassistant.lan, *.lan), IP addresses (192.168.1.20) or CIDR ranges (192.168.1.0/24), without http:// or a port';

const familyOf = (ip: string) => (isIP(ip) === 4 ? 'ipv4' : 'ipv6');

/**
 * An IP address in the one spelling used for comparisons: IPv4 dotted, IPv6 compressed and lowercase, an IPv4-mapped
 * IPv6 address as the IPv4 address it carries. Other IPv6 forms that embed IPv4 (NAT64, 6to4, Teredo) stay IPv6 on
 * purpose: they are only reachable through an address entry that names them. Null for anything that is not an IP,
 * and for zone ids, which name an interface rather than an address.
 */
export function canonicalIp(raw: string): string | null {
  const bare = raw.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6 || bare.includes('%')) return null;
  const v6 = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!mapped) return v6;
  const hi = Number.parseInt(mapped[1]!, 16);
  const lo = Number.parseInt(mapped[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function canonicalName(raw: string): string {
  return domainToASCII(
    raw
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, ''),
  );
}

export function parsePrivateHosts(raw: string | undefined): PrivateHosts | null {
  const items = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return null;
  const names = new Set<string>();
  const suffixes: string[] = [];
  const exact = new Set<string>();
  const ranges = new BlockList();
  const entries: string[] = [];
  const refuse = (item: string, why: string) =>
    new PrivateHostsError(`ALLOW_PRIVATE_HOSTS entry "${item}" ${why}`);
  const thisMachine =
    'names this machine, which only an address entry can open: list 127.0.0.1 (and ::1) instead';

  for (const item of items) {
    const entry = item.toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(entry)) throw refuse(item, `has a scheme: ${USAGE}`);

    const slash = entry.indexOf('/');
    if (slash >= 0) {
      const addr = entry.slice(0, slash);
      const bits = entry.slice(slash + 1);
      const ip = isIP(addr) ? canonicalIp(addr) : null;
      const version = ip ? (isIP(ip) as 4 | 6) : null;
      const prefix = Number(bits);
      if (
        !ip ||
        !version ||
        version !== isIP(addr) ||
        !/^\d{1,3}$/.test(bits) ||
        prefix > (version === 4 ? 32 : 128)
      )
        throw refuse(item, `is not a CIDR range: ${USAGE}`);
      if (prefix < MIN_PREFIX[version])
        throw refuse(
          item,
          `is too broad: a range must be at least /${MIN_PREFIX[version]} for IPv${version}`,
        );
      ranges.addSubnet(ip, prefix, familyOf(ip));
      entries.push(`${ip}/${prefix}`);
      continue;
    }

    const ip = canonicalIp(entry);
    if (ip) {
      if (NEVER.check(ip, familyOf(ip)))
        throw refuse(item, 'is not a host address; to reach this machine, list 127.0.0.1 or ::1');
      exact.add(ip);
      ranges.addAddress(ip, familyOf(ip));
      entries.push(ip);
      continue;
    }

    if (entry.startsWith('*.')) {
      const suffix = canonicalName(entry.slice(2));
      if (!suffix || !NAME.test(suffix)) throw refuse(item, `is not a host name: ${USAGE}`);
      if (suffix === 'localhost' || suffix.endsWith('.localhost')) throw refuse(item, thisMachine);
      suffixes.push(suffix);
      entries.push(`*.${suffix}`);
      continue;
    }

    // The URL parser reads "3232235786" and "0x7f.1" as IPv4 addresses; an entry spelled that way would never match.
    let asUrl = '';
    try {
      asUrl = new URL(`http://${entry}/`).hostname;
    } catch {
      // Not a host at all; the name check below says so.
    }
    const parsedIp = asUrl ? canonicalIp(asUrl) : null;
    if (parsedIp) throw refuse(item, `is an IP address in an unusual notation; write ${parsedIp}`);
    const name = canonicalName(entry);
    if (!name || !NAME.test(name)) throw refuse(item, `is not a host name: ${USAGE}`);
    if (name === 'localhost' || name.endsWith('.localhost')) throw refuse(item, thisMachine);
    names.add(name);
    entries.push(name);
  }

  const nameListed = (host: string): boolean => {
    const name = canonicalName(host);
    if (!name || canonicalIp(name)) return false;
    return names.has(name) || suffixes.some((s) => name.endsWith(`.${s}`));
  };

  const allowsAddress = (host: string, rawIp: string): boolean => {
    const ip = canonicalIp(rawIp);
    if (!ip || NEVER.check(ip, familyOf(ip))) return false;
    if (METADATA_ADDRESSES.has(ip)) return exact.has(ip);
    if (ranges.check(ip, familyOf(ip))) return true;
    return nameListed(host) && LAN.check(ip, familyOf(ip));
  };

  return {
    entries: Object.freeze(entries),
    allowsAddress,
    listsHost: (host) => {
      const ip = canonicalIp(host);
      return ip ? allowsAddress(ip, ip) : nameListed(host);
    },
  };
}

/** Startup log lines: what is open and to whom, and a warning when the setting is wide or does nothing. */
export function privateHostsNotice(
  hosts: PrivateHosts | null,
  mode: PrivateHostsFor,
  instance: { googleSignIn: boolean; admins: number },
): string[] {
  if (!hosts) return [];
  const who = {
    admins: 'dashboards owned by an administrator',
    'signed-in': 'dashboards with an owner',
    everyone: 'every dashboard',
  }[mode];
  const lines = [
    `ALLOW_PRIVATE_HOSTS: ${who} may load from ${hosts.entries.join(', ')}, also over http:// and on any port`,
  ];
  if (mode !== 'everyone' && !instance.googleSignIn) {
    lines.push(
      `ALLOW_PRIVATE_HOSTS has no effect: PRIVATE_HOSTS_FOR=${mode} needs Google sign-in. On a server only your own network can reach, set PRIVATE_HOSTS_FOR=everyone.`,
    );
  } else if (mode === 'admins' && instance.admins === 0) {
    lines.push('ALLOW_PRIVATE_HOSTS has no effect: PRIVATE_HOSTS_FOR=admins needs ADMIN_EMAILS.');
  }
  if (mode === 'signed-in' && instance.googleSignIn) {
    lines.push(
      'PRIVATE_HOSTS_FOR=signed-in: anyone with a Google account who reaches this server can sign in and read from these hosts.',
    );
  }
  if (mode === 'everyone') {
    lines.push(
      'PRIVATE_HOSTS_FOR=everyone: anyone who reaches this server can read from these hosts. Use it only when nobody outside your network can reach it.',
    );
  }
  return lines;
}
