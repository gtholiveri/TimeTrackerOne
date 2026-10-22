import { useEffect, useState } from "react";
import { AppProvider } from "./lib/store";
import { usePref } from "./components/usePref";
import { Attention } from "./views/Attention";
import { Categories } from "./views/Categories";
import { Explore } from "./views/Explore";
import { Today } from "./views/Today";

const ROUTES = {
  today: { label: "Today", view: Today },
  explore: { label: "Explore", view: Explore },
  categories: { label: "Categories", view: Categories },
  attention: { label: "Attention", view: Attention },
} as const;
type Route = keyof typeof ROUTES;

function useRoute(): Route {
  const read = (): Route => {
    const r = location.hash.replace(/^#\/?/, "");
    return r in ROUTES ? (r as Route) : "today";
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = usePref<Theme>("theme", "system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  return [theme, () => setTheme(next[theme])];
}

const Logo = () => (
  <svg viewBox="0 0 32 32" aria-hidden>
    <circle cx="16" cy="16" r="12.5" fill="none" stroke="var(--accent)" strokeWidth="3.5" />
    <path d="M16 9v7l5 3" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export function App() {
  const route = useRoute();
  const [theme, cycleTheme] = useTheme();
  const View = ROUTES[route].view;

  useEffect(() => {
    document.title = `${ROUTES[route].label} · TimeTracker`;
    window.scrollTo(0, 0);
  }, [route]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          TimeTracker
        </div>
        <nav className="tabs" aria-label="Views">
          {(Object.keys(ROUTES) as Route[]).map((r) => (
            <a key={r} href={`#/${r}`} aria-current={route === r ? "page" : undefined}>
              {ROUTES[r].label}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <a className="small" href="/" title="ActivityWatch's own web UI, on the same data">ActivityWatch ↗</a>
        <button className="icon-btn" onClick={cycleTheme} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}`}>
          {theme === "system" ? "◐" : theme === "light" ? "☀" : "☾"}
        </button>
      </header>
      <AppProvider
        fallback={(boot) =>
          boot.status === "error" ? (
            <div className="card">
              <h2>Couldn't reach the relay</h2>
              <p className="error">{boot.error}</p>
              <p className="secondary">
                Check <a href="/tt/health">/tt/health</a>, then reload. If you're signed out, any page here asks for the
                key again.
              </p>
            </div>
          ) : (
            <div className="empty">Loading…</div>
          )
        }
      >
        <main>
          <View />
        </main>
      </AppProvider>
    </div>
  );
}
