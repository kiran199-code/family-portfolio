# Data providers: what is verified and what is not

Checked against documentation on 10 Nov 2026, but never called live from the build environment (network blocked there).
Run `node scripts/phase0-spike.mjs` on your own machine; it writes docs/provider-report.md with real results.

| Provider | Used for | Status |
|---|---|---|
| AMFI NAVAll.txt | Mutual fund NAV (primary) | Format verified from docs; live call not run |
| mfapi.in | MF NAV fallback | Endpoints verified from docs; rate limit not published |
| Frankfurter v2 | SGD/INR reference rate | Verified from docs; reference rate, not live |
| Upstox v3 LTP | Indian stocks, indices | Needs your access token (expires daily). Pricing/token life not verified |
| Dhan marketfeed LTP | Alternative broker feed | Needs token + client id. Security-id mapping not verified |
| Yahoo chart | Opt-in only | Unofficial, terms disallow automation; off by default |
| ULIP NAVs | Insurer pages | No known API. Page regex only if you add link + pattern; otherwise manual price |
| DBS (SGX) | SG stock | No verified free source; manual price |

Rules enforced: never estimate; only move forward in time; 35% jump rejected; provider/stored close mismatch >0.5% flagged; LTP is a close only after 15:45 IST on a trading day.
