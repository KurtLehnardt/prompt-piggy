import type { Metadata } from "next";

/**
 * Public deploy check (ARCHITECTURE section 4). It is rendered on every request
 * so the commit and environment are always current. It makes no database or
 * network call, and it reports only whether each Supabase setting is present,
 * never its value.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Health | Prompt Piggy",
  robots: { index: false, follow: false },
};

const APP_NAME = "Prompt Piggy";

function presence(value: string | undefined): "yes" | "no" {
  return value ? "yes" : "no";
}

export default function HealthPage() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local";
  const environment = process.env.VERCEL_ENV || "development";

  const rows: { label: string; value: string; testId: string }[] = [
    { label: "App", value: APP_NAME, testId: "health-app" },
    { label: "Commit", value: commit, testId: "health-commit" },
    { label: "Environment", value: environment, testId: "health-environment" },
    {
      label: "NEXT_PUBLIC_SUPABASE_URL set",
      value: presence(process.env.NEXT_PUBLIC_SUPABASE_URL),
      testId: "health-supabase-url",
    },
    {
      label: "NEXT_PUBLIC_SUPABASE_ANON_KEY set",
      value: presence(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      testId: "health-supabase-anon-key",
    },
  ];

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Status: <span data-testid="health-status">ok</span>
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.testId} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-mono" data-testid={row.testId}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
