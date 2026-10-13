import {
  BlockVolume,
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandSource,
  CustomCommandStatus,
  MolangVariableMap,
  system,
  world,
} from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { getEconomySettings, getTaxPool, setTaxPool } from "./settings.js";

const MINECOIN_GLYPH = "\uE102";
const OWNER_KEY_PROPERTY = "moolah:claim_owner_key";
const SHARD_SIZE = 8;
const SHARD_CACHE_LIMIT = 512;
const WALK_MAX_CHUNKS = 512;
const TRIPLE_SNEAK_WINDOW_TICKS = 40;
const ENTRY_MESSAGE_TICKS = 60;
const DENIAL_COOLDOWN_TICKS = 20;
const FIRE_SCAN_RADIUS = 2;
const FIRE_SLICE_HEIGHT = 32;
const FIRE_TASKS_PER_TICK = 2;
const FIRE_QUEUE_LIMIT = 2048;
const MAX_FRIENDS = 64;
const CLAIM_VIEW_RADIUS_CHUNKS = 1;
const CLAIM_VIEW_PARTICLE_STEP = 4;
const CLAIM_VIEW_MAX_PARTICLES = 96;
const CLAIM_VIEW_OFFSETS = [];
for (let x = -CLAIM_VIEW_RADIUS_CHUNKS; x <= CLAIM_VIEW_RADIUS_CHUNKS; x++) {
  for (let z = -CLAIM_VIEW_RADIUS_CHUNKS; z <= CLAIM_VIEW_RADIUS_CHUNKS; z++) {
    CLAIM_VIEW_OFFSETS.push({ x, z });
  }
}
CLAIM_VIEW_OFFSETS.sort((left, right) => (
  left.x * left.x + left.z * left.z - (right.x * right.x + right.z * right.z)
));
const FIRE_DAMAGE_CAUSES = new Set(["fire", "firetick", "campfire", "soulcampfire", "lava"]);
const EXPLOSION_DAMAGE_CAUSES = new Set(["blockexplosion", "entityexplosion"]);

const shardCache = new Map();
const profileCache = new Map();
const claimLocks = new Set();
const walkSessions = new Map();
const claimViewPlayers = new Set();
const lastPlayerClaimStates = new Map();
const claimActionbarUntil = new Map();
const denialCooldowns = new Map();
const fireQueue = [];
const queuedFireTasks = new Set();
const ownerKeyCache = new Map();
const ownClaimBorderColor = new MolangVariableMap();
const otherClaimBorderColor = new MolangVariableMap();
ownClaimBorderColor.setColorRGB("variable.color", { red: 0.15, green: 1, blue: 0.15 });
otherClaimBorderColor.setColorRGB("variable.color", { red: 1, green: 0.1, blue: 0.1 });
let initialized = false;
let claimViewParticleWarningShown = false;

function formatAmount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function getStoredOwnerKey(player) {
  const cached = ownerKeyCache.get(player.id);
  if (cached) return cached;

  try {
    const value = player.getDynamicProperty(OWNER_KEY_PROPERTY);
    if (typeof value === "string" && value) {
      ownerKeyCache.set(player.id, value);
      return value;
    }
  } catch {
    // Fall back to the current username if player properties are unavailable.
  }
  const ownerKey = normalizeName(player.name);
  ownerKeyCache.set(player.id, ownerKey);
  return ownerKey;
}

function rememberOwnerKey(player, ownerKey) {
  ownerKeyCache.set(player.id, ownerKey);
  try {
    player.setDynamicProperty(OWNER_KEY_PROPERTY, ownerKey);
  } catch (error) {
    console.warn(`[Moolah Claims] Could not remember owner identity: ${error}`);
  }
}

function dimensionToken(dimensionId) {
  return String(dimensionId).replace(/^minecraft:/, "").replace(/[^a-z0-9_-]/gi, "_");
}

function getChunk(location) {
  return {
    x: Math.floor(location.x / 16),
    z: Math.floor(location.z / 16),
  };
}

function chunkKey(dimensionId, x, z) {
  return `${dimensionId}:${x}:${z}`;
}

function getShardDescriptor(dimensionId, chunkX, chunkZ) {
  const regionX = Math.floor(chunkX / SHARD_SIZE);
  const regionZ = Math.floor(chunkZ / SHARD_SIZE);
  const localX = chunkX - regionX * SHARD_SIZE;
  const localZ = chunkZ - regionZ * SHARD_SIZE;
  const localIndex = String(localZ * SHARD_SIZE + localX);
  const propertyId = `moolah:claims:${dimensionToken(dimensionId)}:${regionX}:${regionZ}`;
  return { propertyId, localIndex };
}

function isValidClaim(value) {
  return value
    && typeof value === "object"
    && typeof value.ownerKey === "string"
    && value.ownerKey.length > 0
    && typeof value.ownerName === "string"
    && Number.isSafeInteger(value.paid)
    && value.paid >= 0
    && typeof value.fireTick === "boolean"
    && typeof value.explosions === "boolean";
}

function touchCache(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
}

function trimShardCache() {
  while (shardCache.size > SHARD_CACHE_LIMIT) {
    const oldest = shardCache.keys().next().value;
    shardCache.delete(oldest);
  }
}

function loadShard(propertyId) {
  const cached = shardCache.get(propertyId);
  if (cached) {
    touchCache(shardCache, propertyId, cached);
    return cached;
  }

  const shard = { claims: {} };
  const value = world.getDynamicProperty(propertyId);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      const claims = parsed?.version === 1 && parsed.claims && typeof parsed.claims === "object"
        ? parsed.claims
        : {};
      for (const [key, claim] of Object.entries(claims)) {
        if (isValidClaim(claim)) shard.claims[key] = claim;
      }
    } catch {
      console.error(`[Moolah Claims] Ignoring malformed shard ${propertyId}.`);
    }
  }

  shardCache.set(propertyId, shard);
  trimShardCache();
  return shard;
}

function saveShard(propertyId, claims) {
  const keys = Object.keys(claims);
  if (keys.length === 0) {
    world.setDynamicProperty(propertyId, undefined);
  } else {
    world.setDynamicProperty(propertyId, JSON.stringify({ version: 1, claims }));
  }
  touchCache(shardCache, propertyId, { claims });
  trimShardCache();
}

function getClaim(dimensionId, chunkX, chunkZ) {
  const descriptor = getShardDescriptor(dimensionId, chunkX, chunkZ);
  return loadShard(descriptor.propertyId).claims[descriptor.localIndex];
}

function getClaimAt(dimension, location) {
  const chunk = getChunk(location);
  return getClaim(dimension.id, chunk.x, chunk.z);
}

