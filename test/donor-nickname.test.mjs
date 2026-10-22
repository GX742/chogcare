import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDonorNickname, validateNewDonorNickname } from '../src/donor-nickname.ts';
import { donorDraftKey, parsePublicProfile, readDonorDraft, saveDonorDraft } from '../src/donor-profile-model.ts';

const store = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const invoiceId = 'a'.repeat(64);
const profile = { amount: '300', initiativeId: 'solar-foundation', avatarTokenId: null, avatarName: null, avatarImage: null, publishedAt: 1791700000000 };
function blocked(names, code) {
  for (const nickname of names) {
    const result = validateNewDonorNickname(nickname);
    assert.equal(result.ok, false, `expected rejection for fixture ${nickname}`);
    assert.equal(result.code, code, `expected the fixed reason for fixture ${nickname}`);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length < 180);
  }
}

test('known donors and innocent substring, multilingual and normalized names remain eligible', () => {
  for (const nickname of [
    'GX', 'web3sergo', 'saenqomillionaire', 'Scunthorpe', 'assistant', 'Peter', 'Dickson', 'Shiitake', 'Sussex', 'Niger',
    'Supporter', 'Hancock', 'Cassian', 'John.Doe', 'Élodie Иван', '王小明', 'Сукачёв', 'Херсон', 'Петров', 'Иван Ёлкин', 'Donor 123', '0xCafe',
  ]) assert.deepEqual(validateNewDonorNickname(nickname), { ok: true, nickname });
  assert.deepEqual(validateNewDonorNickname('  ＧＸ   Donor  '), { ok: true, nickname: 'GX Donor' });
});

test('future publication rejects explicit RU and EN profanity, slurs and sexual abuse', () => {
  blocked(['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'faggot', 'nigger', 'сука', 'блядь', 'нахуй', 'пиздец', 'ебать', 'долбоёб', 'пидорас',
    'хуйня', 'хуйло', 'уёбок', 'пиздёж', 'childporn', 'child sex', 'rape kids', 'porn', 'porno', 'sex', 'heil hitler', 'kill all jews'], 'NICKNAME_PROFANITY');
});

test('common leet, mixed-script, separator, numeric padding and repeated-letter bypasses stay blocked', () => {
  blocked(['f.u.c.k', 'F U C K', 'John B I T C H', 'sh1t', 'b1tch', 'n1gg3r', 'fuсk', 'fυck', '𝖘𝖍𝖎𝖙', 'сyка', 'суkа', 'пuздa', 'пи3да', 'бл9ть',
    '123сука', 'сука123', '123sh1t99', 'fuuuck', 'bittch', 'niggger', 'd.o.l.b.o.e.b'], 'NICKNAME_PROFANITY');
});

test('official role and brand names are reserved even through common obfuscation', () => {
  blocked(['ChogCare', 'Ch0gCare', 'сhоgсаrе', 'ChogCare Official', 'NFT Pool', 'N.F.T. P00L', 'NFT Community Pool', 'NFT Пул',
    'Admin', 'Adm1n', 'admin42', 'a.d.m.i.n42', 'SuperAdmin', 'Админ', 'Support', 'Suрport', 'support123', 'Technical Support', 'Поддержка'], 'NICKNAME_RESERVED');
});

test('links, contact handles, phone-like strings and clear ads cannot become public nicknames', () => {
  blocked(['free-usdt.com', 'example.ru', 'donor dot com', 'сайт.рф', 'https://example.org', '@contactme', 'person@example.com', 't.me.alex',
    'telegram Alex', 'whatsapp12345', '12345678901', '١٢٣٤٥٦٧٨٩', 'Buy USDT', 'free airdrop', 'ПРОМОКОД', 'СКИДКА 50', 'скидки всем'], 'NICKNAME_CONTACT');
});

test('invalid or non-name input fails with a bounded fixed error and never echoes submitted text', () => {
  blocked(['a', 'x'.repeat(25), '___', 'GX\u202e', 'f\u200buck', 'GX😀'], 'NICKNAME_INVALID');
  for (const value of [null, undefined, 123, {}, 'x'.repeat(97)]) {
    const result = validateNewDonorNickname(value);
    assert.equal(result.ok, false); assert.equal(result.code, 'NICKNAME_INVALID');
    assert.equal(result.error, validateNewDonorNickname('a').error);
  }
});

test('published legacy profiles keep their structurally valid names without retroactive moderation', () => {
  for (const nickname of ['GX', 'web3sergo', 'saenqomillionaire', 'fuck', 'Admin', 'example.com']) {
    assert.equal(normalizeDonorNickname(nickname), nickname);
    assert.equal(parsePublicProfile({ ...profile, nickname })?.nickname, nickname);
  }
});

test('future or restored drafts must pass new moderation before saving or automatic publication', () => {
  const storage = store();
  saveDonorDraft(invoiceId, { nickname: 'GX', avatarTokenId: null }, [], storage);
  assert.deepEqual(readDonorDraft(invoiceId, [], storage), { nickname: 'GX', avatarTokenId: null });
  for (const nickname of ['fuck', 'Admin', 'free-usdt.com']) {
    assert.throws(() => saveDonorDraft(invoiceId, { nickname, avatarTokenId: null }, [], storage));
    assert.deepEqual(readDonorDraft(invoiceId, [], storage), { nickname: 'GX', avatarTokenId: null });
    storage.setItem(donorDraftKey(invoiceId), JSON.stringify({ nickname, avatarTokenId: null }));
    assert.equal(readDonorDraft(invoiceId, [], storage), null);
    storage.removeItem(donorDraftKey(invoiceId));
    saveDonorDraft(invoiceId, { nickname: 'GX', avatarTokenId: null }, [], storage);
  }
});

test('Continue, confirmation and Publish each use the shared new-publication policy', () => {
  const source = readFileSync(new URL('../src/DonorProfile.tsx', import.meta.url), 'utf8');
  for (const action of ['continueToAvatar', 'publish', 'confirm']) {
    assert.match(source, new RegExp(`const ${action}=[^\n]+validateNewDonorNickname\\(nickname\\)`));
  }
  assert.match(source, /nickname:validation\.nickname/);
});
