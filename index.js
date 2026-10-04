// Hidden Floor Collapse for SillyTavern
// Groups consecutive hidden (is_system="true") chat messages into a details-like fold.
// Supports per-chat persistent notes for each hidden sequence.

import { eventSource, event_types } from '/script.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';

const MODULE_NAME = 'hidden-floor-collapse';
const CHAT_SELECTOR = '#chat';

const DETAILS_CLASS = 'st-hfc-details';
const GROUPED_CLASS = 'st-hfc-grouped-message';
const COLLAPSED_CLASS = 'st-hfc-collapsed-message';

// Stored inside the current chat's metadata.
const METADATA_KEY = 'hidden_floor_collapse';
const METADATA_VERSION = 1;

let observer = null;
let scheduled = false;
let suppressMutationObserver = false;
let initialized = false;


/* ------------------------------------------------------------------------- */
/* Basic helpers                                                             */
/* ------------------------------------------------------------------------- */

function getChatElement() {
    return document.querySelector(CHAT_SELECTOR);
}

function isOurDetails(node) {
    return node instanceof HTMLElement
        && node.classList.contains(DETAILS_CLASS);
}

function isCollapsibleHiddenMessage(node) {
    if (!(node instanceof HTMLElement)) return false;
    if (!node.classList.contains('mes')) return false;
    if (node.getAttribute('is_system') !== 'true') return false;

    // Leave SillyTavern's own small system/tool blocks alone.
    if (node.classList.contains('smallSysMes')) return false;
    if (node.classList.contains('toolCall')) return false;
    if (node.getAttribute('type') === 'system') return false;

    return true;
}

function getMessageId(messageElement) {
    const raw = messageElement.getAttribute('mesid');
    const number = Number(raw);

    return Number.isFinite(number) ? number : null;
}

function getMessageName(messageElement) {
    const nameFromAttr = messageElement.getAttribute('ch_name');
    const nameFromDom = messageElement
        .querySelector('.ch_name .name_text')
        ?.textContent
        ?.trim();

    return nameFromDom || nameFromAttr || 'Unknown';
}

function getMessagePreview(messageElement) {
    const text = messageElement.querySelector('.mes_text')?.textContent || '';

    return text
        .replace(/\s+/g, ' ')
        .trim();
}


/* ------------------------------------------------------------------------- */
/* Group summaries                                                           */
/* ------------------------------------------------------------------------- */

function summarizeNames(group) {
    const counts = new Map();

    for (const message of group) {
        const name = getMessageName(message);
        counts.set(name, (counts.get(name) || 0) + 1);
    }

    return Array.from(counts.entries())
        .slice(0, 4)
        .map(([name, count]) => `${name} × ${count}`)
        .join(' / ');
}

function summarizeRange(group) {
    const firstId = getMessageId(group[0]);
    const lastId = getMessageId(group[group.length - 1]);

    if (firstId === null || lastId === null) {
        return '';
    }

    return firstId === lastId
        ? `#${firstId}`
        : `#${firstId}–#${lastId}`;
}


/* ------------------------------------------------------------------------- */
/* Chat metadata / notes                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Returns the metadata object used by this extension.
 *
 * IMPORTANT:
 * SillyTavern replaces chatMetadata when switching chats, so callers should
 * not keep this object around permanently.
 */
function getMetadataState(chatMetadata = SillyTavern.getContext().chatMetadata) {
    let state = chatMetadata[METADATA_KEY];

    if (
        !state
        || typeof state !== 'object'
        || Array.isArray(state)
    ) {
        state = {
            version: METADATA_VERSION,
            notes: {},
        };

        chatMetadata[METADATA_KEY] = state;
    }

    if (
        !state.notes
        || typeof state.notes !== 'object'
        || Array.isArray(state.notes)
    ) {
        state.notes = {};
    }

    if (!state.version) {
        state.version = METADATA_VERSION;
    }

    return state;
}

/**
 * Finds the SillyTavern chat object corresponding to one rendered message.
 */
function getChatMessage(messageElement) {
    const messageId = getMessageId(messageElement);

    if (messageId === null) {
        return null;
    }

    const { chat } = SillyTavern.getContext();

    return chat?.[messageId] ?? null;
}

