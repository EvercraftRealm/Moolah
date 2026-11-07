import { system, world } from "@minecraft/server";
import { writeAuditLog } from "./audit.js";
import { getEconomySettings, getTaxPool, setTaxPool } from "./settings.js";
import {
  getMoolahPlayers,
  getMoolahPlayerSnapshot,
} from "./players.js";

const LAST_KNOWN_BALANCE_PROPERTY = "moolah:last_known_balance";
const BALANCE_MONITOR_INTERVAL_TICKS = 20;
const knownBalances = new Map();
const monitorWarnings = new Set();
const monitoredPlayerIds = new Set();
let monitorInitialized = false;

export function getCurrencyObjective() {
  return world.scoreboard.getObjective("moolah")
    ?? world.scoreboard.addObjective("moolah", "Moolah");
}

function getScoreboardIdentity(player) {
  try {
    return player.scoreboardIdentity;
  } catch {
    return undefined;
  }
}

function readBalance(objective, player) {
  const identity = getScoreboardIdentity(player);
  if (!identity) return undefined;
  return objective.hasParticipant(identity)
    ? objective.getScore(identity) ?? 0
    : 0;
}

export function getBalance(player) {
  try {
    if (!getMoolahPlayerSnapshot(player)) return 0;
    return readBalance(getCurrencyObjective(), player) ?? 0;
  } catch {
    return 0;
  }
}

function getKnownBalance(player, playerId) {
  if (knownBalances.has(playerId)) return knownBalances.get(playerId);

  try {
    const saved = player.getDynamicProperty(LAST_KNOWN_BALANCE_PROPERTY);
    return Number.isSafeInteger(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

function rememberBalance(player, identity, balance) {
  knownBalances.set(identity.id, balance);

  try {
    player.setDynamicProperty(LAST_KNOWN_BALANCE_PROPERTY, balance);
  } catch (error) {
    console.warn(
      `[Moolah] Could not save the tracked balance for ${identity.name}: ${error?.stack ?? error}`,
    );
  }
}

function reconcileBalance(player, identity, currentBalance, collectExternalCharges) {
  const previousBalance = getKnownBalance(player, identity.id);

  if (previousBalance === undefined) {
    rememberBalance(player, identity, currentBalance);
    return;
  }

  if (collectExternalCharges && currentBalance < previousBalance) {
    const externalCharge = previousBalance - currentBalance;
    const previousPool = getTaxPool();
    const nextPool = previousPool + externalCharge;

    if (!Number.isSafeInteger(nextPool)) {
      console.error(
        `[Moolah] The Tax Pool could not accept an external charge of ${externalCharge} from ${identity.name}.`,
      );
    } else {
      try {
        setTaxPool(nextPool);
        writeAuditLog(
          "admin",
          "External Charge Collected",
          identity.name,
          `${externalCharge} Moolah moved to the Tax Pool after an external scoreboard decrease from ${previousBalance} to ${currentBalance}.`,
        );
      } catch (error) {
        console.error(
          `[Moolah] Could not collect an external charge from ${identity.name}: ${error?.stack ?? error}`,
        );
      }
    }
  }

  if (currentBalance !== previousBalance) {
    rememberBalance(player, identity, currentBalance);
  }
}

function reconcileBeforeMoolahWrite(player, objective) {
  const identity = getMoolahPlayerSnapshot(player);
  if (!identity) return;
  const currentBalance = readBalance(objective, player);
  if (currentBalance === undefined) return;
  reconcileBalance(
    player,
    identity,
    currentBalance,
    getEconomySettings().sendExternalChargesToTaxPool
      && monitoredPlayerIds.has(identity.id),
  );
  monitoredPlayerIds.add(identity.id);
}

export function addBalance(player, amount) {
  const identity = getMoolahPlayerSnapshot(player);
  if (!identity) throw new Error("The player's balance is no longer available.");
  const objective = getCurrencyObjective();
  reconcileBeforeMoolahWrite(player, objective);
  const balance = objective.addScore(getScoreboardIdentity(player) ?? player, amount);
  rememberBalance(player, identity, balance);
  monitoredPlayerIds.add(identity.id);
  return balance;
}

export function setBalance(player, amount) {
  const identity = getMoolahPlayerSnapshot(player);
  if (!identity) throw new Error("The player's balance is no longer available.");
  const objective = getCurrencyObjective();
  reconcileBeforeMoolahWrite(player, objective);
  objective.setScore(getScoreboardIdentity(player) ?? player, amount);
  rememberBalance(player, identity, amount);
  monitoredPlayerIds.add(identity.id);
}

function monitorExternalBalanceChanges() {
  const collectExternalCharges = getEconomySettings().sendExternalChargesToTaxPool;
  if (!collectExternalCharges) {
    monitoredPlayerIds.clear();
    monitorWarnings.clear();
    return;
  }

  const onlinePlayerIds = new Set();
  let objective;

  try {
    objective = getCurrencyObjective();
  } catch (error) {
    console.warn(`[Moolah] Could not access the balance scoreboard: ${error?.stack ?? error}`);
    return;
  }

  for (const player of getMoolahPlayers()) {
    const identity = getMoolahPlayerSnapshot(player);
    if (!identity) continue;
    onlinePlayerIds.add(identity.id);

    try {
      const currentBalance = readBalance(objective, player);
      if (currentBalance === undefined) {
        monitorWarnings.delete(identity.id);
        continue;
      }
      reconcileBalance(
        player,
        identity,
        currentBalance,
        monitoredPlayerIds.has(identity.id),
      );
      monitoredPlayerIds.add(identity.id);
      monitorWarnings.delete(identity.id);
    } catch (error) {
      if (!monitorWarnings.has(identity.id)) {
        monitorWarnings.add(identity.id);
        console.warn(
          `[Moolah] Could not monitor the balance for ${identity.name}: ${error?.stack ?? error}`,
        );
      }
    }
  }

  for (const playerId of knownBalances.keys()) {
    if (!onlinePlayerIds.has(playerId)) knownBalances.delete(playerId);
  }
  for (const playerId of monitorWarnings) {
    if (!onlinePlayerIds.has(playerId)) monitorWarnings.delete(playerId);
  }
}

export function initializeBalanceMonitor() {
  if (monitorInitialized) return;
  monitorInitialized = true;
  system.runInterval(monitorExternalBalanceChanges, BALANCE_MONITOR_INTERVAL_TICKS);
}

world.afterEvents.playerLeave.subscribe((event) => {
  knownBalances.delete(event.playerId);
  monitorWarnings.delete(event.playerId);
  monitoredPlayerIds.delete(event.playerId);
});
