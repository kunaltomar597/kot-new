# 22. Turn on AI menu import

**Why:** a restaurant can photograph its printed menu and have it read into a draft that a
manager checks dish by dish before it is imported (ONB-006). The reading is done by an AI
provider (Anthropic's Claude) from the Vendor Control Plane, which alone holds the provider's
key (SEC-002). Claude built and tested the whole path with a scripted reader, but cannot open the
provider account or put the key in your secret manager. Until you do, restaurants use the Excel
template, which works the same afterwards.

**Work packages:** P6-04a (Control Plane), P6-04b (review and import on the restaurant PC).

**You need:**

- The Control Plane deployed (OWNER_CHECKLIST: cloud hosting in India and a secrets manager).
- An Anthropic account for the business, with billing set up (OWNER_CHECKLIST: AI provider).

Never paste the key into a Claude session, a chat, a file in the repository or a commit.

## Steps

1. In the Anthropic Console (console.anthropic.com), create a workspace for the Control Plane,
   for example "Restaurant platform – production", and a spending limit you are comfortable with.
   One menu costs roughly as much as reading a few photos and writing a few thousand words.
2. Create an API key in that workspace. Copy it straight into your cloud secret manager as the
   value of `CP_AI_API_KEY` for the Control Plane of that environment. Do the same, with a
   separate key, for staging.
3. Optional settings (environment variables of the Control Plane, defaults in brackets):
   - `CP_AI_MODEL` (`claude-sonnet-5-5`): the model that reads the menus;
   - `CP_AI_DAILY_LIMIT` (20): menus each restaurant may have read in 24 hours;
   - `CP_AI_TIMEOUT_SECONDS` (300).
4. Restart the Control Plane so it reads the key.
5. Check from a restaurant PC that is enrolled with this Control Plane: in **Manage → Menu →
   Import → Read a printed menu**, send two or three clear photos of a real menu. Within about a
   minute a draft should appear with every section and dish. Do not import it unless you mean to.
6. In the Anthropic Console, check that the request appears under the workspace's usage.

## Results to report back

Copy this into a Claude session (no keys):

```
AI menu import
- Anthropic workspace created (staging/prod): __/__
- CP_AI_API_KEY set in the secret manager (staging/prod): __/__
- A test menu was read into a draft (staging/prod): __/__ ; dishes found: __ of __ on the menu
- Anything misread (prices, names, veg marks):
```
