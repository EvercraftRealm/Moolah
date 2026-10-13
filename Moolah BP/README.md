# Moolah - Digitize your diamonds.

Moolah is a player-driven economy add-on for Minecraft Bedrock multiplayer. Unlike nearly every currency/economy system currently avilable for Minecraft, Moolah **is not a fiat currency**. The **money cannot be printed into existance** by minigames or lotteries. It's just a far more convenient and fungible way to store, use, and spend real diamonds!

Players can exchange diamonds for moolah at a 1:100 ratio, transfer payments to other players, use payment signs, and trade any item through a GUI-based Market. Global controls and configurable taxes let world owners tune the economy to thier liking without enabling cheats.


## Getting started

1. Enable the **Moolah** behavior pack and its **Moolah UI** resource-pack dependency on your world.
2. Enter the world and read the **Moolah Guide** given to you on your first join.
3. Run `/bank`, or **Use** a diamond, to open the main menu.
4. Deposit diamonds to create your first balance.

If a short command is unavailable, use its namespaced version:

- `/moolah:bank`
- `/moolah:taxes`
- `/moolah:pay`
- `/moolah:warp`
- `/moolah:market`
- `/moolah:buy`
- `/moolah:sell`
- `/moolah:claim`


## Moolah Menu

Open the main menu by running `/bank`.

