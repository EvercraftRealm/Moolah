import { ItemStack, SignSide, system, world } from "@minecraft/server";
import {
  ActionFormData,
  MessageFormData,
  ModalFormData,
} from "@minecraft/server-ui";
import {
  addToTaxPool,
  calculateTax,
  getEconomySettings,
} from "./settings.js";

const DEPOSIT_QUANTITIES = [1, 4, 16, 64];
const ESCROW_PROPERTY_PREFIX = "moolah:escrow:";
const INBOX_ACCEPT_DELAY_MS = 60_000;
const QUICK_PAY_COOLDOWN_MS = 3_000;
const MINECOIN_GLYPH = "\uE102";
const quickPayCooldowns = new Map();

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

function getInventory(player) {
  return player.getComponent("minecraft:inventory")?.container;
}

function countDiamonds(container) {
  let total = 0;

  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);

    if (item?.typeId === "minecraft:diamond") {
      total += item.amount;
    }
  }

  return total;
}

function removeDiamonds(container, quantity) {
  let remaining = quantity;

  for (let slot = 0; slot < container.size && remaining > 0; slot++) {
    const item = container.getItem(slot);

    if (item?.typeId !== "minecraft:diamond") continue;

    const removedFromStack = Math.min(item.amount, remaining);
    const newAmount = item.amount - removedFromStack;

    if (newAmount === 0) {
      container.setItem(slot);
    } else {
      item.amount = newAmount;
      container.setItem(slot, item);
    }

    remaining -= removedFromStack;
  }
}

export function depositAllDiamonds(player) {
  if (!getEconomySettings().allowDeposit) {
    player.sendMessage("Deposits are currently disabled.");
    return;
  }

  const inventory = getInventory(player);

  if (!inventory) {
    player.sendMessage("Your inventory could not be accessed.");
    return;
  }

  const quantity = countDiamonds(inventory);

  if (quantity === 0) {
    player.sendMessage("You do not have any diamonds to deposit.");
    return;
  }

  depositDiamonds(player, quantity);
}

export function depositDiamonds(player, quantity) {
  if (!getEconomySettings().allowDeposit) {
    player.sendMessage("Deposits are currently disabled.");
    return;
  }

  const inventory = getInventory(player);

  if (!inventory) {
    player.sendMessage("Your inventory could not be accessed.");
    return;
  }

  const availableDiamonds = countDiamonds(inventory);

  if (availableDiamonds < quantity) {
    player.sendMessage(
      `You need ${quantity} diamond${quantity === 1 ? "" : "s"}, but only have ${availableDiamonds}.`,
    );
    return;
  }

  const objective = getCurrencyObjective();

  removeDiamonds(inventory, quantity);
  objective.addScore(player, quantity * 100);

  player.sendMessage(
    `Deposited ${quantity} diamond${quantity === 1 ? "" : "s"} for \uE102${quantity * 100}.`,
  );
}

export function openDepositMenu(player, onBack) {
  if (!getEconomySettings().allowDeposit) {
    player.sendMessage("Deposits are currently disabled.");
    goBack(onBack);
    return;
  }

  const depositForm = new ActionFormData()
    .title("Deposit")
    .body("Each diamond is worth \uE102100.");

  for (const quantity of DEPOSIT_QUANTITIES) {
    depositForm.button(`${quantity} Diamond${quantity === 1 ? "" : "s"}`);
  }
  depositForm.button("All");

  depositForm.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === undefined) return;

    if (response.selection === DEPOSIT_QUANTITIES.length) {
      depositAllDiamonds(player);
      return;
    }

    const quantity = DEPOSIT_QUANTITIES[response.selection];
    if (quantity !== undefined) {
      depositDiamonds(player, quantity);
    }
  }).catch(() => {
    player.sendMessage("The deposit menu could not be opened.");
  });
}

function getDiamondCapacity(container) {
  let capacity = 0;

  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);

    if (!item) {
      capacity += 64;
    } else if (item.typeId === "minecraft:diamond") {
      capacity += 64 - item.amount;
    }
  }

  return capacity;
}

