import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandSource,
  CustomCommandStatus,
  system,
  world,
} from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import {
  createListingFromCommand,
  getMarketNotificationCounts,
  openAddListingMenu,
  openMarket,
  openBrowseListings,
} from "./market.js";
import { openAdminMenu } from "./admin.js";
import { openWarpMenu } from "./warp.js";
import { giveFirstJoinGuide } from "./guide.js";
import {
  createSystemInboxMail,
  createSystemInboxPayment,
  confirmMaximumWithdrawal,
  confirmWithdrawal,
  decorateQuickPaySign,
  depositAllDiamonds,
  depositDiamonds,
  getEscrowPayments,
  getPaymentCounts,
  openDepositMenu,
  openEscrowMenu,
  openInboxMenu,
  openMailMenu,
  openTransferMenu,
  openWithdrawMenu,
  readQuickPaySign,
  useQuickPaySign,
} from "./bank.js";
import {
  getEconomySettings,
  getTaxPool,
  setTaxPool,
} from "./settings.js";

const MINECOIN_GLYPH = "\uE102";
const FIRST_ADMIN_PROPERTY = "moolah:first_admin_assigned";
const TAX_REFUND_TIME_PROPERTY = "moolah:tax_refund_time_ms";
const LAST_DEATH_TAX_PROPERTY = "moolah:last_death_tax_ms";
const TAX_REFUND_INTERVAL_MS = 60 * 60 * 1000;
const MINIMUM_DISTRIBUTION_POOL = 100;
const TAX_REFUND_AFK_MS = 5 * 60 * 1000;
const CAMERA_ACTIVITY_EPSILON = 0.1;
const BANK_ICON_ROOT = "textures/ui/moolah";
const playersShowingBalance = new Set();
const taxRefundSessions = new Map();

function sendLoginNotifications(player) {
  const payments = getEscrowPayments();
  const { inbox: inboxCount, pending: pendingCount } = getPaymentCounts(
    player,
    payments,
  );
  const marketCounts = getMarketNotificationCounts(player);

  if (
    inboxCount === 0
    && pendingCount === 0
    && marketCounts.unclaimed === 0
    && marketCounts.active === 0
  ) {
    return;
  }

  player.sendMessage("§d§lYour notifications§r");
  if (inboxCount > 0) {
    player.sendMessage(
      `§aInbox: ${inboxCount} incoming item${inboxCount === 1 ? "" : "s"}§r`,
    );
  }
  if (pendingCount > 0) {
    player.sendMessage(
      `§ePending: ${pendingCount} outgoing item${pendingCount === 1 ? "" : "s"}§r`,
    );
  }
  if (marketCounts.unclaimed > 0) {
    player.sendMessage(
      `§6Market proceeds: ${marketCounts.unclaimed} sold listing${marketCounts.unclaimed === 1 ? "" : "s"} ready to claim§r`,
    );
  }
  if (marketCounts.active > 0) {
    player.sendMessage(
      `§bActive listings: ${marketCounts.active} listing${marketCounts.active === 1 ? "" : "s"} for sale§r`,
    );
  }
}

function assignFirstEconomyAdmin(player) {
  if (world.getDynamicProperty(FIRST_ADMIN_PROPERTY) === true) return;

  try {
    player.addTag("econ_admin");
    world.setDynamicProperty(FIRST_ADMIN_PROPERTY, true);
    player.sendMessage(
      "You are the first player in this world and have been granted economy admin access.",
    );
  } catch (error) {
    console.error(
      `[Moolah] Could not assign the first economy admin: ${error?.stack ?? error}`,
    );
  }
}