function hashText(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function profilePropertyId(ownerKey) {
  return `moolah:claim_profile:${hashText(ownerKey, 2166136261)}${hashText(ownerKey, 3339675911)}`;
}

function defaultProfile(ownerKey, ownerName = ownerKey) {
  return {
    version: 1,
    ownerKey,
    ownerName,
    claimCount: 0,
    friends: [],
  };
}

function sanitizeProfile(value, ownerKey, ownerName = ownerKey) {
  const profile = defaultProfile(ownerKey, ownerName);
  if (!value || typeof value !== "object" || value.ownerKey !== ownerKey) return profile;

  if (typeof value.ownerName === "string" && value.ownerName) {
    profile.ownerName = value.ownerName;
  }
  if (Number.isSafeInteger(value.claimCount) && value.claimCount >= 0) {
    profile.claimCount = value.claimCount;
  }
  if (Array.isArray(value.friends)) {
    const seen = new Set();
    for (const friend of value.friends) {
      if (!friend || typeof friend.key !== "string" || !friend.key || seen.has(friend.key)) continue;
      seen.add(friend.key);
      profile.friends.push({
        key: friend.key,
        name: typeof friend.name === "string" && friend.name ? friend.name : friend.key,
        id: typeof friend.id === "string" ? friend.id : undefined,
      });
      if (profile.friends.length >= MAX_FRIENDS) break;
    }
  }
  return profile;
}

function getProfile(ownerKey, ownerName = ownerKey) {
  const cached = profileCache.get(ownerKey);
  if (cached) return cached;

  const propertyId = profilePropertyId(ownerKey);
  const raw = world.getDynamicProperty(propertyId);
  let profile = defaultProfile(ownerKey, ownerName);
  if (typeof raw === "string") {
    try {
      profile = sanitizeProfile(JSON.parse(raw), ownerKey, ownerName);
    } catch {
      console.error(`[Moolah Claims] Ignoring malformed owner profile ${propertyId}.`);
    }
  }
  profileCache.set(ownerKey, profile);
  return profile;
}

function saveProfile(profile) {
  const clean = sanitizeProfile(profile, profile.ownerKey, profile.ownerName);
  world.setDynamicProperty(profilePropertyId(clean.ownerKey), JSON.stringify(clean));
  profileCache.set(clean.ownerKey, clean);
}

function restoreProfile(ownerKey, rawValue) {
  const propertyId = profilePropertyId(ownerKey);
  world.setDynamicProperty(propertyId, rawValue);
  profileCache.delete(ownerKey);
}

function isOwner(player, claim) {
  return claim.ownerKey === getStoredOwnerKey(player)
    || claim.ownerKey === normalizeName(player.name)
    || (typeof claim.ownerId === "string" && claim.ownerId === player.id);
}

function isAuthorized(player, claim) {
  if (!claim) return true;
  if (player.hasTag("econ_admin") || isOwner(player, claim)) return true;

  const playerKey = normalizeName(player.name);
  return getProfile(claim.ownerKey, claim.ownerName).friends.some(
    (friend) => friend.key === playerKey || (friend.id && friend.id === player.id),
  );
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

function enumerateRadius(center, radius) {
  const chunks = [];
  for (let x = center.x - radius; x <= center.x + radius; x++) {
    for (let z = center.z - radius; z <= center.z + radius; z++) {
      chunks.push({ x, z });
    }
  }
  return chunks;
}

function groupClaimChanges(dimensionId, changes) {
  const groups = new Map();
  for (const change of changes) {
    const descriptor = getShardDescriptor(dimensionId, change.x, change.z);
    let group = groups.get(descriptor.propertyId);
    if (!group) {
      const before = { ...loadShard(descriptor.propertyId).claims };
      group = { propertyId: descriptor.propertyId, before, after: { ...before } };
      groups.set(descriptor.propertyId, group);
    }
    if (change.claim === undefined) {
      delete group.after[descriptor.localIndex];
    } else {
      group.after[descriptor.localIndex] = change.claim;
    }
  }
  return [...groups.values()];
}

function commitClaimChanges(dimensionId, changes) {
  const groups = groupClaimChanges(dimensionId, changes);
  const saved = [];
  try {
    for (const group of groups) {
      saveShard(group.propertyId, group.after);
      saved.push(group);
    }
  } catch (error) {
    for (const group of saved.reverse()) {
      try {
        saveShard(group.propertyId, group.before);
      } catch (rollbackError) {
        console.error(`[Moolah Claims] Shard rollback failed: ${rollbackError}`);
      }
    }
    throw error;
  }

  return () => {
    for (const group of groups) saveShard(group.propertyId, group.before);
  };
}

function acquireLocks(dimensionId, chunks) {
  const keys = chunks.map((chunk) => chunkKey(dimensionId, chunk.x, chunk.z));
  if (keys.some((key) => claimLocks.has(key))) return undefined;
  keys.forEach((key) => claimLocks.add(key));
  return () => keys.forEach((key) => claimLocks.delete(key));
}

function describeRadius(radius) {
  return radius === 0 ? "the current chunk" : `a radius-${radius} area`;
}

function analyzePurchase(player, dimensionId, chunks) {
  const ownerKey = getStoredOwnerKey(player);
  const available = [];
  const conflicts = [];
  for (const chunk of chunks) {
    const claim = getClaim(dimensionId, chunk.x, chunk.z);
    if (!claim) {
      available.push(chunk);
    } else if (!isOwner(player, claim) && claim.ownerKey !== ownerKey) {
      conflicts.push({ ...chunk, ownerName: claim.ownerName });
    }
  }
  return { available, conflicts };
}

function purchaseChunks(player, dimensionId, requestedChunks) {
  const settings = getEconomySettings();
  if (!settings.allowClaims) {
    player.sendMessage("Claims are currently disabled.");
    return;
  }

  const releaseLocks = acquireLocks(dimensionId, requestedChunks);
  if (!releaseLocks) {
    player.sendMessage("One of those chunks is already being updated. Try again.");
    return;
  }

  try {
    const { available, conflicts } = analyzePurchase(player, dimensionId, requestedChunks);
    if (conflicts.length > 0) {
      player.sendMessage(`Purchase canceled: ${conflicts.length} chunk${conflicts.length === 1 ? " is" : "s are"} now owned by another player.`);
      return;
    }
    if (available.length === 0) {
      player.sendMessage("You already own every selected chunk.");
      return;
    }

    const totalCost = available.length * settings.claimCostPerChunk;
    if (!Number.isSafeInteger(totalCost)) {
      player.sendMessage("That claim purchase is too large.");
      return;
    }

    const balance = getBalance(player);
    if (balance < totalCost) {
      player.sendMessage(`You need ${MINECOIN_GLYPH}${formatAmount(totalCost)}, but your balance is ${MINECOIN_GLYPH}${formatAmount(balance)}.`);
      return;
    }

    const previousPool = getTaxPool();
    const nextPool = previousPool + totalCost;
    if (!Number.isSafeInteger(nextPool)) {
      player.sendMessage("The Tax Pool cannot accept this purchase.");
      return;
    }

    const ownerKey = getStoredOwnerKey(player);
    const profileProperty = profilePropertyId(ownerKey);
    const previousProfileRaw = world.getDynamicProperty(profileProperty);
    const previousProfile = getProfile(ownerKey, player.name);
    const nextProfile = {
      ...previousProfile,
      ownerName: player.name,
      claimCount: previousProfile.claimCount + available.length,
      friends: [...previousProfile.friends],
    };
    const claimRecord = {
      ownerKey,
      ownerName: player.name,
      ownerId: player.id,
      paid: settings.claimCostPerChunk,
      fireTick: false,
      explosions: false,
    };
    const changes = available.map((chunk) => ({ ...chunk, claim: claimRecord }));
    const objective = getCurrencyObjective();
    let rollbackClaims;

    try {
      if (totalCost > 0) objective.addScore(player, -totalCost);
      setTaxPool(nextPool);
      rollbackClaims = commitClaimChanges(dimensionId, changes);
      saveProfile(nextProfile);
      rememberOwnerKey(player, ownerKey);
    } catch (error) {
      try {
        rollbackClaims?.();
        restoreProfile(ownerKey, previousProfileRaw);
        setTaxPool(previousPool);
        objective.setScore(player, balance);
      } catch (rollbackError) {
        console.error(`[Moolah Claims] Purchase rollback failed: ${rollbackError}`);
      }
      console.error(`[Moolah Claims] Purchase failed: ${error?.stack ?? error}`);
      player.sendMessage("The claim purchase failed and was rolled back.");
      return;
    }

    player.sendMessage(`Claimed ${available.length} chunk${available.length === 1 ? "" : "s"} for ${MINECOIN_GLYPH}${formatAmount(totalCost)}. The charge was sent to the Tax Pool.`);
  } finally {
    releaseLocks();
  }
}

function confirmPurchase(player, dimensionId, chunks, label, onBack) {
  const settings = getEconomySettings();
  if (!settings.allowClaims) {
    player.sendMessage("Claims are currently disabled.");
    return;
  }

  const { available, conflicts } = analyzePurchase(player, dimensionId, chunks);
  if (conflicts.length > 0) {
    const first = conflicts[0];
    player.sendMessage(`${conflicts.length} selected chunk${conflicts.length === 1 ? " is" : "s are"} already claimed. First conflict: ${first.ownerName} at ${first.x}, ${first.z}.`);
    return;
  }
  if (available.length === 0) {
    player.sendMessage("You already own every selected chunk.");
    return;
  }

  const totalCost = available.length * settings.claimCostPerChunk;
  const form = new MessageFormData()
    .title("Confirm Claim Purchase")
    .body(
      `${label}\n`
      + `New chunks: ${available.length}\n`
      + `Price per chunk: ${MINECOIN_GLYPH}${formatAmount(settings.claimCostPerChunk)}\n`
      + `Total: ${MINECOIN_GLYPH}${formatAmount(totalCost)}\n`
      + `Balance: ${MINECOIN_GLYPH}${formatAmount(getBalance(player))}\n\n`
      + "Claim charges are sent to the Tax Pool.",
    )
    .button1("Buy Claims")
    .button2("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      if (onBack) system.run(onBack);
    } else if (response.selection === 0) {
      system.run(() => purchaseChunks(player, dimensionId, chunks));
    }
  }).catch(() => player.sendMessage("The claim confirmation could not be opened."));
}

