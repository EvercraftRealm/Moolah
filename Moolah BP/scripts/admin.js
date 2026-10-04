import { system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import {
  getEconomySettings,
  getTaxPool,
  saveEconomySettings,
} from "./settings.js";

function goBack(onBack) {
  if (onBack) system.run(onBack);
}

function formatAmount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function openAdminMenu(player, onBack) {
  if (!player.hasTag("econ_admin")) {
    player.sendMessage("You do not have permission to configure the economy.");
    goBack(onBack);
    return;
  }

  const form = new ActionFormData()
    .title("Admin")
    .body("Choose a settings category.")
    .button("General")
    .button("Tax Policy")
    .button("Market")
    .button("Warp")
    .button("Misc");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) {
      goBack(onBack);
      return;
    }

    const returnToAdmin = () => openAdminMenu(player, onBack);

    if (response.selection === 0) {
      system.run(() => openGeneralAdminMenu(player, returnToAdmin));
    } else if (response.selection === 1) {
      system.run(() => openTaxPolicyAdminMenu(player, returnToAdmin));
    } else if (response.selection === 2) {
      system.run(() => openMarketAdminMenu(player, returnToAdmin));
    } else if (response.selection === 3) {
      system.run(() => openWarpAdminMenu(player, returnToAdmin));
    } else if (response.selection === 4) {
      system.run(() => openMiscAdminMenu(player, returnToAdmin));
    }
  }).catch(() => {
    player.sendMessage("The Admin menu could not be opened.");
  });
}

function canConfigureEconomy(player, onBack) {
  if (player.hasTag("econ_admin")) return true;

  player.sendMessage("You no longer have permission to configure the economy.");
  goBack(onBack);
  return false;
}

function saveAdminSettings(partialSettings) {
  saveEconomySettings({
    ...getEconomySettings(),
    ...partialSettings,
  });
}

function openGeneralAdminMenu(player, onBack) {
  if (!canConfigureEconomy(player, onBack)) return;

  const settings = getEconomySettings();
  const form = new ModalFormData()
    .title("General")
    .toggle("Allow Deposit", { defaultValue: settings.allowDeposit })
    .toggle("Allow Withdraw", { defaultValue: settings.allowWithdraw })
    .toggle("Allow Transfer", { defaultValue: settings.allowTransfer })
    .toggle("Allow Mail", { defaultValue: settings.allowMail })
    .submitButton("Save General Settings");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }
    if (!response.formValues || !canConfigureEconomy(player, onBack)) return;

    const [allowDeposit, allowWithdraw, allowTransfer, allowMail] = response.formValues;

    if (![allowDeposit, allowWithdraw, allowTransfer, allowMail]
      .every((value) => typeof value === "boolean")) {
      player.sendMessage("The General settings were invalid.");
      return;
    }

    saveAdminSettings({ allowDeposit, allowWithdraw, allowTransfer, allowMail });
    player.sendMessage("General settings saved.");
    goBack(onBack);
  }).catch(() => {
    player.sendMessage("The General menu could not be opened.");
  });
}

