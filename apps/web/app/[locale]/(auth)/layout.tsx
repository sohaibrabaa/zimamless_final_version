import { LanguageSwitcher } from "@/components/layout/LanguageSwitcher";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-(--color-surface)">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="text-sm font-semibold">Zimmamless</span>
        <LanguageSwitcher />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="w-full max-w-md rounded-xl border border-(--color-border) bg-(--color-bg) p-8 shadow-sm">
          {children}
        </div>
      </main>
    </div>
  );
}
