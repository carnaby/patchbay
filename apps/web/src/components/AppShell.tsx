import { LayoutGrid, LogOut, Moon, Settings, Shield, Sun } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { setTheme, useLogout, useMe, useTheme } from '../lib/hooks.ts';
import { Button, cx, IconButton } from './ui.tsx';

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
  const [open, setOpen] = useState(false);
  const location = useLocation();
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
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex size-8 items-center justify-center overflow-hidden rounded-full border border-line bg-surface-2 text-xs font-semibold"
        aria-label="Account menu"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          user.name.slice(0, 1).toUpperCase()
        )}
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-40 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-xl">
            <div className="px-3 py-2">
              <div className="truncate text-sm font-medium">{user.name}</div>
              <div className="truncate text-xs text-muted">{user.email}</div>
            </div>
            <MenuLink to="/me" icon={<LayoutGrid className="size-4" />} onClick={() => setOpen(false)}>
              My dashboards
            </MenuLink>
            <MenuLink to="/settings" icon={<Settings className="size-4" />} onClick={() => setOpen(false)}>
              AI connections &amp; tokens
            </MenuLink>
            {user.isAdmin ? (
              <MenuLink to="/admin" icon={<Shield className="size-4" />} onClick={() => setOpen(false)}>
                Admin
              </MenuLink>
            ) : null}
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function MenuLink({
  to,
  icon,
  children,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      {icon}
      {children}
    </Link>
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
