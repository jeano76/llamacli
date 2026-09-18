/**
 * Some models occasionally fail to trigger llama-server's grammar-
 * constrained tool-calling mode and instead leak raw fragments of their own
 * fine-tuning chat template into the plain assistant `content` text —
 * confirmed directly against the real backend: the *raw* API response
 * itself already contains trailing tags like `</parameter>\n</function>\n
 * </tool_call>` or `</parameter>\n</invoke>`, so this isn't something
 * llamacli's own SSE parsing introduces. It's intermittent (sampling-
 * dependent — the same prompt sometimes reproduces it, sometimes doesn't),
 * so it can't be fixed by changing how we parse; the pragmatic mitigation
 * is to strip these known tool-calling template tags before they're shown
 * to the user or stored in conversation history (where they'd otherwise
 * reinforce the same leaky pattern in later turns).
 */

/** Tag names seen leaking across different tool-calling chat-template
 *  conventions (Hermes-style tool_call/function/parameter, Anthropic-style
 *  invoke/parameter). Deliberately narrow and tool-calling-specific, not
 *  generic words, to avoid stripping legitimate `<function>`-style content
 *  a user might actually paste (e.g. real XML/SOAP snippets). */
const LEAKED_TAG_NAMES = ["tool_call", "tool_use", "function", "parameter", "parameters", "invoke"];

const LEAK_PATTERN = new RegExp(`</?(?:${LEAKED_TAG_NAMES.join("|")})(?:\\s[^>]*)?>`, "gi");

/** Strips known tool-calling template leak tags from `text`. Safe to call
 *  on partial/incomplete text (e.g. mid-stream): a tag split across chunk
 *  boundaries just won't match yet and gets caught once the full tag has
 *  arrived, since callers re-run this over the cumulative text each time. */
export function stripToolCallTemplateLeak(text: string): string {
  return text.replace(LEAK_PATTERN, "");
}
