import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { ConfirmProvider, SessionProvider, ToastProvider, useSession } from './ui';
import { Layout } from './components/Layout';
import { Feed } from './pages/Feed';
import { Explore } from './pages/Explore';
import { Videos } from './pages/Videos';
import { PostPage } from './pages/PostPage';
import { People } from './pages/People';
import { Person } from './pages/Person';
import { UserProfile } from './pages/UserProfile';
import { Create, EditPost } from './pages/Create';
import { Settings } from './pages/Settings';
import { At, Hashtag, Hashtags, Liked, Login, Notifications } from './pages/Misc';

function Protected() {
  const { me, loaded } = useSession();
  if (!loaded) return <div className="loading">Loading…</div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Layout />;
}

function MeRedirect() {
  const { me } = useSession();
  return <Navigate to={`/user/${me!.username}`} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>
        <Route index element={<Feed />} />
        <Route path="explore" element={<Explore />} />
        <Route path="videos" element={<Videos />} />
        <Route path="p/:id" element={<PostPage />} />
        <Route path="p/:id/edit" element={<EditPost />} />
        <Route path="people" element={<People />} />
        <Route path="u/:handle" element={<Person />} />
        <Route path="user/:username" element={<UserProfile />} />
        <Route path="me" element={<MeRedirect />} />
        <Route path="at/:name" element={<At />} />
        <Route path="tags" element={<Hashtags />} />
        <Route path="tags/:tag" element={<Hashtag />} />
        <Route path="liked" element={<Liked />} />
        <Route path="create" element={<Create />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings" element={<Settings />} />
        <Route path="settings/:tab" element={<Settings />} />
        <Route path="*" element={<div className="empty">Page not found.</div>} />
      </Route>
    </Routes>
  );
}

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
