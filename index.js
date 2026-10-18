// Hidden Floor Collapse for SillyTavern
// Groups consecutive hidden (is_system="true") chat messages into a details-like fold.
// Supports per-chat persistent notes for each hidden sequence.

import * as Tavern from '/script.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';

const MODULE_NAME = 'hidden-floor-collapse';
const CHAT_SELECTOR = '#chat';

const DETAILS_CLASS = 'st-hfc-details';
const GROUPED_CLASS = 'st-hfc-grouped-message';
const COLLAPSED_CLASS = 'st-hfc-collapsed-message';
const VIRTUAL_CLASS = 'st-hfc-virtual-message';
const CARD_HOST_CLASS = 'st-hfc-card-host';
const { eventSource, event_types } = Tavern;
const RENDER_BATCH_SIZE = 8;

// Stored inside the current chat's metadata.
const METADATA_KEY = 'hidden_floor_collapse';
const METADATA_VERSION = 1;

let observer = null;
let observedChat = null;
let scheduled = false;
let initialized = false;
let discoveryObserver = null;
let parentObserver = null;
let session = null;
let sessionNumber = 0;
let retryTimer = null;
let retryCount = 0;
let restoreFrame = null;
let restoredSinceNotify = false;
let preserveMessageDom = false;
let managedOwnership = false;
const mountedMessages = new Set();
let openKeys = new Set();
const cards = new Map();
const virtualMessages = new Map();
const restoreQueue = new Map();
const failedRestores = new Set();


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
    const message = getChatMessage(node);
    if (message ? !isCollapsibleData(message) : node.getAttribute('is_system') !== 'true') return false;

    // Leave SillyTavern's own small system/tool blocks alone.
    if (node.classList.contains('smallSysMes')) return false;
    if (node.classList.contains('toolCall')) return false;
    if (node.getAttribute('type') === 'system') return false;

    return true;
}

function isCollapsibleData(message) {
    return message?.is_system === true
        && message.extra?.isSmallSys !== true
        && !Array.isArray(message.extra?.tool_invocations)
        && message.extra?.type !== 'system';
}

function getMessageId(messageElement) {
    const raw = messageElement.getAttribute('mesid');
    if (raw === null || raw.trim() === '') return null;
    const number = Number(raw);

    return Number.isInteger(number) && number >= 0 ? number : null;
}

function getMessageName(messageElement) {
    const nameFromAttr = messageElement.getAttribute('ch_name');
    const nameFromDom = messageElement
        .querySelector('.ch_name .name_text')
        ?.textContent
        ?.trim();

    return getChatMessage(messageElement)?.name || nameFromDom || nameFromAttr || 'Unknown';
}

