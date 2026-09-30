/**
 * Pure small talk ("hey", "thanks") needs no classification, no plan and no tools. Recognising it locally
 * saves a whole `claude` start-up (often many seconds with plugins, hooks and MCP servers installed).
 * The match is deliberately narrow: the whole message must be a greeting or thanks, so real tasks are never caught.
 */
const WORDS = [
  'hi', 'hey', 'hello', 'hallo', 'hej', 'yo', 'hiya', 'howdy', 'sup', 'moin', 'servus', 'ciao',
  'thanks', 'thank', 'thx', 'ty', 'cheers', 'danke', 'ok', 'okay', 'cool', 'nice', 'great', 'perfect', 'awesome', 'good', 'morning', 'evening', 'afternoon',
  'there', 'you', 'smart', 'claude', 'again', 'all', 'a', 'lot', 'so', 'much', 'very', 'bye', 'goodbye', 'later', 'how', 'are', 'is', 'it', 'going', 'whats', "what's", 'up', 'man', 'dude', 'mate', 'friend',
];
const SMALL = new Set(WORDS);
const OPENERS = new Set(['hi', 'hey', 'hello', 'hallo', 'hej', 'yo', 'hiya', 'howdy', 'sup', 'moin', 'servus', 'ciao', 'thanks', 'thank', 'thx', 'ty', 'cheers', 'danke', 'ok', 'okay', 'cool', 'nice', 'great', 'perfect', 'awesome', 'good', 'bye', 'goodbye', 'whats', "what's", 'how']);

export function isSmallTalk(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 40 || /[@/\\`{}()[\]<>=#$]|\d|\n/.test(t)) return false;
  const words = t.replace(/[!?.,:;'’]+$/g, '').split(/\s+/).map((w) => w.replace(/[!?.,:;]+$/g, ''));
  if (words.length === 0 || words.length > 6) return false;
  return OPENERS.has(words[0]!) && words.every((w) => SMALL.has(w));
}

export const CHAT_SYSTEM =
  'You are "smart", a friendly command-line coding assistant that routes work to the cheapest capable model. ' +
  'The user is making small talk. Reply in one or two short sentences in the same language, and offer to help with their code. ' +
  'Do not claim to have run or changed anything.';
