# LedgerScan — Claude Code Instructions

## Branch Workflow
- **Always work on `staging` first** before making any changes
- Never commit or push directly to `main`
- Merge `staging` → `main` only when the user explicitly approves
- Confirm the current branch with `git branch --show-current` if unsure

## UI
- **All UI changes must consider mobile.** Test layouts at ≤480px. Use responsive CSS (media queries or flex/grid wrapping) — never hardcode fixed widths without a mobile override.
- Components that render independently (i.e. return early before Dashboard's `<style>` tag) must include their own `<style>` tag for mobile overrides.