function getMaximumWithdrawalQuantity(player) {
  const inventory = getInventory(player);

  if (!inventory) return { error: "Your inventory could not be accessed." };

  const capacity = getDiamondCapacity(inventory);

  if (capacity <= 0) {
    return { error: "You do not have inventory space for any diamonds." };
  }

  const settings = getEconomySettings();
  const balance = getBalance(player);
  let low = 0;
  let high = capacity;

  while (low < high) {
    const quantity = Math.ceil((low + high) / 2);
    const baseCost = quantity * 100;
    const totalCost = baseCost + calculateTax(
      baseCost,
      settings.withdrawTaxRate,
    );

    if (Number.isSafeInteger(totalCost) && totalCost <= balance) {
      low = quantity;
    } else {
      high = quantity - 1;
    }
  }

  return low > 0
    ? { quantity: low }
    : { error: "Your balance is too low to withdraw a diamond after taxes." };
}

function withdrawDiamonds(player, quantity) {
  const settings = getEconomySettings();

  if (!settings.allowWithdraw) {
    player.sendMessage("Withdrawals are currently disabled.");
    return;
  }

  const inventory = getInventory(player);

  if (!inventory) {
    player.sendMessage("Your inventory could not be accessed.");
    return;
  }

  if (getDiamondCapacity(inventory) < quantity) {
    player.sendMessage(
      `You need inventory space for ${quantity} diamond${quantity === 1 ? "" : "s"}.`,
    );
    return;
  }

  const baseCost = quantity * 100;
  const taxAmount = calculateTax(
    baseCost,
    settings.withdrawTaxRate,
  );
  const totalCost = baseCost + taxAmount;
  const balance = getBalance(player);

  if (balance < totalCost) {
    player.sendMessage(
      `You need ${MINECOIN_GLYPH}${totalCost}, but your balance is ${MINECOIN_GLYPH}${balance}.`,
    );
    return;
  }

  const objective = getCurrencyObjective();
  const inventorySnapshot = [];

  for (let slot = 0; slot < inventory.size; slot++) {
    inventorySnapshot.push(inventory.getItem(slot)?.clone());
  }

  objective.addScore(player, -totalCost);

  try {
    let remaining = quantity;

    while (remaining > 0) {
      const stackSize = Math.min(64, remaining);
      const remainder = inventory.addItem(
        new ItemStack("minecraft:diamond", stackSize),
      );

      if (remainder) throw new Error("The diamonds did not fit in the inventory.");
      remaining -= stackSize;
    }
  } catch (error) {
    objective.addScore(player, totalCost);
    try {
      for (let slot = 0; slot < inventorySnapshot.length; slot++) {
        inventory.setItem(slot, inventorySnapshot[slot]);
      }
    } catch (restoreError) {
      console.error(
        `[Moolah] Withdrawal inventory rollback failed: ${restoreError?.stack ?? restoreError}`,
      );
    }
    console.error(
      `[Moolah] Withdrawal failed: ${error?.stack ?? error}`,
    );
    player.sendMessage("The withdrawal could not be completed. No funds were moved.");
    return;
  }

  addToTaxPool(taxAmount);
  player.sendMessage(
    `Withdrew ${quantity} diamond${quantity === 1 ? "" : "s"} for ${MINECOIN_GLYPH}${totalCost}.`,
  );
}

export function confirmWithdrawal(player, quantity, onBack) {
  const settings = getEconomySettings();

  if (!settings.allowWithdraw) {
    player.sendMessage("Withdrawals are currently disabled.");
    goBack(onBack);
    return;
  }

  const baseCost = quantity * 100;
  const taxAmount = calculateTax(
    baseCost,
    settings.withdrawTaxRate,
  );
  const totalCost = baseCost + taxAmount;
  const taxLabel = settings.withdrawTaxRate > 0
    ? `${settings.withdrawTaxRate}%`
    : "Off";
  const form = new MessageFormData()
    .title("Confirm Withdrawal")
    .body(
      `${quantity} diamond${quantity === 1 ? "" : "s"}\n`
      + `Value: ${MINECOIN_GLYPH}${baseCost}\n`
      + `Tax (${taxLabel}): ${MINECOIN_GLYPH}${taxAmount}\n`
      + `Total: ${MINECOIN_GLYPH}${totalCost}`,
    )
    .button1("Withdraw")
    .button2("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      withdrawDiamonds(player, quantity);
    }
  }).catch(() => {
    player.sendMessage("The withdrawal confirmation could not be opened.");
  });
}

