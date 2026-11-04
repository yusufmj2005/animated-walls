import { useEffect, useState } from 'react';
import { Notices } from './components/Notices';
import { AppLayout, type PageId } from './layouts/AppLayout';
import { DisplaysPage } from './pages/DisplaysPage';
import { HomePage } from './pages/HomePage';
import { LibraryPage } from './pages/LibraryPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { SettingsPage } from './pages/SettingsPage';
import { startStores } from './stores/appStores';

export function App() {
  const [page, setPage] = useState<PageId>('home');

  useEffect(() => {
    startStores();
    // Dropping a file outside a drop zone would otherwise navigate the window to it.
    const block = (event: DragEvent): void => event.preventDefault();
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  return (
    <>
      <AppLayout page={page} onNavigate={setPage}>
        {/* The key restarts the page transition on each navigation. */}
        <div key={page} className="h-full">
          {page === 'home' && <HomePage onNavigate={setPage} />}
          {page === 'library' && <LibraryPage />}
          {page === 'marketplace' && <MarketplacePage />}
          {page === 'displays' && <DisplaysPage />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </AppLayout>
      <Notices />
    </>
  );
}