export function confirmClaimAdd(player, radius = 0, onBack) {
  const center = getChunk(player.location);
  confirmPurchase(
    player,
    player.dimension.id,
    enumerateRadius(center, radius),
    `Buy ${describeRadius(radius)} centered at chunk ${center.x}, ${center.z}?`,
    onBack,
  );
}

function removeChunks(player, dimensionId, requestedChunks, targetOwnerKey, isAdminRemoval) {
  const releaseLocks = acquireLocks(dimensionId, requestedChunks);
  if (!releaseLocks) {
    player.sendMessage("One of those chunks is already being updated. Try again.");
    return;
  }

  try {
    const removable = requestedChunks
      .map((chunk) => ({ ...chunk, claim: getClaim(dimensionId, chunk.x, chunk.z) }))
      .filter((entry) => entry.claim?.ownerKey === targetOwnerKey);
    if (removable.length === 0) {
      player.sendMessage("No matching claimed chunks remain in that area.");
      return;
    }

    const settings = getEconomySettings();
    const totalPaid = removable.reduce((sum, entry) => sum + entry.claim.paid, 0);
    const previousPool = getTaxPool();
    const refund = !isAdminRemoval && settings.refundRemovedClaims
      ? Math.min(totalPaid, previousPool)
      : 0;
    const ownerName = removable[0].claim.ownerName;
    const previousProfileRaw = world.getDynamicProperty(profilePropertyId(targetOwnerKey));
    const previousProfile = getProfile(targetOwnerKey, ownerName);
    const nextProfile = {
      ...previousProfile,
      claimCount: Math.max(0, previousProfile.claimCount - removable.length),
      friends: [...previousProfile.friends],
    };
    const changes = removable.map((entry) => ({ x: entry.x, z: entry.z, claim: undefined }));
    const objective = getCurrencyObjective();
    const previousBalance = getBalance(player);
    let rollbackClaims;

    try {
      rollbackClaims = commitClaimChanges(dimensionId, changes);
      saveProfile(nextProfile);
      if (refund > 0) {
        setTaxPool(previousPool - refund);
        objective.addScore(player, refund);
      }
    } catch (error) {
      try {
        rollbackClaims?.();
        restoreProfile(targetOwnerKey, previousProfileRaw);
        setTaxPool(previousPool);
        if (!isAdminRemoval) objective.setScore(player, previousBalance);
      } catch (rollbackError) {
        console.error(`[Moolah Claims] Removal rollback failed: ${rollbackError}`);
      }
      console.error(`[Moolah Claims] Removal failed: ${error?.stack ?? error}`);
      player.sendMessage("The claim removal failed and was rolled back.");
      return;
    }

    const refundText = refund > 0
      ? ` Refunded ${MINECOIN_GLYPH}${formatAmount(refund)} from the Tax Pool.`
      : " No refund was issued.";
    player.sendMessage(`Removed ${removable.length} chunk claim${removable.length === 1 ? "" : "s"} owned by ${ownerName}.${refundText}`);
  } finally {
    releaseLocks();
  }
}