function getMessagePreview(messageElement) {
    const message = getChatMessage(messageElement);
    const text = message?.extra?.display_text ?? message?.mes
        ?? messageElement.querySelector('.mes_text')?.textContent ?? '';

    return String(text)
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

    // Anchor notes/open state to the start of the hidden run in chat DATA.
    // Only the loaded portion is ever rendered. Loading an older part of the
    // same run must not move the note to a different key.
    const { chat } = SillyTavern.getContext();
    let firstId = getMessageId(group[0]);
    if (firstId === null) return null;
    while (firstId > 0 && isCollapsibleData(chat[firstId - 1])) firstId--;
    const date = chat[firstId]?.send_date;
    const canonical = date !== undefined && date !== null && String(date).trim()
        ? `date:${String(date)}` : `mesid:${firstId}`;
    const notes = getMetadataState().notes;
    if (Object.hasOwn(notes, canonical)) return canonical;
    // Preserve notes made by 1.0.x on a partially loaded group.
    for (let id = firstId; id <= getMessageId(group[group.length - 1]); id++) {
        const legacyDate = chat[id]?.send_date;
        const key = legacyDate !== undefined && legacyDate !== null && String(legacyDate).trim()
            ? `date:${String(legacyDate)}` : `mesid:${id}`;
        if (Object.hasOwn(notes, key)) return key;
    }
    return canonical;
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

function createNoteElement(getGroup) {
    const noteText = getGroupNote(getGroup());

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

        void editGroupNote(getGroup());
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

function createDetailsForGroup(group, key, cardId = key) {
    const details = document.createElement('details');
    details.className = DETAILS_CLASS;
    details.dataset.groupKey = key;
    const state = { details, group, key, cardId, signature: '', expectedOpen: openKeys.has(key) };
    details.open = state.expectedOpen;
    details.addEventListener('toggle', () => {
        if (!details.isConnected || cards.get(cardId) !== state || details.open === state.expectedOpen) return;
        if (!details.open && [...cards.values()].some(card => card.key === key && groupHasEditor(card.group))) {
            details.open = true;
            showToast('info', '请先保存或取消楼层编辑，再收起这一组。');
            return;
        }
        state.expectedOpen = details.open;
        if (details.open) {
            openKeys.add(key);
            state.group.forEach(node => failedRestores.delete(node));
        } else {
            openKeys.delete(key);
            state.group.forEach(node => restoreQueue.delete(node));
        }
        scheduleApply('toggle');
    });
    return state;
}

function updateCard(state, group) {
    state.group = group;
    const { details } = state;
    const rangeText = summarizeRange(group);
    const namesText = summarizeNames(group);
    const previewText = getMessagePreview(group[0]);
    const noteText = getGroupNote(group);
    const signature = JSON.stringify([group.length, rangeText, namesText, previewText.slice(0, 89), noteText]);
    if (signature !== state.signature) {
        const summary = document.createElement('summary');
        summary.className = 'st-hfc-summary';
        const layout = document.createElement('span');
        layout.className = 'st-hfc-summary-layout';
        const add = (className, text) => {
            const span = document.createElement('span');
            span.className = className;
            span.textContent = text;
            layout.append(span);
            return span;
        };
        add('st-hfc-kicker', 'Hidden sequence');
        add('st-hfc-title', `已隐藏${group.length}层`);
        add('st-hfc-range', rangeText);
        add('st-hfc-names', namesText);
        // Resolve the current nodes when clicked, after an expansion replaces
        // placeholders with freshly rendered messages.
        const note = createNoteElement(() => state.group);
        layout.append(note);
        add('st-hfc-preview', previewText
            ? `“${previewText.slice(0, 88)}${previewText.length > 88 ? '…' : ''}”`
            : '点击展开查看隐藏楼层');
        add('st-hfc-hint', '点击以展开');
        summary.append(layout);
        details.replaceChildren(summary);
        state.signature = signature;
    }
    details.dataset.count = String(group.length);
    details.dataset.range = rangeText;
    state.expectedOpen = openKeys.has(state.key);
    details.open = state.expectedOpen;
    details.classList.toggle('is-open', details.open);
    updateCardProgress(state);
}

function updateCardProgress(state) {
    const pending = state.group.filter(node => virtualMessages.has(node)).length;
    const failed = state.group.some(node => failedRestores.has(node));
    const busy = state.details.open && pending > 0 && !failed;
    state.details.setAttribute('aria-busy', String(busy));
    const hint = state.details.querySelector('.st-hfc-hint');
    if (hint) {
        hint.textContent = !state.details.open ? '点击以展开'
            : failed ? '收起后重试'
                : busy ? `展开中 ${state.group.length - pending}/${state.group.length}`
                    : '点击以折叠';
        hint.title = failed ? '部分楼层未能恢复；可收起后重试，或使用 /hfc-refresh。' : '';
    }
}

function groupHasEditor(group) {
    return group.some(node => node.querySelector('.edit_textarea, .reasoning_edit_textarea'));
}

function getSessionId(context) {
    return JSON.stringify([context.characterId, context.groupId, context.chatId]);
}

function sessionIsCurrent() {
    const context = SillyTavern.getContext();
    return session && session.element === getChatElement()
        && session.metadata === context.chatMetadata
        && session.messages === context.chat
        && session.id === getSessionId(context);
}

function resetSession(chat, context) {
    sessionNumber++;
    if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
    restoreFrame = null;
    restoreQueue.clear();
    restoredSinceNotify = false;
    virtualMessages.clear();
    failedRestores.clear();
    openKeys = new Set();
    for (const state of cards.values()) removeCard(state);
    cards.clear();
    session = { element: chat, metadata: context.chatMetadata, messages: context.chat, id: getSessionId(context) };
}

function removeCard(state) {
    state.details.remove();
    const host = state.group[0];
    if (!host?.querySelector(`.${DETAILS_CLASS}`)) host?.classList.remove(CARD_HOST_CLASS);
    state.group = [];
}

function mountManagedMessage({ element }) {
    mountedMessages.add(element);
    // Observe only this mount's attributes/content. The host owns the chat
    // projection; scrolling must not be treated as a message business event.
    const localObserver = new MutationObserver(records => {
        if (records.some(record => {
            if (record.type === 'attributes') return record.target === element;
            if (record.target.closest?.(`.${DETAILS_CLASS}`)) return false;
            return [...record.addedNodes, ...record.removedNodes].some(node => !isOurDetails(node));
        })) scheduleApply('managed-message-changed');
    });
    localObserver.observe(element, observerOptions);
    scheduleApply('managed-mount');
    return () => {
        localObserver.disconnect();
        mountedMessages.delete(element);
        element.classList.remove(GROUPED_CLASS, COLLAPSED_CLASS, CARD_HOST_CLASS);
        for (const [cardId, state] of cards) {
            if (!state.group.includes(element)) continue;
            removeCard(state);
            cards.delete(cardId);
        }
        scheduleApply('managed-unmount');
    };
}

const observerOptions = {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['is_system', 'mesid'],
};

function mutateDom(callback) {
    // Preserve external mutations already queued before temporarily pausing
    // observation. Our own empty/replace operations must not cause a loop.
    const pending = observer?.takeRecords() || [];
    if (pending.length) handleMutations(pending);
    observer?.disconnect();
    try {
        return callback();
    } finally {
        if (observer && observedChat) observer.observe(observedChat, observerOptions);
    }
}

function canRebuildMessages(context) {
    // TauriTavern validates content identity even in its static mode.
    return !preserveMessageDom && (typeof Tavern.updateMessageElement === 'function'
        || typeof context.addOneMessage === 'function');
}

function makeVirtual(node, message) {
    // Keep ONE empty .mes per loaded message. SillyTavern 1.14–1.19 uses their
    // contiguous order for reindexing, swipes, deletion, and Show more messages.
    // Keep neither a detached DOM cache nor copies of message content.
    if (node.firstChild) {
        if (globalThis.jQuery) globalThis.jQuery(node).empty();
        else node.replaceChildren();
    }
    node.classList.add(VIRTUAL_CLASS);
    virtualMessages.set(node, message);
}

function fixLastMessageClass(chat) {
    const messages = chat.querySelectorAll(':scope > .mes');
    for (const node of messages) node.classList.remove('last_mes');
    messages[messages.length - 1]?.classList.add('last_mes');
}

function restoreMessage(node, message, id) {
    const chat = session.element;
    const selected = node.classList.contains('selected');
    let rendered;
    if (typeof Tavern.updateMessageElement === 'function') {
        const result = Tavern.updateMessageElement(message, { messageId: id });
        rendered = result instanceof HTMLElement ? result : result?.[0];
        if (!(rendered instanceof HTMLElement) || !rendered.classList.contains('mes')) {
            throw new Error('The native renderer did not return a message element.');
        }
        node.before(rendered);
        if (globalThis.jQuery) globalThis.jQuery(node).remove();
        else node.remove();
    } else {
        // 1.14/1.15 addOneMessage returns nothing and looks up the inserted
        // message by mesid. Remove the placeholder first so that lookup is
        // unambiguous, then move the new message back to its exact position.
        const marker = document.createComment('hfc-restore');
        node.replaceWith(marker);
        try {
            SillyTavern.getContext().addOneMessage(message, { forceId: id, scroll: false, showSwipes: false });
            rendered = chat.querySelector(`:scope > .mes[mesid="${id}"]`);
            if (!(rendered instanceof HTMLElement)) throw new Error('The native renderer did not insert a message element.');
            marker.replaceWith(rendered);
        } catch (error) {
            chat.querySelector(`:scope > .mes[mesid="${id}"]`)?.remove();
            marker.replaceWith(node);
            throw error;
        }
    }
    if (selected) rendered.classList.add('selected');
    virtualMessages.delete(node);
    failedRestores.delete(node);
    restoredSinceNotify = true;
    return rendered;
}

function queueRestore(node, message) {
    if (!failedRestores.has(node)) restoreQueue.set(node, { message, sessionNumber });
}

function pumpRestores() {
    if (restoreFrame !== null || !restoreQueue.size) return;
    restoreFrame = requestAnimationFrame(() => {
        restoreFrame = null;
        if (!sessionIsCurrent()) {
            scheduleApply('restore-chat-changed');
            return;
        }
        if (document.body.dataset.generating === 'true') return;
        const started = performance.now();
        let completed = 0;
        mutateDom(() => {
            for (const [node, job] of restoreQueue) {
                restoreQueue.delete(node);
                const id = getMessageId(node);
                if (job.sessionNumber !== sessionNumber || node.parentElement !== session.element
                    || session.messages[id] !== job.message || !virtualMessages.has(node)) continue;
                try {
                    restoreMessage(node, job.message, id);
                } catch (error) {
                    failedRestores.add(node);
                    console.error(`[${MODULE_NAME}] Could not restore message #${id}:`, error);
                    showToast('error', `楼层 #${id} 展开失败，可收起后重试。`);
                }
                completed++;
                if (completed >= RENDER_BATCH_SIZE || performance.now() - started >= 8) break;
            }
            fixLastMessageClass(session.element);
        });
        // Reconcile before the next batch: closing, deletion, reindexing, and
        // chat switches may have invalidated queued nodes since the last frame.
        scheduleApply('restore-batch');
    });
}

function findHiddenGroups(chat) {
    const groups = [];
    let current = [];
    for (const node of Array.from(chat.children)) {
        if (isOurDetails(node)) continue;
        const id = node instanceof HTMLElement ? getMessageId(node) : null;
        const message = id === null ? null : session.messages[id];
        if (message && (!managedOwnership || mountedMessages.has(node)) && isCollapsibleHiddenMessage(node)) {
            if (current.length && id !== getMessageId(current[current.length - 1]) + 1) {
                groups.push(current);
                current = [];
            }
            current.push(node);
        } else if (current.length) {
            groups.push(current);
            current = [];
        }
    }
    if (current.length) groups.push(current);
    return groups;
}

function retryWhenReady() {
    if (retryTimer || retryCount >= 50) return;
    retryCount++;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        scheduleApply('context-ready-retry');
    }, 100);
}

