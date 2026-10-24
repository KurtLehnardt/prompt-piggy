import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

// Placeholder landing page for the PP-01 skeleton; PP-11 replaces it.
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Prompt Piggy</h1>
      <p className="text-muted-foreground">
        A self-hardening prompt-security game. The game is not built yet; this
        page only proves that the deployment works.
      </p>
      <Link href="/health" className={buttonVariants({ variant: "outline" })}>
        Check deployment health
      </Link>
    </main>
  );
}