export function confirmMaximumWithdrawal(player, onBack) {
  if (!getEconomySettings().allowWithdraw) {
    player.sendMessage("Withdrawals are currently disabled.");
    goBack(onBack);
    return;
  }

  const result = getMaximumWithdrawalQuantity(player);

  if (!result.quantity) {
    player.sendMessage(result.error);
    goBack(onBack);
    return;
  }

  confirmWithdrawal(player, result.quantity, onBack);
}

export function openWithdrawMenu(player, onBack) {
  if (!getEconomySettings().allowWithdraw) {
    player.sendMessage("Withdrawals are currently disabled.");
    goBack(onBack);
    return;
  }

  const form = new ActionFormData()
    .title("Withdraw")
    .body("Each diamond has a base value of \uE102100.");

  for (const quantity of DEPOSIT_QUANTITIES) {
    form.button(`${quantity} Diamond${quantity === 1 ? "" : "s"}`);
  }
  form.button("All");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === undefined) return;

    if (response.selection === DEPOSIT_QUANTITIES.length) {
      system.run(() => confirmMaximumWithdrawal(
        player,
        () => openWithdrawMenu(player, onBack),
      ));
      return;
    }

    const quantity = DEPOSIT_QUANTITIES[response.selection];
    if (quantity !== undefined) {
      system.run(() => confirmWithdrawal(
        player,
        quantity,
        () => openWithdrawMenu(player, onBack),
      ));
    }
  }).catch(() => {
    player.sendMessage("The Withdraw menu could not be opened.");
  });
}

export function getEscrowPayments() {
  const payments = [];

  for (const propertyId of world.getDynamicPropertyIds()) {
    if (!propertyId.startsWith(ESCROW_PROPERTY_PREFIX)) continue;

    const value = world.getDynamicProperty(propertyId);

    if (typeof value !== "string") continue;

    try {
      const payment = JSON.parse(value);

      if (
        (payment.kind === "transfer" || payment.kind === "mail") &&
        typeof payment.senderId === "string" &&
        typeof payment.senderName === "string" &&
        typeof payment.recipientName === "string" &&
        Number.isSafeInteger(payment.amount) &&
        Number.isSafeInteger(payment.taxAmount) &&
        payment.taxAmount >= 0 &&
        typeof payment.message === "string" &&
        Number.isSafeInteger(payment.acceptAfter) &&
        (
          (
            payment.kind === "transfer" &&
            payment.amount > 0 &&
            payment.message.length <= 120
          ) || (
            payment.kind === "mail" &&
            payment.amount === 0 &&
            payment.taxAmount === 0 &&
            payment.message.length > 0 &&
            payment.message.length <= 512 &&
            Number.isSafeInteger(payment.postageCost) &&
            payment.postageCost >= 0
          )
        )
      ) {
        payments.push({
          propertyId,
          ...payment,
        });
      }
    } catch {
      // Ignore malformed escrow records instead of interrupting other payments.
    }
  }

  return payments;
}

function saveEscrowPayment(payment) {
  const { propertyId, ...storedPayment } = payment;
  world.setDynamicProperty(propertyId, JSON.stringify(storedPayment));
}

function createSystemInboxItem(recipientName, kind, amount, message) {
  const paymentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const propertyId = `${ESCROW_PROPERTY_PREFIX}${paymentId}`;
  const payment = {
    propertyId,
    kind,
    senderId: "moolah:system",
    senderName: "System",
    recipientName,
    amount,
    taxAmount: 0,
    message,
    acceptAfter: Date.now(),
  };

  if (kind === "mail") payment.postageCost = 0;

  try {
    saveEscrowPayment(payment);
  } catch (error) {
    console.error(
      `[Moolah] System Inbox item could not be saved: ${error?.stack ?? error}`,
    );
    return false;
  }

  const onlineRecipient = world.getPlayers().find(
    (player) => player.name.toLowerCase() === recipientName.toLowerCase(),
  );
  onlineRecipient?.sendMessage(
    kind === "mail"
      ? "System sent you mail. Open your Inbox to read it."
      : `System sent you ${MINECOIN_GLYPH}${amount}. Open your Inbox to accept it.`,
  );
  return true;
}

export function createSystemInboxPayment(recipientName, amount, description) {
  return createSystemInboxItem(recipientName, "transfer", amount, description);
}

export function createSystemInboxMail(recipientName, message) {
  return createSystemInboxItem(recipientName, "mail", 0, message);
}

