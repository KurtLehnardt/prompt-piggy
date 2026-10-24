# Validator fixture corpora (PP-08a)

Data only. These files feed the Dynamic Validator tests (PP-08), the golden gate (PP-13), the hardening pipeline (PP-23), and the poisoning tests.

**Every prompt here is synthetic. None contains personal data. None is a real breach.** The repository is public. Real breach prompts, the breach corpus, and all level 4 and 5 secret material exist only in the database (`golden_prompts`, `level_secrets`) and the gitignored `.secrets/` directory, never in git (CH2-3, R2-12).

| File | Role | Size |
|---|---|---|
| `attacks.v1.json` | Prompt-injection technique samples, tagged by detector family (`roleplay`, `authority`, `override`, `delimiter`, `decode`, `tool`, `deferred`, `mixed_script`, `hypothetical`) and variant (`plain`, `zero_width`, `homoglyph`, `reversed`, `encoded_base64`, `encoded_hex`, `encoded_url`, `encoded_decimal`). `flaggedFromLevel` is the first level whose version-0 rule set blocks the family. | 84 cases |
| `benign.v1.json` | Banking and friendly-chat prompts that must always be allowed (HC4), including the near-misses from ARCHITECTURE section 6.6 and phrases a poisoner would target (`poisoner_target`). | 182 cases |
| `loophole.v1.json` | Prompts that use a level's intended route to a transfer: levels 1 to 3 only (manager code, Nana Truffle's pie, an appointment). Public by design (T31). Levels 4 and 5 have no fixtures here. | 25 cases |
| `traffic-sample.v1.json` | Realistic non-breach attempts (chat, failed jailbreaks, banking) from 41 synthetic authors, split `filter` (100) and `holdout` (100). The traffic filter reads only the filter half; the holdout half only checks that hardening never newly blocks it (R2-15). | 200 cases |

Rules for editing:

- Add new cases with new ids; never reuse or renumber an id. Changing a corpus means bumping to `v2` files, except for fixes agreed in review.
- Attack phrasing stays clearly synthetic. No slurs, no abuse, no real keys or tokens.
- Benign and loophole prompts must not contain a catalog phrase of a detector active at their level (the shape test enforces this for the section 6.2 phrases).
- Zero-width and homoglyph characters are written as literal characters in the JSON; do not normalize them.
