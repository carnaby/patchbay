import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell.tsx';
import { Spinner, Toaster, toast } from './components/ui.tsx';
import { ApiError } from './lib/api.ts';
import './styles.css';

const Landing = lazy(() => import('./pages/Landing.tsx'));
const NewDashboard = lazy(() => import('./pages/NewDashboard.tsx'));
const DashboardPage = lazy(() => import('./editor/DashboardPage.tsx'));
const MyDashboards = lazy(() => import('./pages/MyDashboards.tsx'));
const Settings = lazy(() => import('./pages/Settings.tsx'));
const Admin = lazy(() => import('./pages/Admin.tsx'));
const Login = lazy(() => import('./pages/Login.tsx'));
const OAuthConsent = lazy(() => import('./pages/OAuthConsent.tsx'));
const OAuthError = lazy(() => import('./pages/OAuthError.tsx'));
const NotFound = lazy(() => import('./pages/NotFound.tsx'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
  mutationCache: new MutationCache({
    onError: (error) => toast(error.message, 'bad'),
  }),
});

const fallback = (
  <div className="flex h-[60vh] items-center justify-center">
    <Spinner />
  </div>
);
const page = (node: React.ReactNode) => <Suspense fallback={fallback}>{node}</Suspense>;

const router = createBrowserRouter([
  { path: '/d/:id', element: page(<DashboardPage />) },
  {
    element: <AppShell />,
    children: [
      { path: '/', element: page(<Landing />) },
      { path: '/new', element: page(<NewDashboard />) },
      { path: '/me', element: page(<MyDashboards />) },
      { path: '/settings', element: page(<Settings />) },
      { path: '/admin', element: page(<Admin />) },
      { path: '/login', element: page(<Login />) },
      { path: '/oauth/consent', element: page(<OAuthConsent />) },
      { path: '/oauth/error', element: page(<OAuthError />) },
      { path: '*', element: page(<NotFound />) },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
