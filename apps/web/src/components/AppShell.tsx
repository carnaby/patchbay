import { Download, LayoutGrid, LogOut, Moon, Settings, Shield, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { setTheme, useLogout, useMe, useTheme } from '../lib/hooks.ts';
import { useInstallPrompt } from '../lib/pwa.ts';
import { Button, cx, IconButton, Menu, MenuItem, MenuLabel } from './ui.tsx';

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cx('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-ink" />
        <circle cx="10" cy="11" r="3" fill="var(--pb-accent)" />
        <circle cx="22" cy="11" r="3" className="fill-page" />
        <circle cx="10" cy="21" r="3" className="fill-page" />
        <circle cx="22" cy="21" r="3" fill="var(--pb-data)" />
        <path
          d="M10 11 C 16 11, 16 21, 22 21"
          stroke="var(--pb-accent)"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[17px]">Patchbay</span>
    </Link>
  );
}

/** Shown only when the browser offers to install Patchbay as an app. */
export function InstallButton() {
  const { available, install } = useInstallPrompt();
  if (!available) return null;
  return (
    <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={install}>
      <span className="hidden sm:inline">Install app</span>
    </Button>
  );
}

export function ThemeToggle() {
  const mode = useTheme();
  return (
    <IconButton
      label={mode === 'dark' ? 'Light mode' : 'Dark mode'}
      onClick={() => setTheme(mode === 'dark' ? 'light' : 'dark')}
    >
      {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </IconButton>
  );
}

export function UserMenu() {
  const { data: user, isLoading } = useMe();
  const logout = useLogout();
  const location = useLocation();
  const navigate = useNavigate();
  if (isLoading) return <div className="size-8" />;
  if (!user) {
    return (
      <Link to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}>
        <Button size="sm" variant="secondary">
          Sign in
        </Button>
      </Link>
    );
  }
  // A portalled Menu: the header's backdrop blur would otherwise confine the click-outside layer to the header.
  return (
    <Menu
      label="Account menu"
      round
      icon={
        user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="text-xs font-semibold text-ink">{user.name.slice(0, 1).toUpperCase()}</span>
        )
      }
    >
      <MenuLabel>
        <div className="truncate text-sm font-medium text-ink">{user.name}</div>
        <div className="truncate text-xs text-muted">{user.email}</div>
      </MenuLabel>
      <MenuItem icon={<LayoutGrid className="size-4" />} onSelect={() => navigate('/me')}>
        My dashboards
      </MenuItem>
      <MenuItem icon={<Settings className="size-4" />} onSelect={() => navigate('/settings')}>
        AI connections &amp; tokens
      </MenuItem>
      {user.isAdmin ? (
        <MenuItem icon={<Shield className="size-4" />} onSelect={() => navigate('/admin')}>
          Admin
        </MenuItem>
      ) : null}
      <MenuItem icon={<LogOut className="size-4" />} onSelect={() => void logout()}>
        Sign out
      </MenuItem>
    </Menu>
  );
}

/** Standard page chrome for everything except the dashboard editor. */
export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-page/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Logo />
          <nav className="ml-4 hidden items-center gap-1 text-sm text-ink-2 sm:flex">
            <Link to="/new" className="rounded-lg px-3 py-1.5 hover:bg-surface-2 hover:text-ink">
              New dashboard
            </Link>
            <Link to="/me" className="rounded-lg px-3 py-1.5 hover:bg-surface-2 hover:text-ink">
              My dashboards
            </Link>
            <a
              href="https://github.com/carnaby/patchbay"
              className="rounded-lg px-3 py-1.5 hover:bg-surface-2 hover:text-ink"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <InstallButton />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-auto w-full max-w-6xl px-4 py-10', className)}>{children}</div>;
}