function isPaymentRecipient(payment, player) {
  return payment.recipientName.toLowerCase() === player.name.toLowerCase();
}

export function getPaymentCounts(player, payments = getEscrowPayments()) {
  return {
    inbox: payments.filter((payment) => isPaymentRecipient(payment, player)).length,
    pending: payments.filter((payment) => payment.senderId === player.id).length,
  };
}

function createEscrowPayment(sender, recipientName, amount, message = "") {
  const settings = getEconomySettings();

  if (!settings.allowTransfer) {
    sender.sendMessage("Transfers are currently disabled.");
    return false;
  }

  if (!settings.allowTransferDescriptions && message) {
    sender.sendMessage("Transfer descriptions are currently disabled.");
    return false;
  }

  if (message.length > 64) {
    sender.sendMessage("Transfer descriptions can be at most 64 characters.");
    return false;
  }

  const taxAmount = calculateTax(
    amount,
    settings.transferTaxRate,
  );
  const totalCost = amount + taxAmount;

  if (!Number.isSafeInteger(totalCost)) {
    sender.sendMessage("That transfer is too large to process.");
    return false;
  }

  const objective = getCurrencyObjective();
  const senderBalance = getBalance(sender);

  if (senderBalance < totalCost) {
    sender.sendMessage(
      `You need \uE102${totalCost}, but your balance is \uE102${senderBalance}.`,
    );
    return false;
  }

  const paymentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const propertyId = `${ESCROW_PROPERTY_PREFIX}${paymentId}`;
  const payment = {
    propertyId,
    kind: "transfer",
    senderId: sender.id,
    senderName: sender.name,
    recipientName,
    amount,
    taxAmount,
    message,
    acceptAfter: Date.now() + INBOX_ACCEPT_DELAY_MS,
  };

  objective.addScore(sender, -totalCost);

  try {
    saveEscrowPayment(payment);
  } catch {
    objective.addScore(sender, totalCost);
    sender.sendMessage("The pending payment could not be saved. No funds were moved.");
    return false;
  }

  sender.sendMessage(
    `Created a pending transfer of \uE102${amount} for ${recipientName}`
      + `${taxAmount > 0 ? ` (\uE102${taxAmount} tax)` : ""}.`,
  );

  const onlineRecipient = world.getPlayers().find(
    (player) => player.name.toLowerCase() === recipientName.toLowerCase(),
  );
  onlineRecipient?.sendMessage(
    `${sender.name} sent you \uE102${amount}. Open your Inbox to accept it.`,
  );
  return true;
}

function createEscrowMail(sender, recipientName, message) {
  const settings = getEconomySettings();

  if (!settings.allowMail) {
    sender.sendMessage("Mail is currently disabled.");
    return false;
  }

  const postageCost = settings.postageCost;
  const objective = getCurrencyObjective();
  const senderBalance = getBalance(sender);

  if (senderBalance < postageCost) {
    sender.sendMessage(
      `You need ${MINECOIN_GLYPH}${postageCost} for postage, but your balance is ${MINECOIN_GLYPH}${senderBalance}.`,
    );
    return false;
  }

  const paymentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const propertyId = `${ESCROW_PROPERTY_PREFIX}${paymentId}`;
  const mail = {
    propertyId,
    kind: "mail",
    senderId: sender.id,
    senderName: sender.name,
    recipientName,
    amount: 0,
    taxAmount: 0,
    postageCost,
    message,
    acceptAfter: Date.now(),
  };

  if (postageCost > 0) objective.addScore(sender, -postageCost);

  try {
    saveEscrowPayment(mail);
  } catch {
    if (postageCost > 0) objective.addScore(sender, postageCost);
    sender.sendMessage("The mail could not be saved. No postage was charged.");
    return false;
  }

  sender.sendMessage(
    `Sent pending mail to ${recipientName}`
      + `${postageCost > 0 ? ` for ${MINECOIN_GLYPH}${postageCost} postage` : ""}.`,
  );

  const onlineRecipient = world.getPlayers().find(
    (player) => player.name.toLowerCase() === recipientName.toLowerCase(),
  );
  onlineRecipient?.sendMessage(
    `${sender.name} sent you mail. Open your Inbox to read it.`,
  );
  return true;
}