function applyDeathTax(player) {
  const settings = getEconomySettings();

  if (settings.deathTax <= 0) return;

  const now = Date.now();
  const previousDeathTax = player.getDynamicProperty(LAST_DEATH_TAX_PROPERTY);
  const cooldownMs = settings.deathTaxCooldownMinutes * 60 * 1000;

  if (
    typeof previousDeathTax === "number"
    && now - previousDeathTax < cooldownMs
  ) {
    return;
  }

  const objective = getCurrencyObjective();
  const balance = getBalance(player);
  const charged = Math.min(settings.deathTax, balance);
  const previousPool = getTaxPool();

  try {
    if (charged > 0) {
      objective.addScore(player, -charged);
      setTaxPool(previousPool + charged);
    }

    const shortfall = settings.deathTax - charged;
    const message = `Death Tax\nCharged: ${MINECOIN_GLYPH}${charged}`
      + `${shortfall > 0 ? `\nUncollected: ${MINECOIN_GLYPH}${shortfall} (insufficient balance)` : ""}`;

    if (!createSystemInboxMail(player.name, message)) {
      throw new Error("The Death Tax notice could not be saved.");
    }

    player.setDynamicProperty(LAST_DEATH_TAX_PROPERTY, now);
  } catch (error) {
    if (charged > 0) {
      try {
        setTaxPool(previousPool);
        objective.addScore(player, charged);
      } catch (rollbackError) {
        console.error(
          `[Moolah] Death Tax rollback failed: ${rollbackError?.stack ?? rollbackError}`,
        );
      }
    }
    console.error(`[Moolah] Death Tax failed: ${error?.stack ?? error}`);
  }
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

function getInventory(player) {
  return player.getComponent("minecraft:inventory")?.container;
}

function getSavedTaxRefundTime(player) {
  const value = player.getDynamicProperty(TAX_REFUND_TIME_PROPERTY);

  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function awardTaxRefund(player) {
  const currentPool = getTaxPool();
  const maxTaxRefund = getEconomySettings().maxTaxRefund;

  if (currentPool < MINIMUM_DISTRIBUTION_POOL || maxTaxRefund <= 0) return false;

  const refund = Math.min(
    maxTaxRefund,
    Math.floor(currentPool * 0.01),
  );

  if (refund <= 0) return false;

  setTaxPool(currentPool - refund);

  try {
    if (!createSystemInboxPayment(player.name, refund, "Tax Return")) {
      throw new Error("The Tax Return payment could not be saved.");
    }
  } catch (error) {
    setTaxPool(currentPool);
    console.error(
      `[Moolah] Tax Refund failed: ${error?.stack ?? error}`,
    );
    return false;
  }

  return true;
}

function cameraMoved(previous, current) {
  return Math.abs(previous.x - current.x) >= CAMERA_ACTIVITY_EPSILON
    || Math.abs(previous.y - current.y) >= CAMERA_ACTIVITY_EPSILON;
}

function formatTaxRefundCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatMoolahAmount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function getTaxPoolMessage(player) {
  const settings = getEconomySettings();
  const currentPool = getTaxPool();
  const poolText = `There is ${formatMoolahAmount(currentPool)} Moolah `
    + "in the global Tax Pool.";

  if (!settings.distributeTaxes || settings.maxTaxRefund <= 0) {
    return `${poolText} Tax refunds are currently disabled by admin.`;
  }

  if (currentPool < MINIMUM_DISTRIBUTION_POOL) {
    return `${poolText} There is not sufficient Moolah in the Tax Pool `
      + "to process refunds.";
  }

  const estimatedRefund = Math.min(
    settings.maxTaxRefund,
    Math.floor(currentPool * 0.01),
  );
  const session = taxRefundSessions.get(player.id);
  const elapsed = session?.elapsed ?? getSavedTaxRefundTime(player);
  const remaining = Math.max(0, TAX_REFUND_INTERVAL_MS - elapsed);

  return `${poolText} Your next estimated Tax Return is `
    + `${formatMoolahAmount(estimatedRefund)} Moolah in `
    + `${formatTaxRefundCountdown(remaining)} of active online time.`;
}

function getTaxRefundTimerText(player, now) {
  const session = taxRefundSessions.get(player.id);

  if (!session) return "Refund: 60:00";

  if (now - session.lastCameraActivity >= TAX_REFUND_AFK_MS) {
    return "Refund: Paused";
  }

  const remaining = Math.max(0, TAX_REFUND_INTERVAL_MS - session.elapsed);

  if (remaining === 0 && getTaxPool() < MINIMUM_DISTRIBUTION_POOL) {
    return "Refund: Waiting";
  }

  return `Refund: ${formatTaxRefundCountdown(remaining)}`;
}

function updateTaxRefundTimers() {
  const now = Date.now();
  const settings = getEconomySettings();
  const onlinePlayerIds = new Set();

  for (const player of world.getPlayers()) {
    onlinePlayerIds.add(player.id);

    try {
      let session = taxRefundSessions.get(player.id);

      if (!session) {
        session = {
          elapsed: getSavedTaxRefundTime(player),
          lastUpdate: now,
          lastCameraActivity: now,
          rotation: player.getRotation(),
        };
        taxRefundSessions.set(player.id, session);
      }

      const rotation = player.getRotation();
      const wasAfk = now - session.lastCameraActivity >= TAX_REFUND_AFK_MS;

      if (cameraMoved(session.rotation, rotation)) {
        session.lastCameraActivity = now;
        session.rotation = rotation;
      }

      const isAfk = now - session.lastCameraActivity >= TAX_REFUND_AFK_MS;

      if (settings.distributeTaxes && !isAfk && !wasAfk) {
        session.elapsed += Math.max(0, now - session.lastUpdate);
      }
      session.lastUpdate = now;

      if (
        settings.distributeTaxes
        && !isAfk
        && session.elapsed >= TAX_REFUND_INTERVAL_MS
        && awardTaxRefund(player)
      ) {
        session.elapsed -= TAX_REFUND_INTERVAL_MS;
      }

      player.setDynamicProperty(TAX_REFUND_TIME_PROPERTY, session.elapsed);
    } catch (error) {
      console.error(
        `[Moolah] Could not update Tax Refund time for ${player.name}: ${error?.stack ?? error}`,
      );
    }
  }

  for (const playerId of taxRefundSessions.keys()) {
    if (!onlinePlayerIds.has(playerId)) taxRefundSessions.delete(playerId);
  }
}

function updateHeldDiamondBalances() {
  const onlinePlayerIds = new Set();
  const now = Date.now();
  const settings = getEconomySettings();

  for (const player of world.getPlayers()) {
    onlinePlayerIds.add(player.id);

    const inventory = getInventory(player);
    const heldItem = inventory?.getItem(player.selectedSlotIndex);
    const isHoldingDiamond = heldItem?.typeId === "minecraft:diamond";

    if (isHoldingDiamond) {
      const refundTimer = settings.distributeTaxes
        ? ` | ${getTaxRefundTimerText(player, now)}`
        : "";
      player.onScreenDisplay.setActionBar(
        `Balance: \uE102${getBalance(player)}${refundTimer}`,
      );
      playersShowingBalance.add(player.id);
    } else if (playersShowingBalance.delete(player.id)) {
      player.onScreenDisplay.setActionBar("");
    }
  }

  for (const playerId of playersShowingBalance) {
    if (!onlinePlayerIds.has(playerId)) {
      playersShowingBalance.delete(playerId);
    }
  }
}

function openShop(player) {
  const balance = getBalance(player);
  const settings = getEconomySettings();
  const { inbox: inboxCount, pending: pendingCount } = getPaymentCounts(player);
  const menuActions = [];
  const shopForm = new ActionFormData()
    .title("Moolah Menu")
    .body(`Balance: \uE102${balance}\n\nChoose an option:`);

  if (settings.allowDeposit) {
    shopForm.button("Deposit", `${BANK_ICON_ROOT}/deposit`);
    menuActions.push("deposit");
  }

  if (settings.allowWithdraw) {
    shopForm.button("Withdraw", `${BANK_ICON_ROOT}/withdraw`);
    menuActions.push("withdraw");
  }

  if (settings.allowTransfer) {
    shopForm.button("Transfer", `${BANK_ICON_ROOT}/transfer`);
    menuActions.push("transfer");
  }

  if (settings.allowMail) {
    shopForm.button("Mail", `${BANK_ICON_ROOT}/mail`);
    menuActions.push("mail");
  }

  if (settings.allowMarket) {
    shopForm.button("Market", `${BANK_ICON_ROOT}/market`);
    menuActions.push("market");
  }

  if (inboxCount > 0) {
    shopForm.button(`(${inboxCount}) Inbox`);
    menuActions.push("inbox");
  }

  if (pendingCount > 0) {
    shopForm.button(`(${pendingCount}) Pending`);
    menuActions.push("pending");
  }

  if (settings.allowWarp) {
    shopForm.button("Warp", `${BANK_ICON_ROOT}/warp`);
    menuActions.push("warp");
  }

  if (player.hasTag("econ_admin")) {
    shopForm.button("Admin", `${BANK_ICON_ROOT}/admin`);
    menuActions.push("admin");
  }

  shopForm.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) return;

    const action = menuActions[response.selection];
    const returnToShop = () => openShop(player);

    if (action === "deposit") {
      system.run(() => openDepositMenu(player, returnToShop));
    } else if (action === "withdraw") {
      system.run(() => openWithdrawMenu(player, returnToShop));
    } else if (action === "transfer") {
      system.run(() => openTransferMenu(player, returnToShop));
    } else if (action === "mail") {
      system.run(() => openMailMenu(player, returnToShop));
    } else if (action === "market") {
      system.run(() => openMarket(player, returnToShop));
    } else if (action === "admin") {
      system.run(() => openAdminMenu(player, returnToShop));
    } else if (action === "inbox") {
      system.run(() => openInboxMenu(player, returnToShop));
    } else if (action === "pending") {
      system.run(() => openEscrowMenu(player, returnToShop));
    } else if (action === "warp") {
      system.run(() => openWarpMenu(player, returnToShop));
    }
  }).catch(() => {
    player.sendMessage("The main menu could not be opened.");
  });
}

