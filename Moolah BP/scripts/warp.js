import { GameMode, system, world } from "@minecraft/server";
import { MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { addToTaxPool, getEconomySettings } from "./settings.js";
import { writeAuditLog } from "./audit.js";
import { addBalance, getBalance } from "./balance.js";
import { getMoolahPlayers } from "./players.js";

const MINECOIN_GLYPH = "\uE102";
const NETHER_COORDINATE_SCALE = 8;
const EMERGENCY_WARP_COOLDOWN_PROPERTY = "moolah:emergency_warp_last_ms";
const EMERGENCY_WARP_COOLDOWN_MS = 8 * 60 * 60 * 1000;
const EMERGENCY_WARP_COUNTDOWN_MS = 30 * 1000;
const EMERGENCY_WARP_MOVEMENT_LIMIT = 1.1;
const emergencyWarpSessions = new Map();

function goBack(onBack) {
  if (onBack) system.run(onBack);
}

function isAvailablePlayerWarpTarget(player) {
  try {
    return player.getGameMode() !== GameMode.Spectator;
  } catch {
    return false;
  }
}

function getWorldSpawnDestination() {
  const dimension = world.getDimension("overworld");
  const spawn = world.getDefaultSpawnLocation();
  let y = spawn.y;

  if (y < dimension.heightRange.min || y >= dimension.heightRange.max) {
    const topBlock = dimension.getTopmostBlock({ x: spawn.x, z: spawn.z });

    if (!topBlock) {
      throw new Error("The world spawn surface could not be resolved.");
    }
    y = topBlock.location.y + 1;
  }

  return {
    label: "Spawn",
    dimension,
    location: { x: spawn.x + 0.5, y, z: spawn.z + 0.5 },
  };
}

function getHomeDestination(player) {
  const spawnPoint = player.getSpawnPoint();

  if (!spawnPoint) return getWorldSpawnDestination();

  return {
    label: "Home",
    dimension: spawnPoint.dimension,
    location: {
      x: spawnPoint.x + 0.5,
      y: spawnPoint.y,
      z: spawnPoint.z + 0.5,
    },
  };
}

function getDimensionName(dimension) {
  return dimension.id.replace(/^minecraft:/, "");
}

function getEmergencyWarpCooldownRemaining(player, now = Date.now()) {
  const lastWarp = player.getDynamicProperty(EMERGENCY_WARP_COOLDOWN_PROPERTY);
  if (typeof lastWarp !== "number" || !Number.isFinite(lastWarp)) return 0;
  const elapsed = Math.max(0, now - lastWarp);
  return Math.max(0, EMERGENCY_WARP_COOLDOWN_MS - elapsed);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function cancelEmergencyWarp(player, reason) {
  if (!emergencyWarpSessions.delete(player.id)) return;
  const message = `Emergency Warp cancelled: ${reason}.`;
  player.onScreenDisplay.setActionBar(`§c${message}`);
  player.sendMessage(message);
}

function completeEmergencyWarp(player) {
  const session = emergencyWarpSessions.get(player.id);
  if (!session) return;
  emergencyWarpSessions.delete(player.id);

  let destination;
  let previousCooldown;
  try {
    destination = getWorldSpawnDestination();
    previousCooldown = player.getDynamicProperty(EMERGENCY_WARP_COOLDOWN_PROPERTY);
    player.setDynamicProperty(EMERGENCY_WARP_COOLDOWN_PROPERTY, Date.now());
  } catch (error) {
    console.error(`[Moolah] Emergency Warp could not start: ${error?.stack ?? error}`);
    player.onScreenDisplay.setActionBar("§cEmergency Warp failed.");
    player.sendMessage("Emergency Warp could not be completed. Your cooldown was not used.");
    return;
  }

  try {
    player.teleport(destination.location, { dimension: destination.dimension });
  } catch (error) {
    try {
      player.setDynamicProperty(EMERGENCY_WARP_COOLDOWN_PROPERTY, previousCooldown);
    } catch (rollbackError) {
      console.error(
        `[Moolah] Emergency Warp cooldown rollback failed: ${rollbackError?.stack ?? rollbackError}`,
      );
    }
    console.error(`[Moolah] Emergency Warp failed: ${error?.stack ?? error}`);
    player.onScreenDisplay.setActionBar("§cEmergency Warp failed.");
    player.sendMessage("Emergency Warp could not be completed. Your cooldown was not used.");
    return;
  }

  player.onScreenDisplay.setActionBar("§aEmergency Warp complete.");
  player.sendMessage("Emergency Warp complete. You have been sent to Spawn.");
  writeAuditLog(
    "warp",
    "Emergency Warp Completed",
    player,
    `Destination: Spawn; overworld at ${Math.floor(destination.location.x)}, ${Math.floor(destination.location.y)}, ${Math.floor(destination.location.z)}; cost 0 Moolah; cooldown 8 hours.`,
  );
}

function updateEmergencyWarps() {
  if (emergencyWarpSessions.size === 0) return;

  const playersById = new Map(
    getMoolahPlayers().map((player) => [player.id, player]),
  );
  const now = Date.now();

  for (const [playerId, session] of emergencyWarpSessions) {
    const player = playersById.get(playerId);
    if (!player) {
      emergencyWarpSessions.delete(playerId);
      continue;
    }

    const settings = getEconomySettings();
    if (!settings.allowWarp || !settings.enableEmergencyWarp) {
      cancelEmergencyWarp(player, "it was disabled by an admin");
      continue;
    }

    try {
      if (player.dimension.id !== session.dimensionId) {
        cancelEmergencyWarp(player, "you changed dimensions");
        continue;
      }
      if (player.isJumping) {
        cancelEmergencyWarp(player, "you jumped");
        continue;
      }

      const distance = Math.hypot(
        player.location.x - session.location.x,
        player.location.y - session.location.y,
        player.location.z - session.location.z,
      );
      if (distance > EMERGENCY_WARP_MOVEMENT_LIMIT) {
        cancelEmergencyWarp(player, "you moved too far");
        continue;
      }
    } catch (error) {
      console.warn(`[Moolah] Emergency Warp movement check failed: ${error?.stack ?? error}`);
      cancelEmergencyWarp(player, "your position could not be checked");
      continue;
    }

    const remainingMs = session.endsAt - now;
    if (remainingMs <= 0) {
      completeEmergencyWarp(player);
      continue;
    }

    const seconds = Math.ceil(remainingMs / 1000);
    if (seconds !== session.lastDisplayedSecond) {
      session.lastDisplayedSecond = seconds;
      player.onScreenDisplay.setActionBar(
        `§cEmergency Warp: §f${seconds}s §7— Do not move, jump, or take damage`,
      );
    }
  }
}

function startEmergencyWarp(player) {
  const settings = getEconomySettings();
  if (!settings.allowWarp || !settings.enableEmergencyWarp) {
    player.sendMessage("Emergency Warp is currently disabled.");
    return;
  }
  if (emergencyWarpSessions.has(player.id)) {
    player.sendMessage("Your Emergency Warp countdown is already running.");
    return;
  }

  let remainingCooldown;
  try {
    remainingCooldown = getEmergencyWarpCooldownRemaining(player);
  } catch (error) {
    console.error(`[Moolah] Emergency Warp cooldown check failed: ${error?.stack ?? error}`);
    player.sendMessage("Your Emergency Warp cooldown could not be checked.");
    return;
  }
  if (remainingCooldown > 0) {
    player.sendMessage(
      `Emergency Warp will be available again in ${formatDuration(remainingCooldown)}.`,
    );
    return;
  }

  const now = Date.now();
  emergencyWarpSessions.set(player.id, {
    dimensionId: player.dimension.id,
    location: { ...player.location },
    endsAt: now + EMERGENCY_WARP_COUNTDOWN_MS,
    lastDisplayedSecond: undefined,
  });
  player.sendMessage(
    "Emergency Warp started. Do not move more than one block, jump, or take damage for 30 seconds.",
  );
  updateEmergencyWarps();
}

function openEmergencyWarpWarning(player, onBack) {
  const settings = getEconomySettings();
  if (!settings.allowWarp || !settings.enableEmergencyWarp) {
    player.sendMessage("Emergency Warp is currently disabled.");
    goBack(onBack);
    return;
  }

  let remainingCooldown;
  try {
    remainingCooldown = getEmergencyWarpCooldownRemaining(player);
  } catch (error) {
    console.error(`[Moolah] Emergency Warp cooldown check failed: ${error?.stack ?? error}`);
    player.sendMessage("Your Emergency Warp cooldown could not be checked.");
    goBack(onBack);
    return;
  }
  if (remainingCooldown > 0) {
    player.sendMessage(
      `Emergency Warp will be available again in ${formatDuration(remainingCooldown)}.`,
    );
    goBack(onBack);
    return;
  }

  const form = new MessageFormData()
    .title("Emergency Warp")
    .body(
      "Emergency Warp is free and sends you to Spawn after 30 seconds.\n\n"
      + "Do not move more than one block, jump, or take any damage during the countdown. "
      + "Doing any of these cancels the warp.",
    )
    .button1("Start Emergency Warp")
    .button2("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      system.run(() => startEmergencyWarp(player));
    }
  }).catch(() => {
    player.sendMessage("The Emergency Warp warning could not be opened.");
  });
}

