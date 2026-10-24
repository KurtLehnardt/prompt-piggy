export type PigReaction = 'idle' | 'win' | 'late_win' | 'fail' | 'blocked' | 'leak_blocked' | 'error'

export function PiggyBank({ reaction = 'idle' }: { reaction?: PigReaction }) {
  const happy = reaction === 'win'
  const hurt = reaction === 'fail' || reaction === 'blocked' || reaction === 'leak_blocked'
  return (
    <svg viewBox="0 0 120 100" width="160" height="133" role="img" aria-label={`Piggy bank (${reaction})`} data-reaction={reaction}>
      <ellipse cx="60" cy="58" rx="42" ry="30" fill="#f9a8d4" stroke="#be185d" strokeWidth="2" />
      <polygon points="38,34 44,18 54,32" fill="#f472b6" stroke="#be185d" strokeWidth="2" />
      <ellipse cx="100" cy="58" rx="9" ry="8" fill="#f472b6" stroke="#be185d" strokeWidth="2" />
      <rect x="40" y="82" width="10" height="12" rx="3" fill="#f472b6" />
      <rect x="70" y="82" width="10" height="12" rx="3" fill="#f472b6" />
      <rect x="50" y="30" width="20" height="4" rx="2" fill="#831843" />
      {hurt ? (
        <path d="M80 46 l8 8 m0 -8 l-8 8" stroke="#831843" strokeWidth="2" />
      ) : (
        <circle cx="84" cy="50" r="3" fill="#831843" />
      )}
      {happy ? <path d="M92 66 q6 6 12 0" stroke="#831843" strokeWidth="2" fill="none" /> : null}
    </svg>
  )
}