function openTaxPolicyAdminMenu(player, onBack) {
  if (!canConfigureEconomy(player, onBack)) return;

  const settings = getEconomySettings();
  const form = new ModalFormData()
    .title("Tax Policy")
    .label(`Tax Pool: \uE102${formatAmount(getTaxPool())}`)
    .textField("Death Tax", "Flat fee (0 or more)", {
      defaultValue: String(settings.deathTax),
    })
    .textField("Death Tax Cooldown", "Minutes (0 or more)", {
      defaultValue: String(settings.deathTaxCooldownMinutes),
    })
    .slider("Transfer Tax Rate (percent)", 0, 100, {
      defaultValue: settings.transferTaxRate,
      valueStep: 1,
    })
    .slider("Withdrawal Tax Rate (percent)", 0, 100, {
      defaultValue: settings.withdrawTaxRate,
      valueStep: 1,
    })
    .slider("Market Tax Rate (percent)", 0, 100, {
      defaultValue: settings.marketTaxRate,
      valueStep: 1,
    })
    .toggle("Distribute Taxes", { defaultValue: settings.distributeTaxes })
    .textField("Max Tax Refund", "0 or more", {
      defaultValue: String(settings.maxTaxRefund),
    })
    .submitButton("Save Tax Policy");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }
    if (!response.formValues || !canConfigureEconomy(player, onBack)) return;

    const [
      ,
      deathTaxValue,
      deathTaxCooldownValue,
      transferTaxRate,
      withdrawTaxRate,
      marketTaxRate,
      distributeTaxes,
      maxTaxRefundValue,
    ] = response.formValues;
    const rates = [transferTaxRate, withdrawTaxRate, marketTaxRate];
    const deathTaxText = typeof deathTaxValue === "string"
      ? deathTaxValue.trim()
      : "";
    const deathTaxCooldownText = typeof deathTaxCooldownValue === "string"
      ? deathTaxCooldownValue.trim()
      : "";
    const deathTax = Number(deathTaxText);
    const deathTaxCooldownMinutes = Number(deathTaxCooldownText);
    const maxTaxRefundText = typeof maxTaxRefundValue === "string"
      ? maxTaxRefundValue.trim()
      : "";
    const maxTaxRefund = Number(maxTaxRefundText);

    if (
      !rates.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
      || typeof distributeTaxes !== "boolean"
      || !/^\d+$/.test(deathTaxText)
      || !Number.isSafeInteger(deathTax)
      || !/^\d+$/.test(deathTaxCooldownText)
      || !Number.isSafeInteger(deathTaxCooldownMinutes)
      || !/^\d+$/.test(maxTaxRefundText)
      || !Number.isSafeInteger(maxTaxRefund)
    ) {
      player.sendMessage("The Tax Policy settings were invalid.");
      return;
    }

    saveAdminSettings({
      transferTaxRate,
      withdrawTaxRate,
      marketTaxRate,
      deathTax,
      deathTaxCooldownMinutes,
      distributeTaxes,
      maxTaxRefund,
    });
    player.sendMessage("Tax Policy saved.");
    goBack(onBack);
  }).catch(() => {
    player.sendMessage("The Tax Policy menu could not be opened.");
  });
}

function openMarketAdminMenu(player, onBack) {
  if (!canConfigureEconomy(player, onBack)) return;

  const settings = getEconomySettings();
  const form = new ModalFormData()
    .title("Market")
    .toggle("Allow Market", { defaultValue: settings.allowMarket })
    .slider("Max Market Listings (per player)", 1, 10, {
      defaultValue: settings.maxMarketListings,
      valueStep: 1,
    })
    .textField("Listing Fee (Moolah)", "0 or more", {
      defaultValue: String(settings.listingFee),
    })
    .toggle("Refund Cancelled Listing Fees", {
      defaultValue: settings.refundCanceledListingFees,
    })
    .submitButton("Save Market Settings");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }
    if (!response.formValues || !canConfigureEconomy(player, onBack)) return;

    const [
      allowMarket,
      maxMarketListings,
      listingFeeValue,
      refundCanceledListingFees,
    ] = response.formValues;
    const listingFeeText = typeof listingFeeValue === "string"
      ? listingFeeValue.trim()
      : "";
    const listingFee = Number(listingFeeText);

    if (
      typeof allowMarket !== "boolean"
      || typeof refundCanceledListingFees !== "boolean"
      || !/^\d+$/.test(listingFeeText)
      || !Number.isSafeInteger(listingFee)
      || !Number.isSafeInteger(maxMarketListings)
      || maxMarketListings < 1
      || maxMarketListings > 10
    ) {
      player.sendMessage("The Market settings were invalid.");
      return;
    }

    saveAdminSettings({
      allowMarket,
      listingFee,
      maxMarketListings,
      refundCanceledListingFees,
    });
    player.sendMessage("Market settings saved.");
    goBack(onBack);
  }).catch(() => {
    player.sendMessage("The Market settings menu could not be opened.");
  });
}

