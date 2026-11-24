import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import HomePage from './pages/HomePage';

// Route-level code split. ScorePage statically pulls the MusicXML/OSMD stylesheet;
// the 11 MB @music-i18n/musicxml-player chunk is then only fetched when /score
// actually mounts, instead of on the landing page.
const UploadPage = lazy(() => import('./pages/UploadPage'));
const ScorePage = lazy(() => import('./pages/ScorePage'));

function App() {
  return (
    <Router>
      <div className="app-wrapper">
        <header className="container">
          <nav className="top-nav">
            <Link to="/" className="nav-logo logo-text">
              Cadenza
            </Link>
            <div className="nav-links">
              <Link to="/">Home</Link>
              <Link to="/upload">Upload Score</Link>
            </div>
          </nav>
        </header>

        <main>
          <Suspense fallback={<div className="route-loading">Loading…</div>}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/score" element={<ScorePage />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </Router>
  );
}

export default App;
