/**
 * The /live shell: a dark, large-type canvas for a 1920x1080 projector
 * (docs/ARCHITECTURE.md section 12.2). Body text is 28 px.
 */
export default function LiveLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-slate-950 text-[28px] leading-snug text-slate-50">{children}</div>
}
