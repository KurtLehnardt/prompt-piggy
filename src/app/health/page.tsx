import type { Metadata } from "next";
import {
  resolveSupabasePublishableKey,
  resolveSupabaseSecretKey,
  resolveSupabaseUrl,
} from "@/lib/supabase/env";

/**
 * Public deploy check (ARCHITECTURE section 4). It is rendered on every request
 * so the commit and environment are always current. It makes no database or
 * network call. For each Supabase setting it reports only whether it is set
 * and the name of the variable it was read from, never its value.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Health | Prompt Piggy",
  robots: { index: false, follow: false },
};

const APP_NAME = "Prompt Piggy";

type Row = { label: string; value: string; testId: string; source?: string };

function setting(
  label: string,
  testId: string,
  resolved: { name: string } | null,
): Row {
  return {
    label,
    value: resolved ? "yes" : "no",
    testId,
    source: resolved?.name,
  };
}

export default function HealthPage() {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local";
  const environment = process.env.VERCEL_ENV || "development";

  // Only the variable names leave these objects; the values are never rendered.
  const rows: Row[] = [
    { label: "App", value: APP_NAME, testId: "health-app" },
    { label: "Commit", value: commit, testId: "health-commit" },
    { label: "Environment", value: environment, testId: "health-environment" },
    setting("Supabase URL set", "health-supabase-url", resolveSupabaseUrl()),
    setting(
      "Supabase publishable key set",
      "health-supabase-publishable-key",
      resolveSupabasePublishableKey(),
    ),
    setting(
      "Supabase secret key set",
      "health-supabase-secret-key",
      resolveSupabaseSecretKey(),
    ),
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
            <dd className="font-mono">
              <span data-testid={row.testId}>{row.value}</span>
              {row.source ? (
                <span className="text-muted-foreground">
                  {" "}
                  (from{" "}
                  <span data-testid={`${row.testId}-name`}>{row.source}</span>)
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