function applyHiddenFloorCollapse() {
    setupMutationObserver();
    const chat = getChatElement();
    const context = globalThis.SillyTavern?.getContext?.();
    if (!chat || !Array.isArray(context?.chat) || !context.chatMetadata) {
        retryWhenReady();
        return;
    }
    if (!sessionIsCurrent()) resetSession(chat, context);
    if (document.body.dataset.generating === 'true') return;
    const nodes = Array.from(chat.children).filter(node => node.classList.contains('mes')
        && (!managedOwnership || mountedMessages.has(node)));
    if (nodes.some(node => !context.chat[getMessageId(node)])) {
        // Some ST versions fill chat data after inserting the initial DOM.
        retryWhenReady();
        return;
    }
    retryCount = 0;
    restoreQueue.clear();
    const live = new Set(nodes);
    for (const node of virtualMessages.keys()) {
        if (!live.has(node)) {
            virtualMessages.delete(node);
            failedRestores.delete(node);
        }
    }
    mutateDom(() => {
        for (const node of nodes) {
            node.classList.remove(GROUPED_CLASS, COLLAPSED_CLASS, CARD_HOST_CLASS);
            // Metadata or chat-array replacement can start a new session
            // while the existing loaded DOM is retained.
            if (!preserveMessageDom && node.classList.contains(VIRTUAL_CLASS)) {
                virtualMessages.set(node, context.chat[getMessageId(node)]);
            }
            if (virtualMessages.has(node)) {
                const id = getMessageId(node);
                const message = context.chat[id];
                virtualMessages.set(node, message);
                // Retain the newest message's full native structure even when
                // hidden: generation/continue/swipe code can target it directly.
                if (id === context.chat.length - 1) {
                    try { restoreMessage(node, message, id); }
                    catch (error) { failedRestores.add(node); console.error(`[${MODULE_NAME}]`, error); }
                } else if (!isCollapsibleHiddenMessage(node)) queueRestore(node, message);
            }
        }
        const groups = findHiddenGroups(chat);
        const usedKeys = new Set();
        const canVirtualize = canRebuildMessages(context);
        // A virtualized view can contain disjoint parts of the same hidden run
        // (viewport plus pinned tail). They need distinct cards but share notes
        // and open state. Editing either part keeps the entire run open.
        for (const group of groups) {
            if (groupHasEditor(group)) openKeys.add(getGroupKey(group));
        }
        for (const group of groups) {
            const key = getGroupKey(group);
            if (!key) continue;
            const cardId = managedOwnership ? `${key}/mounted:${getMessageId(group[0])}` : key;
            usedKeys.add(cardId);
            let state = cards.get(cardId);
            if (!state) {
                state = createDetailsForGroup(group, key, cardId);
                cards.set(cardId, state);
            }
            const isOpen = openKeys.has(key);
            for (const node of group) {
                const id = getMessageId(node);
                node.classList.add(GROUPED_CLASS);
                node.classList.toggle(COLLAPSED_CLASS, !isOpen);
                if (isOpen) {
                    if (virtualMessages.has(node)) queueRestore(node, context.chat[id]);
                } else if (canVirtualize && id !== context.chat.length - 1) {
                    makeVirtual(node, context.chat[id]);
                }
            }
            updateCard(state, group);
            if (preserveMessageDom) {
                // Bounded ChatSurface forbids additional #chat children. Keep
                // our UI inside the first message, outside its managed content.
                // A direct child can span the avatar and text columns when
                // expanded, without moving any host-owned message children.
                const container = group[0];
                if (state.details.parentElement !== container) container.prepend(state.details);
                group[0].classList.add(CARD_HOST_CLASS);
            } else if (state.details.nextElementSibling !== group[0]) group[0].before(state.details);
        }
        for (const [cardId, state] of cards) {
            if (!usedKeys.has(cardId)) {
                removeCard(state);
                cards.delete(cardId);
                if (!managedOwnership) openKeys.delete(state.key);
            }
        }
        if (!preserveMessageDom) fixLastMessageClass(chat);
    });
    pumpRestores();
    if (!restoreQueue.size && restoredSinceNotify) {
        restoredSinceNotify = false;
        // The same notification ST sends after loading existing history lets
        // other extensions reapply their DOM enhancements to restored content.
        if (event_types.MORE_MESSAGES_LOADED) {
            Promise.resolve(eventSource.emit(event_types.MORE_MESSAGES_LOADED))
                .catch(error => console.error(`[${MODULE_NAME}] History render listener failed:`, error));
        }
    }
}