export function confirmClaimRemove(player, radius = 0, onBack) {
  const settings = getEconomySettings();
  if (!settings.allowClaims) {
    player.sendMessage("Claims are currently disabled.");
    return;
  }

  const dimensionId = player.dimension.id;
  const center = getChunk(player.location);
  const centerClaim = getClaim(dimensionId, center.x, center.z);
  const playerOwnerKey = getStoredOwnerKey(player);
  const adminTarget = centerClaim
    && !isOwner(player, centerClaim)
    && player.hasTag("econ_admin");

  if (centerClaim && !isOwner(player, centerClaim) && !adminTarget) {
    player.sendMessage(`This chunk belongs to ${centerClaim.ownerName}.`);
    return;
  }

  const targetOwnerKey = adminTarget ? centerClaim.ownerKey : playerOwnerKey;
  const chunks = enumerateRadius(center, radius);
  const removable = chunks
    .map((chunk) => ({ ...chunk, claim: getClaim(dimensionId, chunk.x, chunk.z) }))
    .filter((entry) => entry.claim?.ownerKey === targetOwnerKey);
  if (removable.length === 0) {
    player.sendMessage("There are no matching claims to remove in that area.");
    return;
  }

  const totalPaid = removable.reduce((sum, entry) => sum + entry.claim.paid, 0);
  const refund = !adminTarget && settings.refundRemovedClaims
    ? Math.min(totalPaid, getTaxPool())
    : 0;
  const refundText = adminTarget
    ? "Administrative removals do not refund the owner."
    : settings.refundRemovedClaims
      ? `Refund from available Tax Pool funds: ${MINECOIN_GLYPH}${formatAmount(refund)}`
      : "Refunds are disabled.";
  const ownerName = removable[0].claim.ownerName;
  const form = new MessageFormData()
    .title(adminTarget ? "Confirm Admin Removal" : "Confirm Unclaim")
    .body(
      `${describeRadius(radius)} centered at chunk ${center.x}, ${center.z}\n`
      + `Owner: ${ownerName}\n`
      + `Claims removed: ${removable.length}\n`
      + `${refundText}`,
    )
    .button1("Remove Claims")
    .button2("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === 1) {
      if (onBack) system.run(onBack);
    } else if (response.selection === 0) {
      system.run(() => removeChunks(player, dimensionId, chunks, targetOwnerKey, adminTarget));
    }
  }).catch(() => player.sendMessage("The claim removal confirmation could not be opened."));
}

function resolveOwnerProfile(player) {
  let ownerKey = getStoredOwnerKey(player);
  let profile = getProfile(ownerKey, player.name);
  if (profile.claimCount > 0) return { ownerKey, profile };

  const claim = getClaimAt(player.dimension, player.location);
  if (claim && isOwner(player, claim)) {
    ownerKey = claim.ownerKey;
    rememberOwnerKey(player, ownerKey);
    profile = getProfile(ownerKey, player.name);
  }
  return { ownerKey, profile };
}

function inviteFriend(player, username) {
  const targetName = String(username ?? "").trim();
  const targetKey = normalizeName(targetName);
  if (!targetKey) {
    player.sendMessage("Usage: /claim invite <username>");
    return;
  }

  const { profile } = resolveOwnerProfile(player);
  if (profile.claimCount <= 0) {
    player.sendMessage("You need at least one claim before inviting friends.");
    return;
  }
  if (targetKey === normalizeName(player.name)) {
    player.sendMessage("You already have access to your own claims.");
    return;
  }
  if (profile.friends.some((friend) => friend.key === targetKey)) {
    player.sendMessage(`${targetName} is already invited to all of your claims.`);
    return;
  }
  if (profile.friends.length >= MAX_FRIENDS) {
    player.sendMessage(`You cannot invite more than ${MAX_FRIENDS} friends.`);
    return;
  }

  const onlineTarget = world.getPlayers().find((candidate) => normalizeName(candidate.name) === targetKey);
  const nextProfile = {
    ...profile,
    ownerName: player.name,
    friends: [...profile.friends, {
      key: targetKey,
      name: onlineTarget?.name ?? targetName,
      id: onlineTarget?.id,
    }],
  };
  try {
    saveProfile(nextProfile);
    player.sendMessage(`${onlineTarget?.name ?? targetName} can now use, build, and interact in all of your claimed chunks.`);
    onlineTarget?.sendMessage(`${player.name} invited you to all of their claimed chunks.`);
  } catch (error) {
    console.error(`[Moolah Claims] Invite failed: ${error?.stack ?? error}`);
    player.sendMessage("That claim invitation could not be saved.");
  }
}

function deinviteFriend(player, username) {
  const targetName = String(username ?? "").trim();
  const targetKey = normalizeName(targetName);
  if (!targetKey) {
    player.sendMessage("Usage: /claim deinvite <username>");
    return;
  }

  const { profile } = resolveOwnerProfile(player);
  const remaining = profile.friends.filter((friend) => friend.key !== targetKey);
  if (remaining.length === profile.friends.length) {
    player.sendMessage(`${targetName} is not invited to your claims.`);
    return;
  }

  try {
    saveProfile({ ...profile, ownerName: player.name, friends: remaining });
    player.sendMessage(`${targetName} can no longer access any of your claimed chunks.`);
    const onlineTarget = world.getPlayers().find((candidate) => normalizeName(candidate.name) === targetKey);
    onlineTarget?.sendMessage(`${player.name} removed your access to all of their claimed chunks.`);
  } catch (error) {
    console.error(`[Moolah Claims] Deinvite failed: ${error?.stack ?? error}`);
    player.sendMessage("That claim permission change could not be saved.");
  }
}

function openOfflineClaimInvite(player, onBack) {
  const form = new ModalFormData()
    .title("Offline Player")
    .textField("Username", "Enter the player's exact name", { defaultValue: "" })
    .submitButton("Invite");

  form.show(player).then((response) => {
    if (response.canceled) {
      if (onBack) system.run(onBack);
      return;
    }
    const username = response.formValues?.[0];
    if (typeof username !== "string" || username.trim().length === 0) {
      player.sendMessage("Enter a player name.");
      return;
    }
    inviteFriend(player, username);
  }).catch(() => player.sendMessage("The offline-player invite menu could not be opened."));
}

function openClaimInviteMenu(player, onBack) {
  const { profile } = resolveOwnerProfile(player);
  if (profile.claimCount <= 0) {
    player.sendMessage("You need at least one claim before inviting friends.");
    if (onBack) system.run(onBack);
    return;
  }

  const invitedKeys = new Set(profile.friends.map((friend) => friend.key));
  const onlineNames = world.getPlayers()
    .filter((candidate) => (
      candidate.id !== player.id
      && !invitedKeys.has(normalizeName(candidate.name))
    ))
    .map((candidate) => candidate.name);
  const options = [...onlineNames, "Offline Player"];
  const form = new ModalFormData()
    .title("Invite to Claims")
    .dropdown("Player", options, { defaultValueIndex: 0 })
    .submitButton("Invite");

  form.show(player).then((response) => {
    if (response.canceled) {
      if (onBack) system.run(onBack);
      return;
    }
    const selectedIndex = response.formValues?.[0];
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= options.length) {
      player.sendMessage("The selected player was invalid.");
      return;
    }
    if (selectedIndex === onlineNames.length) {
      system.run(() => openOfflineClaimInvite(
        player,
        () => openClaimInviteMenu(player, onBack),
      ));
      return;
    }
    inviteFriend(player, onlineNames[selectedIndex]);
  }).catch(() => player.sendMessage("The claim invite menu could not be opened."));
}