/**
 * Produces a reasonably stable anchor for one message.
 *
 * mesid is essentially a rendered/index position and may change if earlier
 * messages are removed. send_date normally remains attached to the message,
 * so we prefer that whenever available.
 */
function getMessageAnchor(messageElement) {
    const messageId = getMessageId(messageElement);
    const chatMessage = getChatMessage(messageElement);

    const sendDate = chatMessage?.send_date;

    if (
        sendDate !== undefined
        && sendDate !== null
        && String(sendDate).trim()
    ) {
        return `date:${String(sendDate)}`;
    }

    // Fallback for unusual/old messages without send_date.
    if (messageId !== null) {
        return `mesid:${messageId}`;
    }

    return null;
}

/**
 * A note belongs to the hidden group whose first hidden message owns this
 * anchor.
 */
function getGroupKey(group) {
    if (!group?.length) {
        return null;
    }

    return getMessageAnchor(group[0]);
}

function getGroupNote(group) {
    const key = getGroupKey(group);

    if (!key) {
        return '';
    }

    const state = getMetadataState();
    const note = state.notes[key];

    return typeof note === 'string'
        ? note
        : '';
}


/* ------------------------------------------------------------------------- */
/* Note editing                                                              */
/* ------------------------------------------------------------------------- */

function showToast(type, message) {
    const toast = globalThis.toastr;

    if (toast && typeof toast[type] === 'function') {
        toast[type](message);
    }
}

/**
 * Opens SillyTavern's input popup and persists the note into chatMetadata.
 */
async function editGroupNote(group) {
    const key = getGroupKey(group);

    if (!key) {
        showToast('warning', '无法识别这个隐藏楼层组。');
        return;
    }

    // Keep the metadata reference only for the lifetime of this popup.
    // This lets us detect if the user switches chat while editing.
    const contextAtOpen = SillyTavern.getContext();
    const metadataAtOpen = contextAtOpen.chatMetadata;
    const state = getMetadataState(metadataAtOpen);

    const previousNote = typeof state.notes[key] === 'string'
        ? state.notes[key]
        : '';

    const value = await contextAtOpen.Popup.show.input(
        '隐藏楼层备注',
        '给这组隐藏楼层写一个备注。清空内容并保存即可删除备注。',
        previousNote,
    );

    // User pressed Cancel.
    if (value === null) {
        return;
    }

    const currentContext = SillyTavern.getContext();

    // The popup may have remained open while the user switched chats.
    // Never accidentally save the old group's note into the new chat.
    if (currentContext.chatMetadata !== metadataAtOpen) {
        showToast('warning', '聊天已经切换，备注没有保存。');
        return;
    }

    const nextNote = String(value).trim();

    if (nextNote === previousNote) {
        return;
    }

    if (nextNote) {
        state.notes[key] = nextNote;
    } else {
        delete state.notes[key];
    }

    try {
        await currentContext.saveMetadata();

        if (nextNote) {
            showToast('success', '隐藏楼层备注已保存。');
        } else {
            showToast('success', '隐藏楼层备注已删除。');
        }
    } catch (error) {
        // Roll back local metadata if persistence failed.
        if (previousNote) {
            state.notes[key] = previousNote;
        } else {
            delete state.notes[key];
        }

        console.error(
            `[${MODULE_NAME}] Failed to save hidden-floor note:`,
            error,
        );

        showToast('error', '备注保存失败，请查看控制台。');
        return;
    }

    scheduleApply('note-updated');
}


/* ------------------------------------------------------------------------- */
/* Note UI                                                                   */
/* ------------------------------------------------------------------------- */

function createNoteElement(group) {
    const noteText = getGroupNote(group);

    const note = document.createElement('span');
    note.className = 'st-hfc-note';
    note.setAttribute('role', 'button');
    note.setAttribute('tabindex', '0');

    if (!noteText) {
        note.classList.add('is-empty');
    }

    const icon = document.createElement('span');
    icon.className = 'st-hfc-note-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✎';

    const text = document.createElement('span');
    text.className = 'st-hfc-note-text';
    text.textContent = noteText || '添加备注';

    note.append(icon, text);

    note.title = noteText
        ? `备注：${noteText}\n点击编辑`
        : '点击给这组隐藏楼层添加备注';

    note.setAttribute(
        'aria-label',
        noteText
            ? `编辑备注：${noteText}`
            : '给这组隐藏楼层添加备注',
    );

    note.addEventListener('click', (event) => {
        // summary itself toggles <details>.
        // Clicking the note must only edit the note.
        event.preventDefault();
        event.stopPropagation();

        void editGroupNote(group);
    });

    note.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        note.click();
    });

    return note;
}


