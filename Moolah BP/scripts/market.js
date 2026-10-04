import { system, world } from "@minecraft/server";
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

const LISTING_PROPERTY_PREFIX = "moolah:market:";
const STORAGE_ENTITY_TYPE = "moolah:market_storage";
const MAX_DESCRIPTION_LENGTH = 240;

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

function formatAmount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function requireMarketEnabled(player, onBack) {
  if (getEconomySettings().allowMarket) return true;

  player.sendMessage("The Market is currently disabled.");
  goBack(onBack);
  return false;
}

function getInventory(player) {
  return player.getComponent("minecraft:inventory")?.container;
}

function getFirstEmptySlot(container) {
  for (let slot = 0; slot < container.size; slot++) {
    if (!container.getItem(slot)) return slot;
  }

  return undefined;
}

function formatItemType(itemTypeId) {
  return itemTypeId
    .replace(/^minecraft:/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getItemDisplayName(item) {
  return item.nameTag?.trim() || formatItemType(item.typeId);
}

function parseListing(propertyId, value) {
  if (typeof value !== "string") return undefined;

  try {
    const listing = JSON.parse(value);

    if (
      typeof listing.id !== "string"
      || typeof listing.sellerId !== "string"
      || typeof listing.sellerName !== "string"
      || typeof listing.itemTypeId !== "string"
      || typeof listing.itemName !== "string"
      || !Number.isSafeInteger(listing.amount)
      || listing.amount <= 0
      || !Number.isSafeInteger(listing.price)
      || listing.price <= 0
      || !Number.isSafeInteger(listing.listingFee)
      || listing.listingFee < 0
      || typeof listing.description !== "string"
      || !["active", "sold", "returning", "claimed"].includes(listing.status)
    ) {
      return undefined;
    }

    return { propertyId, ...listing };
  } catch {
    return undefined;
  }
}

function getListings() {
  const listings = [];

  for (const propertyId of world.getDynamicPropertyIds()) {
    if (!propertyId.startsWith(LISTING_PROPERTY_PREFIX)) continue;

    const listing = parseListing(
      propertyId,
      world.getDynamicProperty(propertyId),
    );

    if (listing) listings.push(listing);
  }

  return listings;
}

export function getMarketNotificationCounts(player) {
  const listings = getListings().filter(
    (listing) => listing.sellerId === player.id,
  );

  return {
    active: listings.filter((listing) => listing.status === "active").length,
    unclaimed: listings.filter((listing) => listing.status === "sold").length,
  };
}

function getListing(propertyId) {
  return parseListing(propertyId, world.getDynamicProperty(propertyId));
}

function saveListing(listing) {
  const {
    propertyId,
    ...storedListing
  } = listing;
  world.setDynamicProperty(propertyId, JSON.stringify(storedListing));
}

function getStoredItem(listing) {
  if (typeof listing.storageEntityId !== "string") return undefined;

  const storageEntity = world.getEntity(listing.storageEntityId);
  const storage = storageEntity?.getComponent("minecraft:inventory")?.container;
  const item = storage?.getItem(0);

  if (!storageEntity || !storage || !item) return undefined;

  return { storageEntity, storage, item };
}

function removeStorageEntity(storageEntity) {
  try {
    storageEntity.remove();
  } catch {
    // The listing metadata remains authoritative if cleanup already occurred.
  }
}

function validatePriceAndDescription(player, priceText, descriptionText) {
  const normalizedPrice = priceText.trim();
  const price = Number(normalizedPrice);
  const description = descriptionText.trim();

  if (!/^\d+$/.test(normalizedPrice) || !Number.isSafeInteger(price) || price <= 0) {
    player.sendMessage("Enter a positive whole-number price.");
    return undefined;
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    player.sendMessage(
      `Descriptions can be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
    return undefined;
  }

  return { price, description };
}

function createListing(player, selectedSlot, price, description) {
  if (!requireMarketEnabled(player)) return;

  const inventory = getInventory(player);
  const item = inventory?.getItem(selectedSlot);
  const settings = getEconomySettings();

  if (!inventory || !item) {
    player.sendMessage("Hold the item you want to list and try again.");
    return;
  }

  const activeListingCount = getListings().filter(
    (listing) => listing.sellerId === player.id && listing.status === "active",
  ).length;

  if (activeListingCount >= settings.maxMarketListings) {
    player.sendMessage(
      `You already have the maximum of ${settings.maxMarketListings} active Market listing${settings.maxMarketListings === 1 ? "" : "s"}.`,
    );
    return;
  }

  const objective = getCurrencyObjective();
  const listingFee = settings.listingFee;
  const balance = getBalance(player);

  if (balance < listingFee) {
    player.sendMessage(
      `You need \uE102${formatAmount(listingFee)} for the listing fee, but your balance is \uE102${formatAmount(balance)}.`,
    );
    return;
  }

  const listingId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const propertyId = `${LISTING_PROPERTY_PREFIX}${listingId}`;
  let storageEntity;
  let createdListing;
  let feeReserved = false;

  try {
    if (listingFee > 0) {
      objective.addScore(player, -listingFee);
      feeReserved = true;
    }

    const location = {
      x: player.location.x,
      y: player.location.y,
      z: player.location.z,
    };
    storageEntity = player.dimension.spawnEntity(STORAGE_ENTITY_TYPE, location);
    const storage = storageEntity.getComponent("minecraft:inventory")?.container;

    if (!storage) throw new Error("Market storage has no inventory.");

    storage.setItem(0, item.clone());

    const listing = {
      propertyId,
      id: listingId,
      sellerId: player.id,
      sellerName: player.name,
      itemTypeId: item.typeId,
      itemName: getItemDisplayName(item),
      amount: item.amount,
      price,
      listingFee,
      description,
      status: "active",
      storageEntityId: storageEntity.id,
    };

    saveListing(listing);

    try {
      inventory.setItem(selectedSlot);
    } catch (error) {
      world.setDynamicProperty(propertyId, undefined);
      removeStorageEntity(storageEntity);
      throw error;
    }
    createdListing = listing;
  } catch (error) {
    world.setDynamicProperty(propertyId, undefined);
    if (storageEntity) removeStorageEntity(storageEntity);
    if (feeReserved) {
      try {
        objective.addScore(player, listingFee);
      } catch (refundError) {
        console.error(
          `[Moolah Market] Failed to refund a listing fee: ${refundError?.stack ?? refundError}`,
        );
      }
    }
    console.error(
      `[Moolah Market] Failed to create listing: ${error?.stack ?? error}`,
    );
    player.sendMessage(
      `The listing could not be created. Your item was not taken. (${error?.message ?? error})`,
    );
    return;
  }

  player.sendMessage(
    `Listed ${createdListing.amount}x ${createdListing.itemName} for \uE102${formatAmount(createdListing.price)}`
      + `${createdListing.listingFee > 0 ? ` (\uE102${formatAmount(createdListing.listingFee)} fee)` : ""}.`,
  );
}

export function createListingFromCommand(player, price, description = "") {
  if (!requireMarketEnabled(player)) return;

  const validated = validatePriceAndDescription(
    player,
    String(price),
    description,
  );

  if (!validated) return;

  createListing(
    player,
    player.selectedSlotIndex,
    validated.price,
    validated.description,
  );
}

export function openAddListingMenu(player, onBack) {
  if (!requireMarketEnabled(player, onBack)) return;

  const inventory = getInventory(player);
  const selectedSlot = player.selectedSlotIndex;
  const item = inventory?.getItem(selectedSlot);

  if (!inventory || !item) {
    player.sendMessage("Hold the item you want to list first.");
    goBack(onBack);
    return;
  }

  const listingForm = new ModalFormData()
    .title("Add Listing")
    .textField("Price", "Moolah", { defaultValue: "" })
    .textField(
      "Description (optional)",
      `Explain special details (max ${MAX_DESCRIPTION_LENGTH})`,
      { defaultValue: "" },
    );

  const settings = getEconomySettings();
  if (settings.listingFee > 0) {
    listingForm.label(`Listing fee: \uE102${formatAmount(settings.listingFee)}`);
  }
  listingForm.submitButton("List Item");

  listingForm.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (!response.formValues) return;

    const priceText = response.formValues[0];
    const descriptionText = response.formValues[1];

    if (typeof priceText !== "string" || typeof descriptionText !== "string") {
      player.sendMessage("The listing details were invalid.");
      return;
    }

    const validated = validatePriceAndDescription(
      player,
      priceText,
      descriptionText,
    );

    if (validated) {
      createListing(player, selectedSlot, validated.price, validated.description);
    }
  }).catch(() => {
    player.sendMessage("The listing form could not be opened.");
  });
}

function purchaseListing(buyer, propertyId) {
  if (!requireMarketEnabled(buyer)) return;

  const listing = getListing(propertyId);

  if (!listing || listing.status !== "active") {
    buyer.sendMessage("That listing is no longer available.");
    return;
  }

  if (listing.sellerId === buyer.id) {
    buyer.sendMessage("You cannot buy your own listing.");
    return;
  }

  const stored = getStoredItem(listing);

  if (!stored) {
    buyer.sendMessage("The listed item is temporarily unavailable.");
    return;
  }

  const inventory = getInventory(buyer);
  const emptySlot = inventory ? getFirstEmptySlot(inventory) : undefined;

  if (!inventory || emptySlot === undefined) {
    buyer.sendMessage("You need an empty inventory slot to buy this item.");
    return;
  }

  const objective = getCurrencyObjective();
  const balance = getBalance(buyer);
  const settings = getEconomySettings();
  const taxAmount = calculateTax(
    listing.price,
    settings.marketTaxRate,
  );
  const totalCost = listing.price + taxAmount;

  if (!Number.isSafeInteger(totalCost)) {
    buyer.sendMessage("That listing total is too large to process.");
    return;
  }

  if (balance < totalCost) {
    buyer.sendMessage(
      `You need \uE102${formatAmount(totalCost)}, but your balance is \uE102${formatAmount(balance)}.`,
    );
    return;
  }

  objective.addScore(buyer, -totalCost);
  const soldListing = {
    ...listing,
    status: "sold",
    buyerId: buyer.id,
    buyerName: buyer.name,
    taxRate: settings.marketTaxRate,
    taxAmount,
    totalPaid: totalCost,
  };

  try {
    saveListing(soldListing);
  } catch {
    objective.addScore(buyer, totalCost);
    buyer.sendMessage("The purchase could not be completed. No funds were moved.");
    return;
  }

  try {
    inventory.setItem(emptySlot, stored.item);
  } catch {
    objective.addScore(buyer, totalCost);
    try {
      saveListing(listing);
    } catch {
      // The buyer has been refunded even if metadata recovery fails.
    }
    buyer.sendMessage("The item could not be delivered. No funds were moved.");
    return;
  }

  try {
    stored.storage.setItem(0);
  } catch {
    // Removing a private storage entity does not drop its inventory.
  }
  removeStorageEntity(stored.storageEntity);

  try {
    saveListing({ ...soldListing, storageEntityId: undefined });
  } catch {
    // The already-sold record still allows the seller to claim proceeds.
  }

  try {
    addToTaxPool(taxAmount + listing.listingFee);
  } catch (error) {
    console.error(
      `[Moolah Market] Failed to record Market fees in the Tax Pool: ${error?.stack ?? error}`,
    );
  }

  buyer.sendMessage(
    `Bought ${listing.amount}x ${listing.itemName} for \uE102${formatAmount(totalCost)} (\uE102${formatAmount(taxAmount)} tax).`,
  );

  const seller = world.getPlayers().find(
    (player) => player.id === listing.sellerId,
  );
  seller?.sendMessage(
    `${listing.itemName} sold for \uE102${formatAmount(listing.price)}. Claim it in My Listings.`,
  );
}

function confirmPurchase(player, listing, onBack) {
  if (!requireMarketEnabled(player, onBack)) return;

  const description = listing.description || "No description provided.";
  const settings = getEconomySettings();
  const taxAmount = calculateTax(
    listing.price,
    settings.marketTaxRate,
  );
  const totalCost = listing.price + taxAmount;
  const taxLabel = settings.marketTaxRate > 0
    ? `${settings.marketTaxRate}%`
    : "Off";
  const form = new MessageFormData()
    .title(listing.itemName)
    .body(
      `${listing.amount} item${listing.amount === 1 ? "" : "s"}\n`
      + `Seller: ${listing.sellerName}\n`
      + `Price: \uE102${formatAmount(listing.price)}\n`
      + `Tax (${taxLabel}): \uE102${formatAmount(taxAmount)}\n`
      + `Total: \uE102${formatAmount(totalCost)}\n\n${description}`,
    )
    .button1("Buy")
    .button2("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      purchaseListing(player, listing.propertyId);
    }
  }).catch(() => {
    player.sendMessage("The listing could not be opened.");
  });
}

export function openBrowseListings(player, onBack) {
  if (!requireMarketEnabled(player, onBack)) return;

  const listings = getListings().filter((listing) => listing.status === "active");

  if (listings.length === 0) {
    player.sendMessage("The Market has no active listings.");
    goBack(onBack);
    return;
  }

  const form = new ActionFormData()
    .title("Browse Listings")
    .body("Select a listing to view its details.");

  for (const listing of listings) {
    form.button(
      `${listing.amount}x ${listing.itemName}\n\uE102${formatAmount(listing.price)} - ${listing.sellerName}`,
    );
  }

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === undefined) return;

    const listing = listings[response.selection];

    if (listing) {
      system.run(() => confirmPurchase(
        player,
        listing,
        () => openBrowseListings(player, onBack),
      ));
    }
  }).catch(() => {
    player.sendMessage("The Market could not be opened.");
  });
}

function editListing(player, propertyId, onBack) {
  const listing = getListing(propertyId);

  if (!listing || listing.status !== "active" || listing.sellerId !== player.id) {
    player.sendMessage("That listing can no longer be edited.");
    return;
  }

  const form = new ModalFormData()
    .title("Edit Listing")
    .textField("Price", "Moolah", { defaultValue: String(listing.price) })
    .textField(
      "Description (optional)",
      `Max ${MAX_DESCRIPTION_LENGTH} characters`,
      { defaultValue: listing.description },
    )
    .submitButton("Save Changes");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (!response.formValues) return;

    const priceText = response.formValues[0];
    const descriptionText = response.formValues[1];

    if (typeof priceText !== "string" || typeof descriptionText !== "string") {
      player.sendMessage("The listing details were invalid.");
      return;
    }

    const validated = validatePriceAndDescription(
      player,
      priceText,
      descriptionText,
    );
    const currentListing = getListing(propertyId);

    if (
      !validated
      || !currentListing
      || currentListing.status !== "active"
      || currentListing.sellerId !== player.id
    ) {
      if (validated) player.sendMessage("That listing can no longer be edited.");
      return;
    }

    saveListing({
      ...currentListing,
      price: validated.price,
      description: validated.description,
    });
    player.sendMessage("Listing updated.");
  }).catch(() => {
    player.sendMessage("The edit form could not be opened.");
  });
}

function cancelListing(player, propertyId) {
  const listing = getListing(propertyId);

  if (!listing || listing.status !== "active" || listing.sellerId !== player.id) {
    player.sendMessage("That listing can no longer be canceled.");
    return;
  }

  const stored = getStoredItem(listing);
  const inventory = getInventory(player);
  const emptySlot = inventory ? getFirstEmptySlot(inventory) : undefined;

  if (!stored) {
    player.sendMessage("The listed item is temporarily unavailable.");
    return;
  }

  if (!inventory || emptySlot === undefined) {
    player.sendMessage("You need an empty inventory slot to cancel this listing.");
    return;
  }

  const returningListing = { ...listing, status: "returning" };

  try {
    saveListing(returningListing);
    inventory.setItem(emptySlot, stored.item);
  } catch {
    saveListing(listing);
    player.sendMessage("The listing could not be canceled.");
    return;
  }

  try {
    stored.storage.setItem(0);
  } catch {
    // Removing a private storage entity does not drop its inventory.
  }
  removeStorageEntity(stored.storageEntity);
  world.setDynamicProperty(propertyId, undefined);
  const settings = getEconomySettings();
  let listingFeeRefunded = false;

  if (listing.listingFee > 0) {
    if (settings.refundCanceledListingFees) {
      try {
        getCurrencyObjective().addScore(player, listing.listingFee);
        listingFeeRefunded = true;
      } catch (error) {
        addToTaxPool(listing.listingFee);
        console.error(
          `[Moolah Market] Listing fee refund failed and was moved to the Tax Pool: ${error?.stack ?? error}`,
        );
      }
    } else {
      addToTaxPool(listing.listingFee);
    }
  }

  player.sendMessage(
    `Canceled the listing for ${listing.itemName}`
      + `${listingFeeRefunded
        ? ` and refunded the \uE102${formatAmount(listing.listingFee)} listing fee`
        : ""}.`,
  );
}

function confirmListingCancellation(player, listing, onBack) {
  const settings = getEconomySettings();
  const feeText = listing.listingFee > 0
    ? `\n\nListing fee: \uE102${formatAmount(listing.listingFee)} (${settings.refundCanceledListingFees ? "refunded" : "sent to Tax Pool"})`
    : "";
  const form = new MessageFormData()
    .title("Cancel Listing")
    .body(`Return ${listing.amount}x ${listing.itemName} to your inventory?${feeText}`)
    .button1("Cancel Listing")
    .button2("Keep Listing");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      goBack(onBack);
    } else if (response.selection === 0) {
      cancelListing(player, listing.propertyId);
    }
  }).catch(() => {
    player.sendMessage("The listing could not be opened.");
  });
}

function claimListingProceeds(player, propertyId) {
  const listing = getListing(propertyId);

  if (!listing || listing.status !== "sold" || listing.sellerId !== player.id) {
    player.sendMessage("Those proceeds are no longer available.");
    return;
  }

  const objective = getCurrencyObjective();
  const claimedListing = { ...listing, status: "claimed" };

  try {
    saveListing(claimedListing);
    objective.addScore(player, listing.price);
  } catch {
    saveListing(listing);
    player.sendMessage("The proceeds could not be claimed.");
    return;
  }

  world.setDynamicProperty(propertyId, undefined);
  player.sendMessage(`Claimed \uE102${formatAmount(listing.price)} from ${listing.itemName}.`);
}

function openOwnedListing(player, listing, onBack) {
  if (listing.status === "sold") {
    const form = new MessageFormData()
      .title("Sold Listing")
      .body(
        `${listing.amount}x ${listing.itemName}\n`
        + `Buyer: ${listing.buyerName}\n`
        + `Proceeds: \uE102${formatAmount(listing.price)}`,
      )
      .button1("Claim Proceeds")
      .button2("Back");

    form.show(player).then((response) => {
      if (response.canceled || response.selection === 1) {
        goBack(onBack);
      } else if (response.selection === 0) {
        claimListingProceeds(player, listing.propertyId);
      }
    }).catch(() => {
      player.sendMessage("The sold listing could not be opened.");
    });
    return;
  }

  const form = new ActionFormData()
    .title(listing.itemName)
    .body(
      `Price: \uE102${formatAmount(listing.price)}\n\n`
      + (listing.description || "No description provided."),
    )
    .button("Edit")
    .button("Cancel Listing");

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === 0) {
      system.run(() => editListing(player, listing.propertyId, () => {
        const current = getListing(listing.propertyId);
        if (current) openOwnedListing(player, current, onBack);
        else goBack(onBack);
      }));
    } else if (response.selection === 1) {
      system.run(() => confirmListingCancellation(
        player,
        listing,
        () => openOwnedListing(player, listing, onBack),
      ));
    }
  }).catch(() => {
    player.sendMessage("The listing could not be opened.");
  });
}

function openMyListings(player, onBack) {
  const listings = getListings().filter(
    (listing) => listing.sellerId === player.id
      && ["active", "sold"].includes(listing.status),
  );

  const form = new ActionFormData()
    .title("My Listings")
    .body("Add a listing or manage your existing listings.")
    .button("Add Listing");

  for (const listing of listings) {
    const status = listing.status === "sold"
      ? "SOLD"
      : `\uE102${formatAmount(listing.price)}`;
    form.button(
      `${listing.amount}x ${listing.itemName}\n${status}`,
    );
  }

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === undefined) return;

    if (response.selection === 0) {
      system.run(() => openAddListingMenu(
        player,
        () => openMyListings(player, onBack),
      ));
      return;
    }

    const listing = listings[response.selection - 1];

    if (listing) {
      system.run(() => openOwnedListing(
        player,
        listing,
        () => openMyListings(player, onBack),
      ));
    }
  }).catch(() => {
    player.sendMessage("My Listings could not be opened.");
  });
}

export function openMarket(player, onBack) {
  if (!requireMarketEnabled(player, onBack)) return;

  const listings = getListings();
  const activeCount = listings.filter(
    (listing) => listing.status === "active",
  ).length;
  const unclaimedCount = listings.filter(
    (listing) => listing.sellerId === player.id && listing.status === "sold",
  ).length;
  const myListingsLabel = unclaimedCount > 0
    ? `(${unclaimedCount}) My Listings`
    : "My Listings";
  const form = new ActionFormData()
    .title("Market")
    .body(`${activeCount} active listing${activeCount === 1 ? "" : "s"}`)
    .button("Browse Listings")
    .button(myListingsLabel);

  form.show(player).then((response) => {
    if (response.canceled) {
      goBack(onBack);
      return;
    }

    if (response.selection === 0) {
      system.run(() => openBrowseListings(
        player,
        () => openMarket(player, onBack),
      ));
    } else if (response.selection === 1) {
      system.run(() => openMyListings(
        player,
        () => openMarket(player, onBack),
      ));
    }
  }).catch(() => {
    player.sendMessage("The Market could not be opened.");
  });
}