function acceptEscrowPayment(recipient, propertyId) {
  const payment = getEscrowPayments().find(
    (candidate) => candidate.propertyId === propertyId,
  );

  if (
    !payment ||
    !isPaymentRecipient(payment, recipient)
  ) {
    recipient.sendMessage("That incoming item is no longer available.");
    return false;
  }

  const waitTime = payment.acceptAfter - Date.now();

  if (payment.kind === "transfer" && waitTime > 0) {
    recipient.sendMessage(
      `This item can be accepted in ${Math.ceil(waitTime / 1000)} second${waitTime > 1000 ? "s" : ""}.`,
    );
    return false;
  }

  world.setDynamicProperty(payment.propertyId, undefined);

  if (payment.kind === "transfer") {
    try {
      getCurrencyObjective().addScore(recipient, payment.amount);
    } catch {
      saveEscrowPayment(payment);
      recipient.sendMessage("The payment could not be accepted.");
      return false;
    }

    addToTaxPool(payment.taxAmount);
    recipient.sendMessage(
      `Accepted \uE102${payment.amount} from ${payment.senderName}.`,
    );
  } else {
    addToTaxPool(payment.postageCost);
    recipient.sendMessage(`Accepted mail from ${payment.senderName}.`);
  }

  const sender = world.getPlayers().find(
    (player) => player.id === payment.senderId,
  );
  sender?.sendMessage(payment.kind === "mail"
    ? `${recipient.name} accepted your mail.`
    : `${recipient.name} accepted your payment of \uE102${payment.amount}.`);
  return true;
}

function confirmIncomingPayment(recipient, payment, onBack) {
  const messageText = payment.message
    ? `\n\nMessage: ${payment.message}`
    : "";
  const waitSeconds = Math.max(0, Math.ceil((payment.acceptAfter - Date.now()) / 1000));
  const delayText = waitSeconds > 0
    ? `\n\nAvailable in ${waitSeconds} second${waitSeconds === 1 ? "" : "s"}.`
    : "";
  const isMail = payment.kind === "mail";

  if (isMail) {
    if (!acceptEscrowPayment(recipient, payment.propertyId)) {
      goBack(onBack);
      return;
    }

    new ActionFormData()
      .title("Mail")
      .body(`From: ${payment.senderName}${messageText}`)
      .button("Done")
      .show(recipient)
      .catch(() => {
        recipient.sendMessage(`Mail from ${payment.senderName}: ${payment.message}`);
      });
    return;
  }

  const confirmForm = new MessageFormData()
    .title("Incoming Payment")
    .body(`Accept \uE102${payment.amount} from ${payment.senderName}?${messageText}${delayText}`)
    .button1("Accept")
    .button2("Leave in Inbox");

  confirmForm.show(recipient).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      acceptEscrowPayment(recipient, payment.propertyId);
    }
  }).catch(() => {
    recipient.sendMessage("The incoming item could not be opened.");
  });
}

export function openInboxMenu(recipient, onBack) {
  const payments = getEscrowPayments().filter(
    (payment) => isPaymentRecipient(payment, recipient),
  );

  if (payments.length === 0) {
    recipient.sendMessage("Your inbox has no pending items.");
    goBack(onBack);
    return;
  }

  const inboxForm = new ActionFormData()
    .title("Inbox")
    .body("Select an item to review and accept it.");

  for (const payment of payments) {
    inboxForm.button(payment.kind === "mail"
      ? `${payment.senderName}\nMail`
      : `${payment.senderName}\n\uE102${payment.amount}`);
  }

  inboxForm.show(recipient).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === undefined) return;

    const payment = payments[response.selection];

    if (payment) {
      system.run(() => confirmIncomingPayment(
        recipient,
        payment,
        () => openInboxMenu(recipient, onBack),
      ));
    }
  }).catch(() => {
    recipient.sendMessage("The inbox could not be opened.");
  });
}