function openClaimDeinviteMenu(player, onBack) {
  const { profile } = resolveOwnerProfile(player);
  if (profile.friends.length === 0) {
    player.sendMessage("You have not invited anyone to your claims.");
    if (onBack) system.run(onBack);
    return;
  }

  const form = new ModalFormData()
    .title("Remove Claim Access")
    .dropdown(
      "Invited Friend",
      profile.friends.map((friend) => friend.name),
      { defaultValueIndex: 0 },
    )
    .submitButton("Remove Access");

  form.show(player).then((response) => {
    if (response.canceled) {
      if (onBack) system.run(onBack);
      return;
    }
    const selectedIndex = response.formValues?.[0];
    if (
      !Number.isSafeInteger(selectedIndex)
      || selectedIndex < 0
      || selectedIndex >= profile.friends.length
    ) {
      player.sendMessage("The selected friend was invalid.");
      return;
    }
    deinviteFriend(player, profile.friends[selectedIndex].name);
  }).catch(() => player.sendMessage("The claim access menu could not be opened."));
}

function toggleProtection(player, option) {
  const center = getChunk(player.location);
  const dimensionId = player.dimension.id;
  const claim = getClaim(dimensionId, center.x, center.z);
  if (!claim) {
    player.sendMessage("This chunk is not claimed.");
    return;
  }
  if (!isOwner(player, claim)) {
    player.sendMessage("Only the claim owner can change this chunk's protection settings.");
    return;
  }

  const key = String(option ?? "").trim().toLowerCase();
  if (key !== "firetick" && key !== "explosions") {
    player.sendMessage("Usage: /claim toggle <firetick|explosions>");
    return;
  }

  const updated = { ...claim, [key === "firetick" ? "fireTick" : "explosions"]: !claim[key === "firetick" ? "fireTick" : "explosions"] };
  try {
    commitClaimChanges(dimensionId, [{ ...center, claim: updated }]);
    const enabled = key === "firetick" ? updated.fireTick : updated.explosions;
    player.sendMessage(`${key === "firetick" ? "Fire tick" : "Explosions"} ${enabled ? "enabled" : "protected"} in this chunk.`);
  } catch (error) {
    console.error(`[Moolah Claims] Protection toggle failed: ${error?.stack ?? error}`);
    player.sendMessage("That protection setting could not be changed.");
  }
}

function openClaimToggleMenu(player, onBack) {
  const center = getChunk(player.location);
  const claim = getClaim(player.dimension.id, center.x, center.z);
  if (!claim) {
    player.sendMessage("This chunk is not claimed.");
    if (onBack) system.run(onBack);
    return;
  }
  if (!isOwner(player, claim)) {
    player.sendMessage("Only the claim owner can change this chunk's protection settings.");
    if (onBack) system.run(onBack);
    return;
  }

  const form = new ActionFormData()
    .title("Claim Protection")
    .body(`Chunk ${center.x}, ${center.z}\nChoose a protection to toggle.`)
    .button(claim.fireTick ? "§cFire Tick: Enabled§r" : "Fire Tick: Protected")
    .button(claim.explosions ? "§cExplosions: Enabled§r" : "Explosions: Protected");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) {
      if (onBack) system.run(onBack);
      return;
    }
    if (response.selection === 0) toggleProtection(player, "firetick");
    if (response.selection === 1) toggleProtection(player, "explosions");
  }).catch(() => player.sendMessage("The claim protection menu could not be opened."));
}

function openClaimRadiusMenu(player, onBack) {
  const radii = Array.from({ length: 9 }, (_, index) => index + 1);
  const form = new ModalFormData()
    .title("Claim Radius")
    .dropdown(
      "Radius",
      radii.map((radius) => {
        const width = radius * 2 + 1;
        return `Radius ${radius} (${width}x${width}, ${width * width} chunks)`;
      }),
      { defaultValueIndex: 0 },
    )
    .submitButton("Continue");

  form.show(player).then((response) => {
    if (response.canceled) {
      if (onBack) system.run(onBack);
      return;
    }
    const selectedIndex = response.formValues?.[0];
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= radii.length) {
      player.sendMessage("The selected claim radius was invalid.");
      return;
    }
    system.run(() => confirmClaimAdd(player, radii[selectedIndex], onBack));
  }).catch(() => player.sendMessage("The claim radius menu could not be opened."));
}

function showClaimInfo(player) {
  const chunk = getChunk(player.location);
  const claim = getClaim(player.dimension.id, chunk.x, chunk.z);
  if (!claim) {
    player.sendMessage(`Chunk ${chunk.x}, ${chunk.z} in ${dimensionToken(player.dimension.id)} is unclaimed.`);
    return;
  }

  const profile = getProfile(claim.ownerKey, claim.ownerName);
  const friends = profile.friends.length > 0
    ? profile.friends.map((friend) => friend.name).join(", ")
    : "None";
  player.sendMessage(
    `§d§lClaim Information§r\n`
    + `Owner: ${claim.ownerName}\n`
    + `Dimension: ${dimensionToken(player.dimension.id)}\n`
    + `Chunk: ${chunk.x}, ${chunk.z}\n`
    + `Friends (all claims): ${friends}\n`
    + `Fire tick: ${claim.fireTick ? "Enabled" : "Protected"}\n`
    + `Explosions: ${claim.explosions ? "Enabled" : "Protected"}`,
  );
}

function addWalkChunk(player, session, chunk) {
  const key = chunkKey(session.dimensionId, chunk.x, chunk.z);
  if (session.visited.has(key)) return;
  session.visited.add(key);

  const claim = getClaim(session.dimensionId, chunk.x, chunk.z);
  if (!claim) {
    if (session.selected.size >= WALK_MAX_CHUNKS) {
      player.sendMessage(`Walk & Claim reached its ${WALK_MAX_CHUNKS}-chunk limit. Triple-crouch to finish.`);
      return;
    }
    session.selected.set(key, chunk);
    const cost = session.selected.size * getEconomySettings().claimCostPerChunk;
    player.sendMessage(`Walk & Claim: added chunk ${chunk.x}, ${chunk.z} (${session.selected.size} selected, ${MINECOIN_GLYPH}${formatAmount(cost)} estimated).`);
  } else if (isOwner(player, claim)) {
    player.sendMessage(`Walk & Claim: chunk ${chunk.x}, ${chunk.z} is already yours and was skipped.`);
  } else {
    player.sendMessage(`Walk & Claim: chunk ${chunk.x}, ${chunk.z} belongs to ${claim.ownerName} and was skipped.`);
  }
}

