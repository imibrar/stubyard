import { useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { isTeamsAdmin, loadAuth, signInMode, useAuth } from './auth';
import { ForcedPasswordPage } from './components/AccountPassword';
import { Shell } from './components/Shell';
import { Empty } from './components/ui';
import { ProjectsProvider } from './context';
import ApiTokensPage from './pages/ApiTokensPage';
import HttpsPage from './pages/HttpsPage';
import InvitePage from './pages/InvitePage';
import LoginPage from './pages/LoginPage';
import SystemPage from './pages/SystemPage';
import ProjectPage from './pages/ProjectPage';
import ProjectsPage from './pages/ProjectsPage';
import TeamPage from './pages/TeamPage';
import TrafficPage from './pages/TrafficPage';
import './styles/team.css';

/**
 * Sign-in gate: Open mode renders the app as before; Single admin and Teams modes show the sign-in page until signed
 * in. Teams: /invite (accept an invite link) is public, and a temporary password must be changed before anything else.
 */
export default function App() {
  const auth = useAuth();
  const location = useLocation();
  useEffect(() => void loadAuth(), []);
  if (!auth.loaded) return null;
  if (auth.mode === 'teams' && location.pathname === '/invite') return <InvitePage />;
  if (signInMode(auth.mode) && !auth.user) return <LoginPage />;
  if (auth.mode === 'teams' && auth.user?.mustChangePassword) return <ForcedPasswordPage />;
  return <Dashboard signedIn={signInMode(auth.mode)} teamsAdmin={isTeamsAdmin(auth)} />;
}

function Dashboard({ signedIn, teamsAdmin }: { signedIn: boolean; teamsAdmin: boolean }) {
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
                {teamsAdmin && <Route path="/team" element={<TeamPage />} />}
                <Route path="*" element={<Empty title="Page not found" />} />
              </Routes>
            </Shell>
          }
        />
      </Routes>
    </ProjectsProvider>
  );
}