function cancelEscrowPayment(sender, propertyId) {
  const payment = getEscrowPayments().find(
    (candidate) => candidate.propertyId === propertyId,
  );

  if (!payment || payment.senderId !== sender.id) {
    sender.sendMessage("That pending item is no longer available.");
    return;
  }

  const objective = getCurrencyObjective();
  const settings = getEconomySettings();
  const refundPostage = payment.kind === "mail" && settings.refundCanceledPostage;
  const refundAmount = payment.kind === "mail"
    ? (refundPostage ? payment.postageCost : 0)
    : payment.amount + payment.taxAmount;
  const taxPoolAmount = payment.kind === "mail" && !refundPostage
    ? payment.postageCost
    : 0;

  world.setDynamicProperty(payment.propertyId, undefined);

  try {
    if (refundAmount > 0) objective.addScore(sender, refundAmount);
  } catch {
    saveEscrowPayment(payment);
    sender.sendMessage("The pending item could not be canceled.");
    return;
  }

  addToTaxPool(taxPoolAmount);

  sender.sendMessage(
    `Canceled the ${payment.kind === "mail" ? "mail" : "payment"} to ${payment.recipientName}`
      + `${refundAmount > 0 ? ` and refunded \uE102${refundAmount}` : ""}`
      + `${taxPoolAmount > 0 ? `; \uE102${taxPoolAmount} postage was moved to the Tax Pool` : ""}.`,
  );
}

function confirmEscrowCancellation(sender, payment, onBack) {
  const settings = getEconomySettings();
  const postageText = payment.kind === "mail" && payment.postageCost > 0
    ? `\n\nPostage: ${MINECOIN_GLYPH}${payment.postageCost} (${settings.refundCanceledPostage ? "refunded" : "sent to Tax Pool"})`
    : "";
  const confirmForm = new MessageFormData()
    .title(payment.kind === "mail" ? "Cancel Pending Mail" : "Cancel Pending Payment")
    .body(payment.kind === "mail"
      ? `Cancel mail to ${payment.recipientName}?${postageText}`
      : `Cancel \uE102${payment.amount} to ${payment.recipientName}?`)
    .button1(payment.kind === "mail" ? "Cancel Mail" : "Cancel Payment")
    .button2(payment.kind === "mail" ? "Keep Mail" : "Keep Payment");

  confirmForm.show(sender).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      cancelEscrowPayment(sender, payment.propertyId);
    }
  }).catch(() => {
    sender.sendMessage("The pending payment could not be opened.");
  });
}

export function openEscrowMenu(sender, onBack) {
  const payments = getEscrowPayments().filter(
    (payment) => payment.senderId === sender.id,
  );

  if (payments.length === 0) {
    sender.sendMessage("You have no pending items.");
    goBack(onBack);
    return;
  }

  const escrowForm = new ActionFormData()
    .title("Pending")
    .body("Select a pending item to cancel it.");

  for (const payment of payments) {
    escrowForm.button(payment.kind === "mail"
      ? `${payment.recipientName}\nMail`
      : `${payment.recipientName}\n\uE102${payment.amount}`);
  }

  escrowForm.show(sender).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === undefined) return;

    const payment = payments[response.selection];

    if (payment) {
      system.run(() => confirmEscrowCancellation(
        sender,
        payment,
        () => openEscrowMenu(sender, onBack),
      ));
    }
  }).catch(() => {
    sender.sendMessage("The Pending menu could not be opened.");
  });
}

function openOfflineRecipientMenu(sender, amount, message, onBack) {
  if (!getEconomySettings().allowTransfer) {
    sender.sendMessage("Transfers are currently disabled.");
    goBack(onBack);
    return;
  }

  const offlineForm = new ModalFormData()
    .title("Offline Player")
    .textField("Username", "Enter the player's exact name", { defaultValue: "" })
    .submitButton("Transfer");

  offlineForm.show(sender).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (!response.formValues) return;

    const recipientNameValue = response.formValues[0];

    if (typeof recipientNameValue !== "string") {
      sender.sendMessage("The recipient name was invalid.");
      return;
    }

    const recipientName = recipientNameValue.trim();

    if (recipientName.length === 0) {
      sender.sendMessage("Enter a recipient name.");
      return;
    }

    if (recipientName.toLowerCase() === sender.name.toLowerCase()) {
      sender.sendMessage("You cannot send funds to yourself.");
      return;
    }

    createEscrowPayment(sender, recipientName, amount, message);
  }).catch(() => {
    sender.sendMessage("The offline-player menu could not be opened.");
  });
}

