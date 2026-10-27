/**
 * @hoi-sau/svg-text: lettering for the comic.
 *
 * Panels are drawn without text. Each line of dialogue is broken between
 * syllables, fitted to its bubble using the font's real metrics, drawn as
 * glyph outlines in SVG, and optionally flattened onto the panel as a PNG.
 */

export { ALL_FONT_PATHS, BOLD_FONT_PATH, COMIC_FONT_PATH, DEFAULT_FONT_PATH, loadFont, measure, missingGlyphs, SHOUT_FONT_PATH, type LoadedFont } from "./font.js";
export { fitText, prepare, tokens, type Box, type BubbleShape, type Fit, type FitOptions, type Line } from "./layout.js";
export { balloon, BUBBLE_KINDS, type BubbleKind } from "./balloon.js";
export { bubbleFont, escapeXml, letterText, MissingGlyphError, renderSpeech, snugBubble, type Bubble, type RenderedSpeech, type SpeechOptions } from "./render.js";
export { composePanel, imageSize, svgToPng, type ComposeResult, type DialogueLine, type PanelImage } from "./compose.js";
