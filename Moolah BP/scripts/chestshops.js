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
const MAX_SHOP_DESCRIPTION_LENGTH = 160;
const MAX_DEFAULT_QUANTITY = 255;
const VANILLA_ITEM_ICON_OVERRIDES = new Map([
  ["minecraft:book", "textures/items/book_normal"],
  ["minecraft:writable_book", "textures/items/book_writable"],
  ["minecraft:written_book", "textures/items/book_written"],
  ["minecraft:enchanted_book", "textures/items/book_enchanted"],
]);
const SHOP_NAME_COLORS = [
  { code: "§0", name: "black" },
  { code: "§1", name: "dark_blue" },
  { code: "§2", name: "dark_green" },
  { code: "§3", name: "dark_aqua" },
  { code: "§4", name: "dark_red" },
  { code: "§5", name: "dark_purple" },
  { code: "§6", name: "gold" },
  { code: "§7", name: "gray" },
  { code: "§8", name: "dark_gray" },
  { code: "§9", name: "blue" },
  { code: "§a", name: "green" },
  { code: "§b", name: "aqua" },
  { code: "§c", name: "red" },
  { code: "§d", name: "light_purple" },
  { code: "§e", name: "yellow" },
  { code: "§f", name: "white" },
  { code: "§h", name: "material_quartz" },
  { code: "§i", name: "material_iron" },
  { code: "§j", name: "material_netherite" },
  { code: "§m", name: "material_redstone" },
  { code: "§n", name: "material_copper" },
  { code: "§p", name: "material_gold" },
  { code: "§q", name: "material_emerald" },
  { code: "§s", name: "material_diamond" },
  { code: "§t", name: "material_lapis" },
  { code: "§u", name: "material_amethyst" },
  { code: "§v", name: "material_resin" },
  { code: "§w", name: "party_blue" },
];
const SHOP_NAME_COLOR_CODES = new Set(SHOP_NAME_COLORS.map(({ code }) => code));
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
      || !(shop.nameColor === undefined || SHOP_NAME_COLOR_CODES.has(shop.nameColor))
      || !(shop.description === undefined || (
        typeof shop.description === "string"
        && shop.description.length > 0
        && shop.description.length <= MAX_SHOP_DESCRIPTION_LENGTH
        && !/[\r\n§]/.test(shop.description)
      ))
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

function formatShopName(shop) {
  return shop.nameColor ? `${shop.nameColor}${shop.name}§r` : shop.name;
}

function setShopSignSideText(sign, side, formattedText, plainText, shop) {
  try {
    sign.setText({ rawtext: [{ text: formattedText }] }, side);
    return true;
  } catch (rawTextError) {
    try {
      sign.setText(formattedText, side);
      return true;
    } catch (formattedError) {
      if (formattedText !== plainText) {
        try {
          sign.setText(plainText, side);
          return true;
        } catch {
          // Report both scripted write failures below.
        }
      }
      console.warn(`[Moolah Chest Shop] Could not update ${shop.name}'s sign at ${shop.dimensionId} ${shop.signLocation.x}, ${shop.signLocation.y}, ${shop.signLocation.z}: ${rawTextError?.stack ?? rawTextError}; fallback: ${formattedError?.stack ?? formattedError}`);
      return false;
    }
  }
}

function shopSignSideMatches(sign, side, expectedText) {
  try {
    const rawText = sign.getRawText(side);
    if (rawText?.rawtext) {
      return rawText.rawtext.map((part) => (
        typeof part?.text === "string" ? part.text : ""
      )).join("") === expectedText;
    }
    return sign.getText(side) === expectedText;
  } catch {
    return false;
  }
}

function verifyShopSign(shop) {
  try {
    const block = getShopBlock(shop, shop.signLocation);
    const sign = block?.getComponent("minecraft:sign");
    if (!sign) return false;
    const [line2, line3] = splitShopName(shop.name);
    const colorLine = (line) => (line && shop.nameColor ? `${shop.nameColor}${line}§r` : line);
    const plainText = ["!ChestShop", line2, line3, ""].join("\n");
    const formattedText = ["!ChestShop", colorLine(line2), colorLine(line3), ""].join("\n");
    const sideMatches = (side) => (
      shopSignSideMatches(sign, side, formattedText)
      || shopSignSideMatches(sign, side, plainText)
    );
    return sideMatches(SignSide.Front) && sideMatches(SignSide.Back);
  } catch {
    return false;
  }
}

