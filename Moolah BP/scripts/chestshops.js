import { SignSide, system, world } from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { createSystemInboxPayment } from "./bank.js";
import { addBalance, getBalance } from "./balance.js";
import { writeAuditLog } from "./audit.js";
import {
  addToTaxPool,
  calculateTax,
  getEconomySettings,
} from "./settings.js";
import { getMoolahPlayers, isMoolahPlayer } from "./players.js";

const SHOP_PROPERTY_PREFIX = "moolah:chest_shop:";
const MINECOIN_GLYPH = "\uE102";
const MAX_SHOP_NAME_LENGTH = 36;
const MAX_DEFAULT_QUANTITY = 255;
const ADJACENT_OFFSETS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

const shopsById = new Map();
const shopsBySign = new Map();
const shopsByContainer = new Map();
const transactionLocks = new Set();
const reconciliationLocks = new Set();
const ownerStockSessions = new Map();
const PENDING_STOCK_SESSION_TICKS = 40;
const ACTIVE_STOCK_SESSION_TICKS = 20 * 60 * 10;
let shopsLoaded = false;
let initialized = false;

function locationKey(dimensionId, location) {
  return `${dimensionId}|${location.x}|${location.y}|${location.z}`;
}

function sameLocation(left, right) {
  return left?.x === right?.x && left?.y === right?.y && left?.z === right?.z;
}

function cleanLocation(location) {
  return {
    x: Math.floor(location.x),
    y: Math.floor(location.y),
    z: Math.floor(location.z),
  };
}

function shopPropertyId(shopId) {
  return `${SHOP_PROPERTY_PREFIX}${shopId}`;
}

function cleanStoredListings(value) {
  const listings = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return listings;
  for (const [slotText, listing] of Object.entries(value)) {
    const slot = Number(slotText);
    if (
      !Number.isSafeInteger(slot)
      || slot < 0
      || slot >= 54
      || typeof listing?.signature !== "string"
      || listing.signature.length < 1
      || listing.signature.length > 160
      || typeof listing.unsold !== "boolean"
      || (!listing.unsold && (
        !Number.isSafeInteger(listing.price)
        || listing.price <= 0
        || !Number.isSafeInteger(listing.quantity)
        || listing.quantity <= 0
        || listing.quantity > MAX_DEFAULT_QUANTITY
      ))
    ) continue;
    listings[slot] = listing.unsold
      ? { signature: listing.signature, unsold: true }
      : {
        signature: listing.signature,
        unsold: false,
        price: listing.price,
        quantity: listing.quantity,
      };
  }
  return listings;
}

function parseShop(propertyId, raw) {
  if (typeof raw !== "string") return undefined;
  try {
    const shop = JSON.parse(raw);
    if (
      shop?.version !== 1
      || typeof shop.id !== "string"
      || propertyId !== shopPropertyId(shop.id)
      || typeof shop.ownerId !== "string"
      || typeof shop.ownerName !== "string"
      || typeof shop.dimensionId !== "string"
      || !shop.signLocation
      || !Array.isArray(shop.containerLocations)
      || shop.containerLocations.length < 1
      || shop.containerLocations.length > 2
      || typeof shop.name !== "string"
      || shop.name.length < 1
      || shop.name.length > MAX_SHOP_NAME_LENGTH
      || !(shop.defaultPrice === undefined || (Number.isSafeInteger(shop.defaultPrice) && shop.defaultPrice > 0))
      || !(shop.defaultQuantity === undefined || (Number.isSafeInteger(shop.defaultQuantity) && shop.defaultQuantity > 0))
    ) return undefined;
    return {
      ...shop,
      propertyId,
      signLocation: cleanLocation(shop.signLocation),
      containerLocations: shop.containerLocations.map(cleanLocation),
      listings: cleanStoredListings(shop.listings),
    };
  } catch {
    return undefined;
  }
}

function indexShop(shop) {
  shopsById.set(shop.id, shop);
  shopsBySign.set(locationKey(shop.dimensionId, shop.signLocation), shop.id);
  for (const location of shop.containerLocations) {
    shopsByContainer.set(locationKey(shop.dimensionId, location), shop.id);
  }
}

function unindexShop(shop) {
  shopsById.delete(shop.id);
  shopsBySign.delete(locationKey(shop.dimensionId, shop.signLocation));
  for (const location of shop.containerLocations) {
    shopsByContainer.delete(locationKey(shop.dimensionId, location));
  }
}

function loadShops() {
  if (shopsLoaded) return;
  const propertyIds = world.getDynamicPropertyIds();
  shopsLoaded = true;
  for (const propertyId of propertyIds) {
    if (!propertyId.startsWith(SHOP_PROPERTY_PREFIX)) continue;
    const shop = parseShop(propertyId, world.getDynamicProperty(propertyId));
    if (shop) indexShop(shop);
  }
}

function saveShop(shop) {
  const stored = { ...shop };
  delete stored.propertyId;
  world.setDynamicProperty(shop.propertyId, JSON.stringify(stored));
  unindexShop(shop);
  indexShop(shop);
}

function deleteShop(shop) {
  world.setDynamicProperty(shop.propertyId, undefined);
  unindexShop(shop);
  ownerStockSessions.delete(shop.id);
}