export function isEmergencyWarpActive(player) {
  return emergencyWarpSessions.has(player.id);
}

function isOverworldNetherWarp(sourceDimension, destinationDimension) {
  const dimensions = new Set([
    getDimensionName(sourceDimension),
    getDimensionName(destinationDimension),
  ]);

  return dimensions.size === 2
    && dimensions.has("overworld")
    && dimensions.has("nether");
}

function getOverworldScaledLocation(location, dimension) {
  if (getDimensionName(dimension) !== "nether") return location;

  return {
    x: location.x * NETHER_COORDINATE_SCALE,
    z: location.z * NETHER_COORDINATE_SCALE,
  };
}

function calculateWarpDetails(
  player,
  destination,
  rate,
  interdimensionalMultiplier,
  minCost,
  maxCost,
) {
  const usesOverworldScale = isOverworldNetherWarp(
    player.dimension,
    destination.dimension,
  );
  const sourceLocation = usesOverworldScale
    ? getOverworldScaledLocation(player.location, player.dimension)
    : player.location;
  const destinationLocation = usesOverworldScale
    ? getOverworldScaledLocation(destination.location, destination.dimension)
    : destination.location;
  const distance = Math.hypot(
    destinationLocation.x - sourceLocation.x,
    destinationLocation.z - sourceLocation.z,
  );
  const blocksCharged = Math.ceil(distance / 100);
  const isInterdimensional = player.dimension.id !== destination.dimension.id;
  const dimensionMultiplier = isInterdimensional ? interdimensionalMultiplier : 1;
  const uncappedCost = blocksCharged * rate * dimensionMultiplier;

  if (!Number.isFinite(uncappedCost)) return undefined;

  const minimumAdjustedCost = minCost === undefined
    ? uncappedCost
    : Math.max(uncappedCost, minCost);
  const cost = maxCost === undefined
    ? minimumAdjustedCost
    : Math.min(minimumAdjustedCost, maxCost);

  if (!Number.isSafeInteger(cost)) return undefined;

  return {
    distance,
    dimensionMultiplier,
    isInterdimensional,
    usesOverworldScale,
    uncappedCost,
    cost,
  };
}