function startWalkMode(player) {
  if (!getEconomySettings().allowClaims) {
    player.sendMessage("Claims are currently disabled.");
    return;
  }
  if (walkSessions.has(player.id)) {
    player.sendMessage("Walk & Claim is already active. Triple-crouch to finish.");
    return;
  }

  const chunk = getChunk(player.location);
  const session = {
    dimensionId: player.dimension.id,
    visited: new Set(),
    selected: new Map(),
    lastChunkKey: chunkKey(player.dimension.id, chunk.x, chunk.z),
    wasSneaking: player.isSneaking,
    sneakTicks: [],
  };
  walkSessions.set(player.id, session);
  player.sendMessage("Walk & Claim started. Enter each chunk you want, then crouch three separate times quickly to finish and review the cost.");
  addWalkChunk(player, session, chunk);
}

function finishWalkMode(player, session) {
  walkSessions.delete(player.id);
  const chunks = [...session.selected.values()];
  if (chunks.length === 0) {
    player.sendMessage("Walk & Claim finished with no new chunks selected.");
    return;
  }
  confirmPurchase(player, session.dimensionId, chunks, `Buy the ${chunks.length} unique chunks selected during Walk & Claim?`);
}

function updateWalkSessions() {
  if (!getEconomySettings().allowClaims) {
    if (walkSessions.size > 0) {
      for (const player of world.getPlayers()) {
        if (walkSessions.delete(player.id)) player.sendMessage("Walk & Claim was canceled because claims were disabled.");
      }
    }
    return;
  }

  const onlineIds = new Set();
  for (const player of world.getPlayers()) {
    onlineIds.add(player.id);
    const session = walkSessions.get(player.id);
    if (!session) continue;
    if (player.dimension.id !== session.dimensionId) {
      walkSessions.delete(player.id);
      player.sendMessage("Walk & Claim was canceled because you changed dimensions.");
      continue;
    }

    const chunk = getChunk(player.location);
    const currentKey = chunkKey(session.dimensionId, chunk.x, chunk.z);
    if (currentKey !== session.lastChunkKey) {
      session.lastChunkKey = currentKey;
      addWalkChunk(player, session, chunk);
    }

    if (player.isSneaking && !session.wasSneaking) {
      session.sneakTicks = session.sneakTicks.filter(
        (tick) => system.currentTick - tick <= TRIPLE_SNEAK_WINDOW_TICKS,
      );
      session.sneakTicks.push(system.currentTick);
      if (session.sneakTicks.length >= 3) {
        finishWalkMode(player, session);
        continue;
      }
    }
    session.wasSneaking = player.isSneaking;
  }

  for (const playerId of walkSessions.keys()) {
    if (!onlineIds.has(playerId)) walkSessions.delete(playerId);
  }
}

function toggleClaimView(player) {
  if (claimViewPlayers.delete(player.id)) {
    player.sendMessage("Claim border view disabled.");
    return;
  }
  claimViewPlayers.add(player.id);
  player.sendMessage("Claim border view enabled. Green borders are yours; red borders belong to other players. Run /claim view again to exit.");
}

function spawnClaimViewParticle(player, location, color, budget) {
  if (budget.count >= CLAIM_VIEW_MAX_PARTICLES) return;
  const dx = location.x - budget.originX;
  const dz = location.z - budget.originZ;
  if (dx * dx + dz * dz > 40 * 40) return;
  try {
    player.spawnParticle("minecraft:colored_flame_particle", location, color);
    budget.count++;
  } catch (error) {
    budget.count = CLAIM_VIEW_MAX_PARTICLES;
    if (!claimViewParticleWarningShown) {
      claimViewParticleWarningShown = true;
      console.warn(`[Moolah Claims] Claim border particle could not be shown: ${error}`);
    }
  }
}

function drawClaimViewLine(player, from, to, y, color, budget) {
  const distance = Math.max(Math.abs(to.x - from.x), Math.abs(to.z - from.z));
  const steps = Math.ceil(distance / CLAIM_VIEW_PARTICLE_STEP);
  for (let step = 0; step <= steps && budget.count < CLAIM_VIEW_MAX_PARTICLES; step++) {
    const progress = steps === 0 ? 0 : step / steps;
    spawnClaimViewParticle(player, {
      x: from.x + (to.x - from.x) * progress,
      y,
      z: from.z + (to.z - from.z) * progress,
    }, color, budget);
  }
}

function drawClaimChunkBorders(player, chunk, claim, y, budget, exposedOnly) {
  const minX = chunk.x * 16;
  const minZ = chunk.z * 16;
  const maxX = minX + 16;
  const maxZ = minZ + 16;
  const dimensionId = player.dimension.id;
  const color = isOwner(player, claim) ? ownClaimBorderColor : otherClaimBorderColor;
  const edges = [
    {
      neighbor: { x: chunk.x, z: chunk.z - 1 },
      from: { x: minX + 0.1, z: minZ + 0.05 },
      to: { x: maxX - 0.1, z: minZ + 0.05 },
    },
    {
      neighbor: { x: chunk.x, z: chunk.z + 1 },
      from: { x: minX + 0.1, z: maxZ - 0.05 },
      to: { x: maxX - 0.1, z: maxZ - 0.05 },
    },
    {
      neighbor: { x: chunk.x - 1, z: chunk.z },
      from: { x: minX + 0.05, z: minZ + 0.1 },
      to: { x: minX + 0.05, z: maxZ - 0.1 },
    },
    {
      neighbor: { x: chunk.x + 1, z: chunk.z },
      from: { x: maxX - 0.05, z: minZ + 0.1 },
      to: { x: maxX - 0.05, z: maxZ - 0.1 },
    },
  ];

  for (const edge of edges) {
    if (exposedOnly) {
      const neighbor = getClaim(dimensionId, edge.neighbor.x, edge.neighbor.z);
      if (neighbor?.ownerKey === claim.ownerKey) continue;
    }
    drawClaimViewLine(player, edge.from, edge.to, y, color, budget);
  }
}

function updateClaimViews() {
  if (claimViewPlayers.size === 0) return;
  const players = world.getPlayers();
  const onlineIds = new Set(players.map((player) => player.id));

  if (!getEconomySettings().allowClaims) {
    for (const player of players) {
      if (claimViewPlayers.delete(player.id)) {
        player.sendMessage("Claim border view was disabled because claims are disabled.");
      }
    }
    claimViewPlayers.clear();
    return;
  }

  for (const playerId of claimViewPlayers) {
    if (!onlineIds.has(playerId)) claimViewPlayers.delete(playerId);
  }

  for (const player of players) {
    if (!claimViewPlayers.has(player.id)) continue;
    const center = getChunk(player.location);
    const y = player.location.y + 0.15;
    const budget = { count: 0, originX: player.location.x, originZ: player.location.z };

    for (const offset of CLAIM_VIEW_OFFSETS) {
      const chunk = { x: center.x + offset.x, z: center.z + offset.z };
      const claim = getClaim(player.dimension.id, chunk.x, chunk.z);
      if (claim) drawClaimChunkBorders(player, chunk, claim, y, budget, true);
    }

    if (budget.count === 0) {
      const currentClaim = getClaim(player.dimension.id, center.x, center.z);
      if (currentClaim) drawClaimChunkBorders(player, center, currentClaim, y, budget, false);
    }
  }
}