function beginOwnerStockSession(player, shop, active = false) {
  ownerStockSessions.set(shop.id, {
    playerId: player.id,
    active,
    expiresAt: system.currentTick + (
      active ? ACTIVE_STOCK_SESSION_TICKS : PENDING_STOCK_SESSION_TICKS
    ),
  });
}

function hasActiveStockSession(shopId) {
  const session = ownerStockSessions.get(shopId);
  if (!session) return false;
  if (system.currentTick <= session.expiresAt) return true;
  ownerStockSessions.delete(shopId);
  return false;
}

function getShopBySign(block) {
  loadShops();
  const id = shopsBySign.get(locationKey(block.dimension.id, block.location));
  return id ? shopsById.get(id) : undefined;
}

function getShopByContainer(block) {
  loadShops();
  const id = shopsByContainer.get(locationKey(block.dimension.id, block.location));
  return id ? shopsById.get(id) : undefined;
}

function getShopAtLocation(dimensionId, location) {
  loadShops();
  const key = locationKey(dimensionId, location);
  const id = shopsBySign.get(key) ?? shopsByContainer.get(key);
  return id ? shopsById.get(id) : undefined;
}

function getDimension(shop) {
  try {
    return world.getDimension(shop.dimensionId);
  } catch {
    return undefined;
  }
}

function getShopBlock(shop, location) {
  try {
    return getDimension(shop)?.getBlock(location);
  } catch {
    return undefined;
  }
}

function getShopContainer(shop) {
  for (const location of shop.containerLocations) {
    const block = getShopBlock(shop, location);
    try {
      const container = block?.getComponent("minecraft:inventory")?.container;
      if (container?.isValid) return container;
    } catch {
      // Try the other half of a double chest.
    }
  }
  return undefined;
}

function isSupportedContainer(block) {
  const typeId = block?.typeId ?? "";
  if (
    typeId !== "minecraft:barrel"
    && typeId !== "minecraft:chest"
    && typeId !== "minecraft:trapped_chest"
    && !typeId.includes("copper_chest")
  ) return false;
  try {
    const container = block.getComponent("minecraft:inventory")?.container;
    return Boolean(container?.isValid && (container.size === 27 || container.size === 54));
  } catch {
    return false;
  }
}

function adjacentBlocks(block) {
  const results = [];
  for (const offset of ADJACENT_OFFSETS) {
    try {
      const candidate = block.dimension.getBlock({
        x: block.location.x + offset.x,
        y: block.location.y + offset.y,
        z: block.location.z + offset.z,
      });
      if (candidate) results.push(candidate);
    } catch {
      // Ignore unloaded or out-of-range neighbors.
    }
  }
  return results;
}

function getContainerParts(block, container) {
  const parts = [cleanLocation(block.location)];
  if (container.size !== 54) return parts;
  for (const candidate of adjacentBlocks(block)) {
    if (candidate.typeId !== block.typeId) continue;
    try {
      const other = candidate.getComponent("minecraft:inventory")?.container;
      if (other?.isValid && other.size === 54) {
        parts.push(cleanLocation(candidate.location));
        break;
      }
    } catch {
      // Keep the known half; validation will reject an incomplete double chest.
    }
  }
  return parts;
}

function findAttachedContainer(signBlock) {
  const matches = adjacentBlocks(signBlock).filter(isSupportedContainer);
  if (matches.length !== 1) return undefined;
  const block = matches[0];
  const container = block.getComponent("minecraft:inventory")?.container;
  const locations = getContainerParts(block, container);
  if (container.size === 54 && locations.length !== 2) return undefined;
  return { block, container, locations };
}

function hasAdjacentHopper(dimension, locations) {
  for (const location of locations) {
    for (const offset of ADJACENT_OFFSETS) {
      try {
        const block = dimension.getBlock({
          x: location.x + offset.x,
          y: location.y + offset.y,
          z: location.z + offset.z,
        });
        if (block?.typeId === "minecraft:hopper") return true;
      } catch {
        // Ignore unloaded neighbors during registration validation.
      }
    }
  }
  return false;
}

function readChestShopTrigger(block) {
  const sign = block.getComponent("minecraft:sign");
  if (!sign) return false;
  for (const side of [SignSide.Front, SignSide.Back]) {
    const text = sign.getText(side);
    if (typeof text !== "string") continue;
    const lines = text.split(/\r?\n/);
    if (lines[0] === "!ChestShop" && lines.slice(1).every((line) => !line.trim())) {
      return true;
    }
  }
  return false;
}

function splitShopName(name) {
  if (name.length <= 18) return [name, ""];
  let splitAt = name.lastIndexOf(" ", 18);
  if (splitAt < 8) splitAt = 18;
  return [name.slice(0, splitAt).trim(), name.slice(splitAt).trim().slice(0, 18)];
}

function decorateShopSign(shop) {
  try {
    const block = getShopBlock(shop, shop.signLocation);
    const sign = block?.getComponent("minecraft:sign");
    if (!sign) return;
    const [line2, line3] = splitShopName(shop.name);
    const text = ["!ChestShop", line2, line3, ""].join("\n");
    sign.setText(text, SignSide.Front);
    sign.setText(text, SignSide.Back);
  } catch {
    // The sign may have been unloaded or removed before this update.
  }
}

