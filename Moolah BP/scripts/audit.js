import { system, world } from "@minecraft/server";
import { ActionFormData, MessageFormData } from "@minecraft/server-ui";

const META_PROPERTY = "moolah:audit_meta";
const SHARD_PREFIX = "moolah:audit:";
const MAX_ENTRIES = 512;
const ENTRIES_PER_SHARD = 32;
const PAGE_SIZE = 20;
const MAX_TEXT_LENGTH = 700;
const BLF_EVENT_ID = "blf:log";
const BLF_SOURCE = "Moolah";
const BLF_MAX_MESSAGE_LENGTH = 1000;

const LOG_CATEGORIES = [
  ["deposit", "Deposits"],
  ["withdrawal", "Withdrawals"],
  ["transfer", "Transfers"],
  ["mail", "Mail"],
  ["market", "Market"],
  ["warp", "Warps"],
  ["claim", "Claims"],
  ["admin", "Admin & Tax"],
];
const LOG_CATEGORY_LABELS = new Map(LOG_CATEGORIES);

function cleanText(value, fallback = "", maxLength = MAX_TEXT_LENGTH) {
  const text = String(value ?? fallback).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function readJsonProperty(propertyId, fallback) {
  const raw = world.getDynamicProperty(propertyId);
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getMeta() {
  const value = readJsonProperty(META_PROPERTY, undefined);
  if (
    value?.version === 1
    && Number.isSafeInteger(value.nextSequence)
    && value.nextSequence >= 0
    && Number.isSafeInteger(value.count)
    && value.count >= 0
    && value.count <= MAX_ENTRIES
  ) {
    return value;
  }
  return { version: 1, nextSequence: 0, count: 0 };
}

function shardPropertyId(shardIndex) {
  return `${SHARD_PREFIX}${shardIndex}`;
}

function getShard(shardIndex) {
  const value = readJsonProperty(shardPropertyId(shardIndex), undefined);
  return value?.version === 1 && Array.isArray(value.entries)
    ? value.entries.slice(0, ENTRIES_PER_SHARD)
    : Array(ENTRIES_PER_SHARD);
}

function actorDetails(actor) {
  if (typeof actor === "string") return { actorName: actor, actorId: undefined };
  return {
    actorName: cleanText(actor?.name, "System"),
    actorId: typeof actor?.id === "string" ? actor.id : undefined,
  };
}

function sendBlfAuditLog(category, action, identity, details) {
  const categoryLabel = LOG_CATEGORY_LABELS.get(category) ?? category;
  const message = cleanText(
    `[${categoryLabel}] ${action} | Player: ${identity.actorName}`
      + `${details ? ` | ${details}` : ""}`,
    "Moolah action",
    BLF_MAX_MESSAGE_LENGTH,
  );

  try {
    system.sendScriptEvent(BLF_EVENT_ID, JSON.stringify({
      source: BLF_SOURCE,
      level: "info",
      message,
    }));
  } catch (error) {
    console.warn(`[Moolah BLF] Could not send log entry: ${error?.stack ?? error}`);
  }
}

export function writeAuditLog(category, action, actor, details) {
  let identity;
  let cleanedCategory;
  let cleanedAction;
  let cleanedDetails;

  try {
    identity = actorDetails(actor);
    cleanedCategory = cleanText(category, "admin");
    cleanedAction = cleanText(action, "Action");
    cleanedDetails = cleanText(details);
    const meta = getMeta();
    const sequence = meta.nextSequence;
    const slot = sequence % MAX_ENTRIES;
    const shardIndex = Math.floor(slot / ENTRIES_PER_SHARD);
    const shardSlot = slot % ENTRIES_PER_SHARD;
    const entries = getShard(shardIndex);
    entries[shardSlot] = {
      sequence,
      timestamp: Date.now(),
      category: cleanedCategory,
      action: cleanedAction,
      actorName: identity.actorName,
      actorId: identity.actorId,
      details: cleanedDetails,
    };
    world.setDynamicProperty(
      shardPropertyId(shardIndex),
      JSON.stringify({ version: 1, entries }),
    );
    world.setDynamicProperty(META_PROPERTY, JSON.stringify({
      version: 1,
      nextSequence: sequence + 1,
      count: Math.min(MAX_ENTRIES, meta.count + 1),
    }));
  } catch (error) {
    console.warn(`[Moolah Audit] Could not save log entry: ${error?.stack ?? error}`);
  }

  try {
    if (identity === undefined) identity = actorDetails(actor);
    if (cleanedCategory === undefined) cleanedCategory = cleanText(category, "admin");
    if (cleanedAction === undefined) cleanedAction = cleanText(action, "Action");
    if (cleanedDetails === undefined) cleanedDetails = cleanText(details);
    sendBlfAuditLog(cleanedCategory, cleanedAction, identity, cleanedDetails);
  } catch (error) {
    console.warn(`[Moolah BLF] Could not prepare log entry: ${error?.stack ?? error}`);
  }
}

function getAuditLogs(category) {
  const meta = getMeta();
  const firstSequence = Math.max(0, meta.nextSequence - meta.count);
  const shards = new Map();
  const results = [];
  for (let sequence = meta.nextSequence - 1; sequence >= firstSequence; sequence--) {
    const slot = sequence % MAX_ENTRIES;
    const shardIndex = Math.floor(slot / ENTRIES_PER_SHARD);
    if (!shards.has(shardIndex)) shards.set(shardIndex, getShard(shardIndex));
    const entry = shards.get(shardIndex)[slot % ENTRIES_PER_SHARD];
    if (!entry || entry.sequence !== sequence) continue;
    if (category && entry.category !== category) continue;
    results.push(entry);
  }
  return results;
}

function formatTimestamp(timestamp) {
  try {
    return new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
  } catch {
    return "Unknown time";
  }
}

function openLogEntry(player, entry, onBack) {
  const form = new MessageFormData()
    .title(entry.action)
    .body(
      `${formatTimestamp(entry.timestamp)}\n`
      + `Player: ${entry.actorName}\n`
      + `Category: ${entry.category}\n\n`
      + (entry.details || "No additional details."),
    )
    .button1("Back")
    .button2("Close");
  form.show(player).then((response) => {
    if (!response.canceled && response.selection === 0 && onBack) system.run(onBack);
  }).catch(() => player.sendMessage("The log entry could not be opened."));
}

function openLogPage(player, category, title, page, onBack) {
  if (!player.hasTag("econ_admin")) {
    player.sendMessage("You no longer have permission to view logs.");
    return;
  }
  const entries = getAuditLogs(category);
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageEntries = entries.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const form = new ActionFormData()
    .title(`${title} (${safePage + 1}/${pageCount})`)
    .body(entries.length === 0 ? "No successful actions have been recorded." : `${entries.length} retained entries. Newest first.`);
  for (const entry of pageEntries) {
    form.button(`${entry.action}\n${entry.actorName} — ${formatTimestamp(entry.timestamp)}`);
  }
  if (safePage > 0) form.button("Previous Page");
  if (safePage + 1 < pageCount) form.button("Next Page");
  form.button("Back");

  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) {
      if (onBack) system.run(onBack);
      return;
    }
    let index = response.selection;
    if (index < pageEntries.length) {
      const entry = pageEntries[index];
      system.run(() => openLogEntry(
        player,
        entry,
        () => openLogPage(player, category, title, safePage, onBack),
      ));
      return;
    }
    index -= pageEntries.length;
    if (safePage > 0) {
      if (index === 0) {
        system.run(() => openLogPage(player, category, title, safePage - 1, onBack));
        return;
      }
      index--;
    }
    if (safePage + 1 < pageCount && index === 0) {
      system.run(() => openLogPage(player, category, title, safePage + 1, onBack));
      return;
    }
    if (onBack) system.run(onBack);
  }).catch(() => player.sendMessage("The logs could not be opened."));
}

export function openAuditLogMenu(player, onBack) {
  if (!player.hasTag("econ_admin")) {
    player.sendMessage("You do not have permission to view logs.");
    if (onBack) system.run(onBack);
    return;
  }
  const allEntries = getAuditLogs();
  const counts = new Map();
  for (const entry of allEntries) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  const form = new ActionFormData()
    .title("Logs")
    .body(`Successful Moolah actions are retained. Up to ${MAX_ENTRIES} recent entries are stored.`)
    .button(`All Activity\n${allEntries.length} entries`);
  for (const [category, label] of LOG_CATEGORIES) {
    const count = counts.get(category) ?? 0;
    form.button(`${label}\n${count} ${count === 1 ? "entry" : "entries"}`);
  }

  form.show(player).then((response) => {
    if (response.canceled || response.selection === undefined) {
      if (onBack) system.run(onBack);
      return;
    }
    const selection = response.selection === 0
      ? [undefined, "All Activity"]
      : LOG_CATEGORIES[response.selection - 1];
    if (!selection) return;
    system.run(() => openLogPage(
      player,
      selection[0],
      selection[1],
      0,
      () => openAuditLogMenu(player, onBack),
    ));
  }).catch(() => player.sendMessage("The Logs menu could not be opened."));
}
