import { system, world } from "@minecraft/server";
import { writeAuditLog } from "./audit.js";
import { getEconomySettings, getTaxPool, setTaxPool } from "./settings.js";

const LAST_KNOWN_BALANCE_PROPERTY = "moolah:last_known_balance";
const knownBalances = new Map();
let monitorInitialized = false;

export function getCurrencyObjective() {
  return world.scoreboard.getObjective("moolah")
    ?? world.scoreboard.addObjective("moolah", "Moolah");
}

export function getBalance(player) {
  try {
    return getCurrencyObjective().getScore(player) ?? 0;
  } catch {
    return 0;
  }
}

function getKnownBalance(player) {
  if (knownBalances.has(player.id)) return knownBalances.get(player.id);

  try {
    const saved = player.getDynamicProperty(LAST_KNOWN_BALANCE_PROPERTY);
    return Number.isSafeInteger(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

function rememberBalance(player, balance) {
  knownBalances.set(player.id, balance);

  try {
    player.setDynamicProperty(LAST_KNOWN_BALANCE_PROPERTY, balance);
  } catch (error) {
    console.warn(
      `[Moolah] Could not save the tracked balance for ${player.name}: ${error?.stack ?? error}`,
    );
  }
}

function reconcileBalance(player, currentBalance, collectExternalCharges) {
  const previousBalance = getKnownBalance(player);

  if (previousBalance === undefined) {
    rememberBalance(player, currentBalance);
    return;
  }

  if (collectExternalCharges && currentBalance < previousBalance) {
    const externalCharge = previousBalance - currentBalance;
    const previousPool = getTaxPool();
    const nextPool = previousPool + externalCharge;

    if (!Number.isSafeInteger(nextPool)) {
      console.error(
        `[Moolah] The Tax Pool could not accept an external charge of ${externalCharge} from ${player.name}.`,
      );
    } else {
      try {
        setTaxPool(nextPool);
        writeAuditLog(
          "admin",
          "External Charge Collected",
          player,
          `${externalCharge} Moolah moved to the Tax Pool after an external scoreboard decrease from ${previousBalance} to ${currentBalance}.`,
        );
      } catch (error) {
        console.error(
          `[Moolah] Could not collect an external charge from ${player.name}: ${error?.stack ?? error}`,
        );
      }
    }
  }

  if (currentBalance !== previousBalance) rememberBalance(player, currentBalance);
}

function reconcileBeforeMoolahWrite(player, objective) {
  const currentBalance = objective.getScore(player) ?? 0;
  reconcileBalance(
    player,
    currentBalance,
    getEconomySettings().sendExternalChargesToTaxPool,
  );
}

export function addBalance(player, amount) {
  const objective = getCurrencyObjective();
  reconcileBeforeMoolahWrite(player, objective);
  const balance = objective.addScore(player, amount);
  rememberBalance(player, balance);
  return balance;
}

export function setBalance(player, amount) {
  const objective = getCurrencyObjective();
  reconcileBeforeMoolahWrite(player, objective);
  objective.setScore(player, amount);
  rememberBalance(player, amount);
}

function monitorExternalBalanceChanges() {
  const onlinePlayerIds = new Set();
  const collectExternalCharges = getEconomySettings().sendExternalChargesToTaxPool;
  let objective;

  try {
    objective = getCurrencyObjective();
  } catch (error) {
    console.warn(`[Moolah] Could not access the balance scoreboard: ${error?.stack ?? error}`);
    return;
  }

  for (const player of world.getPlayers()) {
    onlinePlayerIds.add(player.id);

    try {
      reconcileBalance(
        player,
        objective.getScore(player) ?? 0,
        collectExternalCharges,
      );
    } catch (error) {
      console.warn(
        `[Moolah] Could not monitor the balance for ${player.name}: ${error?.stack ?? error}`,
      );
    }
  }

  for (const playerId of knownBalances.keys()) {
    if (!onlinePlayerIds.has(playerId)) knownBalances.delete(playerId);
  }
}

export function initializeBalanceMonitor() {
  if (monitorInitialized) return;
  monitorInitialized = true;
  system.runInterval(monitorExternalBalanceChanges, 1);
}
