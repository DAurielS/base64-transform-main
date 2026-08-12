import {
    getRegexScripts,
    runRegexScript,
} from '/scripts/extensions/regex/engine.js';


const MODULE_NAME = 'Base64PromptTransform';

/**
 * When true, only Regex scripts currently allowed by SillyTavern are used.
 *
 * This means:
 * - Global Regex scripts are included.
 * - Character-scoped Regex scripts are included only when allowed.
 * - Preset Regex scripts are included only when allowed.
 *
 * Keeping this enabled is recommended because it follows SillyTavern's
 * normal Regex permission behavior.
 */
const ALLOWED_ONLY = true;

/**
 * Enable informational console logs.
 *
 * The extension intentionally does not print the full prompt to the console.
 */
const DEBUG = true;


/* ============================================================
 * UTF-8 Base64 encoding
 * ============================================================ */

/**
 * Encodes an arbitrary Unicode string as Base64.
 *
 * Calling btoa() directly on Unicode text may fail for characters outside
 * the Latin-1 range. TextEncoder converts the input to UTF-8 bytes first,
 * allowing Vietnamese, Japanese, Chinese, emoji, etc. to work correctly.
 *
 * @param {string} text
 * @returns {string}
 */
function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);

    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}


/* ============================================================
 * UTF-8 Base64 decoding (incoming message path)
 * ============================================================ */

/**
 * Minimum length a BARE (unmarked) Base64 run must have before it is treated
 * as a candidate for decoding.
 *
 * This only protects the bare-blob fallback path. Content inside explicit
 * [[b64]]...[[/b64]] markers always decodes regardless of length, because
 * the markers make intent unambiguous.
 *
 * At 8 characters, common 4-character English-word encodings such as
 * "YXNz" (ass) and "c2V4" (sex) are intentionally NOT decoded as bare blobs,
 * which would otherwise create frequent false positives. The model is
 * expected to wrap short or ambiguous tokens in markers.
 *
 * @type {number}
 */
const MIN_DECODE_LENGTH = 8;

/**
 * Matches bare runs of Base64 characters. Lookbehind/lookahead on non-Base64
 * boundaries let consecutive adjacent blobs each match without their
 * delimiters being consumed.
 *
 * Canonical Base64 charset A–Za–z0–9+/ plus up to two trailing `=`.
 *
 * @type {RegExp}
 */
const BARE_BASE64_RE =
    /(?<=^|[^A-Za-z0-9+/=])[A-Za-z0-9+/]{4,}={0,2}(?=$|[^A-Za-z0-9+/=])/g;


/**
 * Decodes a Base64 string back to a Unicode string using UTF-8.
 *
 * Symmetric counterpart to encodeBase64Utf8(). Fatal mode is intentional:
 * any byte sequence that is not valid UTF-8 throws, which the caller uses as
 * a validity filter to reject strings that happen to be valid Base64 but not
 * actually Base64-encoded text.
 *
 * @param {string} encoded
 * @returns {string}
 * @throws {Error} if the input is not valid Base64 or not valid UTF-8.
 */
function decodeBase64Utf8(encoded) {
    const binary = atob(encoded);

    const bytes = Uint8Array.from(
        binary,
        c => c.charCodeAt(0),
    );

    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}


/**
 * Attempts to decode a candidate string as Base64, returning null if it is
 * not a real Base64-encoded value.
 *
 * Three stacked filters make false positives extremely unlikely:
 *
 * 1. Length must be a positive multiple of 4 (canonical Base64 output).
 * 2. UTF-8 decoding must succeed (rejects arbitrary binary garbage).
 * 3. Re-encoding the result must reproduce the candidate exactly. This is
 *    the strongest filter: it guarantees the candidate is the canonical
 *    Base64 of some valid UTF-8 string. Casual English words, hashes, tokens,
 *    and IDs virtually always fail this check.
 *
 * @param {string} candidate
 * @returns {string | null}
 */
function tryDecodeBase64(candidate) {
    if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.length % 4 !== 0
    ) {
        return null;
    }

    let decoded;

    try {
        decoded = decodeBase64Utf8(candidate);
    } catch {
        return null;
    }

    if (encodeBase64Utf8(decoded) !== candidate) {
        return null;
    }

    return decoded;
}


/**
 * Decodes any `[[b64]]<base64>[[/b64]]` markers in the text.
 *
 * Content inside markers always decodes regardless of length, because the
 * markers make the model's intent unambiguous. This is the primary inbound
 * decode path and has zero false-positive risk.
 *
 * Invalid Base64 inside a marker is left untouched rather than throwing, so a
 * single malformed marker cannot drop the whole message.
 *
 * @param {string} text
 * @returns {string}
 */
