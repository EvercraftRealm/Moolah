# Changelog

## 1.1.3 - 2026-10-13

- Added global guest access with optional 1–3650 day expiration.
- Guests can use approved blocks, trade with villagers, and pick up items, but
  cannot build, break blocks, modify land, or damage entities.
- Added **Add Guest** and **Remove Guest** under **Manage Friends**, plus
  `/claim guest` and `/claim unguest`.
- Renamed `/claim deinvite` to `/claim uninvite`.

## 1.1.2 - 2026-10-13

- Replaced the fixed radius-3 and radius-5 claim menu entries with one
  **Claim Radius** dialog supporting every radius from 1 through 9.
- Highlighted enabled fire tick and explosions in red in the claim protection
  menu so unprotected settings are easier to identify.
- Added `/claim view` and a Claims-menu toggle that displays nearby claim
  boundaries with player-only green and red particles.
- Deferred claim-border color initialization until normal world execution to
  prevent an early-execution startup error.
- Expanded claim-border visualization across loaded simulation-distance chunks
  and added grey borders for unclaimed chunks.
- Reorganized the Claims menu into focused **Claim Land** and **Manage Friends**
  submenus.

## 1.1.1 - 2026-10-12

- Changed claim actionbar notices to trigger only when claim ownership changes.
- Added notices for leaving a claimed area and combined notices when moving
  directly between areas owned by different players.
- Fixed `/claim add <radius>` and `/claim remove <radius>` by parsing radii as integers.
- Moved claim invitations, removals, and protection toggles into guided menus.

## 1.1.0 - 2026-10-12

- Added an optional chunk claim and protection system, disabled by default.
- Added configurable per-chunk pricing, Tax Pool payments, global friend access,
  radius claims, Walk & Claim, owner entry messages, and administrative removal.
- Added protection from unauthorized building, interaction, entity damage,
  explosions, and best-effort fire spread cleanup.
- Added per-chunk fire and explosion toggles and configurable unclaim refunds.
- Raised the minimum supported Minecraft Bedrock version to 1.26.10 and the
  `@minecraft/server` dependency to 2.6.0.

## 1.0.1 - 2026-10-09

- Added Vibrant Visuals compatibility to the resource pack.
- Raised the minimum supported Minecraft Bedrock version to 1.21.120.

## 1.0.0 - 2026-10-04

- Initial open-source release.
- Added diamond-backed balances, deposits, and withdrawals.
- Added escrowed transfers, QuickPay signs, and mail.
- Added a native-item player market with configurable fees and taxes.
- Added optional distance-priced warps and tax-return distribution.
