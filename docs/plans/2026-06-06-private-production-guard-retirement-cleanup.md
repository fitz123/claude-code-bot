# Private production guard retirement cleanup

This note tracks private production work required before deploying the guard-retired package from the issue #148 continuation. It is an operator checklist only; it does not authorize deployment by itself.

Do not paste, print, decrypt, or commit secret values while completing this checklist. Validate only file paths, key presence where needed, hook wiring, import references, and operator approval state.

## Required private cleanup

- [ ] Review private settings and remove obsolete schema/write-guard hooks or extension references before restart.
- [ ] Remove or explicitly retire private `guardian.sh` / `protect-files.sh` hook wiring and prose if still present.
- [ ] Remove obsolete `@schema.md` imports from private agent workspace context files if any remain.
- [ ] Decide whether inert private `schema.md` files should be archived, left as historical notes, or removed through a recoverable cleanup path.
- [ ] Confirm the deploy wrapper is pointed at the guard-retired package version intended for production.
- [ ] Record explicit operator sign-off before restarting production services with the guard-retired package.

## Non-secret verification

- [ ] Confirm Telegram, Discord, and Tavily secret references still resolve from the control workspace without printing plaintext values.
- [ ] Confirm production agent workspace paths are configured as intended, including any absolute paths outside the control workspace.
- [ ] Confirm no private Claude-path prose still claims schema/write-guard or immutable-core enforcement is active after retirement.
