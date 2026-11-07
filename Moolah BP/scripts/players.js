import { world } from "@minecraft/server";

const UNPLUGGED_BOT_TAG = "unplugged.bot";
const leavingPlayerIds = new Set();

function readPlayerSnapshot(player) {
  try {
    if (!player?.isValid) return undefined;
    const id = player.id;
    if (leavingPlayerIds.has(id) || player.hasTag(UNPLUGGED_BOT_TAG)) {
      return undefined;
    }
    const name = player.name;
    if (!player.isValid || leavingPlayerIds.has(id)) return undefined;
    return { player, id, name };
  } catch {
    return undefined;
  }
}

export function isMoolahPlayer(player) {
  return readPlayerSnapshot(player) !== undefined;
}

export function getMoolahPlayerSnapshot(player) {
  return readPlayerSnapshot(player);
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

world.beforeEvents.playerLeave.subscribe((event) => {
  try {
    leavingPlayerIds.add(event.player.id);
  } catch {
    // The after-event provides the ID if the native Player is already unavailable.
  }
});

world.afterEvents.playerLeave.subscribe((event) => {
  leavingPlayerIds.add(event.playerId);
});

world.afterEvents.playerSpawn.subscribe((event) => {
  try {
    leavingPlayerIds.delete(event.player.id);
  } catch {
    // A later valid player enumeration will recover normally.
  }
});
