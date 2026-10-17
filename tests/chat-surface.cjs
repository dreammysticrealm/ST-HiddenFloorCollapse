// Integration test against unmodified TauriTavern v2.3.0 ChatSurface modules.
// See tests/README.md for setup. No Tauri app or account is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require(process.env.HFC_PLAYWRIGHT_MODULE || 'playwright');
const extensionRoot = path.resolve(process.env.HFC_EXTENSION_ROOT || path.join(__dirname, '..'));
const hostRoot = path.resolve(process.env.TAURITAVERN_SOURCE || '../TauriTavern');
assert(fs.existsSync(path.join(hostRoot, 'src/tauri/main/services/chat-surface/chat-surface-controller.js')),
    'Set TAURITAVERN_SOURCE to a TauriTavern v2.3.0 checkout');

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--SmartThemeBodyColor:#ddd;--SmartThemeQuoteColor:#a78bfa;--SmartThemeBlurTintColor:#282828;font:16px Arial}
*{box-sizing:border-box}body{background:#333;color:#ddd}#chat{display:flex;flex-direction:column;height:700px;overflow:auto}
.mes{display:flex;flex-shrink:0;padding:10px;width:100%}.mes_block{flex:1;min-width:0}.mes_text{padding:10px}
tt-chat-spacer{display:block;flex-shrink:0}</style><link rel="stylesheet" href="/extension/style.css"></head>
<body><main><div id="chat"></div></main><script type="module" src="/fixture.js"></script></body></html>`;
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let content, type = 'text/javascript';
    if (url.pathname === '/') { content = html; type = 'text/html'; }
    else if (url.pathname === '/fixture.js') content = fs.readFileSync(path.join(__dirname, 'chat-surface-fixture.js'));
    else if (url.pathname === '/script.js') content = 'export const eventSource=window.eventSource; export const event_types=window.event_types; export function updateMessageElement(){throw new Error("Plugin must not rebuild host messages")}';
    else if (url.pathname === '/scripts/slash-commands/SlashCommand.js') content = 'export const SlashCommand={fromProps:p=>p};';
    else if (url.pathname === '/scripts/slash-commands/SlashCommandParser.js') content = 'export const SlashCommandParser={addCommandObject:p=>window.commands[p.name]=p.callback};';
    else {
        const prefix = url.pathname.startsWith('/host/') ? '/host/' : '/extension/';
        const base = prefix === '/host/' ? hostRoot : extensionRoot;
        const file = path.resolve(base, '.' + path.sep + url.pathname.slice(prefix.length));
        if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
        content = fs.readFileSync(file);
        if (file.endsWith('.css')) type = 'text/css';
    }
    response.writeHead(200, { 'Content-Type': type }); response.end(content);
});

async function run(page, origin, mode) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/?mode=${mode}`);
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => settle());
    if (process.env.HFC_EXPECT_REGRESSION === '1') {
        const failure = await page.evaluate(() => {
            try { updateContent(2, 'Edit after collapsing'); return null; }
            catch (error) { return { error: error.message, fault: controller.getFault()?.message }; }
        });
        assert(failure?.fault, 'The old extension must reproduce a ChatSurface ownership fault');
        console.log(`REPRODUCED ${mode}: ${failure.error}`);
        return;
    }
    assert.deepEqual(await page.evaluate(() => ({
        roots: originalRoots.every((element, id) => controller.getMessageElement(id) === element),
        content: originalContents.every((content, id) => originalRoots[id].querySelector('.mes_text') === content),
        data: JSON.stringify(context.chat) === originalData,
        virtual: document.querySelectorAll('.st-hfc-virtual-message').length,
        directCards: document.querySelectorAll('#chat > details').length,
    })), { roots: true, content: true, data: true, virtual: 0, directCards: 0 });
    assert.equal(await page.locator('.st-hfc-title').textContent(), '已隐藏3层');
    assert(await page.locator('.st-hfc-details').isVisible());
    assert(await page.locator('.st-hfc-details').evaluate(card => card.getBoundingClientRect().height >= card.querySelector('summary').getBoundingClientRect().height));
    if (process.env.HFC_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.HFC_SCREENSHOT_DIR, `chat-surface-${mode}.png`) });
    assert(!await page.locator('[mesid="1"] .mes_text').isVisible());
    await page.locator('.st-hfc-summary').click();
    await page.evaluate(() => settle());
    assert(await page.locator('[mesid="1"] .mes_text').isVisible());
    await page.locator('[mesid="1"] .native-control').click();
    assert.equal(await page.evaluate(() => nativeClicks), 1);
    await page.locator('.st-hfc-note').click();
    await page.evaluate(() => settle());
    assert.equal(await page.locator('.st-hfc-note-text').textContent(), 'My note');
    await page.evaluate(() => { commands['hfc-close'](); });
    await page.evaluate(() => settle());

    // The original report's send / edit / cancel / save / delete paths all
    // pass through these real host transactions and their ownership checks.
    await page.evaluate(async () => {
        context.chat.push({ name: 'User', send_date: 'new-message', mes: 'Sent now', is_system: false });
        controller.reconcileMounted({ includeMessageIds: [6] }); syncLayout();
        await eventSource.emit(event_types.MESSAGE_SENT);
    });
    await page.evaluate(() => settle());
    assert.equal(await page.locator('[mesid="6"] .mes_text').textContent(), 'Sent now');
    await page.evaluate(() => { updateContent(2, 'Unsaved draft', true); });
    await page.evaluate(() => settle());
    // A managed mount observer catches transient editors without a fake event.
    if (mode === 'static') { await page.evaluate(() => { commands['hfc-open'](); }); await page.evaluate(() => settle()); }
    assert(await page.locator('[mesid="2"] textarea').isVisible());
    await page.evaluate(() => { commands['hfc-close'](); });
    await page.evaluate(() => settle());
    assert.equal(await page.locator('[mesid="2"] textarea').inputValue(), 'Unsaved draft');
    assert(await page.locator('[mesid="2"] textarea').isVisible());
    await page.evaluate(() => { updateContent(2, context.chat[2].mes); }); // cancel
    await page.evaluate(() => { updateContent(2, 'Saved edit', true); context.chat[2].mes = 'Saved edit'; updateContent(2, 'Saved edit'); });
    await page.evaluate(() => settle());
    assert.equal(await page.locator('[mesid="2"] .mes_text').textContent(), 'Saved edit');
    await page.evaluate(async () => {
        context.chat.splice(0, 1); controller.reconcileMounted(); syncLayout();
        await eventSource.emit(event_types.MESSAGE_DELETED);
    });
    await page.evaluate(() => settle());
    assert.equal(await page.locator('#chat > .mes').count(), 6);
    assert.equal(await page.locator('.st-hfc-range').textContent(), '#0–#2');
    assert.equal(await page.locator('.st-hfc-note-text').textContent(), 'My note');
    await page.evaluate(async () => {
        context.chat[1].is_system = false;
        controller.getMessageElement(1).setAttribute('is_system', 'false');
        await eventSource.emit(event_types.MESSAGE_UPDATED);
    });
    await page.evaluate(() => settle());
    assert.equal(await page.locator('.st-hfc-details').count(), 2);
    assert(await page.locator('[mesid="1"] .mes_text').isVisible());
    await page.evaluate(() => { commands['hfc-refresh'](); syncLayout(); });
    await page.evaluate(() => settle());
    assert.equal(await page.evaluate(() => emitted.filter(name => name === event_types.MORE_MESSAGES_LOADED).length), 0);

    if (mode === 'managed') {
        // Two projected pieces of one hidden run, separated by a host spacer.
        await page.evaluate(() => switchChat(10, [0,1,2,3,4,5,6,7,8,9], [1,2,9]));
        await page.evaluate(() => settle());
        assert.deepEqual(await page.locator('.st-hfc-range').allTextContents(), ['#1–#2', '#9']);
        await page.locator('.st-hfc-summary').first().click();
        await page.evaluate(() => settle());
        assert.equal(await page.locator('details[open]').count(), 2);
        await page.evaluate(() => { updateContent(9, 'Tail draft', true); });
        await page.evaluate(() => settle());
        await page.locator('.st-hfc-summary').first().click();
        await page.evaluate(() => settle());
        assert.equal(await page.locator('details[open]').count(), 2);
        await page.evaluate(() => { updateContent(9, context.chat[9].mes); });
        await page.locator('.st-hfc-note').first().click();
        await page.evaluate(() => settle());
        await page.evaluate(() => { window.oldNode = controller.getMessageElement(1); project([4,5,9]); });
        await page.evaluate(() => settle());
        assert.deepEqual(await page.locator('.st-hfc-range').allTextContents(), ['#4–#5', '#9']);
        assert.equal(await page.evaluate(() => oldNode.querySelectorAll('.st-hfc-details').length), 0);
        assert(!await page.evaluate(() => oldNode.className.includes('st-hfc')));
        await page.evaluate(() => { project([1,2,9]); });
        await page.evaluate(() => settle());
        assert(!await page.evaluate(() => oldNode === controller.getMessageElement(1)));
        assert.equal(await page.locator('details[open]').count(), 2);
        assert.deepEqual(await page.locator('.st-hfc-note-text').allTextContents(), ['My note', 'My note']);
        // Repeated cold mounts and host layout validation must stay healthy.
        for (let i = 0; i < 8; i++) {
            await page.evaluate(i => { project(i % 2 ? [1,2,9] : [4,5,9]); }, i);
            await page.evaluate(() => settle());
            await page.evaluate(() => syncLayout());
        }
    }
    await page.evaluate(() => switchChat(3, [0,1], [0,1,2]));
    await page.evaluate(() => settle());
    assert.equal(await page.locator('details[open]').count(), 0);
    assert.equal(await page.locator('.st-hfc-details').count(), 1);
    assert.equal(await page.evaluate(() => controller.getFault()?.message || null), null);
    await page.evaluate(() => syncLayout());
    assert.deepEqual(errors, []);
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const engine of (process.env.HFC_ENGINES || 'chromium,webkit').split(',')) {
            const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium' && process.env.HFC_CHROMIUM_EXECUTABLE
                ? { executablePath: process.env.HFC_CHROMIUM_EXECUTABLE } : {});
            try {
                for (const mode of ['static', 'managed']) {
                    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
                    try { await run(page, origin, mode); console.log(`PASS ${engine} ${mode}`); }
                    finally { await page.close(); }
                }
            } finally { await browser.close(); }
        }
    } finally { server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
