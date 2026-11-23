import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';
import { loadAuth, useAuth } from './auth';
import { Shell } from './components/Shell';
import { Empty } from './components/ui';
import { ProjectsProvider } from './context';
import ApiTokensPage from './pages/ApiTokensPage';
import HttpsPage from './pages/HttpsPage';
import LoginPage from './pages/LoginPage';
import SystemPage from './pages/SystemPage';
import ProjectPage from './pages/ProjectPage';
import ProjectsPage from './pages/ProjectsPage';
import TrafficPage from './pages/TrafficPage';

/** Sign-in gate: Open mode renders the app as before; Single admin mode shows the sign-in page until signed in. */
export default function App() {
  const auth = useAuth();
  useEffect(() => void loadAuth(), []);
  if (!auth.loaded) return null;
  if (auth.mode === 'single' && !auth.user) return <LoginPage />;
  return <Dashboard signedIn={auth.mode === 'single'} />;
}

function Dashboard({ signedIn }: { signedIn: boolean }) {
  return (
    <ProjectsProvider>
      <Routes>
        {/* Project pages render their own Shell so the sidebar can show the project's users. */}
        <Route path="/p/:slug/*" element={<ProjectPage />} />
        <Route
          path="*"
          element={
            <Shell>
              <Routes>
                <Route path="/" element={<ProjectsPage />} />
                <Route path="/traffic" element={<TrafficPage />} />
                <Route path="/https" element={<HttpsPage />} />
                <Route path="/system" element={<SystemPage />} />
                {signedIn && <Route path="/account/tokens" element={<ApiTokensPage />} />}
                <Route path="*" element={<Empty title="Page not found" />} />
              </Routes>
            </Shell>
          }
        />
      </Routes>
    </ProjectsProvider>
  );
}
