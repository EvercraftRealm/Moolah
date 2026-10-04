const GUIDE_RECEIVED_PROPERTY = "moolah:guide_received";
const GUIDE_LOOT_TABLE = "moolah/player_guide";

function hasEmptyInventorySlot(player) {
  const inventory = player.getComponent("minecraft:inventory")?.container;
  if (!inventory) return false;

  for (let slot = 0; slot < inventory.size; slot += 1) {
    if (!inventory.getItem(slot)) return true;
  }

  return false;
}

export function giveFirstJoinGuide(player) {
  if (player.getDynamicProperty(GUIDE_RECEIVED_PROPERTY) === true) return;

  if (!hasEmptyInventorySlot(player)) {
    player.sendMessage(
      "§eMoolah could not deliver your guide because your inventory is full. "
        + "Leave an empty slot before you next join.§r",
    );
    return;
  }

  try {
    const result = player.runCommand(
      `loot give @s loot "${GUIDE_LOOT_TABLE}"`,
    );
    if (result.successCount < 1) {
      throw new Error("The guide loot table returned no items.");
    }

    player.setDynamicProperty(GUIDE_RECEIVED_PROPERTY, true);
    player.sendMessage(
      "§aYou received the Moolah Guide. Keep it handy for commands and features!§r",
    );
  } catch (error) {
    console.error(
      `[Moolah] Could not give ${player.name} the first-join guide: `
        + `${error?.stack ?? error}`,
    );
  }
}