function openMiscAdminMenu(player, onBack) {
  if (!canConfigureEconomy(player, onBack)) return;

  const settings = getEconomySettings();
  const form = new ModalFormData()
    .title("Misc")
    .toggle("Allow Transfer Desc.", {
      defaultValue: settings.allowTransferDescriptions,
    })
    .textField("Postage Cost (Moolah)", "0 or more", {
      defaultValue: String(settings.postageCost),
    })
    .toggle("Refund Cancelled Mail Postage", {
      defaultValue: settings.refundCanceledPostage,
    })
    .submitButton("Save Misc Settings");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }
    if (!response.formValues || !canConfigureEconomy(player, onBack)) return;

    const [
      allowTransferDescriptions,
      postageCostValue,
      refundCanceledPostage,
    ] = response.formValues;
    const postageCostText = typeof postageCostValue === "string"
      ? postageCostValue.trim()
      : "";
    const postageCost = Number(postageCostText);
    if (
      typeof allowTransferDescriptions !== "boolean"
      || typeof refundCanceledPostage !== "boolean"
      || !/^\d+$/.test(postageCostText)
      || !Number.isSafeInteger(postageCost)
    ) {
      player.sendMessage("The Misc settings were invalid.");
      return;
    }

    saveAdminSettings({
      allowTransferDescriptions,
      postageCost,
      refundCanceledPostage,
    });
    player.sendMessage("Misc settings saved.");
    goBack(onBack);
  }).catch(() => {
    player.sendMessage("The Misc menu could not be opened.");
  });
}

function openWarpAdminMenu(player, onBack) {
  if (!canConfigureEconomy(player, onBack)) return;

  const settings = getEconomySettings();
  const form = new ModalFormData()
    .title("Warp")
    .toggle("Allow Warp", { defaultValue: settings.allowWarp })
    .textField("Warp Cost (per 100 blocks)", "0 or more", {
      defaultValue: String(settings.warpCostPer100),
    })
    .slider("Interdimensional Multiplier", 1, 5, {
      defaultValue: settings.interdimensionalWarpMultiplier,
      valueStep: 1,
    })
    .textField("Minimum Warp Cost", "Blank for no minimum", {
      defaultValue: settings.minWarpCost === undefined
        ? ""
        : String(settings.minWarpCost),
    })
    .textField("Max Warp Cost", "Blank for no cap", {
      defaultValue: settings.maxWarpCost === undefined
        ? ""
        : String(settings.maxWarpCost),
    })
    .submitButton("Save Warp Settings");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }
    if (!response.formValues || !canConfigureEconomy(player, onBack)) return;

    const [
      allowWarp,
      warpCostValue,
      interdimensionalWarpMultiplier,
      minWarpCostValue,
      maxWarpCostValue,
    ] = response.formValues;
    const warpCostText = typeof warpCostValue === "string"
      ? warpCostValue.trim()
      : "";
    const maxWarpCostText = typeof maxWarpCostValue === "string"
      ? maxWarpCostValue.trim()
      : "";
    const minWarpCostText = typeof minWarpCostValue === "string"
      ? minWarpCostValue.trim()
      : "";
    const warpCostPer100 = Number(warpCostText);
    const minWarpCost = minWarpCostText === ""
      ? undefined
      : Number(minWarpCostText);
    const maxWarpCost = maxWarpCostText === ""
      ? undefined
      : Number(maxWarpCostText);

    if (
      typeof allowWarp !== "boolean"
      || !/^\d+$/.test(warpCostText)
      || !Number.isSafeInteger(warpCostPer100)
      || !Number.isSafeInteger(interdimensionalWarpMultiplier)
      || interdimensionalWarpMultiplier < 1
      || interdimensionalWarpMultiplier > 5
      || (
        minWarpCost !== undefined
        && (!/^\d+$/.test(minWarpCostText) || !Number.isSafeInteger(minWarpCost))
      )
      || (
        maxWarpCost !== undefined
        && (!/^\d+$/.test(maxWarpCostText) || !Number.isSafeInteger(maxWarpCost))
      )
      || (
        minWarpCost !== undefined
        && maxWarpCost !== undefined
        && minWarpCost > maxWarpCost
      )
    ) {
      player.sendMessage("The Warp settings were invalid.");
      return;
    }

    saveAdminSettings({
      allowWarp,
      warpCostPer100,
      interdimensionalWarpMultiplier,
      minWarpCost,
      maxWarpCost,
    });
    player.sendMessage("Warp settings saved.");
    goBack(onBack);
  }).catch(() => {
    player.sendMessage("The Warp settings menu could not be opened.");
  });
}
