/**
 * Antigravity IDE-only controls. These operations never fall back to the
 * 2.0 app and never use an out-of-date hard-coded model catalogue.
 */
import * as CDP from './cdp-client.mjs';

export const normalizeModelName = value =>
    String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const isPlausibleModelName = value => {
    const n = String(value ?? '').trim().replace(/\s+/g, ' ');
    return n.length >= 7 && n.length <= 90 &&
        /^(?:gemini|claude|gpt(?:-|[\s\d])|grok|deepseek|qwen|llama|gemma|o[134](?:[-\s]|$))/i.test(n);
};

export function uniqueModels(values) {
    const seen = new Set(), output = [];
    for (const raw of values ?? []) {
        const value = String(raw ?? '').trim().replace(/\s+/g, ' ');
        const key = normalizeModelName(value);
        if (!isPlausibleModelName(value) || seen.has(key)) continue;
        seen.add(key);
        output.push(value);
    }
    return output;
}

/**
 * The user may launch the IDE on port 9333 manually. DevToolsActivePort is not
 * guaranteed to exist for a fixed port, so do not depend on that discovery
 * file. Validate the actual VS Code workbench URL before touching its UI.
 */
export function isIdeWorkbenchTarget(target) {
    if (target?.type !== 'page') return false;
    const url = String(target.url || '');
    return /(?:^|\/)workbench\.html(?:[?#]|$)/i.test(url)
        || /^vscode-(?:file|web):\/\//i.test(url);
}

export async function findOriginalIdeWorkbench() {
    const discovered = await CDP.getSources();
    const ports = [...new Set([
        ...(discovered.sources || []).filter(x => x.id === 'ide').map(x => x.port),
        9333, 9334, 9222,
    ])];
    const wantedName = String(CDP.getPreferredWorkspace() || '').toLowerCase();
    for (const port of ports) {
        try {
            const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
                signal: AbortSignal.timeout(1400),
            });
            if (!response.ok) continue;
            const targets = (await response.json()).filter(isIdeWorkbenchTarget);
            if (!targets.length) continue;
            return targets.find(t => wantedName &&
                String(t.title || '').toLowerCase().startsWith(wantedName)) || targets[0];
        } catch { /* port unreachable, not an IDE, or invalid JSON */ }
    }
    return null;
}

const CONTROL_SCRIPT = String.raw`(async () => {
    const kind = "__ACTION__";
    const requested = __MODEL__;
    const prefix = "Select model, current:";
    const norm = s => String(s || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const plausible = s => /^(?:gemini|claude|gpt(?:-|[\s\d])|grok|deepseek|qwen|llama|gemma|o[134](?:[-\s]|$))/i.test(s)
        && s.length >= 7 && s.length <= 90;
    const visible = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
    const getTrigger = () => [...document.querySelectorAll("[aria-label]")].find(e =>
        (e.getAttribute("aria-label") || "").startsWith(prefix));
    if (kind === "new") {
        const selectors = [
            '[aria-label="New Conversation"]', '[aria-label="New conversation"]',
            '[aria-label="New Chat"]', '[aria-label="New chat"]',
            '[title="New Conversation"]', '[title="New Chat"]',
            '[data-testid="new-conversation"]', '[data-testid="new-chat"]'
        ];
        let btn = null;
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (visible(el)) { btn = el.closest("button,[role=button]") || el; break; }
        }
        if (!btn) btn = [...document.querySelectorAll("button,[role=button]")].find(e =>
            visible(e) && /^new (conversation|chat)$/i.test(
                (e.getAttribute("aria-label") || e.getAttribute("title") || e.innerText || "").trim()));
        if (!btn) return { found: !!getTrigger(), success: false,
            error: "New Chat control not detected in the IDE" };
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true")
            return { found: true, success: false, error: "The IDE New Chat control is disabled" };
        const before = location.href;
        btn.click();
        await new Promise(r => setTimeout(r, 450));
        return { found: true, success: true, verified: location.href !== before };
    }
    const selector = getTrigger();
    if (!selector) return { found: false };
    const current = (selector.getAttribute("aria-label") || "").slice(prefix.length).trim();
    const button = selector.closest("button,[role=button]") || selector;
    button.click();
    await new Promise(r => setTimeout(r, 280));
    const nodes = [...document.querySelectorAll(
        '[role="option"],[role="menuitem"],[role="menuitemradio"],' +
        '[data-testid*="model"],[class*="cursor-pointer"]'
    )];
    const seen = new Set(), options = [];
    for (const el of nodes) {
        if (!visible(el)) continue;
        const raw = (el.innerText || el.textContent || "").split("\n")
            .map(x => x.trim().replace(/\s+/g, " ")).find(plausible);
        if (!raw || seen.has(norm(raw))) continue;
        seen.add(norm(raw));
        options.push({ value: raw, element: el });
    }
    if (kind === "list") {
        button.click();
        return { found: true, success: options.length > 0, currentModel: current,
            models: options.map(x => x.value),
            error: options.length ? undefined : "No model options detected in the IDE menu" };
    }
    if (kind !== "select") {
        button.click();
        return { found: true, success: false, error: "Unknown model action" };
    }
    const matches = options.filter(x => norm(x.value) === norm(requested));
    if (matches.length !== 1) {
        button.click();
        return { found: true, success: false, error: "Requested model is not uniquely available in the IDE menu" };
    }
    const choice = matches[0].element;
    choice.scrollIntoView?.({ block: "nearest" });
    choice.click();
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 120));
        const updated = getTrigger();
        const name = (updated?.getAttribute("aria-label") || "").slice(prefix.length).trim();
        if (norm(name) === norm(requested))
            return { found: true, success: true, selected: name, verified: true };
    }
    return { found: true, success: false,
        error: "Model selection was clicked, but the IDE did not confirm a change" };
})()`;

