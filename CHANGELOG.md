# Changelog

## 1.3.3 - 2026-11-10 (Local Test)

- Added off-by-default Chest Shops for chests, copper chests, double chests,
  and barrels registered with a `!ChestShop` sign.
- Added secure item browsing and purchase confirmation with native item icons,
  per-item pricing and quantities, sales tax, registration fees, final sales,
  seller Inbox proceeds, and dedicated audit logs.
- Added owner shop configuration, automatic matching/default pricing, Unsold
  stock, hopper-added stock reconciliation, claim access, and shop protection.
- Stores Chest Shop pricing in server-side shop records so stock keeps its
  original lore, stacking behavior, and other native item data unchanged.
- Owner stocking sessions now pause hopper reconciliation until the container
  closes, then immediately prompt for every new non-matching item's price and
  quantity with configured defaults prefilled.
- Chest Shop pricing prompts now re-check current priced stock after registration
  and every owner stocking session, reusing price and quantity for identical
  unsold stacks instead of asking again.
- Closing an item-pricing dialog now stops the entire remaining pricing queue;
  existing Unsold items are not repeatedly prompted on every shop close.
- Chest Shop listings and owner pricing dialogs now distinguish item variants
  with potion effects, enchantments, book details, durability, lore, storage
  contents, underlying item types, and exact owner-facing chest slot numbers.
- Buyer catalogs combine identical stock with matching prices and purchase
  quantities into one listing, including stock spread across partial stacks.
- Buyer Chest Shop catalogs play vanilla chest-open and chest-close sounds.
- Chest Shop buyers can select multiple items or configured sets from a
  stock-based slider before confirmation; totals, tax, proceeds, delivery,
  and logs scale with the selected quantity.
- The virtual chest-close sound now waits until the final catalog, quantity,
  or confirmation window is closed.
- Closing a Chest Shop sub-menu now returns to its parent: quantity returns to
  the catalog, and purchase confirmation returns to quantity with a Back button.
- Chest Shop owners can choose the color of their shop name from the full
  classic and material color set, with the color shown on signs and shop UI.
- Chest Shop owners can set a custom buyer-catalog description or leave it
  blank to retain the default owner and purchase prompt.
- Fixed the Chest Shop icons for normal, writable, written, and enchanted
  books by using their vanilla texture paths.
- Removed BedrockUnplugged-specific player filtering and documentation.

## 1.3.2 - 2026-11-07

- Hardened recurring player polling against players departing through scripted
  kicks, including balance, HUD, tax-return, claim, and Emergency Warp state.
- Changed external balance monitoring from every tick to once per second and
  skipped player/scoreboard polling while external-charge collection is off.
- Added before-leave exclusion and after-leave cache cleanup without retaining
  or re-reading an invalid Player object in error paths.

## 1.3.1 - 2026-11-04

- Removed Spectator-mode players from Warp destinations and re-check their
  game mode before teleporting.

## 1.3.0 - 2026-11-04

- Added optional BedLog Framework integration that forwards every successful
  Moolah audit action through `blf:log` while retaining the built-in logs.
- Added **Accept All Payments** to the Inbox with a private summary grouped by
  sender. Mail remains available to read after its attached payment is claimed.
- Added the craftable **Moolah Pouch**, a reusable Bundle-and-Ender-Pearl item
  that shows the player's balance while held and opens the Moolah menu when used.
- Added optional **Emergency Warp**, a free 30-second escape to world spawn with
  movement, jump, and damage cancellation plus an eight-hour successful-use cooldown.
- Added an off-by-default **Send External Charges to Tax Pool** policy with
  Admin & Tax logging for outside scoreboard deductions.
- Prioritized Inbox and Pending notices at the top of the main menu and added
  dedicated icons for both actions.
- Added one informational startup Content Log entry with the Moolah, Minecraft,
  and Script API versions.
- Fixed new-world balance-monitor warnings before a player has a scoreboard
  participant, improved undead fire behavior in protected claims, and adjusted
  unclaimed claim borders closer to neutral white.
- Raised the minimum supported Minecraft Bedrock version to 1.26.60 and the
  `@minecraft/server` dependency to 2.10.0.

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