Alternatively, hold a diamond and **Use** it (right-click or press your platform's interaction button).


The menu includes the following features when enabled by an economy admin.

### Deposit

Convert diamonds in your inventory into Moolah. Preset deposit amounts are:

- 1 diamond = 100 moolah
- 4 diamonds = 400 moolah
- 16 diamonds = 1,600 moolah
- 64 diamonds = 6,400 moolah

Use **Deposit** in the main menu, or run `/deposit` to open the Deposit menu directly. The menu includes an **All** button. You can skip the menu with `/deposit <amount>` for any whole number from 1 to 1,728, or deposit every diamond in your inventory with `/deposit 0`.


### Withdraw

Convert moolah back into diamonds using the same preset quantities: 1, 4, 16, or 64. The **All** option calculates the largest withdrawal that both fits in your inventory and can be covered by your balance after tax. A confirmation screen shows the diamond value, withdrawal tax, and total before anything is charged.

Use **Withdraw** in the main menu, or run `/withdraw` to open the Withdraw menu directly. Run `/withdraw <amount>` for any whole number from 1 to 1,728, or `/withdraw 0`, to skip directly to the appropriate confirmation screen. A quantity of `0` means All. Withdrawals are never completed without confirmation.


### Transfer

Transfer moolah to an online or offline player. When Transfer Descriptions are enabled by an economy admin, you can include an optional message of up to 64 characters.

Choose **Transfer** in the main menu, or run `/pay` to open the Transfer payment menu directly. To skip the menu, provide the recipient and amount:

- `/pay <recipient> <amount>`
- `/pay <recipient> <amount> "optional message"`

Messages containing spaces must be enclosed in quotation marks. If Transfer Descriptions are disabled, the GUI omits this field and `/pay` does not accept the message argument.

Every payment enters escrow first:

- The sender's balance is charged immediately.
- The recipient sees the payment in **Inbox**.
- The sender sees it in **Pending** and may cancel it for a full refund.
- The recipient must wait 60 seconds before accepting it.
- Once accepted, the payment can no longer be canceled.

Run `/inbox` to open incoming payments and mail directly. Run `/pending` to review and cancel outgoing Pending items directly.

Offline recipients are matched by username without regard to capitalization. Check spelling carefully; a misspelled payment remains Pending and can be canceled by its sender.

### Mail

Use **Mail** in the main menu, or run `/mail`, to send a message of up to 512 characters to an online or offline player. Mail uses the same **Inbox** and **Pending** menus as transfers. Mail has no acceptance delay: the sender can cancel it while it remains unopened, but opening it immediately accepts it and recipients cannot decline it afterward.

Mail may have a postage cost configured by an economy admin. The cost is shown before sending and remains reserved while the mail is Pending. Accepted-mail postage always moves into the Tax Pool. If the sender cancels unopened mail, the postage is either refunded or moved into the Tax Pool according to the Admin setting.

### Warp

When enabled by an economy admin, choose **Warp** as the final option in the main menu or run `/warp`. You can warp to another online player, world spawn, or your Home spawn point. Home falls back to world spawn when no personal spawn point is available.

Warp prices are based on horizontal distance, rounded up to the next 100-block increment. Overworld-to-Nether travel converts Nether coordinates to their equivalent Overworld scale before measuring distance, accounting for Minecraft's 1:8 coordinate ratio. Travel between dimensions then uses the configured Interdimensional Multiplier. Economy admins may optionally set minimum and maximum Warp costs; leaving either field blank disables that limit. The confirmation screen shows the destination, priced distance, configured rate, dimension multiplier when applicable, configured limits, and final cost before anything is charged. Successful Warp costs move into the Tax Pool; failed teleports are refunded.

When joining the world, players receive a color-coded summary if they have incoming items, outgoing Pending items, unclaimed Market proceeds, or active Market listings.

### Claims

When enabled by an economy admin, claims protect entire chunks from sky to bedrock. The default price is 10 Moolah per chunk, and every purchase is paid into the Tax Pool. Use **Claims** in the main menu or run `/claim`.

The **Claim Radius** menu supports radii 1 through 9 and shows the resulting square dimensions and chunk count before continuing to purchase confirmation.

- `/claim add` buys the current chunk after confirmation.
- `/claim add <1-9>` buys a square radius centered on the current chunk. Radius 1 is 3×3; radius 9 is 19×19.
- `/claim remove [1-9]` unclaims your chunks in the selected area after confirmation. Refunds are off by default and configurable by admins.
- `/claim invite` opens an online-player dropdown with an **Offline Player** username fallback. Invitations apply to every chunk owned by the inviting player.
- `/claim uninvite` opens a dropdown containing your currently invited friends.
- `/claim guest` opens the **Add Guest** menu. Guests can interact, trade, and pick up items across all your claims without building, breaking, or damaging entities. Guest duration is optional; blank means no expiration.
- `/claim unguest` opens a dropdown containing your active guests.
- `/claim toggle` opens the fire-tick and explosion controls for the current chunk.
- `/claim info` shows the current chunk's owner, globally invited friends, and protection settings.
- `/claim view` toggles claim-border particles across loaded simulation-distance chunks. Green borders are yours, red borders belong to other players, and grey borders are unclaimed; run the command again to exit.
- `/claim walk` records each unique unclaimed chunk you enter. Crouch three separate times quickly to finish, then confirm the combined cost. Walk & Claim is limited to 512 selected chunks per session.

Unauthorized players cannot break or place blocks, use doors or containers, interact with entities, pick up items, or damage mobs and players inside a claim. Guests may use approved doors, controls, containers, workstations, and villager trading, and may pick up dropped items, but cannot edit land or damage entities. Explosions do not destroy protected blocks. Fire spread protection uses bounded background cleanup near online players; keep backups because Bedrock does not expose a cancellable fire-spread event.

Entering or leaving a claimed area shows its owner in the actionbar. Moving between adjacent chunks owned by the same player does not repeat the message. Economy admins can remove another player's claims by standing in one and using the normal remove command; administrative removals never issue refunds.

For larger cleanups, use **Admin → Claims → Remove Player Claims**. Select a known owner or enter an offline player's exact username, then remove their claims within a radius of 1–9 chunks around you or remove all of their claims in every dimension. The final screen shows the exact number before anything is removed. Bulk administrative removals do not issue refunds.

## QuickPay signs

QuickPay signs provide simple one-click transfers. They are not a "chest-shop" and do not protect items, but they provide a convenient alternative to paying with diamonds in brick-and-mortar shops. Write a sign using this exact four-line layout:

```text
!QuickPay
(USERNAME)
(AMOUNT)
(DESCRIPTION)
```

Example:
```text
!QuickPay
HalfMacaroon378
150
64x Rockets
```

Rules:

- `!QuickPay` must be the exact first line.
- Username and amount are required.
- Amount must be a positive whole number.
- Description is optional when Transfer Descriptions are enabled. Otherwise, leave the fourth line blank.
- Activating a valid QuickPay sign adds the Minecoin symbol and copies the complete payment text to both sides.
- Active QuickPay signs cannot be edited. Break and replace the sign if its payment details need to change.

QuickPay payments still have the standard 60-second Inbox delay, giving the sender time to review or cancel an accidental payment. Disabling transfers globally also disables QuickPay. Disabling Transfer Descriptions leaves description-free QuickPay signs working normally.

## Market

Open the Market parent menu with `/market` or from the main menu. Use `/buy` to skip directly to Browse Listings.

The Market contains:

- **Browse Listings** — inspect descriptions and purchase active listings.
- **My Listings** — add, edit, cancel, and claim proceeds from your listings.

### Selling an item

Hold the stack you want to sell, then choose **Market → My Listings → Add Listing** from the main menu. Alternatively, use `/sell` to quickly open the Listing menu.

You can skip the GUI entirely with `/sell <price> "optional description"`
Descriptions containing spaces or symbols must be enclosed in quotation marks.

Listings remain active until they are sold, edited, or canceled.

Economy admins can configure a listing fee and allow between 1 and 10 active listings per player. Listing fees remain reserved while listings are active. A sold listing's fee moves into the Tax Pool; a canceled listing's fee is either refunded or moved into the Tax Pool according to the Admin setting.

### Supported items

The Market stores the original native item(s), preserving any details such as:

- Custom names and lore
- Enchantments and durability
- Written-book contents
- Potion and item data
- Map IDs and map art
- Banner and shield patterns
- Filled bundles and shulker boxes

Descriptions are recommended for map art, decorated banners, written books, and other items whose special value is not obvious from their name.


### Buying and proceeds

The purchase confirmation shows the listing price, Market tax, and final total. The buyer pays the total and receives the exact listed item(s). The seller then claims the original listing price from **My Listings** at their convenience.


## Administration

Only players with the `econ_admin` tag can access the **Admin** menu. On a new world, Moolah automatically grants this tag to the first player who joins, once for the lifetime of that world. This gives vanilla Realm owners access without enabling cheats.

The Admin menu is organized into seven categories:

- **General**
  - **Allow Deposit** — on by default
  - **Allow Withdraw** — on by default
  - **Allow Transfer** — on by default; also controls QuickPay
  - **Allow Mail** — on by default; also controls `/mail`
- **Tax Policy**
  - Current Tax Pool display
  - **Death Tax** — 0 moolah by default
  - **Death Tax Cooldown** — 60 minutes by default
  - **Charge Tax on Transfers** — 0% by default
  - **Charge Tax on Withdraws** — 10% by default
  - **Charge Tax on Market** — 10% by default
  - **Distribute Taxes** — off by default
  - **Max Tax Refund** — 100 moolah by default
- **Market**
  - **Allow Market** — on by default; also controls `/market`, `/buy`, and `/sell`
  - **Max Market Listings** — 3 per player by default
  - **Listing Fee** — 10 moolah by default
  - **Refund Cancelled Listing Fees** — off by default
- **Claims**
  - **Claim Settings**
    - **Allow Claims** — off by default; also controls `/claim`
    - **Claim Cost per Chunk** — 10 moolah by default
    - **Refund Removed Claims** — off by default; refunds are limited by available Tax Pool funds
  - **Remove Player Claims** — safely removes one player's claims in a radius or globally after an exact-count confirmation; no refund is issued
- **Misc**
  - **Allow Transfer Desc.** — on by default; controls descriptions in transfers and QuickPay
  - **Postage Cost** — 5 moolah by default
  - **Refund Cancelled Mail Postage** — on by default
- **Warp**
  - **Allow Warp** — off by default; also controls `/warp`
  - **Warp Cost (per 100 blocks)** — 10 moolah by default
  - **Interdimensional Multiplier** — 2x by default; configurable from 1x to 5x
  - **Minimum Warp Cost** — blank and without a minimum by default
  - **Max Warp Cost** — blank and uncapped by default
- **Logs**
  - Separate logs for deposits, withdrawals, transfers, mail, Market actions, warps, claims, and admin/tax actions
  - Records completed actions only, with the newest entries first
  - Keeps up to 512 recent entries in bounded storage, with an optional **All Activity** overview

Taxes are charged in addition to the base value and added to the shared **Tax Pool**. Transfer taxes remain refundable while the payment is Pending and only enter the pool after the recipient accepts. When configured, the flat Death Tax is collected no more than once per player during its cooldown period; the player receives the result as Inbox Mail from **System**.

When **Distribute Taxes** is enabled, each player earns a Tax Return after every eligible hour online. Each return is 1% of the current Tax Pool, capped by the configured **Max Tax Refund**, and is reserved from the pool until claimed from the player's **Inbox**. Distribution pauses while the pool is below 100 moolah. Only active online play counts toward eligibility; logged-out or AFK time does not. Holding a diamond shows the player's balance and current Tax Return countdown in the actionbar.

Any player can run `/taxes` to view the current global Tax Pool, whether refunds are available, and their estimated next Tax Return and remaining eligible online time.

Dedicated-server owners can grant additional admins from the server console with `/tag <player> add econ_admin`. Using `/tag` from a local world or Realm requires cheats and disables achievements.


## For world owners

- This addon is achievement-friendly!
- Minimum engine version: Minecraft Bedrock `1.26.10`
- Script dependencies: `@minecraft/server` 2.6.0 and `@minecraft/server-ui` 2.0.0
- Market items use persistent private storage entities and should not be removed with broad entity-cleanup commands.
- Back up important worlds before updating or removing economy add-ons.
