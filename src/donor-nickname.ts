// Deterministic publication policy shared by browser and server. Existing public
// profiles use structural normalization only; moderation never rewrites history.
export type DonorNicknameErrorCode = "NICKNAME_INVALID" | "NICKNAME_PROFANITY" | "NICKNAME_CONTACT" | "NICKNAME_RESERVED";
export type DonorNicknameValidation = { ok: true; nickname: string } | { ok: false; code: DonorNicknameErrorCode; error: string };
const errors: Record<DonorNicknameErrorCode, string> = {
  NICKNAME_INVALID: "Use 2 to 24 letters, numbers, spaces, dots, dashes or underscores, including a letter or number.",
  NICKNAME_PROFANITY: "Choose a respectful nickname without profanity, slurs or sexual content.",
  NICKNAME_CONTACT: "Use a nickname without links, contact details or advertising.",
  NICKNAME_RESERVED: "Choose a personal nickname. Official ChogCare, pool, admin and support names are reserved.",
};
const reject = (code: DonorNicknameErrorCode): DonorNicknameValidation => ({ ok: false, code, error: errors[code] });

export function normalizeDonorNickname(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 96) return null;
  const clean = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  const length = [...clean].length;
  return length >= 2 && length <= 24 && /^[-_.\p{L}\p{N} ]+$/u.test(clean) ? clean : null;
}

const visual: Record<string, string> = {
  а: "a", б: "b", в: "b", г: "r", д: "d", е: "e", ж: "zh", з: "z", и: "u", к: "k", л: "l", м: "m", н: "h", о: "o", п: "n", р: "p", с: "c", т: "t", у: "y", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", α: "a", β: "b", ε: "e", ι: "i", κ: "k", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c",
};
const phonetic: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
const leet: Record<string, string> = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 6: "b", 7: "t", 8: "b", 9: "g" };
const russianVisual = { ...visual, 3: "z", 4: "ch", 6: "b", 9: "ya" };
const alphabets = [visual, phonetic, russianVisual];
function folded(value: string, letters: Record<string, string>): string {
  return [...value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()]
    .map(letter => letters[letter] ?? visual[letter] ?? leet[letter] ?? letter).join("");
}
const compact = (value: string) => value.replace(/[-_.\s]/g, "");
// Short/ambiguous words match whole nickname parts, not innocent substrings:
// Scunthorpe, assistant, Peter, Dickson and Shiitake remain valid.
const blockedWords = [
  "fuck", "fucker", "fuckers", "fucking", "fucked", "fuckoff", "fuckyou", "shit", "shitty", "shitting", "bullshit", "bitch", "bitches", "cunt", "cunts", "bastard", "faggot", "faggots", "nigger", "niggers", "nigga", "niggas", "slut", "whore", "rapist", "pedophile", "paedophile", "porn", "porno", "sex",
  "бля", "блядь", "блять", "блядина", "блядский", "хуй", "хуя", "хуи", "хуем", "хуевый", "хуесос", "нахуй", "похуй", "пизда", "пиздец", "пиздюк", "пиздобол", "пиздатый", "ебать", "ебаный", "ебанный", "ебанутый", "еблан", "ебало", "ебучий", "заебал", "заебись", "наебал", "выебать", "долбоеб", "сука", "суки", "мудак", "мразь", "пидор", "пидорас", "педик", "гандон", "хер",
  "хуйня", "хуйни", "хуйло", "хуила", "хуило", "уебок", "ебнул", "ебнулся", "пиздеж", "пиздеть",
  "blya", "blyad", "blyat", "huy", "hui", "khui", "khuy", "nahui", "nahuy", "pohui", "pohuy", "pizda", "pizdec", "pizdets", "ebat", "yebat", "eblan", "dolboeb", "suka", "cyka", "pidor", "pidoras",
];
const wordSets = alphabets.map(letters => new Set(blockedWords.map(word => folded(word, letters))));
const strongWords = ["fuck", "motherfucker", "asshole", "cocksucker", "dickhead", "childporn", "childsex", "rapekids", "rapebabies", "heilhitler", "siegheil", "whitepower", "killalljews", "killallblacks", "долбоеб", "хуесос", "пиздобол"];
const strongSets = alphabets.map(letters => strongWords.map(word => folded(word, letters)));