function claimAreaLabel(state) {
  return state.isOwn ? "your claim" : `${state.ownerName}'s claim`;
}

function updateClaimEntryMessages() {
  const settings = getEconomySettings();
  const onlineIds = new Set();
  for (const player of world.getPlayers()) {
    onlineIds.add(player.id);
    const chunk = getChunk(player.location);
    const currentKey = chunkKey(player.dimension.id, chunk.x, chunk.z);
    const previousState = lastPlayerClaimStates.get(player.id);

    if (!settings.allowClaims) {
      lastPlayerClaimStates.set(player.id, {
        chunkKey: currentKey,
        claim: undefined,
        claimsDisabled: true,
      });
      continue;
    }
    if (currentKey === previousState?.chunkKey && !previousState.claimsDisabled) continue;

    const claim = getClaim(player.dimension.id, chunk.x, chunk.z);
    const currentState = {
      chunkKey: currentKey,
      claim: claim ? {
        ownerKey: claim.ownerKey,
        ownerName: claim.ownerName,
        isOwn: isOwner(player, claim),
      } : undefined,
    };
    lastPlayerClaimStates.set(player.id, currentState);

    const previousClaim = previousState?.claim;
    const currentClaim = currentState.claim;
    if (previousClaim?.ownerKey === currentClaim?.ownerKey) continue;

    let message;
    if (previousClaim && currentClaim) {
      message = `You have left ${claimAreaLabel(previousClaim)} and entered ${claimAreaLabel(currentClaim)}.`;
    } else if (currentClaim) {
      message = `You have entered ${claimAreaLabel(currentClaim)}.`;
    } else if (previousClaim) {
      message = `You have left ${claimAreaLabel(previousClaim)}.`;
    } else {
      continue;
    }

    player.onScreenDisplay.setActionBar(message);
    claimActionbarUntil.set(player.id, system.currentTick + ENTRY_MESSAGE_TICKS);
  }

  for (const playerId of lastPlayerClaimStates.keys()) {
    if (!onlineIds.has(playerId)) {
      lastPlayerClaimStates.delete(playerId);
      claimActionbarUntil.delete(playerId);
      denialCooldowns.delete(playerId);
      ownerKeyCache.delete(playerId);
    }
  }
}

export function isClaimActionbarActive(player) {
  const until = claimActionbarUntil.get(player.id) ?? 0;
  if (system.currentTick < until) return true;
  claimActionbarUntil.delete(player.id);
  return false;
}

function denyPlayer(player, ownerName) {
  const previous = denialCooldowns.get(player.id) ?? -DENIAL_COOLDOWN_TICKS;
  if (system.currentTick - previous < DENIAL_COOLDOWN_TICKS) return;
  denialCooldowns.set(player.id, system.currentTick);
  system.run(() => player.sendMessage(`This chunk is protected by ${ownerName}.`));
}

function cancelIfUnauthorized(event, player, dimension, location) {
  if (!getEconomySettings().allowClaims) return false;
  const claim = getClaimAt(dimension, location);
  if (!claim || isAuthorized(player, claim)) return false;
  event.cancel = true;
  denyPlayer(player, claim.ownerName);
  return true;
}

function getPlacementLocation(event) {
  if (!event.itemStack) return undefined;

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

function getDamagePlayer(damageSource) {
  const direct = damageSource?.damagingEntity;
  if (direct?.typeId === "minecraft:player") return direct;
  try {
    const owner = damageSource?.damagingProjectile
      ?.getComponent("minecraft:projectile")?.owner;
    if (owner?.typeId === "minecraft:player") return owner;
  } catch {
    // Some projectile types do not expose a projectile component.
  }
  return undefined;
}

function isFireDamage(cause) {
  return FIRE_DAMAGE_CAUSES.has(String(cause ?? "").toLowerCase());
}

function isExplosionDamage(cause) {
  return EXPLOSION_DAMAGE_CAUSES.has(String(cause ?? "").toLowerCase());
}

function enqueueFireScanTasks() {
  if (!getEconomySettings().allowClaims) {
    fireQueue.length = 0;
    queuedFireTasks.clear();
    return;
  }

  for (const player of world.getPlayers()) {
    const dimension = player.dimension;
    const center = getChunk(player.location);
    const heightRange = dimension.heightRange;
    for (let chunkX = center.x - FIRE_SCAN_RADIUS; chunkX <= center.x + FIRE_SCAN_RADIUS; chunkX++) {
      for (let chunkZ = center.z - FIRE_SCAN_RADIUS; chunkZ <= center.z + FIRE_SCAN_RADIUS; chunkZ++) {
        const claim = getClaim(dimension.id, chunkX, chunkZ);
        if (!claim || claim.fireTick) continue;
        const checkY = Math.max(heightRange.min, Math.min(0, heightRange.max - 1));
        if (!dimension.isChunkLoaded({ x: chunkX * 16 + 8, y: checkY, z: chunkZ * 16 + 8 })) continue;
        for (let minY = heightRange.min; minY < heightRange.max; minY += FIRE_SLICE_HEIGHT) {
          const taskKey = `${dimension.id}:${chunkX}:${chunkZ}:${minY}`;
          if (queuedFireTasks.has(taskKey) || fireQueue.length >= FIRE_QUEUE_LIMIT) continue;
          queuedFireTasks.add(taskKey);
          fireQueue.push({ taskKey, dimension, chunkX, chunkZ, minY, maxY: Math.min(minY + FIRE_SLICE_HEIGHT - 1, heightRange.max - 1) });
        }
      }
    }
  }
}

function processFireScanQueue() {
  if (!getEconomySettings().allowClaims) return;
  for (let count = 0; count < FIRE_TASKS_PER_TICK && fireQueue.length > 0; count++) {
    const task = fireQueue.shift();
    queuedFireTasks.delete(task.taskKey);
    const claim = getClaim(task.dimension.id, task.chunkX, task.chunkZ);
    if (!claim || claim.fireTick) continue;

    try {
      const volume = new BlockVolume(
        { x: task.chunkX * 16, y: task.minY, z: task.chunkZ * 16 },
        { x: task.chunkX * 16 + 15, y: task.maxY, z: task.chunkZ * 16 + 15 },
      );
      const fires = task.dimension.getBlocks(
        volume,
        { includeTypes: ["minecraft:fire", "minecraft:soul_fire"] },
        true,
      );
      for (const location of fires.getBlockLocationIterator()) {
        task.dimension.setBlockType(location, "minecraft:air");
      }
    } catch (error) {
      console.warn(`[Moolah Claims] Fire scan skipped: ${error}`);
    }
  }
}

export function openClaimMenu(player, onBack) {
  if (!getEconomySettings().allowClaims) {
    player.sendMessage("Claims are currently disabled.");
    if (onBack) system.run(onBack);
    return;
  }

  const form = new ActionFormData()
    .title("Claims")
    .body("Claims protect chunks from other players. Friend invitations apply to all chunks you own.")
    .button("Claim Current Chunk")
    .button("Claim Radius")
    .button("Walk & Claim")
    .button("Invite Friend")
    .button("Remove Friend")
    .button("Toggle Protections")
    .button(claimViewPlayers.has(player.id) ? "Hide Claim Borders" : "View Claim Borders")
    .button("Claim Info")
    .button("Unclaim Current Chunk");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) {
      if (onBack) system.run(onBack);
      return;
    }
    const returnToClaims = () => openClaimMenu(player, onBack);
    if (response.selection === 0) system.run(() => confirmClaimAdd(player, 0, returnToClaims));
    if (response.selection === 1) system.run(() => openClaimRadiusMenu(player, returnToClaims));
    if (response.selection === 2) system.run(() => startWalkMode(player));
    if (response.selection === 3) system.run(() => openClaimInviteMenu(player, returnToClaims));
    if (response.selection === 4) system.run(() => openClaimDeinviteMenu(player, returnToClaims));
    if (response.selection === 5) system.run(() => openClaimToggleMenu(player, returnToClaims));
    if (response.selection === 6) system.run(() => toggleClaimView(player));
    if (response.selection === 7) system.run(() => showClaimInfo(player));
    if (response.selection === 8) system.run(() => confirmClaimRemove(player, 0, returnToClaims));
  }).catch(() => player.sendMessage("The Claims menu could not be opened."));
}