function performWarp(player, destination, expectedCost) {
  if (!getEconomySettings().allowWarp) {
    player.sendMessage("Warp is currently disabled.");
    return;
  }

  const balance = getBalance(player);

  if (balance < expectedCost) {
    player.sendMessage(
      `You need ${MINECOIN_GLYPH}${expectedCost}, but your balance is ${MINECOIN_GLYPH}${balance}.`,
    );
    return;
  }

  if (expectedCost > 0) addBalance(player, -expectedCost);

  try {
    player.teleport(destination.location, { dimension: destination.dimension });
  } catch (error) {
    if (expectedCost > 0) addBalance(player, expectedCost);
    console.error(`[Moolah] Warp failed: ${error?.stack ?? error}`);
    player.sendMessage("The warp could not be completed. No funds were moved.");
    return;
  }

  addToTaxPool(expectedCost);
  player.sendMessage(
    `Warped to ${destination.label}${expectedCost > 0 ? ` for ${MINECOIN_GLYPH}${expectedCost}` : ""}.`,
  );
  writeAuditLog(
    "warp",
    "Warp Completed",
    player,
    `Destination: ${destination.label}; ${getDimensionName(destination.dimension)} at ${Math.floor(destination.location.x)}, ${Math.floor(destination.location.y)}, ${Math.floor(destination.location.z)}; cost ${expectedCost} Moolah.`,
  );
}

