# Changelog

## 1.2.7 - 2026-11-03

- Added the **Moolah Pouch**, a reusable item that shows the player's balance
  while held and opens the Moolah menu when used.
- Added two automatically unlocked shapeless recipes: Bundle + Ender Pearl, or
  Leather + String + Ender Pearl.
- Added a vanilla-style bundle texture with a Minecoin emblem on the front.

## 1.2.6 - 2026-11-03

- Added BedrockUnplugged compatibility by safely ignoring unreadable players
  and entities tagged `unplugged.bot` across Moolah systems.
- Deferred first-spawn handling by one tick so Unplugged can identify its
  ghosts before Moolah assigns an admin, guide, or login notifications.
- Raised the minimum supported Minecraft Bedrock version to 1.26.60 and the
  `@minecraft/server` dependency to 2.10.0.

## 1.2.5 - 2026-11-01

- Added **Accept All Payments** at the top of the Inbox whenever payments are
  ready, with one private summary grouped by sender.
- Bulk payment claims leave mail untouched so recipients can still open and
  read each message normally.

## 1.2.4 - 2026-10-28

- Warmed the unclaimed claim-border tint to counter the particle's blue bias
  and render closer to neutral white in-game.
- Moved Inbox and Pending notices to the top of the main menu when visible and
  added dedicated icons for both actions.
- Added an off-by-default **Send External Charges to Tax Pool** policy that
  detects outside scoreboard deductions, transfers them to the Tax Pool, and
  records each successful collection in the Admin & Tax log.
- Allowed unnamed undead mobs such as zombie horses to take normal fire damage
  inside fire-protected claims, even when they are not classified as hostile.
- Fixed balance-monitor warnings on new worlds where a player does not yet have
  a participant entry in the `moolah` scoreboard.
- Added optional BedLog Framework integration that forwards every successful
  Moolah audit action through `blf:log` while retaining the built-in logs.

## 1.2.1 - 2026-10-15

- Creeper explosions in protected claims now damage players and unnamed hostile
  mobs while continuing to protect blocks, animals, pets, named mobs, and
  decorative entities.
- Unnamed hostile mobs can now take fire and fire-tick damage inside protected
  claims.
- Wind charges retain their normal behavior outside protected claims and for
  claim owners and friends, while unauthorized bursts are blocked inside other
  players' claims.
- Unclaimed chunk borders now use a brighter neutral white particle color.
- New installations now start with Mail and Market disabled, leaving Deposit,
  Withdraw, Transfer, and QuickPay as the default enabled features.
- Remade the Claims menu icon with a rectangular Minecraft-style wooden shield
  and a more vanilla-like grass block texture.
- Clarified the Manage Friends description for friend and guest permissions.

## 1.2.0 - 2026-10-13

- Added global guest access with optional 1–3650 day expiration.
- Guests can use approved blocks, trade with villagers, and pick up items, but
  cannot build, break blocks, modify land, or damage entities.
- Added **Add Guest** and **Remove Guest** under **Manage Friends**, plus
  `/claim guest` and `/claim unguest`.
- Renamed `/claim deinvite` to `/claim uninvite`.
- Added a safe admin tool for removing one player's claims in a selected area
  or across every dimension, with an exact-count confirmation and no refund.
- Added separate, persistent admin logs for deposits, withdrawals, transfers,
  mail, Market actions, warps, claims, and admin/tax actions.

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