function scheduleApply(reason = 'unknown') {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        try { applyHiddenFloorCollapse(); }
        catch (error) {
            console.error(`[${MODULE_NAME}] Failed to apply folds after ${reason}:`, error);
        }
    });
}

function handleMutations(mutations) {
    const relevant = mutations.some(mutation => {
        if (mutation.type === 'attributes') return mutation.target.classList?.contains('mes');
        if (mutation.target === observedChat) {
            return [...mutation.addedNodes, ...mutation.removedNodes]
                .some(node => node instanceof Element && !isOurDetails(node));
        }
        // If another extension writes content into an empty placeholder, empty
        // it again while closed, or rebuild it from current data while open.
        return virtualMessages.has(mutation.target);
    });
    if (relevant) scheduleApply('chat-dom-changed');
}

function setupMutationObserver() {
    if (managedOwnership) return;
    const chat = getChatElement();
    if (observedChat === chat && observer) return;
    observer?.disconnect();
    parentObserver?.disconnect();
    observedChat = chat;
    if (!chat) {
        if (!discoveryObserver) {
            discoveryObserver = new MutationObserver(() => {
                if (getChatElement()) scheduleApply('chat-created');
            });
            discoveryObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        return;
    }
    discoveryObserver?.disconnect();
    discoveryObserver = null;
    observer = new MutationObserver(handleMutations);
    observer.observe(chat, observerOptions);
    parentObserver = new MutationObserver(() => {
        if (getChatElement() !== observedChat) scheduleApply('chat-replaced');
    });
    if (chat.parentElement) parentObserver.observe(chat.parentElement, { childList: true });
}

function openAllFolds() {
    // Scope stays limited to ST's loaded window, even if earlier hidden
    // messages exist in chat data. Never call showMoreMessages implicitly.
    applyHiddenFloorCollapse();
    for (const state of cards.values()) openKeys.add(state.key);
    failedRestores.clear();
    scheduleApply('open-all');
}

function closeAllFolds() {
    applyHiddenFloorCollapse();
    const editingKeys = new Set([...cards.values()].filter(state => groupHasEditor(state.group)).map(state => state.key));
    for (const state of cards.values()) {
        if (!editingKeys.has(state.key)) openKeys.delete(state.key);
    }
    restoreQueue.clear();
    scheduleApply('close-all');
}

function registerSlashCommands() {
    for (const [name, alias, callback, helpString] of [
        ['hfc-refresh', 'hidden-fold-refresh', () => { failedRestores.clear(); scheduleApply('slash-refresh'); }, 'Rebuild hidden-message fold groups in the loaded chat window.'],
        ['hfc-open', 'hidden-fold-open', openAllFolds, 'Open loaded hidden-message fold groups.'],
        ['hfc-close', 'hidden-fold-close', closeAllFolds, 'Close loaded hidden-message fold groups.'],
    ]) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name, aliases: [alias], callback: () => { callback(); return 'true'; }, helpString,
        }));
    }
}