export function openTransferMenu(sender, onBack) {
  const settings = getEconomySettings();

  if (!settings.allowTransfer) {
    sender.sendMessage("Transfers are currently disabled.");
    goBack(onBack);
    return;
  }

  const onlineRecipientNames = world.getPlayers()
    .filter((player) => player.id !== sender.id)
    .map((player) => player.name);
  const recipientOptions = [
    ...onlineRecipientNames,
    "Offline Player",
  ];
  const sendForm = new ModalFormData()
    .title("Transfer Moolah")
    .dropdown("Recipient", recipientOptions, { defaultValueIndex: 0 })
    .textField("Amount", "Enter a whole number", { defaultValue: "" });

  if (settings.allowTransferDescriptions) {
    sendForm.textField(
      "Message (optional)",
      "Up to 64 characters",
      { defaultValue: "" },
    );
  }

  sendForm.submitButton("Transfer");

  sendForm.show(sender).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (!response.formValues) return;

    const recipientIndex = response.formValues[0];
    const amountText = response.formValues[1];
    const messageValue = settings.allowTransferDescriptions
      ? response.formValues[2]
      : "";

    if (
      typeof recipientIndex !== "number" ||
      typeof amountText !== "string" ||
      typeof messageValue !== "string"
    ) {
      sender.sendMessage("The transfer details were invalid.");
      return;
    }

    const message = messageValue.trim();

    if (message.length > 64) {
      sender.sendMessage("Transfer descriptions can be at most 64 characters.");
      return;
    }

    const normalizedAmount = amountText.trim();
    const amount = Number(normalizedAmount);

    if (!/^\d+$/.test(normalizedAmount) || !Number.isSafeInteger(amount) || amount <= 0) {
      sender.sendMessage("Enter a positive whole-number amount.");
      return;
    }

    if (recipientIndex === onlineRecipientNames.length) {
      system.run(() => openOfflineRecipientMenu(
        sender,
        amount,
        message,
        () => openTransferMenu(sender, onBack),
      ));
    } else {
      const recipientName = onlineRecipientNames[recipientIndex];

      if (!recipientName) {
        sender.sendMessage("That recipient selection was invalid.");
        return;
      }

      createEscrowPayment(sender, recipientName, amount, message);
    }
  }).catch(() => {
    sender.sendMessage("The Transfer menu could not be opened.");
  });
}

function openOfflineMailRecipientMenu(sender, message, onBack) {
  const settings = getEconomySettings();

  if (!settings.allowMail) {
    sender.sendMessage("Mail is currently disabled.");
    goBack(onBack);
    return;
  }

  const offlineForm = new ModalFormData()
    .title("Offline Player")
    .textField("Username", "Enter the player's exact name", { defaultValue: "" });

  if (settings.postageCost > 0) {
    offlineForm.label(`Postage cost: ${MINECOIN_GLYPH}${settings.postageCost}`);
  }

  offlineForm.submitButton("Send Mail");

  offlineForm.show(sender).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (!response.formValues) return;
    const recipientNameValue = response.formValues[0];

    if (typeof recipientNameValue !== "string") {
      sender.sendMessage("The recipient name was invalid.");
      return;
    }

    const recipientName = recipientNameValue.trim();

    if (!recipientName) {
      sender.sendMessage("Enter a recipient name.");
      return;
    }

    if (recipientName.toLowerCase() === sender.name.toLowerCase()) {
      sender.sendMessage("You cannot send mail to yourself.");
      return;
    }

    createEscrowMail(sender, recipientName, message);
  }).catch(() => {
    sender.sendMessage("The offline-player menu could not be opened.");
  });
}

export function openMailMenu(sender, onBack) {
  const settings = getEconomySettings();

  if (!settings.allowMail) {
    sender.sendMessage("Mail is currently disabled.");
    goBack(onBack);
    return;
  }

  const onlineRecipientNames = world.getPlayers()
    .filter((player) => player.id !== sender.id)
    .map((player) => player.name);
  const recipientOptions = [
    ...onlineRecipientNames,
    "Offline Player",
  ];
  const mailForm = new ModalFormData()
    .title("Send Mail")
    .dropdown("Recipient", recipientOptions, { defaultValueIndex: 0 })
    .textField("Message", "Up to 512 characters", { defaultValue: "" });

  if (settings.postageCost > 0) {
    mailForm.label(`Postage cost: ${MINECOIN_GLYPH}${settings.postageCost}`);
  }

  mailForm.submitButton("Send Mail");

  mailForm.show(sender).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (!response.formValues) return;
    const recipientIndex = response.formValues[0];
    const messageValue = response.formValues[1];

    if (
      typeof recipientIndex !== "number"
      || typeof messageValue !== "string"
    ) {
      sender.sendMessage("The mail details were invalid.");
      return;
    }

    const message = messageValue.trim();

    if (!message) {
      sender.sendMessage("Enter a message.");
      return;
    }

    if (message.length > 512) {
      sender.sendMessage("Mail messages can be at most 512 characters.");
      return;
    }

    if (recipientIndex === onlineRecipientNames.length) {
      system.run(() => openOfflineMailRecipientMenu(
        sender,
        message,
        () => openMailMenu(sender, onBack),
      ));
    } else {
      const recipientName = onlineRecipientNames[recipientIndex];

      if (!recipientName) {
        sender.sendMessage("That recipient selection was invalid.");
        return;
      }

      createEscrowMail(sender, recipientName, message);
    }
  }).catch(() => {
    sender.sendMessage("The Mail menu could not be opened.");
  });
}

