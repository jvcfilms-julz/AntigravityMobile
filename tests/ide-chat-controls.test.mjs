import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeModelName, isPlausibleModelName, uniqueModels,
    buildControlScript, listIdeModels, selectIdeModel, startNewIdeChat
} from '../src/ide-chat-controls.mjs';

test('live model names are normalized, not tied to an obsolete static catalogue', () => {
    assert.equal(normalizeModelName('  Gemini   3.8 Flash High  '), 'gemini 3.8 flash high');
    assert.equal(isPlausibleModelName('Gemini 3.8 Flash High'), true);
    assert.equal(isPlausibleModelName('Claude Opus 4.6 (Thinking)'), true);
    assert.equal(isPlausibleModelName('A random response containing Gemini'), false);
    assert.deepEqual(uniqueModels(['Gemini 3.8 Flash High', ' Gemini   3.8 Flash High ', 'Claude Opus 4.6 (Thinking)']),
        ['Gemini 3.8 Flash High', 'Claude Opus 4.6 (Thinking)']);
});

test('the generated UI scripts parse for list, select, and new chat actions', () => {
    for (const action of ['list', 'select', 'new']) {
        const script = buildControlScript(action, 'Gemini 3.8 Flash High');
        assert.doesNotThrow(() => new Function('return ' + script));
        assert.match(script, /Select model, current:/);
        assert.match(script, /New Conversation/);
    }
    assert.throws(() => buildControlScript('delete-all'), TypeError);
});

test('model selection is serialized safely into the remote script', () => {
    const unsafe = 'Claude "); alert("bad"); //';
    const script = buildControlScript('select', unsafe);
    assert.ok(script.includes(JSON.stringify(unsafe)));
    assert.doesNotThrow(() => new Function('return ' + script));
});

test('IDE-only operations reject auto/2.0 source without changing IDE state', async () => {
    for (const result of [
        await listIdeModels(),
        await selectIdeModel('Gemini 3.8 Flash High'),
        await startNewIdeChat(),
    ]) {
        assert.equal(result.success, false);
        assert.match(result.error, /Choose IDE/);
    }
});