function playerCommand(callback) {
  return (origin, ...parameters) => {
    if (
      origin.sourceType !== CustomCommandSource.Entity
      || origin.sourceEntity?.typeId !== "minecraft:player"
    ) {
      return {
        status: CustomCommandStatus.Failure,
        message: "This command can only be used by a player.",
      };
    }

    return callback(origin.sourceEntity, ...parameters);
  };
}

system.beforeEvents.startup.subscribe((event) => {
  const commandRegistry = event.customCommandRegistry;

  commandRegistry.registerCommand(
    {
      name: "moolah:bank",
      description: "Open the Moolah main menu.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      system.run(() => openShop(player));

      return {
        status: CustomCommandStatus.Success,
      };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:taxes",
      description: "View the global Tax Pool and your estimated Tax Return.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => ({
      status: CustomCommandStatus.Success,
      message: getTaxPoolMessage(player),
    })),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:deposit",
      description: "Deposit diamonds: /deposit [0-1728] (0 = all).",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [
        {
          type: CustomCommandParamType.Integer,
          name: "amount",
        },
      ],
    },
    playerCommand((player, amountValue) => {
      if (!getEconomySettings().allowDeposit) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Deposits are currently disabled.",
        };
      }

      if (amountValue === undefined) {
        system.run(() => openDepositMenu(player));
        return { status: CustomCommandStatus.Success };
      }

      if (amountValue === 0) {
        system.run(() => depositAllDiamonds(player));
        return { status: CustomCommandStatus.Success };
      }

      const quantity = amountValue;

      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1728) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The deposit amount must be between 1 and 1728.",
        };
      }

      system.run(() => depositDiamonds(player, quantity));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:withdraw",
      description: "Withdraw diamonds: /withdraw [0-1728] (0 = all).",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [
        {
          type: CustomCommandParamType.Integer,
          name: "amount",
        },
      ],
    },
    playerCommand((player, amountValue) => {
      if (!getEconomySettings().allowWithdraw) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Withdrawals are currently disabled.",
        };
      }

      if (amountValue === undefined) {
        system.run(() => openWithdrawMenu(player));
        return { status: CustomCommandStatus.Success };
      }

      if (amountValue === 0) {
        system.run(() => confirmMaximumWithdrawal(player));
        return { status: CustomCommandStatus.Success };
      }

      const quantity = amountValue;

      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1728) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The withdrawal amount must be between 1 and 1728.",
        };
      }

      system.run(() => confirmWithdrawal(player, quantity));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:warp",
      description: "Open the paid Warp menu.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      if (!getEconomySettings().allowWarp) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Warp is currently disabled.",
        };
      }

      system.run(() => openWarpMenu(player));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:mail",
      description: "Open the Mail menu.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      if (!getEconomySettings().allowMail) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Mail is currently disabled.",
        };
      }

      system.run(() => openMailMenu(player));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:inbox",
      description: "Open your incoming payments and mail.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      system.run(() => openInboxMenu(player));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:pending",
      description: "Open your outgoing pending items.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      system.run(() => openEscrowMenu(player));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:pay",
      description: "Transfer a Moolah payment.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [
        {
          type: CustomCommandParamType.String,
          name: "recipient",
        },
        {
          type: CustomCommandParamType.Integer,
          name: "amount",
        },
        {
          type: CustomCommandParamType.String,
          name: "message",
        },
      ],
    },
    playerCommand((sender, recipientValue, amount, messageValue) => {
      const settings = getEconomySettings();

      if (!settings.allowTransfer) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Transfers are currently disabled.",
        };
      }

      if (recipientValue === undefined) {
        system.run(() => openTransferMenu(sender));
        return { status: CustomCommandStatus.Success };
      }

      if (amount === undefined) {
        return {
          status: CustomCommandStatus.Failure,
          message: settings.allowTransferDescriptions
            ? 'Usage: /pay <recipient> <amount> ["message"]'
            : "Usage: /pay <recipient> <amount>",
        };
      }

      if (!settings.allowTransferDescriptions && messageValue !== undefined) {
        return {
          status: CustomCommandStatus.Failure,
          message: "Transfer descriptions are currently disabled.",
        };
      }

      const recipient = recipientValue.trim();
      const message = (messageValue ?? "").trim();
      if (!recipient) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The recipient name cannot be empty.",
        };
      }
      if (recipient.toLowerCase() === sender.name.toLowerCase()) {
        return {
          status: CustomCommandStatus.Failure,
          message: "You cannot send a payment to yourself.",
        };
      }
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The amount must be a positive whole number.",
        };
      }
      if (message.length > 64) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The transfer description cannot exceed 64 characters.",
        };
      }

      system.run(() => createEscrowPayment(sender, recipient, amount, message));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:market",
      description: "Open the Market menu.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      if (!getEconomySettings().allowMarket) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The Market is currently disabled.",
        };
      }

      system.run(() => openMarket(player));
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:sell",
      description: "List the held item on the Market.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [
        {
          type: CustomCommandParamType.Integer,
          name: "moolah",
        },
        {
          type: CustomCommandParamType.String,
          name: "description",
        },
      ],
    },
    playerCommand((player, moolah, description) => {
      if (!getEconomySettings().allowMarket) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The Market is currently disabled.",
        };
      }

      if (moolah === undefined) {
        system.run(() => openAddListingMenu(player));
      } else {
        system.run(() => createListingFromCommand(
          player,
          moolah,
          description ?? "",
        ));
      }
      return { status: CustomCommandStatus.Success };
    }),
  );

  commandRegistry.registerCommand(
    {
      name: "moolah:buy",
      description: "Browse Market listings.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    playerCommand((player) => {
      if (!getEconomySettings().allowMarket) {
        return {
          status: CustomCommandStatus.Failure,
          message: "The Market is currently disabled.",
        };
      }

      system.run(() => openBrowseListings(player));
      return { status: CustomCommandStatus.Success };
    }),
  );
});

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  if (!event.isFirstEvent) return;

  const quickPay = readQuickPaySign(event.block);

  if (!quickPay) return;

  if (
    quickPay.description
    && (
      quickPay.description.length > 64
      || !getEconomySettings().allowTransferDescriptions
    )
    && !quickPay.registered
  ) {
    return;
  }

  event.cancel = true;
  system.run(() => {
    decorateQuickPaySign(event.block, quickPay);
    useQuickPaySign(event.player, quickPay);
  });
});

world.afterEvents.itemUse.subscribe((event) => {
  if (event.itemStack.typeId !== "minecraft:diamond") return;

  system.run(() => openShop(event.source));
});

world.afterEvents.entityDie.subscribe((event) => {
  if (event.deadEntity.typeId !== "minecraft:player") return;

  system.run(() => applyDeathTax(event.deadEntity));
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;

  system.run(() => assignFirstEconomyAdmin(event.player));
  system.runTimeout(() => giveFirstJoinGuide(event.player), 10);
  system.runTimeout(() => sendLoginNotifications(event.player), 20);
});

system.runInterval(updateHeldDiamondBalances, 5);
system.runInterval(updateTaxRefundTimers, 20);
