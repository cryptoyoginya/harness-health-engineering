// App.tsx — корневой компонент. 6 generic-страниц + общий layout с дизайн-системой v2.
//
// КРИТИЧНО: всё приложение обёрнуто в <div className="v2 [dark]">.
// Без этого CSS-переменные из src/v2/styles/v2.css (--background, --card, --foreground...)
// не определяются и Tailwind-утилиты (bg-card, text-foreground) рендерятся как auto/inherit.

import { Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import { cn } from "@/v2/lib/utils";
import { useTheme } from "@/v2/hooks/use-theme";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { Index } from "@/routes/Index";
import { DocumentView } from "@/routes/DocumentView";
import { KbLayer } from "@/routes/KbLayer";
import { Search } from "@/routes/Search";
import { GraphPage } from "@/routes/Graph";
import { OpenQuestions } from "@/routes/OpenQuestions";
import { SkillOpt } from "@/routes/SkillOpt";

export default function App() {
  const { isDark } = useTheme();

  // Синхронизируем [data-theme] на <html> для legacy-CSS-селекторов и highlight.js dark overlay.
  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
  }, [isDark]);

  return (
    <div
      className={cn(
        "v2",
        isDark && "dark",
        "min-h-screen flex flex-col bg-background text-foreground",
      )}
    >
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/layer/:layer" element={<KbLayer />} />
            <Route path="/doc/*" element={<DocumentView />} />
            <Route path="/search" element={<Search />} />
            <Route path="/graph" element={<GraphPage />} />
            <Route path="/open-questions" element={<OpenQuestions />} />
            <Route path="/skillopt" element={<SkillOpt />} />
            <Route
              path="*"
              element={
                <div className="mx-auto max-w-[600px] px-6 py-20 text-center text-muted-foreground">
                  Страница не найдена.{" "}
                  <a href="/" className="text-foreground underline">
                    На главную
                  </a>
                  .
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
