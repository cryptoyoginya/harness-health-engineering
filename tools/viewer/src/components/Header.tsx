// Header.tsx — верхняя панель: breadcrumb + nav + theme toggle.

import { Link, useLocation } from "react-router-dom";
import { Search, Network, Home, HelpCircle, Activity } from "lucide-react";
import { ThemeToggle } from "@/v2/layout/ThemeToggle";

export function Header() {
  const loc = useLocation();
  const breadcrumb = useMakeBreadcrumb(loc.pathname);
  return (
    <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-background/90 px-4 py-2 backdrop-blur">
      <Link to="/" className="font-semibold tracking-tight hover:text-foreground/80">
        KB Viewer
      </Link>
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Crumb to="/" icon={<Home className="h-3.5 w-3.5" />} active={loc.pathname === "/"}>
          Главная
        </Crumb>
        <Crumb to="/search" icon={<Search className="h-3.5 w-3.5" />} active={loc.pathname === "/search"}>
          Поиск
        </Crumb>
        <Crumb to="/graph" icon={<Network className="h-3.5 w-3.5" />} active={loc.pathname === "/graph"}>
          Граф
        </Crumb>
        <Crumb
          to="/open-questions"
          icon={<HelpCircle className="h-3.5 w-3.5" />}
          active={loc.pathname.startsWith("/open-questions")}
        >
          Открытые вопросы
        </Crumb>
        <Crumb
          to="/skillopt"
          icon={<Activity className="h-3.5 w-3.5" />}
          active={loc.pathname.startsWith("/skillopt")}
        >
          SkillOpt
        </Crumb>
      </nav>
      {breadcrumb ? (
        <div className="hidden md:block text-xs text-muted-foreground truncate">
          <span className="mx-1">/</span>
          {breadcrumb}
        </div>
      ) : null}
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}

function Crumb({
  to,
  children,
  icon,
  active,
}: {
  to: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Link
      to={to}
      className={
        "flex items-center gap-1 rounded px-2 py-1 " +
        (active ? "bg-muted text-foreground" : "hover:bg-muted/60 hover:text-foreground")
      }
    >
      {icon}
      <span>{children}</span>
    </Link>
  );
}

function useMakeBreadcrumb(pathname: string): string | null {
  if (pathname.startsWith("/doc/")) return decodeURIComponent(pathname.slice("/doc/".length));
  return null;
}