export function readQuickPaySign(block) {
  const sign = block.getComponent("minecraft:sign");

  if (!sign) return undefined;

  for (const side of [SignSide.Front, SignSide.Back]) {
    const text = sign.getText(side);

    if (typeof text !== "string") continue;

    const lines = text.split(/\r?\n/);

    if (lines[0] !== "!QuickPay") continue;

    const recipientName = (lines[1] ?? "").trim();
    const displayedAmount = (lines[2] ?? "").trim();
    const amountText = displayedAmount.startsWith(MINECOIN_GLYPH)
      ? displayedAmount.slice(MINECOIN_GLYPH.length).trim()
      : displayedAmount;
    const description = (lines[3] ?? "").trim();
    const amount = Number(amountText);

    if (
      !recipientName
      || !/^\d+$/.test(amountText)
      || !Number.isSafeInteger(amount)
      || amount <= 0
      || description.length > 120
    ) {
      continue;
    }

    return {
      recipientName,
      amountText,
      description,
      registered: displayedAmount.startsWith(MINECOIN_GLYPH),
    };
  }

  return undefined;
}

export function decorateQuickPaySign(block, quickPay) {
  try {
    const sign = block.getComponent("minecraft:sign");
    if (!sign) return;

    const activeText = [
      "!QuickPay",
      quickPay.recipientName,
      `${MINECOIN_GLYPH}${quickPay.amountText}`,
      quickPay.description,
    ].join("\n");

    sign.setText(activeText, SignSide.Front);
    sign.setText(activeText, SignSide.Back);
  } catch {
    // The sign may have been removed between the interaction and this update.
  }
}

export function useQuickPaySign(player, quickPay) {
  const fail = (message) => {
    player.sendMessage(message);
    player.playSound("random.click");
  };
  const now = Date.now();
  const cooldownUntil = quickPayCooldowns.get(player.id) ?? 0;

  const settings = getEconomySettings();

  if (!settings.allowTransfer) {
    fail("QuickPay is currently disabled because transfers are disabled.");
    return;
  }

  if (cooldownUntil > now) {
    const seconds = Math.ceil((cooldownUntil - now) / 1000);
    fail(`QuickPay is on cooldown for ${seconds} second${seconds === 1 ? "" : "s"}.`);
    return;
  }

  if (!quickPay.recipientName) {
    fail("This QuickPay sign is missing a recipient username.");
    return;
  }

  if (quickPay.recipientName.toLowerCase() === player.name.toLowerCase()) {
    fail("You cannot send a QuickPay payment to yourself.");
    return;
  }

  const amount = Number(quickPay.amountText);

  if (
    !/^\d+$/.test(quickPay.amountText)
    || !Number.isSafeInteger(amount)
    || amount <= 0
  ) {
    fail("This QuickPay sign has an invalid amount.");
    return;
  }

  if (quickPay.description.length > 64) {
    fail("QuickPay descriptions can be at most 64 characters.");
    return;
  }

  if (!settings.allowTransferDescriptions && quickPay.description) {
    fail("QuickPay descriptions are currently disabled.");
    return;
  }

  quickPayCooldowns.set(player.id, now + QUICK_PAY_COOLDOWN_MS);
  const succeeded = createEscrowPayment(
    player,
    quickPay.recipientName,
    amount,
    quickPay.description,
  );
  player.playSound(succeeded ? "random.levelup" : "random.click");
}
