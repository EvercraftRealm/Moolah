import { world } from "@minecraft/server";

const UNPLUGGED_BOT_TAG = "unplugged.bot";

export function isMoolahPlayer(player) {
  if (!player) return false;

  try {
    return player.isValid && !player.hasTag(UNPLUGGED_BOT_TAG);
  } catch {
    return false;
  }
}

export function getMoolahPlayers() {
  try {
    return world.getAllPlayers()
      .filter(Boolean)
      .filter(isMoolahPlayer);
  } catch {
    return [];
  }
}