function unwrapB64Markers(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    return text.replace(
        /\[\[b64\]\]([\s\S]*?)\[\[\/b64\]\]/gi,
        (_, content) => {
            const decoded = tryDecodeBase64(content.trim());

            return decoded ?? `[[b64]]${content}[[/b64]]`;
        },
    );
}


/**
 * Conservative fallback that decodes bare (unmarked) Base64 blobs.
 *
 * Used only after unwrapB64Markers, as a best-effort recovery for stray
 * blobs the model did not wrap in markers. Each candidate must pass the
 * MIN_DECODE_LENGTH threshold and the round-trip guard in tryDecodeBase64.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeBareBase64Blobs(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    return text.replace(
        BARE_BASE64_RE,
        candidate => {
            if (candidate.length < MIN_DECODE_LENGTH) {
                return candidate;
            }

            return tryDecodeBase64(candidate) ?? candidate;
        },
    );
}


/**
 * Decodes incoming Base64 content back to plaintext.
 *
 * Marker-wrapped content is decoded first (primary, exact path), then any
 * remaining bare blobs are decoded as a conservative fallback.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeIncoming(text) {
    return decodeBareBase64Blobs(unwrapB64Markers(text));
}


/* ============================================================
 * Base64 Regex rule discovery
 * ============================================================ */

/**
 * Determines whether a SillyTavern Regex script should be treated as a
 * Base64 transformation rule.
 *
 * A rule is considered a Base64 rule when its replacement contains both:
 *
 *     [[b64]]
 *     [[/b64]]
 *
 * Example:
 *
 *     Find Regex:
 *     /\b(?:sexuality|violence|weapons?)\b/gi
 *
 *     Replace With:
 *     [[b64]]{{match}}[[/b64]]
 *
 * @param {object} script
 * @returns {boolean}
 */
function isBase64RegexScript(script) {
    if (!script || script.disabled) {
        return false;
    }

    if (
        typeof script.findRegex !== 'string' ||
        script.findRegex.length === 0
    ) {
        return false;
    }

    if (typeof script.replaceString !== 'string') {
        return false;
    }

    return (
        /\[\[b64\]\]/i.test(script.replaceString) &&
        /\[\[\/b64\]\]/i.test(script.replaceString)
    );
}


/**
 * Retrieves all currently available SillyTavern Regex scripts and returns
 * only the rules configured to produce [[b64]] markers.
 *
 * This is evaluated for every prompt generation, so changes made in the
 * Regex UI are automatically picked up without duplicating the keyword
 * list inside this extension.
 *
 * @returns {Array<object>}
 */
function getBase64RegexScripts() {
    const scripts = getRegexScripts({
        allowedOnly: ALLOWED_ONLY,
    });

    return scripts.filter(isBase64RegexScript);
}


/* ============================================================
 * Marker protection
 * ============================================================ */

/**
 * Existing [[b64]] markers may already have been created by SillyTavern's
 * normal Regex pipeline.
 *
 * For example:
 *
 *     violence
 *
 * may already be:
 *
 *     [[b64]]violence[[/b64]]
 *
 * before this extension receives the final prompt.
 *
 * If the same Regex rule were applied again without protection, it could
 * produce nested markers such as:
 *
 *     [[b64]][[b64]]violence[[/b64]][[/b64]]
 *
 * To prevent this:
 *
 * 1. Existing markers are immediately Base64-encoded.
 * 2. Their encoded values are temporarily replaced by private placeholders.
 * 3. Additional Regex rules are applied.
 * 4. Newly created markers are protected in the same way.
 * 5. The placeholders are restored as their final Base64 strings.
 *
 * @param {string} text
 * @param {Array<{token: string, encoded: string}>} vault
 * @returns {string}
 */
function protectAndEncodeMarkers(text, vault) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    return text.replace(
        /\[\[b64\]\]([\s\S]*?)\[\[\/b64\]\]/gi,
        (_, content) => {
            const index = vault.length;

            /*
             * Private Use Area characters are added around the placeholder
             * to make accidental collisions with normal prompt text extremely
             * unlikely.
             */
            const token =
                `\uE000B64_PROTECTED_${index}_${Math.random()
                    .toString(36)
                    .slice(2)}\uE001`;

            vault.push({
                token,
                encoded: encodeBase64Utf8(content),
            });

            return token;
        },
    );
}


/**
 * Restores all protected placeholders to their final Base64 values.
 *
 * The encoded value is wrapped in [[b64]]...[[/b64]] markers in the final
 * outgoing prompt. This gives the model an explicit, unambiguous template to
 * copy when it needs to emit Base64 in its own replies: any Base64 the model
 * produces that follows this format can be decoded exactly on the inbound
 * path with zero false-positive risk, including very short words.
 *
 * @param {string} text
 * @param {Array<{token: string, encoded: string}>} vault
 * @returns {string}
 */