function parseRadius(value) {
  if (value === undefined) return 0;
  const text = String(value).trim();
  if (!/^[1-9]$/.test(text)) return undefined;
  return Number(text);
}

export function registerClaimCommand(commandRegistry) {
  commandRegistry.registerEnum(
    "moolah:claim_action",
    ["add", "remove", "invite", "deinvite", "toggle", "info", "walk", "view"],
  );
  commandRegistry.registerCommand(
    {
      name: "moolah:claim",
      description: "Manage protected chunk claims.",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
      optionalParameters: [
        { type: CustomCommandParamType.Enum, name: "moolah:claim_action" },
        { type: CustomCommandParamType.Integer, name: "radius" },
      ],
    },
    (origin, actionValue, value) => {
      if (
        origin.sourceType !== CustomCommandSource.Entity
        || origin.sourceEntity?.typeId !== "minecraft:player"
      ) {
        return {
          status: CustomCommandStatus.Failure,
          message: "This command can only be used by a player.",
        };
      }

      const player = origin.sourceEntity;
      if (!getEconomySettings().allowClaims) {
        return { status: CustomCommandStatus.Failure, message: "Claims are currently disabled." };
      }
      if (actionValue === undefined) {
        system.run(() => openClaimMenu(player));
        return { status: CustomCommandStatus.Success };
      }

      const action = String(actionValue).trim().toLowerCase();
      if (action === "add" || action === "remove") {
        const radius = parseRadius(value);
        if (radius === undefined) {
          return { status: CustomCommandStatus.Failure, message: `Usage: /claim ${action} [1-9]` };
        }
        system.run(() => action === "add"
          ? confirmClaimAdd(player, radius)
          : confirmClaimRemove(player, radius));
        return { status: CustomCommandStatus.Success };
      }
      if (action === "invite") {
        if (value !== undefined) {
          return { status: CustomCommandStatus.Failure, message: "Usage: /claim invite" };
        }
        system.run(() => openClaimInviteMenu(player));
        return { status: CustomCommandStatus.Success };
      }
      if (action === "deinvite") {
        if (value !== undefined) {
          return { status: CustomCommandStatus.Failure, message: "Usage: /claim deinvite" };
        }
        system.run(() => openClaimDeinviteMenu(player));
        return { status: CustomCommandStatus.Success };
      }
      if (action === "toggle") {
        if (value !== undefined) {
          return { status: CustomCommandStatus.Failure, message: "Usage: /claim toggle" };
        }
        system.run(() => openClaimToggleMenu(player));
        return { status: CustomCommandStatus.Success };
      }
      if (action === "info" && value === undefined) {
        system.run(() => showClaimInfo(player));
        return { status: CustomCommandStatus.Success };
      }
      if (action === "walk" && value === undefined) {
        system.run(() => startWalkMode(player));
        return { status: CustomCommandStatus.Success };
      }
      if (action === "view" && value === undefined) {
        system.run(() => toggleClaimView(player));
        return { status: CustomCommandStatus.Success };
      }

      return {
        status: CustomCommandStatus.Failure,
        message: "Usage: /claim <add|remove> [radius] or /claim <invite|deinvite|toggle|info|walk|view>",
      };
    },
  );
}

export function initializeClaimSystem() {
  if (initialized) return;
  initialized = true;

  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    cancelIfUnauthorized(event, event.player, event.dimension, event.block.location);
  });
  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    if (cancelIfUnauthorized(event, event.player, event.block.dimension, event.block.location)) return;
    const placementLocation = getPlacementLocation(event);
    if (placementLocation) {
      cancelIfUnauthorized(event, event.player, event.block.dimension, placementLocation);
    }
  });
  world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
    cancelIfUnauthorized(event, event.player, event.target.dimension, event.target.location);
  });
  world.beforeEvents.entityItemPickup.subscribe((event) => {
    if (event.entity.typeId !== "minecraft:player") return;
    cancelIfUnauthorized(event, event.entity, event.item.dimension, event.item.location);
  });
  world.beforeEvents.entityHurt.subscribe((event) => {
    if (!getEconomySettings().allowClaims) return;
    const claim = getClaimAt(event.hurtEntity.dimension, event.hurtEntity.location);
    if (!claim) return;
    const cause = event.damageSource?.cause;
    if ((!claim.fireTick && isFireDamage(cause)) || (!claim.explosions && isExplosionDamage(cause))) {
      event.cancel = true;
      return;
    }
    const attacker = getDamagePlayer(event.damageSource);
    if (attacker && !isAuthorized(attacker, claim)) {
      event.cancel = true;
      denyPlayer(attacker, claim.ownerName);
    }
  });
  world.beforeEvents.explosion.subscribe((event) => {
    if (!getEconomySettings().allowClaims) return;
    const chunkStates = new Map();
    const allowedBlocks = event.getImpactedBlocks().filter((block) => {
      const chunk = getChunk(block.location);
      const key = chunkKey(block.dimension.id, chunk.x, chunk.z);
      if (!chunkStates.has(key)) {
        const claim = getClaim(block.dimension.id, chunk.x, chunk.z);
        chunkStates.set(key, !claim || claim.explosions);
      }
      return chunkStates.get(key);
    });
    event.setImpactedBlocks(allowedBlocks);
  });

  system.runInterval(updateWalkSessions, 2);
  system.runInterval(updateClaimViews, 10);
  system.runInterval(updateClaimEntryMessages, 10);
  system.runInterval(enqueueFireScanTasks, 40);
  system.runInterval(processFireScanQueue, 1);
}