function formatAmount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatItemType(typeId) {
  return typeId.replace(/^minecraft:/, "").split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function getItemName(item) {
  return item.nameTag?.trim() || formatItemType(item.typeId);
}

function getItemIconPath(item) {
  if (item.typeId === "moolah:moolah_pouch") return "textures/items/moolah_pouch";
  if (!item.typeId.startsWith("minecraft:")) return "textures/ui/moolah/market";
  const textureName = item.typeId.slice("minecraft:".length);
  try {
    return item.hasComponent("minecraft:block_placer")
      ? `textures/blocks/${textureName}`
      : `textures/items/${textureName}`;
  } catch {
    return "textures/ui/moolah/market";
  }
}

function componentSnapshot(item, componentId, propertyNames) {
  try {
    const component = item.getComponent(componentId);
    if (!component) return undefined;
    const result = {};
    for (const propertyName of propertyNames) {
      try {
        const value = component[propertyName];
        if (value === undefined || typeof value === "function") continue;
        result[propertyName] = value?.id ?? value;
      } catch {
        // Ignore component fields unavailable for this item.
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

function hashText(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function readItemValue(callback, fallback) {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function itemSignature(item, depth = 0) {
  try {
    const dynamicProperties = {};
    for (const propertyId of readItemValue(() => item.getDynamicPropertyIds(), [])) {
      dynamicProperties[propertyId] = readItemValue(
        () => item.getDynamicProperty(propertyId),
        undefined,
      );
    }
    const enchantments = [];
    try {
      for (const enchantment of item.getComponent("minecraft:enchantable")?.getEnchantments() ?? []) {
        enchantments.push(`${enchantment.type.id}:${enchantment.level}`);
      }
      enchantments.sort();
    } catch {
      // The item has no readable enchantments.
    }
    const nestedItems = [];
    if (depth < 2) {
      try {
        const nested = item.getComponent("minecraft:inventory")?.container;
        if (nested?.isValid) {
          for (let slot = 0; slot < nested.size; slot++) {
            const child = nested.getItem(slot);
            nestedItems.push(child ? itemSignature(child, depth + 1) : "");
          }
        }
      } catch {
        // Most items do not contain an inventory.
      }
    }
    const details = JSON.stringify({
      typeId: item.typeId,
      nameTag: readItemValue(() => item.nameTag, "") ?? "",
      lore: readItemValue(() => item.getLore(), []),
      rawLore: readItemValue(() => item.getRawLore(), []),
      canDestroy: readItemValue(() => item.getCanDestroy(), []),
      canPlaceOn: readItemValue(() => item.getCanPlaceOn(), []),
      keepOnDeath: readItemValue(() => item.keepOnDeath, false),
      lockMode: readItemValue(() => item.lockMode, "none"),
      weight: readItemValue(() => item.weight, 0),
      dynamicProperties,
      enchantments,
      book: componentSnapshot(item, "minecraft:book", [
        "author",
        "contents",
        "rawContents",
        "isSigned",
        "pageCount",
        "title",
      ]),
      durability: componentSnapshot(item, "minecraft:durability", ["damage", "maxDurability"]),
      dyeable: componentSnapshot(item, "minecraft:dyeable", ["color", "defaultColor"]),
      map: componentSnapshot(item, "minecraft:map", ["mapId", "isLocked", "isExplorationMap"]),
      potion: componentSnapshot(item, "minecraft:potion", [
        "potionEffectType",
        "potionLiquidType",
        "potionModifierType",
      ]),
      nestedItems,
    });
    return `${item.typeId}|${hashText(details, 2166136261)}${hashText(details, 3339675911)}`;
  } catch {
    return `${item?.typeId ?? "unknown"}|unreadable`;
  }
}

function sameBaseItem(left, right) {
  try {
    if (left.typeId !== right.typeId) return false;
    if (left.isStackable && right.isStackable) return left.isStackableWith(right);
    return itemSignature(left) === itemSignature(right);
  } catch {
    return false;
  }
}

function listingFor(signature, price, quantity) {
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(quantity)) {
    return { signature, unsold: true };
  }
  return { signature, unsold: false, price, quantity };
}

function normalizeShopItems(shop, promptOwner) {
  if (reconciliationLocks.has(shop.id)) return;
  const container = getShopContainer(shop);
  if (!container?.isValid) return;
  const previousListings = cleanStoredListings(shop.listings);
  const nextListings = {};
  const usedPreviousSlots = new Set();
  const promptSlots = [];

  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    if (!item) continue;
    const signature = itemSignature(item);
    let listing = previousListings[slot];
    let reusedMatchingPrice = false;

    if (listing?.signature === signature) {
      usedPreviousSlots.add(String(slot));
    } else {
      listing = undefined;
      for (const [previousSlot, candidate] of Object.entries(previousListings)) {
        if (usedPreviousSlots.has(previousSlot) || candidate.signature !== signature) continue;
        listing = candidate;
        usedPreviousSlots.add(previousSlot);
        break;
      }
    }

    if (!listing) {
      for (const [pricedSlot, candidate] of Object.entries(nextListings)) {
        if (candidate.unsold) continue;
        const pricedItem = container.getItem(Number(pricedSlot));
        if (pricedItem && sameBaseItem(pricedItem, item)) {
          listing = listingFor(signature, candidate.price, candidate.quantity);
          reusedMatchingPrice = true;
          break;
        }
      }
    }

    if (!listing) {
      listing = listingFor(signature, shop.defaultPrice, shop.defaultQuantity);
      if (promptOwner) promptSlots.push(slot);
    } else if (listing.unsold && promptOwner) {
      promptSlots.push(slot);
    }
    nextListings[slot] = { ...listing, signature };
    if (reusedMatchingPrice) nextListings[slot].unsold = false;
  }

  if (JSON.stringify(previousListings) !== JSON.stringify(nextListings)) {
    shop = { ...shop, listings: nextListings };
    saveShop(shop);
  }
  if (promptOwner && promptSlots.length > 0) {
    const owner = getMoolahPlayers().find((player) => player.id === shop.ownerId);
    if (owner) promptListingSlots(owner, shop.id, promptSlots, 0);
  }
}

function promptListingSlots(player, shopId, slots, index) {
  const shop = shopsById.get(shopId);
  const container = shop && getShopContainer(shop);
  if (!shop || !container?.isValid || index >= slots.length || player.id !== shop.ownerId) return;
  const slot = slots[index];
  const item = container.getItem(slot);
  const listing = shop.listings?.[slot];
  const signature = item && itemSignature(item);
  if (!item || !listing || listing.signature !== signature) {
    promptListingSlots(player, shopId, slots, index + 1);
    return;
  }
  const form = new ModalFormData()
    .title(`List ${getItemName(item)}`)
    .label(`${item.amount} item${item.amount === 1 ? "" : "s"} in this stack.`)
    .textField("Price (Moolah)", "Positive whole number", {
      defaultValue: listing.price ? String(listing.price) : (shop.defaultPrice ? String(shop.defaultPrice) : ""),
    })
    .textField("Quantity per Purchase", "1 or more", {
      defaultValue: listing.quantity ? String(listing.quantity) : (shop.defaultQuantity ? String(shop.defaultQuantity) : "1"),
    })
    .submitButton("List Item");
  reconciliationLocks.add(shop.id);
  form.show(player).then((response) => {
    reconciliationLocks.delete(shop.id);
    if (!response.canceled && response.formValues) {
      const priceText = typeof response.formValues[1] === "string" ? response.formValues[1].trim() : "";
      const quantityText = typeof response.formValues[2] === "string" ? response.formValues[2].trim() : "";
      const price = Number(priceText);
      const quantity = Number(quantityText);
      const currentShop = shopsById.get(shopId);
      const currentContainer = currentShop && getShopContainer(currentShop);
      const current = currentContainer?.getItem(slot);
      const currentSignature = current && itemSignature(current);
      if (
        /^\d+$/.test(priceText)
        && /^\d+$/.test(quantityText)
        && Number.isSafeInteger(price)
        && price > 0
        && Number.isSafeInteger(quantity)
        && quantity > 0
        && quantity <= MAX_DEFAULT_QUANTITY
        && currentShop
        && current
        && currentShop.listings?.[slot]?.signature === currentSignature
      ) {
        saveShop({
          ...currentShop,
          listings: {
            ...currentShop.listings,
            [slot]: listingFor(currentSignature, price, quantity),
          },
        });
      } else if (!response.canceled) {
        player.sendMessage("The item remains Unsold because its price, quantity, or slot changed.");
      }
    }
    system.run(() => promptListingSlots(player, shopId, slots, index + 1));
  }).catch(() => {
    reconciliationLocks.delete(shop.id);
    player.sendMessage("The item remains Unsold because the listing menu could not be opened.");
    system.run(() => promptListingSlots(player, shopId, slots, index + 1));
  });
}

function openShopConfig(player, shopId) {
  const shop = shopsById.get(shopId);
  if (!shop || player.id !== shop.ownerId) return;
  const form = new ModalFormData()
    .title("Chest Shop Settings")
    .textField("Shop Name", `1-${MAX_SHOP_NAME_LENGTH} characters`, {
      defaultValue: shop.name,
    })
    .textField("Default Item Price", "Blank for no default", {
      defaultValue: shop.defaultPrice ? String(shop.defaultPrice) : "",
    })
    .textField("Default Purchase Quantity", "Blank for no default", {
      defaultValue: shop.defaultQuantity ? String(shop.defaultQuantity) : "",
    })
    .label("Matching items reuse existing pricing. Items without matching or default pricing are marked Unsold.")
    .submitButton("Save Shop Settings");
  form.show(player).then((response) => {
    if (response.canceled || !response.formValues) return;
    const current = shopsById.get(shopId);
    if (!current || current.ownerId !== player.id) return;
    const name = typeof response.formValues[0] === "string" ? response.formValues[0].trim() : "";
    const priceText = typeof response.formValues[1] === "string" ? response.formValues[1].trim() : "";
    const quantityText = typeof response.formValues[2] === "string" ? response.formValues[2].trim() : "";
    const hasDefaults = priceText !== "" || quantityText !== "";
    const defaultPrice = priceText === "" ? undefined : Number(priceText);
    const defaultQuantity = quantityText === "" ? undefined : Number(quantityText);
    if (
      !name
      || name.length > MAX_SHOP_NAME_LENGTH
      || /[\r\n§]/.test(name)
      || (hasDefaults && (
        !/^\d+$/.test(priceText)
        || !/^\d+$/.test(quantityText)
        || !Number.isSafeInteger(defaultPrice)
        || defaultPrice <= 0
        || !Number.isSafeInteger(defaultQuantity)
        || defaultQuantity <= 0
        || defaultQuantity > MAX_DEFAULT_QUANTITY
      ))
    ) {
      player.sendMessage("The Chest Shop settings were invalid. Enter both defaults or leave both blank.");
      return;
    }
    const updated = {
      ...current,
      name,
      defaultPrice: hasDefaults ? defaultPrice : undefined,
      defaultQuantity: hasDefaults ? defaultQuantity : undefined,
    };
    saveShop(updated);
    decorateShopSign(updated);
    normalizeShopItems(updated, false);
    player.sendMessage("Chest Shop settings saved.");
    writeAuditLog("chest_shop", "Chest Shop Updated", player, `${updated.name}; defaults ${updated.defaultPrice ? `${updated.defaultPrice} Moolah per ${updated.defaultQuantity}` : "disabled"}.`);
  }).catch(() => player.sendMessage("The Chest Shop settings menu could not be opened."));
}

function snapshotInventory(container) {
  const items = [];
  for (let slot = 0; slot < container.size; slot++) items.push(container.getItem(slot)?.clone());
  return items;
}

function restoreInventory(container, snapshot) {
  for (let slot = 0; slot < snapshot.length; slot++) container.setItem(slot, snapshot[slot]);
}

function buyListing(buyer, shopId, slot, expectedPrice, expectedQuantity, expectedSignature) {
  if (transactionLocks.has(shopId)) {
    buyer.sendMessage("That Chest Shop is busy. Try again.");
    return;
  }
  transactionLocks.add(shopId);
  try {
    const settings = getEconomySettings();
    const shop = shopsById.get(shopId);
    if (!settings.allowChestShops || !shop) throw new Error("That Chest Shop is no longer available.");
    if (shop.ownerId === buyer.id) throw new Error("You cannot buy from your own Chest Shop.");
    const container = getShopContainer(shop);
    const buyerInventory = buyer.getComponent("minecraft:inventory")?.container;
    if (!container?.isValid || !buyerInventory?.isValid) throw new Error("The shop or your inventory is unavailable.");
    const stock = container.getItem(slot);
    const listing = shop.listings?.[slot];
    const currentSignature = stock && itemSignature(stock);
    if (
      !stock
      || !listing
      || listing.unsold
      || listing.price !== expectedPrice
      || listing.quantity !== expectedQuantity
      || listing.signature !== expectedSignature
      || currentSignature !== listing.signature
      || stock.amount < listing.quantity
    ) throw new Error("That stock changed before the purchase completed.");
    const tax = calculateTax(listing.price, settings.chestShopTaxRate);
    const total = listing.price + tax;
    if (!Number.isSafeInteger(total)) throw new Error("That purchase total is too large.");
    if (getBalance(buyer) < total) throw new Error(`You need ${MINECOIN_GLYPH}${formatAmount(total)} to buy this item.`);

    const buyerSnapshot = snapshotInventory(buyerInventory);
    const stockSnapshot = stock.clone();
    const delivery = stock.clone();
    delivery.amount = listing.quantity;
    addBalance(buyer, -total);
    let shopMetadataChanged = false;
    try {
      if (stock.amount === listing.quantity) {
        container.setItem(slot);
        const nextListings = { ...shop.listings };
        delete nextListings[slot];
        saveShop({ ...shop, listings: nextListings });
        shopMetadataChanged = true;
      } else {
        stock.amount -= listing.quantity;
        container.setItem(slot, stock);
      }
      const remainder = buyerInventory.addItem(delivery);
      if (remainder) throw new Error("You do not have enough inventory space for this purchase.");
      const onlineOwner = getMoolahPlayers().find((player) => player.id === shop.ownerId);
      const sellerName = onlineOwner?.name ?? shop.ownerName;
      if (!createSystemInboxPayment(
        sellerName,
        listing.price,
        `Chest Shop sale: ${listing.quantity}x ${getItemName(delivery)} to ${buyer.name}`,
      )) throw new Error("The seller payment could not be secured.");
    } catch (error) {
      let rollbackFailed = false;
      try {
        container.setItem(slot, stockSnapshot);
      } catch {
        rollbackFailed = true;
      }
      try {
        restoreInventory(buyerInventory, buyerSnapshot);
      } catch {
        rollbackFailed = true;
      }
      if (shopMetadataChanged) {
        try {
          saveShop(shop);
        } catch {
          rollbackFailed = true;
        }
      }
      try {
        addBalance(buyer, total);
      } catch {
        rollbackFailed = true;
      }
      if (rollbackFailed) {
        console.error(`[Moolah Chest Shop] Purchase rollback failed for ${buyer.name} at ${shop.name}.`);
      }
      throw error;
    }
    try {
      addToTaxPool(tax);
    } catch (error) {
      console.error(`[Moolah Chest Shop] Could not add ${tax} sales tax to the Tax Pool: ${error?.stack ?? error}`);
    }
    buyer.sendMessage(`Purchased ${listing.quantity}x ${getItemName(delivery)} from ${shop.name} for ${MINECOIN_GLYPH}${formatAmount(total)}${tax ? ` (${MINECOIN_GLYPH}${formatAmount(tax)} tax)` : ""}. Sales are final.`);
    const owner = getMoolahPlayers().find((player) => player.id === shop.ownerId);
    owner?.sendMessage(`${listing.quantity}x ${getItemName(delivery)} sold at ${shop.name} for ${MINECOIN_GLYPH}${formatAmount(listing.price)}. The payment is in your Inbox.`);
    writeAuditLog("chest_shop", "Chest Shop Purchase", buyer, `${listing.quantity}x ${getItemName(delivery)} from ${shop.ownerName} at ${shop.name}; price ${listing.price}; tax ${tax}; total ${total}.`);
  } catch (error) {
    buyer.sendMessage(error?.message ?? "The purchase could not be completed. No funds were moved.");
  } finally {
    transactionLocks.delete(shopId);
  }
}

function confirmPurchase(player, shopId, slot, listing, item) {
  const settings = getEconomySettings();
  const tax = calculateTax(listing.price, settings.chestShopTaxRate);
  const total = listing.price + tax;
  const form = new MessageFormData()
    .title("Confirm Purchase")
    .body(
      `${listing.quantity}x ${getItemName(item)}\n`
      + `Price: ${MINECOIN_GLYPH}${formatAmount(listing.price)}\n`
      + `Sales tax: ${MINECOIN_GLYPH}${formatAmount(tax)}\n`
      + `Total: ${MINECOIN_GLYPH}${formatAmount(total)}\n\n`
      + "Payments are non-refundable and items cannot be returned.",
    )
    .button1("Buy")
    .button2("Cancel");
  form.show(player).then((response) => {
    if (!response.canceled && response.selection === 0) {
      system.run(() => buyListing(
        player,
        shopId,
        slot,
        listing.price,
        listing.quantity,
        listing.signature,
      ));
    }
  }).catch(() => player.sendMessage("The purchase confirmation could not be opened."));
}

function openChestShop(player, shopId) {
  let shop = shopsById.get(shopId);
  if (!shop || !getEconomySettings().allowChestShops) {
    player.sendMessage("Chest Shops are currently disabled.");
    return;
  }
  normalizeShopItems(shop, false);
  shop = shopsById.get(shopId);
  if (!shop) {
    player.sendMessage("That Chest Shop is no longer available.");
    return;
  }
  const container = getShopContainer(shop);
  if (!container?.isValid) {
    player.sendMessage("That Chest Shop is unavailable.");
    return;
  }
  const listings = [];
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    const listing = shop.listings?.[slot];
    if (
      item
      && listing
      && listing.signature === itemSignature(item)
      && !listing.unsold
      && item.amount >= listing.quantity
    ) {
      listings.push({ slot, item, listing });
    }
  }
  const form = new ActionFormData()
    .title(shop.name)
    .body(listings.length ? `Owned by ${shop.ownerName}. Choose an item to buy.` : "No items are currently for sale.");
  for (const entry of listings) {
    const purchases = Math.floor(entry.item.amount / entry.listing.quantity);
    form.button(
      `${entry.listing.quantity}x ${getItemName(entry.item)} — ${MINECOIN_GLYPH}${formatAmount(entry.listing.price)}\n`
        + `${entry.item.amount} in slot • ${purchases} purchase${purchases === 1 ? "" : "s"}`,
      getItemIconPath(entry.item),
    );
  }
  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) return;
    const selected = listings[response.selection];
    if (!selected) return;
    system.run(() => confirmPurchase(player, shopId, selected.slot, selected.listing, selected.item));
  }).catch(() => player.sendMessage("The Chest Shop menu could not be opened."));
}

function registerShop(player, signBlock, attached, fee) {
  const settings = getEconomySettings();
  if (!settings.allowChestShops) {
    player.sendMessage("Chest Shops are currently disabled.");
    return;
  }
  if (!readChestShopTrigger(signBlock)) {
    player.sendMessage("The sign must contain !ChestShop as its first and only line.");
    return;
  }
  const currentAttached = findAttachedContainer(signBlock);
  if (
    !currentAttached
    || !sameLocation(currentAttached.block.location, attached.locations[0])
    || currentAttached.container.size !== attached.container.size
  ) {
    player.sendMessage("The sign or container changed. Use the sign again to restart registration.");
    return;
  }
  attached = currentAttached;
  if (!isSupportedContainer(attached.block) || getShopByContainer(attached.block)) {
    player.sendMessage("That container cannot be registered as a Chest Shop.");
    return;
  }
  if (hasAdjacentHopper(signBlock.dimension, attached.locations)) {
    player.sendMessage("A hopper was connected before registration finished. Remove it and use the sign again.");
    return;
  }
  const currentFee = settings.chargeChestShopRegistrationFee
    ? settings.chestShopRegistrationFee * (attached.container.size === 54 ? 2 : 1)
    : 0;
  if (!Number.isSafeInteger(currentFee) || currentFee !== fee) {
    player.sendMessage("Chest Shop fees changed. Use the sign again to review the current fee.");
    return;
  }
  if (fee > 0 && getBalance(player) < fee) {
    player.sendMessage(`You need ${MINECOIN_GLYPH}${formatAmount(fee)} to register this Chest Shop.`);
    return;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const shop = {
    propertyId: shopPropertyId(id),
    version: 1,
    id,
    ownerId: player.id,
    ownerName: player.name,
    dimensionId: signBlock.dimension.id,
    signLocation: cleanLocation(signBlock.location),
    containerLocations: attached.locations,
    name: `${player.name}'s Shop`.slice(0, MAX_SHOP_NAME_LENGTH),
    defaultPrice: undefined,
    defaultQuantity: undefined,
    listings: {},
    registeredAt: Date.now(),
  };
  if (fee > 0) addBalance(player, -fee);
  try {
    const { propertyId, ...storedShop } = shop;
    world.setDynamicProperty(shop.propertyId, JSON.stringify(storedShop));
    indexShop(shop);
  } catch (error) {
    if (fee > 0) addBalance(player, fee);
    player.sendMessage("The Chest Shop could not be registered. No fee was charged.");
    return;
  }
  try {
    addToTaxPool(fee);
  } catch (error) {
    console.error(`[Moolah Chest Shop] Could not add the ${fee} registration fee to the Tax Pool: ${error?.stack ?? error}`);
  }
  decorateShopSign(shop);
  normalizeShopItems(shop, true);
  player.sendMessage(`${shop.name} registered${fee ? ` for ${MINECOIN_GLYPH}${formatAmount(fee)}` : ""}. Right-click the sign to configure it.`);
  writeAuditLog("chest_shop", "Chest Shop Registered", player, `${shop.name}; ${attached.container.size === 54 ? "double chest" : attached.block.typeId}; fee ${fee}.`);
}

function beginRegistration(player, signBlock) {
  const settings = getEconomySettings();
  if (!settings.allowChestShops) {
    player.sendMessage("Chest Shops are currently disabled.");
    return;
  }
  const attached = findAttachedContainer(signBlock);
  if (!attached) {
    player.sendMessage("Place this sign directly beside one supported chest or barrel.");
    return;
  }
  if (getShopByContainer(attached.block)) {
    player.sendMessage("That container is already registered as a Chest Shop.");
    return;
  }
  if (hasAdjacentHopper(signBlock.dimension, attached.locations)) {
    player.sendMessage("Remove connected hoppers before registration. The owner can reconnect them after the Chest Shop is active.");
    return;
  }
  const fee = settings.chargeChestShopRegistrationFee
    ? settings.chestShopRegistrationFee * (attached.container.size === 54 ? 2 : 1)
    : 0;
  if (!Number.isSafeInteger(fee)) {
    player.sendMessage("The configured registration fee is too large.");
    return;
  }
  if (fee <= 0) {
    registerShop(player, signBlock, attached, 0);
    return;
  }
  const form = new MessageFormData()
    .title("Register Chest Shop")
    .body(`Register this ${attached.container.size === 54 ? "double chest" : "container"} for ${MINECOIN_GLYPH}${formatAmount(fee)}? The fee is sent to the Tax Pool.`)
    .button1("Register")
    .button2("Cancel");
  form.show(player).then((response) => {
    if (!response.canceled && response.selection === 0) {
      system.run(() => registerShop(player, signBlock, attached, fee));
    }
  }).catch(() => player.sendMessage("The Chest Shop confirmation could not be opened."));
}

function removeShop(shop, actor) {
  deleteShop(shop);
  writeAuditLog("chest_shop", "Chest Shop Removed", actor, `${shop.name}; owner ${shop.ownerName}.`);
}

function isAdjacentProtectedHopper(block, shop) {
  if (block.typeId !== "minecraft:hopper") return false;
  return shop.containerLocations.some((location) => (
    Math.abs(location.x - block.location.x)
      + Math.abs(location.y - block.location.y)
      + Math.abs(location.z - block.location.z) === 1
  ));
}

function findShopProtectingHopper(block) {
  loadShops();
  for (const shop of shopsById.values()) {
    if (shop.dimensionId === block.dimension.id && isAdjacentProtectedHopper(block, shop)) return shop;
  }
  return undefined;
}

function getPlacementLocation(event) {
  const offsets = {
    down: { x: 0, y: -1, z: 0 },
    east: { x: 1, y: 0, z: 0 },
    north: { x: 0, y: 0, z: -1 },
    south: { x: 0, y: 0, z: 1 },
    up: { x: 0, y: 1, z: 0 },
    west: { x: -1, y: 0, z: 0 },
  };
  const offset = offsets[String(event.blockFace).toLowerCase()];
  if (!offset) return undefined;
  return {
    x: event.block.location.x + offset.x,
    y: event.block.location.y + offset.y,
    z: event.block.location.z + offset.z,
  };
}

function findShopAdjacentToLocation(dimensionId, location) {
  loadShops();
  for (const shop of shopsById.values()) {
    if (shop.dimensionId !== dimensionId) continue;
    if (shop.containerLocations.some((containerLocation) => (
      Math.abs(containerLocation.x - location.x)
        + Math.abs(containerLocation.y - location.y)
        + Math.abs(containerLocation.z - location.z) === 1
    ))) return shop;
  }
  return undefined;
}

function reconcileLoadedShops() {
  if (!getEconomySettings().allowChestShops) return;
  loadShops();
  for (const shop of shopsById.values()) {
    try {
      if (hasActiveStockSession(shop.id)) continue;
      const sign = getShopBlock(shop, shop.signLocation);
      const container = getShopContainer(shop);
      if (!sign?.getComponent("minecraft:sign") || !container?.isValid) continue;
      normalizeShopItems(shop, false);
    } catch {
      // Unloaded shops are skipped until their chunks are active again.
    }
  }
}

export function isChestShopPublicInteractionBlock(block) {
  return Boolean(getShopByContainer(block) || getShopBySign(block));
}

export function initializeChestShopSystem() {
  if (initialized) return;
  initialized = true;
  system.run(() => {
    try {
      loadShops();
    } catch (error) {
      console.warn(`[Moolah Chest Shop] Could not load shops after startup: ${error?.stack ?? error}`);
    }
  });

  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    if (event.cancel || !event.isFirstEvent || !isMoolahPlayer(event.player)) return;
    if (event.itemStack?.typeId === "minecraft:hopper") {
      const placementLocation = getPlacementLocation(event);
      const protectedShop = placementLocation
        ? findShopAdjacentToLocation(event.block.dimension.id, placementLocation)
        : undefined;
      if (protectedShop && event.player.id !== protectedShop.ownerId) {
        event.cancel = true;
        system.run(() => event.player.sendMessage(`Only ${protectedShop.ownerName} can connect a hopper to this Chest Shop.`));
        return;
      }
    }
    const signShop = getShopBySign(event.block);
    if (signShop) {
      event.cancel = true;
      system.run(() => {
        if (event.player.id === signShop.ownerId) openShopConfig(event.player, signShop.id);
        else openChestShop(event.player, signShop.id);
      });
      return;
    }
    if (readChestShopTrigger(event.block)) {
      event.cancel = true;
      system.run(() => {
        try {
          if (event.cancel) beginRegistration(event.player, event.block);
        } catch {
          // The sign or player may no longer be available.
        }
      });
      return;
    }
    const containerShop = getShopByContainer(event.block);
    if (containerShop) {
      if (event.player.id === containerShop.ownerId) {
        beginOwnerStockSession(event.player, containerShop);
      } else {
        event.cancel = true;
        system.run(() => openChestShop(event.player, containerShop.id));
        return;
      }
    }
    const hopperShop = findShopProtectingHopper(event.block);
    if (hopperShop && event.player.id !== hopperShop.ownerId) {
      event.cancel = true;
      system.run(() => event.player.sendMessage(`Only ${hopperShop.ownerName} can use this Chest Shop hopper.`));
    }
  });

  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    if (!isMoolahPlayer(event.player)) return;
    const shop = getShopAtLocation(event.dimension.id, event.block.location)
      ?? findShopProtectingHopper(event.block);
    if (!shop) return;
    if (event.player.id !== shop.ownerId) {
      event.cancel = true;
      system.run(() => event.player.sendMessage(`Only ${shop.ownerName} can break this Chest Shop.`));
      return;
    }
    if (getShopAtLocation(event.dimension.id, event.block.location)) {
      system.run(() => {
        try {
          if (!event.cancel) removeShop(shop, event.player);
        } catch {
          // Another protection may have canceled the break.
        }
      });
    }
  });

  world.beforeEvents.explosion.subscribe((event) => {
    loadShops();
    event.setImpactedBlocks(event.getImpactedBlocks().filter((block) => (
      !getShopAtLocation(block.dimension.id, block.location)
      && !findShopProtectingHopper(block)
    )));
  });

  world.afterEvents.blockContainerOpened.subscribe((event) => {
    const shop = getShopByContainer(event.block);
    const player = event.openSource?.entity;
    if (!shop || player?.typeId !== "minecraft:player" || player.id !== shop.ownerId) return;
    beginOwnerStockSession(player, shop, true);
    system.run(() => {
      try {
        player.onScreenDisplay.setActionBar(`Stocking: ${shop.name}`);
      } catch {
        // The owner may have left before the feedback could be displayed.
      }
    });
  });

  world.afterEvents.blockContainerClosed.subscribe((event) => {
    const shop = getShopByContainer(event.block);
    if (!shop) return;
    const eventPlayer = event.closeSource?.entity;
    const session = ownerStockSessions.get(shop.id);
    const player = eventPlayer?.typeId === "minecraft:player"
      ? eventPlayer
      : getMoolahPlayers().find((candidate) => candidate.id === session?.playerId);
    if (!player || player.id !== shop.ownerId) return;
    ownerStockSessions.delete(shop.id);
    system.run(() => {
      const currentShop = shopsById.get(shop.id);
      if (currentShop) normalizeShopItems(currentShop, true);
    });
  });

  world.afterEvents.playerLeave.subscribe((event) => {
    for (const [shopId, session] of ownerStockSessions) {
      if (session.playerId === event.playerId) ownerStockSessions.delete(shopId);
    }
  });

  system.runInterval(reconcileLoadedShops, 20);
}