function restoreProtectedMarkers(text, vault) {
    let result = text;

    for (const entry of vault) {
        result = result.replaceAll(
            entry.token,
            `[[b64]]${entry.encoded}[[/b64]]`,
        );
    }

    return result;
}


/* ============================================================
 * Regex transformation
 * ============================================================ */

/**
 * Applies every Base64 Regex rule directly to a string.
 *
 * This intentionally calls runRegexScript() rather than getRegexedString().
 *
 * getRegexedString() respects normal Regex placement restrictions such as:
 *
 * - User Input
 * - AI Output
 * - World Info
 * - Reasoning
 *
 * Character Description, Personality, Scenario, and some other prompt
 * components are not normal Regex placements.
 *
 * By calling runRegexScript() directly on the final assembled prompt,
 * the same Regex rules can also affect those prompt components.
 *
 * Using runRegexScript() also preserves SillyTavern's native behavior for:
 *
 * - {{match}}
 * - $1, $2, etc.
 * - Named capture groups
 * - Regex macros
 * - Trim strings
 * - Replacement macros
 *
 * @param {string} text
 * @param {Array<object>} scripts
 * @returns {string}
 */
function transformText(text, scripts) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    const vault = [];

    let result = text;

    /*
     * First consume markers that may already have been produced by the normal
     * SillyTavern Regex pipeline.
     */
    result = protectAndEncodeMarkers(
        result,
        vault,
    );

    /*
     * Reapply every Base64 Regex rule against the final prompt text.
     *
     * Newly created markers are immediately consumed after each rule.
     * This prevents later rules from operating inside already transformed
     * Base64 targets.
     */
    for (const script of scripts) {
        try {
            result = runRegexScript(
                script,
                result,
            );

            result = protectAndEncodeMarkers(
                result,
                vault,
            );
        } catch (error) {
            console.error(
                `[${MODULE_NAME}] Failed to apply Regex rule:`,
                script?.scriptName || '(unnamed)',
                error,
            );
        }
    }

    /*
     * Replace all temporary placeholders with the final Base64 strings.
     */
    result = restoreProtectedMarkers(
        result,
        vault,
    );

    return result;
}


/* ============================================================
 * Message content handling
 * ============================================================ */

/**
 * Transforms a Chat Completion message content value.
 *
 * SillyTavern may use a normal string:
 *
 *     {
 *         role: "system",
 *         content: "Character description..."
 *     }
 *
 * or multimodal content:
 *
 *     {
 *         role: "user",
 *         content: [
 *             {
 *                 type: "text",
 *                 text: "Hello..."
 *             },
 *             {
 *                 type: "image_url",
 *                 ...
 *             }
 *         ]
 *     }
 *
 * Only textual content is modified.
 *
 * @param {unknown} content
 * @param {Array<object>} scripts
 * @returns {unknown}
 */
function transformContent(content, scripts) {
    if (typeof content === 'string') {
        return transformText(
            content,
            scripts,
        );
    }

    if (!Array.isArray(content)) {
        return content;
    }

    for (let index = 0; index < content.length; index++) {
        const part = content[index];

        /*
         * Some providers may represent content array entries directly
         * as strings.
         */
        if (typeof part === 'string') {
            content[index] = transformText(
                part,
                scripts,
            );

            continue;
        }

        if (!part || typeof part !== 'object') {
            continue;
        }

        /*
         * OpenAI-style multimodal text part.
         */
        if (typeof part.text === 'string') {
            part.text = transformText(
                part.text,
                scripts,
            );
        }
    }

    return content;
}


/**
 * Applies Base64 Regex transformations to every textual message in the
 * assembled Chat Completion prompt.
 *
 * @param {Array<object>} messages
 * @param {Array<object>} scripts
 * @returns {number} Number of messages whose content changed
 */
function transformMessages(messages, scripts) {
    if (!Array.isArray(messages)) {
        return 0;
    }

    let changedMessages = 0;

    for (const message of messages) {
        if (
            !message ||
            typeof message !== 'object' ||
            !Object.hasOwn(message, 'content')
        ) {
            continue;
        }

        /*
         * Keep a serialized snapshot only for change detection.
         *
         * This is not printed anywhere.
         */
        let before;

        try {
            before = JSON.stringify(message.content);
        } catch {
            before = null;
        }

        message.content = transformContent(
            message.content,
            scripts,
        );

        let after;

        try {
            after = JSON.stringify(message.content);
        } catch {
            after = null;
        }

        if (
            before !== null &&
            after !== null &&
            before !== after
        ) {
            changedMessages++;
        }
    }

    return changedMessages;
}


/* ============================================================
 * Final Chat Completion prompt hook
 * ============================================================ */

