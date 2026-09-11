'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateStrictTranscriptEvidence, prepareStrictSpokenTranscript } = require('../services/media-gateway/src/strict-lid-batch');
const evaluate = (text, wordCount = text.split(/\s+/u).length) => evaluateStrictTranscriptEvidence({
    text, wordCount, minWords: 12, minUniqueWords: 8,
    whisperLanguage: 'en', transcriptLanguage: 'en', transcriptConfident: true,
});

test('V3-D-shaped regression: sound annotations cannot turn sparse speech into an accepted window', () => {
    // Synthetic equivalent; original model/user transcripts remain outside Git.
    const raw = 'Amy? Colin, I was-- I was joking. Colin? [WHISTLING] [DOG BARKING] Eric? [FOOTSTEPS] [SUSPENSEFUL MUSIC]';
    assert.equal(raw.split(/\s+/u).length, 15);
    assert.equal(new Set(raw.toLowerCase().match(/\p{L}+/gu)).size, 12);
    const speech = prepareStrictSpokenTranscript(raw);
    assert.equal(speech.wordCount, 9);
    assert.equal(speech.uniqueWordCount, 6);
    const evidence = evaluate(raw);
    assert.equal(evidence.enough, false);
    assert.equal(evidence.compatibleWordCount, 9);
    assert.equal(evidence.compatibleUniqueWordCount, 6);
    assert.equal(evaluate(raw, 999).enough, false);
});

test('sparse spoken reference stays distinct from ASR and below unchanged evidence floors', () => {
    const human = 'Amy? Colin, I was joking. Colin? Eric?';
    const speech = prepareStrictSpokenTranscript(human);
    assert.equal(speech.wordCount, 7);
    assert.equal(speech.uniqueWordCount, 6);
    assert.equal(evaluate(human).enough, false);
});

test('multilingual, nested and truncated annotations do not become spoken evidence', () => {
    for (const text of [
        '[WHISTLING] [DOG BARKING] [FOOTSTEPS] [SUSPENSEFUL MUSIC]',
        '[Musique douce] (le chien aboie) {bruits de pas}',
        '［音楽と拍手］【鳥の鳴き声】 [संगीत बज रहा है]',
        '[background (distant voices) and applause]',
        '[an unfinished cue with many different words that must not be counted',
        '<|startoftranscript|><|en|><|transcribe|><|notimestamps|>',
        '♪ a long musical refrain with many words that is not dialogue ♪',
    ]) {
        const speech = prepareStrictSpokenTranscript(text);
        assert.equal(speech.wordCount, 0, text);
        assert.equal(speech.uniqueWordCount, 0, text);
        assert.equal(evaluate(text).enough, false);
    }
});

test('annotation removal neither joins adjacent words nor alters genuine sound-related dialogue', () => {
    assert.equal(prepareStrictSpokenTranscript('hello[music]there').text, 'hello there');
    const spoken = 'The music is loud and I can hear the dog barking outside our house while we discuss the plans for tomorrow.';
    assert.equal(prepareStrictSpokenTranscript(spoken).text, spoken);
    assert.equal(evaluate(spoken).enough, true);
    const plain = evaluate(spoken);
    const annotated = evaluate(`[MUSIC] ${spoken} [DOOR CLOSES]`);
    assert.equal(plain.diversityFingerprint, annotated.diversityFingerprint);
    assert.deepEqual(plain.diversityShingles, annotated.diversityShingles);
});

test('combining marks, contractions and punctuation cannot inflate lexical diversity', () => {
    const marked = prepareStrictSpokenTranscript('किताब किताब किताब किताब');
    assert.equal(marked.wordCount, 4);
    assert.equal(marked.uniqueWordCount, 1);
    const contractions = prepareStrictSpokenTranscript("don't don’t don't ... -- 12 34 56");
    assert.equal(contractions.wordCount, 3);
    assert.equal(contractions.uniqueWordCount, 1);
    assert.equal(evaluate('one two three', Infinity).enough, false);
    assert.equal(evaluate('one two three', -1).enough, false);
});

test('ordinary quotation marks preserve dialogue but oversized ASR output cannot qualify', () => {
    const text = '「これは日本語の会話です」 “Do you know where the children are walking this afternoon with their friendly dog?”';
    assert.equal(prepareStrictSpokenTranscript(text).text, text);
    const long = 'The quick brown fox jumps over the lazy dog and then walks back home. '.repeat(300);
    assert.equal(prepareStrictSpokenTranscript(long).truncated, true);
    assert.equal(evaluate(long).enough, false);
});