/* ------------------------------------------------------------------------- */
/* Fold card creation                                                        */
/* ------------------------------------------------------------------------- */

function createDetailsForGroup(group, initiallyOpen = false) {
    const details = document.createElement('details');
    details.className = DETAILS_CLASS;

    details.dataset.count = String(group.length);
    details.dataset.range = summarizeRange(group);

    const groupKey = getGroupKey(group);

    if (groupKey) {
        details.dataset.groupKey = groupKey;
    }

    if (initiallyOpen) {
        details.open = true;
    }

    const summary = document.createElement('summary');
    summary.className = 'st-hfc-summary';

    const kicker = document.createElement('span');
    kicker.className = 'st-hfc-kicker';
    kicker.textContent = 'Hidden sequence';

    const title = document.createElement('span');
    title.className = 'st-hfc-title';
    title.textContent = `已隐藏${group.length}层`;

    const range = document.createElement('span');
    range.className = 'st-hfc-range';
    range.textContent = summarizeRange(group);

    const names = document.createElement('span');
    names.className = 'st-hfc-names';
    names.textContent = summarizeNames(group);

    const note = createNoteElement(group);

    const preview = document.createElement('span');
    preview.className = 'st-hfc-preview';

    const firstPreview = getMessagePreview(group[0]);

    preview.textContent = firstPreview
        ? `“${firstPreview.slice(0, 88)}${firstPreview.length > 88 ? '…' : ''}”`
        : '点击展开查看隐藏楼层';

    const hint = document.createElement('span');
    hint.className = 'st-hfc-hint';
    hint.textContent = initiallyOpen
        ? '点击以折叠'
        : '点击以展开';

    summary.append(
        kicker,
        title,
        range,
        names,
        note,
        preview,
        hint,
    );

    details.append(summary);

    details.addEventListener('toggle', () => {
        syncGroupVisibility(details, group);
    });

    return details;
}


/* ------------------------------------------------------------------------- */
/* Fold state                                                                */
/* ------------------------------------------------------------------------- */

function syncGroupVisibility(details, group) {
    const collapsed = !details.open;

    details.classList.toggle('is-open', details.open);

    const hint = details.querySelector('.st-hfc-hint');

    if (hint) {
        hint.textContent = details.open
            ? '点击以折叠'
            : '点击以展开';
    }

    for (const message of group) {
        message.classList.add(GROUPED_CLASS);
        message.classList.toggle(COLLAPSED_CLASS, collapsed);
    }
}

/**
 * Remember which cards are currently open before rebuilding the DOM.
 *
 * This is especially useful after editing a note: editing an open card should
 * not unexpectedly collapse it.
 */
function collectOpenGroupKeys(chat) {
    const openKeys = new Set();

    chat
        .querySelectorAll(`:scope > details.${DETAILS_CLASS}[open]`)
        .forEach((details) => {
            if (!(details instanceof HTMLDetailsElement)) {
                return;
            }

            const key = details.dataset.groupKey;

            if (key) {
                openKeys.add(key);
            }
        });

    return openKeys;
}


/* ------------------------------------------------------------------------- */
/* Cleanup / grouping                                                        */
/* ------------------------------------------------------------------------- */

function cleanupExistingFolds(chat) {
    chat
        .querySelectorAll(`:scope > .${DETAILS_CLASS}`)
        .forEach((node) => node.remove());

    chat
        .querySelectorAll(
            `:scope > .mes.${GROUPED_CLASS}, :scope > .mes.${COLLAPSED_CLASS}`,
        )
        .forEach((node) => {
            node.classList.remove(
                GROUPED_CLASS,
                COLLAPSED_CLASS,
            );
        });
}

function findHiddenGroups(chat) {
    const groups = [];
    let current = [];

    for (const child of Array.from(chat.children)) {
        if (isOurDetails(child)) {
            continue;
        }

        if (isCollapsibleHiddenMessage(child)) {
            current.push(child);
            continue;
        }

        if (current.length) {
            groups.push(current);
            current = [];
        }
    }

    if (current.length) {
        groups.push(current);
    }

    return groups;
}


