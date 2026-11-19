import { Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Empty } from './components/ui';
import { ProjectsProvider } from './context';
import HttpsPage from './pages/HttpsPage';
import SystemPage from './pages/SystemPage';
import ProjectPage from './pages/ProjectPage';
import ProjectsPage from './pages/ProjectsPage';
import TrafficPage from './pages/TrafficPage';

export default function App() {
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
                <Route path="*" element={<Empty title="Page not found" />} />
              </Routes>
            </Shell>
          }
        />
      </Routes>
    </ProjectsProvider>
  );
}