function openWarpConfirmation(player, destination, onBack) {
  const settings = getEconomySettings();

  if (!settings.allowWarp) {
    player.sendMessage("Warp is currently disabled.");
    goBack(onBack);
    return;
  }

  const details = calculateWarpDetails(
    player,
    destination,
    settings.warpCostPer100,
    settings.interdimensionalWarpMultiplier,
    settings.minWarpCost,
    settings.maxWarpCost,
  );

  if (!details) {
    player.sendMessage("That warp distance is too large to price safely.");
    goBack(onBack);
    return;
  }

  const dimensionText = details.isInterdimensional
    ? `\nDimension travel: ${details.dimensionMultiplier}x`
    : "";
  const distanceLabel = details.usesOverworldScale
    ? "Distance (Overworld scale)"
    : "Distance";
  const capText = settings.maxWarpCost === undefined
    ? ""
    : `\nMaximum cost: ${MINECOIN_GLYPH}${settings.maxWarpCost}`;
  const minimumText = settings.minWarpCost === undefined
    ? ""
    : `\nMinimum cost: ${MINECOIN_GLYPH}${settings.minWarpCost}`;
  const form = new MessageFormData()
    .title("Confirm Warp")
    .body(
      `Destination: ${destination.label}\n`
      + `${distanceLabel}: ${Math.ceil(details.distance)} blocks\n`
      + `Rate: ${MINECOIN_GLYPH}${settings.warpCostPer100} per 100 blocks`
      + `${dimensionText}${minimumText}${capText}\n`
      + `Total: ${MINECOIN_GLYPH}${details.cost}`,
    )
    .button1("Warp")
    .button2("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      performWarp(player, destination, details.cost);
    }
  }).catch(() => {
    player.sendMessage("The Warp confirmation could not be opened.");
  });
}

export function openWarpMenu(player, onBack) {
  const settings = getEconomySettings();
  if (!settings.allowWarp) {
    player.sendMessage("Warp is currently disabled.");
    goBack(onBack);
    return;
  }

  const targetPlayers = getMoolahPlayers().filter(
    (candidate) => (
      candidate.id !== player.id
      && isAvailablePlayerWarpTarget(candidate)
    ),
  );
  let showEmergencyWarp = false;
  if (settings.enableEmergencyWarp) {
    try {
      showEmergencyWarp = getEmergencyWarpCooldownRemaining(player) <= 0;
    } catch (error) {
      console.error(`[Moolah] Emergency Warp cooldown check failed: ${error?.stack ?? error}`);
    }
  }
  const options = [
    ...(showEmergencyWarp ? ["§cEmergency Warp§r"] : []),
    ...targetPlayers.map((candidate) => candidate.name),
    "Spawn",
    "Home",
  ];
  const form = new ModalFormData()
    .title("Warp")
    .dropdown("Destination", options, { defaultValueIndex: 0 })
    .submitButton("Warp");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }
    if (!response.formValues) return;

    const selection = response.formValues[0];

    if (typeof selection !== "number") {
      player.sendMessage("The Warp destination was invalid.");
      return;
    }

    system.run(() => {
      try {
        if (showEmergencyWarp && selection === 0) {
          openEmergencyWarpWarning(
            player,
            () => openWarpMenu(player, onBack),
          );
          return;
        }

        const destinationSelection = selection - (showEmergencyWarp ? 1 : 0);
        let destination;

        if (destinationSelection < targetPlayers.length) {
          const selectedPlayerId = targetPlayers[destinationSelection]?.id;
          const target = getMoolahPlayers().find(
            (candidate) => candidate.id === selectedPlayerId,
          );

          if (!target) {
            player.sendMessage("That player is no longer online.");
            return;
          }
          if (!isAvailablePlayerWarpTarget(target)) {
            player.sendMessage("That player is in Spectator mode and cannot be warped to.");
            return;
          }

          destination = {
            label: target.name,
            dimension: target.dimension,
            location: { ...target.location },
          };
        } else if (destinationSelection === targetPlayers.length) {
          destination = getWorldSpawnDestination();
        } else if (destinationSelection === targetPlayers.length + 1) {
          destination = getHomeDestination(player);
        }

        if (!destination) {
          player.sendMessage("The Warp destination was invalid.");
          return;
        }

        openWarpConfirmation(
          player,
          destination,
          () => openWarpMenu(player, onBack),
        );
      } catch (error) {
        console.error(`[Moolah] Could not resolve Warp destination: ${error?.stack ?? error}`);
        player.sendMessage("That Warp destination could not be resolved.");
      }
    });
  }).catch(() => {
    player.sendMessage("The Warp menu could not be opened.");
  });
}

world.afterEvents.entityHurt.subscribe((event) => {
  const player = event.hurtEntity;
  if (player.typeId !== "minecraft:player" || !emergencyWarpSessions.has(player.id)) return;
  cancelEmergencyWarp(player, "you took damage");
});

world.afterEvents.playerLeave.subscribe((event) => {
  emergencyWarpSessions.delete(event.playerId);
});

system.runInterval(updateEmergencyWarps, 1);
