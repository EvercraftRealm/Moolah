import { world } from "@minecraft/server";

const SETTINGS_PROPERTY = "moolah:economy_settings";
const TAX_POOL_PROPERTY = "moolah:tax_pool";

export const DEFAULT_ECONOMY_SETTINGS = Object.freeze({
  allowDeposit: true,
  allowWithdraw: true,
  allowTransfer: true,
  allowTransferDescriptions: true,
  allowMail: true,
  allowMarket: true,
  allowWarp: false,
  transferTaxRate: 0,
  withdrawTaxRate: 10,
  marketTaxRate: 10,
  deathTax: 0,
  deathTaxCooldownMinutes: 60,
  maxTaxRefund: 100,
  listingFee: 10,
  maxMarketListings: 3,
  refundCanceledListingFees: false,
  postageCost: 5,
  refundCanceledPostage: true,
  warpCostPer100: 10,
  interdimensionalWarpMultiplier: 2,
  minWarpCost: undefined,
  maxWarpCost: undefined,
  distributeTaxes: false,
});

export function getEconomySettings() {
  const value = world.getDynamicProperty(SETTINGS_PROPERTY);

  if (typeof value !== "string") return { ...DEFAULT_ECONOMY_SETTINGS };

  try {
    const stored = JSON.parse(value);
    const settings = { ...DEFAULT_ECONOMY_SETTINGS };

    for (const key of [
      "allowDeposit",
      "allowWithdraw",
      "allowTransfer",
      "allowTransferDescriptions",
      "allowMail",
      "allowMarket",
      "allowWarp",
      "refundCanceledListingFees",
      "refundCanceledPostage",
      "distributeTaxes",
    ]) {
      if (typeof stored[key] === "boolean") settings[key] = stored[key];
    }

    for (const key of [
      "transferTaxRate",
      "withdrawTaxRate",
      "marketTaxRate",
    ]) {
      if (
        Number.isFinite(stored[key])
        && stored[key] >= 0
        && stored[key] <= 100
      ) {
        settings[key] = stored[key];
      }
    }

    if (
      Number.isSafeInteger(stored.deathTax)
      && stored.deathTax >= 0
    ) {
      settings.deathTax = stored.deathTax;
    }

    if (
      Number.isSafeInteger(stored.deathTaxCooldownMinutes)
      && stored.deathTaxCooldownMinutes >= 0
    ) {
      settings.deathTaxCooldownMinutes = stored.deathTaxCooldownMinutes;
    }

    if (
      Number.isSafeInteger(stored.maxTaxRefund)
      && stored.maxTaxRefund >= 0
    ) {
      settings.maxTaxRefund = stored.maxTaxRefund;
    }

    if (
      Number.isSafeInteger(stored.listingFee)
      && stored.listingFee >= 0
    ) {
      settings.listingFee = stored.listingFee;
    }

    if (
      Number.isSafeInteger(stored.maxMarketListings)
      && stored.maxMarketListings >= 1
      && stored.maxMarketListings <= 10
    ) {
      settings.maxMarketListings = stored.maxMarketListings;
    }

    if (
      Number.isSafeInteger(stored.postageCost)
      && stored.postageCost >= 0
    ) {
      settings.postageCost = stored.postageCost;
    }

    if (
      Number.isSafeInteger(stored.warpCostPer100)
      && stored.warpCostPer100 >= 0
    ) {
      settings.warpCostPer100 = stored.warpCostPer100;
    }

    if (
      Number.isSafeInteger(stored.interdimensionalWarpMultiplier)
      && stored.interdimensionalWarpMultiplier >= 1
      && stored.interdimensionalWarpMultiplier <= 5
    ) {
      settings.interdimensionalWarpMultiplier = stored.interdimensionalWarpMultiplier;
    }

    if (
      Number.isSafeInteger(stored.minWarpCost)
      && stored.minWarpCost >= 0
    ) {
      settings.minWarpCost = stored.minWarpCost;
    }

    if (
      Number.isSafeInteger(stored.maxWarpCost)
      && stored.maxWarpCost >= 0
    ) {
      settings.maxWarpCost = stored.maxWarpCost;
    }

    return settings;
  } catch {
    return { ...DEFAULT_ECONOMY_SETTINGS };
  }
}

export function saveEconomySettings(settings) {
  world.setDynamicProperty(SETTINGS_PROPERTY, JSON.stringify(settings));
}

export function calculateTax(amount, taxRate) {
  return Math.ceil(amount * taxRate / 100);
}

export function getTaxPool() {
  const value = world.getDynamicProperty(TAX_POOL_PROPERTY);

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function setTaxPool(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("The Tax Pool must be a non-negative safe integer.");
  }

  world.setDynamicProperty(TAX_POOL_PROPERTY, amount);
}

export function addToTaxPool(amount) {
  if (amount <= 0) return;

  const newTotal = getTaxPool() + amount;

  if (!Number.isSafeInteger(newTotal)) {
    console.error("[Moolah] Tax Pool exceeded the safe integer limit.");
    return;
  }

  setTaxPool(newTotal);
}