export function buildControlScript(kind, model = '') {
    if (!['list', 'select', 'new'].includes(kind)) throw new TypeError('Unknown IDE operation');
    return CONTROL_SCRIPT.replace('__ACTION__', kind).replace('__MODEL__', JSON.stringify(model));
}

async function evaluateInSelectedIde(kind, model = '') {
    if (CDP.getCdpPreference() !== 'ide') {
        return { success: false, error: 'Choose IDE, not 2.0, before using IDE chat controls' };
    }
    let client;
    const contexts = new Set();
    const onMessage = packet => {
        try {
            const msg = JSON.parse(packet.toString());
            if (msg.method === 'Runtime.executionContextCreated')
                contexts.add(msg.params.context.id);
        } catch { /* ignore unrelated CDP notifications */ }
    };
    try {
        const target = await findOriginalIdeWorkbench();
        if (!target?.webSocketDebuggerUrl)
            return { success: false, error: 'No original IDE workbench detected. Open the IDE with CDP enabled.' };
        client = await CDP.connectToTarget(target);
        client.ws.on('message', onMessage);
        await client.send('Runtime.enable', {}, 6000);
        await new Promise(r => setTimeout(r, 240));
        const expression = buildControlScript(kind, model);
        for (const contextId of contexts) {
            try {
                const result = await client.send('Runtime.evaluate', {
                    expression, returnByValue: true, awaitPromise: true, contextId,
                }, 7000);
                const value = result?.result?.value;
                if (value?.found) return value;
            } catch { /* try another frame or context */ }
        }
        return { success: false, error: 'The IDE UI controls were not detected in the active workspace' };
    } catch (e) {
        return { success: false, error: 'IDE connection failed: ' + (e?.message || String(e)) };
    } finally {
        if (client) { client.ws.off('message', onMessage); client.close(); }
    }
}

export async function listIdeModels() {
    const res = await evaluateInSelectedIde('list');
    if (!res.success) return { success: false, models: [], currentModel: res.currentModel || null, error: res.error };
    const models = uniqueModels(res.models);
    if (!models.length) return { success: false, models: [], currentModel: res.currentModel,
        error: 'No live IDE model choices could be verified' };
    return { success: true, models, currentModel: res.currentModel };
}

export async function selectIdeModel(model) {
    const requested = String(model ?? '').trim();
    if (!isPlausibleModelName(requested))
        return { success: false, error: 'Invalid or missing model selection' };
    return evaluateInSelectedIde('select', requested);
}

export async function startNewIdeChat() {
    return evaluateInSelectedIde('new');
}