function forbiddenContent(value: string): boolean {
  const joined = compact(value);
  const parts = value.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[-_.\s]+/);
  const letterRuns: string[] = []; let run = "";
  for (const part of parts.map(part => part.replace(/^\d+|\d+$/gu, ""))) {
    if ([...part].length === 1) run += part;
    else { if (run) letterRuns.push(run); run = ""; }
  }
  if (run) letterRuns.push(run);
  // Test both parts and the joined spelling to catch f.u.c.k and mixed scripts.
  const candidates = [...parts, ...letterRuns, joined].flatMap(part => [part, part.replace(/^\d+|\d+$/gu, "")]);
  return alphabets.some((letters, index) => candidates.some(part => {
    const key = folded(part, letters);
    // Keep original spelling and two bounded repetition variants. Do not fold
    // the dictionary itself: Niger must not become a match for a racial slur.
    return [key, key.replace(/(.)\1+/gu, "$1"), key.replace(/(.)\1{2,}/gu, "$1$1")]
      .some(candidate => wordSets[index].has(candidate) || strongSets[index].some(word => candidate.includes(word)));
  }));
}

function reservedName(value: string): boolean {
  const parts = value.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[-_.\s]+/);
  return alphabets.some(letters => {
    const joined = folded(compact(value), letters), withoutSuffix = folded(compact(value).replace(/^\d+|\d+$/g, ""), letters);
    if (joined.includes("chogcare") || /nft(?:community)?(?:pool|pul)/.test(joined)) return true;
    return [withoutSuffix, ...parts.map(part => folded(part.replace(/\d+$/, ""), letters))]
      .some(part => /^(?:super|head|chief|official|the)?admin(?:istrator|istration|team|official|staff)?$/.test(part) || /^(?:technical|tech|customer|official)?support(?:team|staff|official|desk)?$/.test(part) || /^(?:moderator|podderzhka)$/.test(part));
  });
}

function contactOrAdvertising(value: string): boolean {
  const lower = value.toLowerCase();
  if (/https?:|www\s*\.|@|[\/\\]/i.test(lower) || /(?:\.|\bdot\b|точка)\s*(?:com|net|org|ru|io|xyz|gg|me|ai|app|site|online|top|club|link|info|co|dev|biz|рф)(?=$|[^\p{L}\p{N}])/iu.test(lower)) return true;
  if (/^[\p{N}\s._+-]+$/u.test(value) && [...value.replace(/[^\p{N}]/gu, "")].length >= 9) return true;
  return alphabets.some(letters => {
    const key = folded(compact(value), letters);
    return /^(?:telegram|whatsapp|onlyfans|tme)(?:[a-z\d]+)$/u.test(key) || /(?:buynow|buycrypto|buyusdt|buyfollowers|freeairdrop|claimairdrop|freecrypto|freeusdt|casinobonus|promocode|skidk[ai]|promokod)/u.test(key);
  });
}

export function validateNewDonorNickname(value: unknown): DonorNicknameValidation {
  if (typeof value !== "string" || value.length > 96) return reject("NICKNAME_INVALID");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (contactOrAdvertising(normalized)) return reject("NICKNAME_CONTACT");
  const nickname = normalizeDonorNickname(normalized);
  if (!nickname || !/[\p{L}\p{N}]/u.test(nickname)) return reject("NICKNAME_INVALID");
  if (reservedName(nickname)) return reject("NICKNAME_RESERVED");
  if (forbiddenContent(nickname)) return reject("NICKNAME_PROFANITY");
  return { ok: true, nickname };
}