/**
 * Handles SillyTavern's CHAT_COMPLETION_PROMPT_READY event.
 *
 * At this stage, the Chat Completion prompt has already been assembled,
 * which means components such as Character Description, Personality,
 * Scenario, World Info, and chat history are available in the final
 * message array.
 *
 * The extension retrieves the current Regex rules every time this event
 * fires. This allows Regex UI changes, preset changes, and character changes
 * to take effect automatically.
 *
 * Dry runs are intentionally processed as well. Base64 can change token
 * counts, so applying the same transformation during prompt estimation keeps
 * token calculations closer to the actual outgoing prompt.
 *
 * @param {object} eventData
 * @returns {Promise<void>}
 */
async function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData) {
            return;
        }

        const chat = eventData.chat;

        if (!Array.isArray(chat)) {
            console.warn(
                `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY did not contain a valid chat array.`,
            );

            return;
        }

        /*
         * Retrieve the active Base64 Regex rules for every generation.
         *
         * There is deliberately no cached keyword list in this extension.
         */
        const scripts = getBase64RegexScripts();

        if (scripts.length === 0) {
            if (DEBUG) {
                console.debug(
                    `[${MODULE_NAME}] No active [[b64]] Regex rules were found.`,
                );
            }

            return;
        }

        if (DEBUG) {
            console.debug(
                `[${MODULE_NAME}] Applying ${scripts.length} Base64 Regex rule(s) to the final prompt.`,
                scripts.map(
                    script => script.scriptName || '(unnamed)',
                ),
            );
        }

        const changedMessages = transformMessages(
            chat,
            scripts,
        );

        if (DEBUG) {
            console.info(
                `[${MODULE_NAME}] Transformation complete. ` +
                `${changedMessages} message(s) changed. ` +
                `Dry run: ${Boolean(eventData.dryRun)}.`,
            );
        }
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] Failed to transform the final prompt:`,
            error,
        );
    }
}


/* ============================================================
 * Incoming message decoding
 * ============================================================ */

/**
 * Handles SillyTavern's MESSAGE_RECEIVED event.
 *
 * This fires after the LLM message has been generated and recorded into the
 * `chat` array, but before it is rendered in the UI. Mutating
 * `chat[messageId].mes` here updates both the stored message and the
 * rendered text, because the live `chat` object is persisted by
 * SillyTavern's normal post-receive save. This mirrors how the core
 * `reasoning.js` extension parses/extracts reasoning pre-render.
 *
 * Only AI (non-user, non-system) messages are decoded. User and system
 * messages are passed through untouched.
 *
 * No explicit saveChat() is needed here, and swipe/regenerate paths are
 * covered automatically because they also fire MESSAGE_RECEIVED.
 *
 * @param {number} messageId Index into the `chat` array.
 * @param {string} [_source] What triggered the message (e.g. 'command').
 * @returns {void}
 */
function onMessageReceived(messageId, _source) {
    try {
        if (!Number.isInteger(messageId) || messageId < 0) {
            return;
        }

        const { chat } = SillyTavern.getContext();

        const message = chat?.[messageId];

        if (
            !message ||
            typeof message !== 'object' ||
            message.is_user ||
            message.is_system
        ) {
            return;
        }

        if (typeof message.mes !== 'string' || message.mes.length === 0) {
            return;
        }

        const before = message.mes;

        const after = decodeIncoming(before);

        if (after !== before) {
            message.mes = after;

            if (DEBUG) {
                console.info(
                    `[${MODULE_NAME}] Decoded incoming message ${messageId} ` +
                    `(${before.length} -> ${after.length} chars).`,
                );
            }
        }
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] Failed to decode incoming message:`,
            error,
        );
    }
}


/* ============================================================
 * Extension initialization
 * ============================================================ */

const {
    eventSource,
    event_types,
} = SillyTavern.getContext();


if (
    !eventSource ||
    !event_types?.CHAT_COMPLETION_PROMPT_READY
) {
    console.error(
        `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY is not available.`,
    );
} else {
    eventSource.on(
        event_types.CHAT_COMPLETION_PROMPT_READY,
        onChatCompletionPromptReady,
    );


    if (
        !event_types?.MESSAGE_RECEIVED
    ) {
        console.error(
            `[${MODULE_NAME}] MESSAGE_RECEIVED is not available.`,
        );
    } else {
        eventSource.on(
            event_types.MESSAGE_RECEIVED,
            onMessageReceived,
        );
    }


    console.log(
        `[${MODULE_NAME}] Loaded. ` +
        'Regex rules containing [[b64]] markers will be reapplied to the final Chat Completion prompt, ' +
        'and incoming Base64 (markers or bare blobs) will be decoded back to plaintext.',
    );
}
