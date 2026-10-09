# Moolah

Moolah is an achievement-friendly, player-driven economy add-on for Minecraft
Bedrock multiplayer. It digitizes diamonds at a fixed rate of 100 moolah per
diamond instead of creating a fiat currency.

Players can deposit and withdraw diamonds, transfer funds, use QuickPay signs,
send mail, trade native items through a market, and optionally pay for warps.
World owners can configure taxes and other economy controls without enabling
cheats.

## Install

1. Download the `.mcaddon` file from the latest GitHub release.
2. Open it with Minecraft to import both packs.
3. Activate the Moolah behavior pack on a world. Its linked resource pack will
   be available alongside it.
4. Join the world and follow the Moolah Guide. Run `/bank` to open the menu.

Moolah requires Minecraft Bedrock 1.21.120 or newer. Back up important worlds
before installing or updating add-ons.

## Features

- Diamond-backed balances and reversible deposits
- Escrowed online and offline player payments
- QuickPay signs and player mail
- GUI market that preserves native item data
- Configurable taxes and tax-return distribution
- Optional distance-priced warps
- Achievement-friendly first-player administration

For complete player and administrator documentation, see
[`Moolah BP/README.md`](Moolah%20BP/README.md).

## Contributing

Issues and pull requests are welcome. Keep behavior-pack JavaScript compatible
with the Script API versions declared in `Moolah BP/manifest.json`, and update
both pack versions together when preparing a release.

## License

Moolah is available under the [MIT License](LICENSE).