function updateShopSignWithFeedback(shop, player) {
  system.run(() => {
    if (!decorateShopSign(shop)) {
      player.sendMessage("Moolah saved the Chest Shop, but its sign rejected the update.");
      return;
    }
    system.runTimeout(() => {
      if (verifyShopSign(shop)) return;
      if (!decorateShopSign(shop)) {
        player.sendMessage("Moolah saved the Chest Shop, but its sign rejected the update.");
        return;
      }
      system.runTimeout(() => {
        if (!verifyShopSign(shop)) {
          player.sendMessage("Moolah saved the Chest Shop, but the Realm did not retain its sign text.");
        }
      }, 20);
    }, 20);
  });
}

function decorateShopSign(shop) {
  let sign;
  try {
    const block = getShopBlock(shop, shop.signLocation);
    sign = block?.getComponent("minecraft:sign");
  } catch (error) {
    console.warn(`[Moolah Chest Shop] Could not access ${shop.name}'s sign at ${shop.dimensionId} ${shop.signLocation.x}, ${shop.signLocation.y}, ${shop.signLocation.z}: ${error?.stack ?? error}`);
    return false;
  }
  if (!sign) {
    console.warn(`[Moolah Chest Shop] Could not find ${shop.name}'s sign at ${shop.dimensionId} ${shop.signLocation.x}, ${shop.signLocation.y}, ${shop.signLocation.z}.`);
    return false;
  }
  const [line2, line3] = splitShopName(shop.name);
  const colorLine = (line) => (line && shop.nameColor ? `${shop.nameColor}${line}§r` : line);
  const plainText = ["!ChestShop", line2, line3, ""].join("\n");
  const formattedText = ["!ChestShop", colorLine(line2), colorLine(line3), ""].join("\n");
  const frontUpdated = setShopSignSideText(
    sign,
    SignSide.Front,
    formattedText,
    plainText,
    shop,
  );
  const backUpdated = setShopSignSideText(
    sign,
    SignSide.Back,
    formattedText,
    plainText,
    shop,
  );
  return frontUpdated && backUpdated;
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

function formatIdentifier(identifier) {
  return String(identifier ?? "")
    .replace(/^[^:]+:/, "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function romanNumeral(value) {
  const numerals = [
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = Number(value);
  let result = "";
  if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 20) {
    return String(value);
  }
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

function cleanDisplayText(value) {
  return String(value ?? "").replace(/§./g, "").replace(/[\r\n]+/g, " ").trim();
}

function getItemVariantDetails(item) {
  const details = [];
  try {
    const potion = item.getComponent("minecraft:potion");
    if (potion) {
      const effect = formatIdentifier(potion.potionEffectType?.id);
      const modifier = formatIdentifier(potion.potionModifierType?.id);
      const liquid = formatIdentifier(potion.potionLiquidType?.id);
      const potionText = [modifier, effect || liquid].filter(Boolean).join(" ");
      if (potionText) details.push(potionText);
    }
  } catch {
    // This item is not a readable potion.
  }
  try {
    const enchantments = item.getComponent("minecraft:enchantable")
      ?.getEnchantments()
      ?.map((enchantment) => (
        `${formatIdentifier(enchantment.type.id)} ${romanNumeral(enchantment.level)}`
      ))
      .sort();
    if (enchantments?.length) details.push(enchantments.join(", "));
  } catch {
    // This item has no readable enchantments.
  }
  try {
    const book = item.getComponent("minecraft:book");
    if (book) {
      const title = cleanDisplayText(book.title);
      const author = cleanDisplayText(book.author);
      if (title) details.push(author ? `“${title}” by ${author}` : `“${title}”`);
      else if (book.pageCount > 0) details.push(`${book.pageCount} page${book.pageCount === 1 ? "" : "s"}`);
    }
  } catch {
    // This item is not a readable book.
  }
  try {
    const durability = item.getComponent("minecraft:durability");
    if (durability?.maxDurability > 0) {
      details.push(`${durability.maxDurability - durability.damage}/${durability.maxDurability} durability`);
    }
  } catch {
    // This item has no durability.
  }
  if (item.nameTag?.trim()) details.push(formatItemType(item.typeId));
  try {
    const lore = item.getLore().map(cleanDisplayText).filter(Boolean);
    if (lore.length) details.push(lore.slice(0, 2).join(" / "));
  } catch {
    // This item has no readable lore.
  }
  try {
    const inventory = item.getComponent("minecraft:inventory")?.container;
    if (inventory?.isValid) {
      let occupied = 0;
      for (let slot = 0; slot < inventory.size; slot++) {
        if (inventory.getItem(slot)) occupied++;
      }
      if (occupied > 0) details.push(`${occupied}/${inventory.size} storage slots filled`);
    }
  } catch {
    // This item does not contain inventory storage.
  }
  return details;
}

function compactItemVariant(item, maxLength = 52) {
  const text = getItemVariantDetails(item).join(" • ");
  if (!text) return "Standard item";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function playChestShopSound(player, soundId) {
  try {
    player.playSound(soundId);
  } catch {
    // Sound feedback should never block the shop UI.
  }
}

function getItemIconPath(item) {
  if (item.typeId === "moolah:moolah_pouch") return "textures/items/moolah_pouch";
  const vanillaOverride = VANILLA_ITEM_ICON_OVERRIDES.get(item.typeId);
  if (vanillaOverride) return vanillaOverride;
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

    if (listing?.unsold) {
      for (const [pricedSlot, candidate] of Object.entries(previousListings)) {
        if (Number(pricedSlot) === slot || candidate.unsold) continue;
        const pricedItem = container.getItem(Number(pricedSlot));
        if (
          pricedItem
          && candidate.signature === signature
          && itemSignature(pricedItem) === signature
        ) {
          listing = listingFor(signature, candidate.price, candidate.quantity);
          reusedMatchingPrice = true;
          break;
        }
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
  if (!listing.unsold) {
    system.run(() => promptListingSlots(player, shopId, slots, index + 1));
    return;
  }
  for (let candidateSlot = 0; candidateSlot < container.size; candidateSlot++) {
    if (candidateSlot === slot) continue;
    const candidateItem = container.getItem(candidateSlot);
    const candidateListing = shop.listings?.[candidateSlot];
    if (
      !candidateItem
      || !candidateListing
      || candidateListing.unsold
      || candidateListing.signature !== signature
      || itemSignature(candidateItem) !== signature
    ) continue;
    saveShop({
      ...shop,
      listings: {
        ...shop.listings,
        [slot]: listingFor(signature, candidateListing.price, candidateListing.quantity),
      },
    });
    system.run(() => promptListingSlots(player, shopId, slots, index + 1));
    return;
  }
  const form = new ModalFormData()
    .title(`List ${getItemName(item)}`)
    .label(
      `Chest slot ${slot + 1}\n`
      + `${item.amount} item${item.amount === 1 ? "" : "s"} in this stack.\n`
      + (getItemVariantDetails(item).join("\n") || "Standard item"),
    )
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
    if (response.canceled || !response.formValues) {
      player.sendMessage("Chest Shop pricing stopped. Remaining items will stay Unsold.");
      return;
    }
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
    } else {
      player.sendMessage("The item remains Unsold because its price, quantity, or slot changed.");
    }
    system.run(() => promptListingSlots(player, shopId, slots, index + 1));
  }).catch(() => {
    reconciliationLocks.delete(shop.id);
    player.sendMessage("Chest Shop pricing stopped because the listing menu could not be opened. Remaining items will stay Unsold.");
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
    .textField("Shop Description", `Blank uses the default (max ${MAX_SHOP_DESCRIPTION_LENGTH} characters)`, {
      defaultValue: shop.description ?? "",
    })
    .dropdown(
      "Shop Name Color",
      ["Default", ...SHOP_NAME_COLORS.map(({ code, name }) => `${name} — ${code}Sample§r`)],
      {
        defaultValueIndex: shop.nameColor
          ? SHOP_NAME_COLORS.findIndex(({ code }) => code === shop.nameColor) + 1
          : 0,
      },
    )
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
    const description = typeof response.formValues[1] === "string"
      ? response.formValues[1].trim()
      : "";
    const colorIndex = response.formValues[2];
    const nameColor = colorIndex === 0 ? undefined : SHOP_NAME_COLORS[colorIndex - 1]?.code;
    const priceText = typeof response.formValues[3] === "string" ? response.formValues[3].trim() : "";
    const quantityText = typeof response.formValues[4] === "string" ? response.formValues[4].trim() : "";
    const hasDefaults = priceText !== "" || quantityText !== "";
    const defaultPrice = priceText === "" ? undefined : Number(priceText);
    const defaultQuantity = quantityText === "" ? undefined : Number(quantityText);
    if (
      !name
      || name.length > MAX_SHOP_NAME_LENGTH
      || /[\r\n§]/.test(name)
      || description.length > MAX_SHOP_DESCRIPTION_LENGTH
      || /[\r\n§]/.test(description)
      || !Number.isSafeInteger(colorIndex)
      || colorIndex < 0
      || colorIndex > SHOP_NAME_COLORS.length
      || (colorIndex > 0 && !nameColor)
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
      description: description || undefined,
      nameColor,
      defaultPrice: hasDefaults ? defaultPrice : undefined,
      defaultQuantity: hasDefaults ? defaultQuantity : undefined,
    };
    saveShop(updated);
    normalizeShopItems(updated, false);
    player.sendMessage("Chest Shop settings saved.");
    updateShopSignWithFeedback(updated, player);
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

function getMatchingStock(shop, container, signature, price, quantity) {
  const matches = [];
  for (let slot = 0; slot < container.size; slot++) {
    const listing = shop.listings?.[slot];
    const item = container.getItem(slot);
    if (
      !item
      || !listing
      || listing.unsold
      || listing.signature !== signature
      || listing.price !== price
      || listing.quantity !== quantity
      || itemSignature(item) !== signature
    ) continue;
    matches.push({ slot, item });
  }
  return matches;
}

function addItemQuantity(container, template, quantity) {
  let maxStackSize = 1;
  try {
    const probe = template.clone();
    probe.amount = 255;
    maxStackSize = probe.amount;
  } catch {
    maxStackSize = 1;
  }
  let remaining = quantity;
  while (remaining > 0) {
    const stack = template.clone();
    stack.amount = Math.min(maxStackSize, remaining);
    const remainder = container.addItem(stack);
    if (remainder) throw new Error("You do not have enough inventory space for this purchase.");
    remaining -= stack.amount;
  }
}

function buyListing(
  buyer,
  shopId,
  expectedPrice,
  expectedQuantity,
  expectedSignature,
  setCount,
) {
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
    const matchingStock = getMatchingStock(
      shop,
      container,
      expectedSignature,
      expectedPrice,
      expectedQuantity,
    );
    if (!Number.isSafeInteger(setCount) || setCount < 1) {
      throw new Error("That purchase quantity is invalid.");
    }
    const itemCount = expectedQuantity * setCount;
    const subtotal = expectedPrice * setCount;
    if (!Number.isSafeInteger(itemCount) || !Number.isSafeInteger(subtotal)) {
      throw new Error("That purchase total is too large.");
    }
    const available = matchingStock.reduce((total, entry) => total + entry.item.amount, 0);
    if (matchingStock.length === 0 || available < itemCount) {
      throw new Error("That stock changed before the purchase completed.");
    }
    const tax = calculateTax(subtotal, settings.chestShopTaxRate);
    const total = subtotal + tax;
    if (!Number.isSafeInteger(total)) throw new Error("That purchase total is too large.");
    if (getBalance(buyer) < total) throw new Error(`You need ${MINECOIN_GLYPH}${formatAmount(total)} to buy this item.`);

    const buyerSnapshot = snapshotInventory(buyerInventory);
    const shopSnapshot = snapshotInventory(container);
    const delivery = matchingStock[0].item.clone();
    addBalance(buyer, -total);
    let shopMetadataChanged = false;
    try {
      let remaining = itemCount;
      const nextListings = { ...shop.listings };
      for (const entry of matchingStock) {
        if (remaining <= 0) break;
        const taken = Math.min(entry.item.amount, remaining);
        if (taken === entry.item.amount) {
          container.setItem(entry.slot);
          delete nextListings[entry.slot];
          shopMetadataChanged = true;
        } else {
          entry.item.amount -= taken;
          container.setItem(entry.slot, entry.item);
        }
        remaining -= taken;
      }
      if (remaining !== 0) throw new Error("The shop stock could not be reserved.");
      if (shopMetadataChanged) saveShop({ ...shop, listings: nextListings });
      addItemQuantity(buyerInventory, delivery, itemCount);
      const onlineOwner = getMoolahPlayers().find((player) => player.id === shop.ownerId);
      const sellerName = onlineOwner?.name ?? shop.ownerName;
      if (!createSystemInboxPayment(
        sellerName,
        subtotal,
        `Chest Shop sale: ${itemCount}x ${getItemName(delivery)} to ${buyer.name}`,
      )) throw new Error("The seller payment could not be secured.");
    } catch (error) {
      let rollbackFailed = false;
      try {
        restoreInventory(container, shopSnapshot);
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
    const setText = expectedQuantity > 1 ? ` (${setCount} set${setCount === 1 ? "" : "s"})` : "";
    buyer.sendMessage(`Purchased ${itemCount}x ${getItemName(delivery)}${setText} from ${formatShopName(shop)} for ${MINECOIN_GLYPH}${formatAmount(total)}${tax ? ` (${MINECOIN_GLYPH}${formatAmount(tax)} tax)` : ""}. Sales are final.`);
    const owner = getMoolahPlayers().find((player) => player.id === shop.ownerId);
    owner?.sendMessage(`${itemCount}x ${getItemName(delivery)}${setText} sold at ${formatShopName(shop)} for ${MINECOIN_GLYPH}${formatAmount(subtotal)}. The payment is in your Inbox.`);
    writeAuditLog("chest_shop", "Chest Shop Purchase", buyer, `${itemCount}x ${getItemName(delivery)} (${setCount} purchase unit(s)) from ${shop.ownerName} at ${shop.name}; price ${subtotal}; tax ${tax}; total ${total}.`);
  } catch (error) {
    buyer.sendMessage(error?.message ?? "The purchase could not be completed. No funds were moved.");
  } finally {
    transactionLocks.delete(shopId);
  }
}

function confirmPurchase(player, shopId, entry, setCount, hasQuantityStep) {
  const { item, listing } = entry;
  const settings = getEconomySettings();
  const itemCount = listing.quantity * setCount;
  const subtotal = listing.price * setCount;
  if (!Number.isSafeInteger(itemCount) || !Number.isSafeInteger(subtotal)) {
    player.sendMessage("That purchase total is too large.");
    playChestShopSound(player, "random.chestclosed");
    return;
  }
  const tax = calculateTax(subtotal, settings.chestShopTaxRate);
  const total = subtotal + tax;
  if (!Number.isSafeInteger(total)) {
    player.sendMessage("That purchase total is too large.");
    playChestShopSound(player, "random.chestclosed");
    return;
  }
  const quantityText = listing.quantity > 1
    ? `${setCount} set${setCount === 1 ? "" : "s"} (${itemCount} items)`
    : `${itemCount} item${itemCount === 1 ? "" : "s"}`;
  const form = new MessageFormData()
    .title("Confirm Purchase")
    .body(
      `${quantityText} — ${getItemName(item)}\n`
      + `Price: ${MINECOIN_GLYPH}${formatAmount(subtotal)}\n`
      + `Sales tax: ${MINECOIN_GLYPH}${formatAmount(tax)}\n`
      + `Total: ${MINECOIN_GLYPH}${formatAmount(total)}\n\n`
      + "Payments are non-refundable and items cannot be returned.",
    )
    .button1("Buy")
    .button2("Back");
  form.show(player).then((response) => {
    if (!response.canceled && response.selection === 0) {
      playChestShopSound(player, "random.chestclosed");
      system.run(() => buyListing(
        player,
        shopId,
        listing.price,
        listing.quantity,
        listing.signature,
        setCount,
      ));
      return;
    }
    system.run(() => {
      if (hasQuantityStep) {
        openPurchaseQuantityMenu(player, shopId, entry, setCount, true);
      } else {
        openChestShop(player, shopId, true);
      }
    });
  }).catch(() => {
    playChestShopSound(player, "random.chestclosed");
    player.sendMessage("The purchase confirmation could not be opened.");
  });
}

function refreshPurchaseEntry(shopId, entry) {
  const shop = shopsById.get(shopId);
  const container = shop && getShopContainer(shop);
  if (!shop || !container?.isValid) return undefined;
  const matchingStock = getMatchingStock(
    shop,
    container,
    entry.listing.signature,
    entry.listing.price,
    entry.listing.quantity,
  );
  if (matchingStock.length === 0) return undefined;
  return {
    ...entry,
    item: matchingStock[0].item,
    stockAmount: matchingStock.reduce((total, stock) => total + stock.item.amount, 0),
  };
}

function openPurchaseQuantityMenu(
  player,
  shopId,
  originalEntry,
  defaultSetCount = 1,
  returningFromConfirmation = false,
) {
  const entry = refreshPurchaseEntry(shopId, originalEntry);
  if (!entry || entry.stockAmount < entry.listing.quantity) {
    player.sendMessage("That item is no longer available in this Chest Shop.");
    system.run(() => openChestShop(player, shopId, true));
    return;
  }
  const maxSets = Math.floor(entry.stockAmount / entry.listing.quantity);
  if (maxSets <= 1) {
    system.run(() => {
      if (returningFromConfirmation) openChestShop(player, shopId, true);
      else confirmPurchase(player, shopId, entry, 1, false);
    });
    return;
  }
  const initialSetCount = Math.max(1, Math.min(defaultSetCount, maxSets));
  const quantityLabel = entry.listing.quantity > 1
    ? `Sets (${entry.listing.quantity} items each)`
    : "Items";
  const form = new ModalFormData()
    .title("Purchase Quantity")
    .label(`${getItemName(entry.item)}\n${compactItemVariant(entry.item, 120)}`)
    .slider(quantityLabel, 1, maxSets, { defaultValue: initialSetCount, valueStep: 1 })
    .submitButton("Continue");
  form.show(player).then((response) => {
    if (response.canceled || !response.formValues) {
      system.run(() => openChestShop(player, shopId, true));
      return;
    }
    const selectedSets = response.formValues[1];
    if (!Number.isSafeInteger(selectedSets) || selectedSets < 1 || selectedSets > maxSets) {
      player.sendMessage("That purchase quantity was invalid.");
      playChestShopSound(player, "random.chestclosed");
      return;
    }
    system.run(() => confirmPurchase(
      player,
      shopId,
      entry,
      selectedSets,
      true,
    ));
  }).catch(() => {
    playChestShopSound(player, "random.chestclosed");
    player.sendMessage("The purchase quantity menu could not be opened.");
  });
}

function openChestShop(player, shopId, sessionActive = false) {
  let shop = shopsById.get(shopId);
  if (!shop || !getEconomySettings().allowChestShops) {
    player.sendMessage("Chest Shops are currently disabled.");
    if (sessionActive) playChestShopSound(player, "random.chestclosed");
    return;
  }
  normalizeShopItems(shop, false);
  shop = shopsById.get(shopId);
  if (!shop) {
    player.sendMessage("That Chest Shop is no longer available.");
    if (sessionActive) playChestShopSound(player, "random.chestclosed");
    return;
  }
  const container = getShopContainer(shop);
  if (!container?.isValid) {
    player.sendMessage("That Chest Shop is unavailable.");
    if (sessionActive) playChestShopSound(player, "random.chestclosed");
    return;
  }
  const groupedListings = new Map();
  for (let slot = 0; slot < container.size; slot++) {
    const item = container.getItem(slot);
    const listing = shop.listings?.[slot];
    if (
      item
      && listing
      && listing.signature === itemSignature(item)
      && !listing.unsold
    ) {
      const groupKey = JSON.stringify([
        listing.signature,
        listing.price,
        listing.quantity,
      ]);
      const existing = groupedListings.get(groupKey);
      if (existing) {
        existing.stockAmount += item.amount;
      } else {
        groupedListings.set(groupKey, {
          item,
          listing,
          stockAmount: item.amount,
        });
      }
    }
  }
  const listings = [...groupedListings.values()].filter(
    (entry) => entry.stockAmount >= entry.listing.quantity,
  );
  const catalogDescription = shop.description
    ?? `Owned by ${shop.ownerName}. Choose an item to buy.`;
  const form = new ActionFormData()
    .title(formatShopName(shop))
    .body(listings.length ? catalogDescription : "No items are currently for sale.");
  for (const entry of listings) {
    const purchases = Math.floor(entry.stockAmount / entry.listing.quantity);
    form.button(
      `${entry.listing.quantity}x ${getItemName(entry.item)} — ${MINECOIN_GLYPH}${formatAmount(entry.listing.price)}\n`
        + `${compactItemVariant(entry.item)} • ${entry.stockAmount} stock • ${purchases} purchase${purchases === 1 ? "" : "s"}`,
      getItemIconPath(entry.item),
    );
  }
  if (!sessionActive) playChestShopSound(player, "random.chestopen");
  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) {
      playChestShopSound(player, "random.chestclosed");
      return;
    }
    const selected = listings[response.selection];
    if (!selected) {
      playChestShopSound(player, "random.chestclosed");
      return;
    }
    system.run(() => openPurchaseQuantityMenu(player, shopId, selected));
  }).catch(() => {
    playChestShopSound(player, "random.chestclosed");
    player.sendMessage("The Chest Shop menu could not be opened.");
  });
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
  updateShopSignWithFeedback(shop, player);
  normalizeShopItems(shop, true);
  player.sendMessage(`${formatShopName(shop)} registered${fee ? ` for ${MINECOIN_GLYPH}${formatAmount(fee)}` : ""}. Right-click the sign to configure it.`);
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
        player.onScreenDisplay.setActionBar(`Stocking: ${formatShopName(shop)}`);
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