/* ------------------------------------------------------------------------- */
/* Main renderer                                                             */
/* ------------------------------------------------------------------------- */

function applyHiddenFloorCollapse() {
    const chat = getChatElement();

    if (!chat) {
        return;
    }

    suppressMutationObserver = true;

    try {
        // Preserve manually opened cards while rebuilding.
        const openGroupKeys = collectOpenGroupKeys(chat);

        cleanupExistingFolds(chat);

        const groups = findHiddenGroups(chat);

        for (const group of groups) {
            const key = getGroupKey(group);
            const initiallyOpen = key
                ? openGroupKeys.has(key)
                : false;

            const details = createDetailsForGroup(
                group,
                initiallyOpen,
            );

            group[0].before(details);

            syncGroupVisibility(details, group);
        }
    } finally {
        requestAnimationFrame(() => {
            suppressMutationObserver = false;
        });
    }
}

function scheduleApply(reason = 'unknown') {
    if (scheduled) {
        return;
    }

    scheduled = true;

    requestAnimationFrame(() => {
        scheduled = false;

        try {
            applyHiddenFloorCollapse();
        } catch (error) {
            console.error(
                `[${MODULE_NAME}] Failed to apply folds after ${reason}:`,
                error,
            );
        }
    });
}


/* ------------------------------------------------------------------------- */
/* Mutation observer                                                         */
/* ------------------------------------------------------------------------- */

function setupMutationObserver() {
    const chat = getChatElement();

    if (!chat || observer) {
        return;
    }

    observer = new MutationObserver((mutations) => {
        if (suppressMutationObserver) {
            return;
        }

        // Never rebuild folds while SillyTavern is generating.
        if (document.body.dataset.generating === 'true') {
            return;
        }

        const relevant = mutations.some((mutation) => {
            return mutation.type === 'attributes'
                && mutation.attributeName === 'is_system'
                && mutation.target instanceof HTMLElement
                && mutation.target.classList.contains('mes');
        });

        if (relevant) {
            scheduleApply('is_system-changed');
        }
    });

    observer.observe(chat, {
        childList: false,
        subtree: true,
        attributes: true,
        attributeFilter: ['is_system'],
    });
}


/* ------------------------------------------------------------------------- */
/* Commands                                                                  */
/* ------------------------------------------------------------------------- */

function openAllFolds() {
    document
        .querySelectorAll(`${CHAT_SELECTOR} > .${DETAILS_CLASS}`)
        .forEach((details) => {
            if (details instanceof HTMLDetailsElement) {
                details.open = true;
            }
        });
}

function closeAllFolds() {
    document
        .querySelectorAll(`${CHAT_SELECTOR} > .${DETAILS_CLASS}`)
        .forEach((details) => {
            if (details instanceof HTMLDetailsElement) {
                details.open = false;
            }
        });
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'hfc-refresh',
            aliases: ['hidden-fold-refresh'],
            callback: () => {
                scheduleApply('slash-refresh');
                return 'true';
            },
            helpString: 'Rebuild hidden-message fold groups.',
        }),
    );

    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'hfc-open',
            aliases: ['hidden-fold-open'],
            callback: () => {
                openAllFolds();
                return 'true';
            },
            helpString: 'Open all hidden-message fold groups.',
        }),
    );

    SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({
            name: 'hfc-close',
            aliases: ['hidden-fold-close'],
            callback: () => {
                closeAllFolds();
                return 'true';
            },
            helpString: 'Close all hidden-message fold groups.',
        }),
    );
}


/* ------------------------------------------------------------------------- */
/* Initialization                                                            */
/* ------------------------------------------------------------------------- */

export function init() {
    if (initialized) {
        return;
    }

    initialized = true;

    setupMutationObserver();
    registerSlashCommands();

    const refreshEvents = [
        event_types.APP_READY,
        event_types.CHAT_CHANGED,
        event_types.CHAT_LOADED,
        event_types.MORE_MESSAGES_LOADED,

        // These are included when available in the installed ST version.
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_EDITED,
    ].filter(Boolean);

    for (const eventName of refreshEvents) {
        eventSource.on(
            eventName,
            () => scheduleApply(eventName),
        );
    }

    scheduleApply('init');

    console.info('[Hidden Floor Collapse] loaded');
}

init();
