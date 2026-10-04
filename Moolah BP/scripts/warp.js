import { system, world } from "@minecraft/server";
import { MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { addToTaxPool, getEconomySettings } from "./settings.js";

const MINECOIN_GLYPH = "\uE102";
const NETHER_COORDINATE_SCALE = 8;

function goBack(onBack) {
  if (onBack) system.run(onBack);
}

function getCurrencyObjective() {
  return world.scoreboard.getObjective("moolah")
    ?? world.scoreboard.addObjective("moolah", "Moolah");
}

function getBalance(player) {
  try {
    return getCurrencyObjective().getScore(player) ?? 0;
  } catch {
    return 0;
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

  const objective = getCurrencyObjective();
  const balance = getBalance(player);

  if (balance < expectedCost) {
    player.sendMessage(
      `You need ${MINECOIN_GLYPH}${expectedCost}, but your balance is ${MINECOIN_GLYPH}${balance}.`,
    );
    return;
  }

  if (expectedCost > 0) objective.addScore(player, -expectedCost);

  try {
    player.teleport(destination.location, { dimension: destination.dimension });
  } catch (error) {
    if (expectedCost > 0) objective.addScore(player, expectedCost);
    console.error(`[Moolah] Warp failed: ${error?.stack ?? error}`);
    player.sendMessage("The warp could not be completed. No funds were moved.");
    return;
  }

  addToTaxPool(expectedCost);
  player.sendMessage(
    `Warped to ${destination.label}${expectedCost > 0 ? ` for ${MINECOIN_GLYPH}${expectedCost}` : ""}.`,
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
  if (!getEconomySettings().allowWarp) {
    player.sendMessage("Warp is currently disabled.");
    goBack(onBack);
    return;
  }

  const targetPlayers = world.getPlayers().filter(
    (candidate) => candidate.id !== player.id,
  );
  const options = [
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
        let destination;

        if (selection < targetPlayers.length) {
          const selectedPlayerId = targetPlayers[selection]?.id;
          const target = world.getPlayers().find(
            (candidate) => candidate.id === selectedPlayerId,
          );

          if (!target) {
            player.sendMessage("That player is no longer online.");
            return;
          }

          destination = {
            label: target.name,
            dimension: target.dimension,
            location: { ...target.location },
          };
        } else if (selection === targetPlayers.length) {
          destination = getWorldSpawnDestination();
        } else if (selection === targetPlayers.length + 1) {
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
