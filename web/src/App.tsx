import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { FeedbackProvider } from './components/Feedback';
import { HostsProvider, Layout } from './components/Layout';
import { api, BASE_PATH } from './lib/api';
import { SessionCtx, useTheme } from './lib/hooks';
import type { Me } from './lib/types';
import { Audit } from './pages/Audit';
import { ContainerDetail } from './pages/ContainerDetail';
import { Containers } from './pages/Containers';
import { Dashboard } from './pages/Dashboard';
import { Hosts } from './pages/Hosts';
import { Login } from './pages/Login';

/** Remount the detail page per container so log/terminal sessions never leak between containers. */
function KeyedDetail() {
  const { hostId, id } = useParams();
  return <ContainerDetail key={`${hostId}/${id}`} />;
}

export function App() {
  useTheme(); // apply persisted theme before first paint of any page
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const check = useCallback(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    check();
    const onUnauthorized = () => setMe(null);
    window.addEventListener('dp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dp:unauthorized', onUnauthorized);
  }, [check]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setMe(null);
  }, []);

  if (me === undefined) {
    return (
      <div className="loading">
        <Loader2 className="spin" size={22} />
      </div>
    );
  }

  return (
    <FeedbackProvider>
      {me === null ? (
        <Login onLogin={check} />
      ) : (
        <SessionCtx.Provider value={{ me, logout }}>
          <HostsProvider>
          <BrowserRouter basename={BASE_PATH || undefined}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Dashboard />} />
                <Route path="containers" element={<Containers />} />
                <Route path="hosts" element={<Hosts />} />
                <Route path="hosts/:hostId/containers/:id/:tab?" element={<KeyedDetail />} />
                <Route path="audit" element={<Audit />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
          </HostsProvider>
        </SessionCtx.Provider>
      )}
    </FeedbackProvider>
  );
}