export function init() {
    if (initialized) return;
    const api = globalThis.__TAURITAVERN__?.api?.chatSurface;
    preserveMessageDom = Boolean(globalThis.__TAURITAVERN__);
    managedOwnership = api?.isManagedOwnershipRequired?.() === true;
    if (managedOwnership) {
        api.registerParticipant({
            id: 'hidden-floor-collapse/folds',
            protocolVersion: 1,
            didMount: mountManagedMessage,
            didCommitContent() { scheduleApply('managed-content'); },
        });
    }
    initialized = true;
    setupMutationObserver();
    registerSlashCommands();
    const refreshEvents = new Set([
        event_types.APP_READY, event_types.APP_INITIALIZED,
        event_types.CHAT_CHANGED, event_types.CHAT_LOADED,
        event_types.MORE_MESSAGES_LOADED, event_types.MESSAGE_DELETED,
        event_types.MESSAGE_EDITED, event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SENT, event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_SWIPED, event_types.MESSAGE_SWIPE_DELETED,
        event_types.USER_MESSAGE_RENDERED, event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED,
        event_types.SETTINGS_UPDATED,
    ].filter(Boolean));
    for (const eventName of refreshEvents) eventSource.on(eventName, () => scheduleApply(eventName));
    scheduleApply('init');
    console.info('[Hidden Floor Collapse] loaded');
}

// TauriTavern's activation hook runs with the Host API ready. The additional
// chatSurface hook brings this extension forward before the first projection.
export function registerChatSurface() {
    init();
}

if (!globalThis.__TAURITAVERN__) init();
