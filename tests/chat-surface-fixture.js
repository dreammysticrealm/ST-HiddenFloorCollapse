import { createChatDomAdapter } from '/host/src/tauri/main/adapters/chat-surface/chat-dom-adapter.js';
import { createChatScrollAdapter } from '/host/src/tauri/main/adapters/chat-surface/chat-scroll-adapter.js';
import { createChatSurfaceController } from '/host/src/tauri/main/services/chat-surface/chat-surface-controller.js';
import { createChatSurfaceParticipantRegistry } from '/host/src/tauri/main/services/chat-surface/participant-registry.js';
import { createBoundedProjectionLayout } from '/host/src/tauri/main/kernel/chat-surface/projection-layout.js';

const managed = new URLSearchParams(location.search).get('mode') === 'managed';
const root = document.querySelector('#chat');
const registry = createChatSurfaceParticipantRegistry();
const listeners = new Map();
window.emitted = [];
window.commands = {};
window.toasts = [];
window.event_types = Object.fromEntries(['APP_READY', 'CHAT_CHANGED', 'MORE_MESSAGES_LOADED',
    'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED',
    'GENERATION_ENDED'].map(name => [name, name]));
window.eventSource = {
    on(name, callback) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(callback);
    },
    async emit(name) {
        emitted.push(name);
        for (const callback of listeners.get(name) || []) await callback();
    },
};
window.makeMessages = (count, hidden) => Array.from({ length: count }, (_, id) => ({
    name: 'Tester', send_date: `date-${id}`, is_system: hidden.includes(id),
    mes: `Message ${id}`, extra: {},
}));
window.context = {
    chat: makeMessages(6, [1, 2, 3]), chatMetadata: {}, chatId: 'first', characterId: 0,
    saveMetadata() {}, Popup: { show: { input: async () => 'My note' } },
};
window.SillyTavern = { getContext: () => context };
window.toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(name => [name, text => toasts.push(text)]));
window.__TAURITAVERN__ = {}; // Host exists before API installation/activation.
window.nativeClicks = 0;
function materializeMessage({ message, messageId }) {
    const element = document.createElement('div');
    element.className = 'mes';
    element.setAttribute('mesid', String(messageId));
    element.setAttribute('is_system', String(message.is_system));
    element.innerHTML = '<div class="mesAvatarWrapper">Avatar</div><div class="mes_block">'
        + '<div class="ch_name"><span class="name_text">Tester</span></div>'
        + '<span class="mesIDDisplay"></span><div class="mes_text"></div>'
        + '<button class="native-control">Native control</button></div>';
    element.querySelector('.mes_text').textContent = message.mes;
    element.querySelector('button').addEventListener('click', () => nativeClicks++);
    return element;
}
window.adapter = createChatDomAdapter({ root, guardUnauthorizedMutations: managed,
    onUnauthorizedMutation: error => controller.fault(error),
    onExternalRemoval: elements => controller.reconcileExternalRemovals(elements),
});
window.controller = createChatSurfaceController({ getMessages: () => context.chat,
    materializeMessage, domAdapter: adapter, scrollAdapter: createChatScrollAdapter(root), participantRegistry: registry,
});
controller.configureRuntimeAdmission({ mode: managed ? 'managed' : 'eager' });

// Import before the API is installed, as an extension entry must have no host
// rendering side effects. Activation/early chatSurface hook is idempotent.
const extension = await import('/extension/index.js');
window.__TAURITAVERN__.api = { chatSurface: {
    protocolVersion: 1, isManagedOwnershipRequired: () => managed,
    registerParticipant: definition => registry.register(definition),
} };
extension.init();
extension.registerChatSurface?.();
extension.init();

window.syncLayout = () => {
    if (!managed) return;
    adapter.enableBoundedLayout();
    const indices = controller.getMountedMessageIds();
    const items = indices.map(index => ({ index, start: index * 100, end: (index + 1) * 100 }));
    let end = 1;
    while (end < indices.length && indices[end] === indices[end - 1] + 1) end++;
    adapter.commitBoundedLayout(createBoundedProjectionLayout({ count: context.chat.length,
        viewportItems: items.slice(0, end), projectedItems: items, maxViewportItems: 100,
    }));
};
window.project = indices => { controller.project({ indices }); syncLayout(); };
window.updateContent = (id, text, editing = false) => {
    const element = controller.getMessageElement(id);
    const live = element.querySelector('.mes_text');
    const content = document.createElement('div');
    content.className = 'mes_text';
    if (editing) {
        const input = document.createElement('textarea');
        input.className = 'edit_textarea'; input.value = text; content.append(input);
    } else content.textContent = text;
    controller.updateContent(element, { content, commit() { live.replaceChildren(...content.childNodes); return live; } }, { transient: editing });
};
window.switchChat = (count, hidden, indices) => {
    controller.resetEpoch({ includeAuxiliary: true });
    context.chat = makeMessages(count, hidden);
    context.chatMetadata = {};
    context.chatId += '-next';
    controller.reconcile({ indices }); syncLayout();
    return eventSource.emit(event_types.CHAT_CHANGED);
};
window.settle = async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); };
controller.reconcile({ indices: [0, 1, 2, 3, 4, 5] });
syncLayout();
window.originalRoots = adapter.directMessages();
window.originalContents = originalRoots.map(element => element.querySelector('.mes_text'));
window.originalData = JSON.stringify(context.chat);
window.ready = true;
